import { Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { businessDate, businessTime, fromDbDate, toDbDate } from '../../common/dates';
import { fromPaise, toPaise } from '../../common/money';
import { isUniqueViolation } from '../../common/pg-error';
import { nextSequence } from '../../common/sequences';
import { PrismaService, TX_OPTIONS, type Tx } from '../../database/prisma.service';
import type { RecordPaymentDto } from './payments.dto';
import { customerBalancePaise, lockCustomer, settleCustomer } from './receivables';

@Injectable()
export class PaymentsService {
  constructor(private readonly db: PrismaService) {}

  /**
   * Receipt + ledger credit + allocation (named bill first, then oldest dues) + audit, under a lock on the
   * customer. Paying more than is owed is accepted: the excess is an advance used by the customer's next bills.
   */
  async record(actor: Actor, dto: RecordPaymentDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.findByKey(actor, idempotencyKey);
      if (existing) return this.get(actor, existing);
    }
    try {
      const id = await this.db.$transaction((tx) => this.post(tx, actor, dto, idempotencyKey), TX_OPTIONS);
      return this.get(actor, id);
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.findByKey(actor, idempotencyKey);
        if (existing) return this.get(actor, existing);
      }
      throw error;
    }
  }

  private async post(tx: Tx, actor: Actor, dto: RecordPaymentDto, idempotencyKey?: string): Promise<string> {
    if (!(await lockCustomer(tx, actor.organizationId, dto.customerId))) throw new NotFoundException('Customer not found');
    const party = await tx.party.findUniqueOrThrow({ where: { id: dto.customerId } });
    const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });

    const amountPaise = toPaise(dto.amount);
    const beforePaise = await customerBalancePaise(tx, actor.organizationId, party.id);
    const date = businessDate(org.timezone);
    const receiptNumber = `${org.receiptPrefix}-${await nextSequence(tx, actor.organizationId, 'RECEIPT')}`;
    const reference = dto.referenceNumber?.trim() || null;
    const payment = await tx.payment.create({ data: {
      organizationId: actor.organizationId,
      receiptNumber,
      kind: 'RECEIPT',
      customerPartyId: party.id,
      customerName: party.name,
      receivedOn: toDbDate(date),
      amount: fromPaise(amountPaise),
      method: dto.paymentMethod,
      referenceNumber: reference,
      notes: dto.notes?.trim() || null,
      previousOutstanding: fromPaise(beforePaise),
      newOutstanding: fromPaise(beforePaise - amountPaise),
      recordedByUserId: actor.userId,
      recordedByName: actor.name,
      idempotencyKey: idempotencyKey ?? null,
    } });
    await tx.customerLedgerEntry.create({ data: {
      organizationId: actor.organizationId, customerPartyId: party.id, entryDate: toDbDate(date), type: 'PAYMENT',
      referenceNo: receiptNumber, paymentId: payment.id, credit: fromPaise(amountPaise),
      description: `Payment received via ${dto.paymentMethod}${reference ? ` (${reference})` : ''}`,
    } });
    const named = reference
      ? await tx.sale.findFirst({ where: { organizationId: actor.organizationId, customerPartyId: party.id, billNumber: reference }, select: { id: true } })
      : null;
    await settleCustomer(tx, actor, party.id, named?.id);

    const advance = Math.max(0, amountPaise - Math.max(0, beforePaise));
    await audit(tx, actor, {
      action: 'RECORD_PAYMENT', entity: 'PAYMENT', entityId: payment.id,
      details: `Payment ${receiptNumber} of ₹${dto.amount.toLocaleString('en-IN')} from ${party.name}`
        + (advance > 0 ? `; ₹${fromPaise(advance).toLocaleString('en-IN')} kept as advance` : ''),
    });
    return payment.id;
  }

  async get(actor: Actor, id: string) {
    const [payment] = await this.list(actor, 1, 0, id);
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  /** Receipts (positive) and counter refunds (negative), newest first, with the bills each one settled. */
  async list(actor: Actor, limit: number, offset: number, paymentId?: string) {
    const org = await this.db.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { timezone: true } });
    const rows = await this.db.payment.findMany({
      where: { organizationId: actor.organizationId, ...(paymentId && { id: paymentId }) },
      include: { allocations: { include: { sale: { select: { billNumber: true } } }, orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return rows.map((row) => {
      const net = new Map<string, { saleId: string | null; billNumber: string | null; paise: number }>();
      for (const a of row.allocations) {
        const key = a.saleId ?? 'opening';
        const entry = net.get(key) ?? { saleId: a.saleId, billNumber: a.sale?.billNumber ?? null, paise: 0 };
        entry.paise += toPaise(Number(a.amount));
        net.set(key, entry);
      }
      const allocatedPaise = [...net.values()].reduce((s, e) => s + e.paise, 0);
      const amount = Number(row.amount);
      return {
        id: row.id,
        receiptNumber: row.receiptNumber,
        kind: row.kind,
        customerId: row.customerPartyId ?? '',
        customerName: row.customerName,
        date: fromDbDate(row.receivedOn),
        time: businessTime(org.timezone, row.createdAt),
        amount,
        paymentMethod: row.method,
        ...(row.referenceNumber && { referenceNumber: row.referenceNumber }),
        previousOutstanding: Number(row.previousOutstanding),
        newOutstanding: Number(row.newOutstanding),
        ...(row.notes && { notes: row.notes }),
        recordedBy: row.recordedByName,
        createdAt: row.createdAt.toISOString(),
        /** Which bills this receipt settled; billNumber null = opening balance. */
        billAllocations: [...net.values()].filter((e) => e.paise !== 0).map((e) => ({ saleId: e.saleId, billNumber: e.billNumber, amount: fromPaise(e.paise) })),
        /** Part of the receipt not yet used (customer advance). */
        unallocatedAmount: row.kind === 'RECEIPT' ? fromPaise(Math.max(0, toPaise(amount) - allocatedPaise)) : 0,
      };
    });
  }

  private async findByKey(actor: Actor, idempotencyKey: string): Promise<string | undefined> {
    const row = await this.db.payment.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey } },
      select: { id: true },
    });
    return row?.id;
  }
}
