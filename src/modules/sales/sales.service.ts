import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { businessDate, businessTime, daysBetween, fromDbDate } from '../../common/dates';
import { fromPaise, toPaise } from '../../common/money';
import { isUniqueViolation } from '../../common/pg-error';
import { PrismaService, TX_OPTIONS, type Tx } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { settleCustomer } from '../payments/receivables';
import { cancelBill, COUNTER_SALE, insertBill, loadCustomer, postBillFinancials } from './billing';
import { paymentStatusFor } from './sales.calc';
import type { CreateSaleDto, SalesQueryDto } from './sales.dto';

/** How far a bill date may move from today. A bill on another day posts at once; it is recorded in the audit trail. */
export const MAX_BACKDATE_DAYS = 365;
export const MAX_FORWARD_DAYS = 30;

export type ChangeResult =
  | { status: 'APPLIED'; sale: Awaited<ReturnType<SalesService['get']>> }
  | { status: 'PENDING_APPROVAL'; approvalId: string };

@Injectable()
export class SalesService {
  constructor(private readonly db: PrismaService) {}

  /**
   * Posts a bill at once, whoever enters it and whatever day it is dated (within the allowed window): stock, receivable
   * and receipts are all posted on that date. Only cancelling and editing a bill need the Owner (requestCancel / requestRebill).
   * With an Idempotency-Key, a retry returns the bill created by the first attempt.
   */
  async create(actor: Actor, dto: CreateSaleDto, idempotencyKey?: string) {
    if (idempotencyKey) {
      const existing = await this.findByKey(actor, idempotencyKey);
      if (existing) return this.get(actor, existing);
    }
    try {
      const saleId = await this.db.$transaction(async (tx) => {
        const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
        const today = businessDate(org.timezone);
        const saleDate = checkedSaleDate(dto.date, today);
        const customer = await loadCustomer(tx, actor, dto.customerId);
        const bill = await insertBill(tx, actor, org, dto, { customer, saleDate, status: 'CONFIRMED', idempotencyKey });
        await postBillFinancials(tx, actor, org, { ...bill, saleDate, customer, description: await describe(tx, bill.saleId) });
        const reason = dto.dateReason?.trim();
        await audit(tx, actor, {
          action: 'CREATE_SALE', entity: 'SALE', entityId: bill.saleId,
          details: `Sale ${bill.billNumber} for ${customer?.name ?? COUNTER_SALE}: ₹${fromPaise(bill.totalPaise).toLocaleString('en-IN')}`
            + (saleDate !== today ? ` dated ${saleDate} (entered ${today})${reason ? `: ${reason}` : ''}` : ''),
        });
        return bill.saleId;
      }, TX_OPTIONS);
      return this.get(actor, saleId);
    } catch (error) {
      if (idempotencyKey && isUniqueViolation(error)) {
        const existing = await this.findByKey(actor, idempotencyKey);
        if (existing) return this.get(actor, existing);
      }
      throw error;
    }
  }

  /** Owner cancels directly; anyone else files a request for the Owner. */
  async requestCancel(actor: Actor, saleId: string, reason: string): Promise<ChangeResult> {
    if (actor.role !== 'OWNER') return this.fileRequest(actor, saleId, 'SALE_CANCEL', reason, {});
    await this.db.$transaction((tx) => this.executeCancel(tx, actor, saleId, reason), TX_OPTIONS);
    return { status: 'APPLIED', sale: await this.get(actor, saleId) };
  }

  /** Edit = cancel and rebill in one step. Owner applies directly; anyone else files a request. */
  async requestRebill(actor: Actor, saleId: string, dto: CreateSaleDto, reason: string): Promise<ChangeResult> {
    if (actor.role !== 'OWNER') {
      const { date: _date, dateReason: _reason, ...bill } = dto;
      return this.fileRequest(actor, saleId, 'SALE_REBILL', reason, bill as unknown as Prisma.InputJsonValue);
    }
    const newId = await this.db.$transaction((tx) => this.executeRebill(tx, actor, saleId, dto, reason), TX_OPTIONS);
    return { status: 'APPLIED', sale: await this.get(actor, newId) };
  }

  async executeCancel(tx: Tx, actor: Actor, saleId: string, reason: string, approver?: string): Promise<void> {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
    const { sale } = await cancelBill(tx, actor, org, saleId, reason, businessDate(org.timezone), { keepCounterMoney: false });
    if (sale.customerPartyId) await settleCustomer(tx, actor, sale.customerPartyId);
    await audit(tx, actor, { action: 'CANCEL_SALE', entity: 'SALE', entityId: saleId, details: `Cancelled ${sale.billNumber}: ${reason}`, approver });
  }

  /**
   * Replaces a bill: the old one is cancelled (stock back, receipts released) and the new one is posted on the
   * old bill's date (stock taken again, released money applied to it first). Returns the new bill id.
   */
  async executeRebill(tx: Tx, actor: Actor, saleId: string, dto: CreateSaleDto, reason: string, approver?: string): Promise<string> {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
    const old = await tx.sale.findFirst({ where: { id: saleId, organizationId: actor.organizationId } });
    if (!old) throw new NotFoundException('Sale not found');
    const customer = await loadCustomer(tx, actor, dto.customerId || null);
    const otherCustomer = old.customerPartyId && old.customerPartyId !== customer?.partyId ? old.customerPartyId : null;
    if (otherCustomer) await loadCustomer(tx, actor, otherCustomer);

    // Customer money released by the old bill is that customer's credit and is applied by settleCustomer.
    // Counter money moves to the new counter bill; if the bill now belongs to a customer it is refunded instead.
    const { released: carried } = await cancelBill(tx, actor, org, saleId, `rebilled: ${reason}`, businessDate(org.timezone), { keepCounterMoney: !customer });
    const saleDate = fromDbDate(old.saleDate);
    const bill = await insertBill(tx, actor, org, dto, {
      customer, saleDate, status: 'CONFIRMED', replacesSaleId: saleId, carriedPaise: carried.reduce((s, r) => s + r.amountPaise, 0),
    });
    await postBillFinancials(tx, actor, org, { ...bill, saleDate, customer, carried, description: await describe(tx, bill.saleId) });
    if (otherCustomer) await settleCustomer(tx, actor, otherCustomer);
    await tx.sale.update({ where: { id: saleId }, data: { cancelReason: `Rebilled as ${bill.billNumber}: ${reason}` } });
    await audit(tx, actor, {
      action: 'REBILL_SALE', entity: 'SALE', entityId: bill.saleId, approver,
      details: `${old.billNumber} replaced by ${bill.billNumber} (₹${fromPaise(bill.totalPaise).toLocaleString('en-IN')}): ${reason}`,
    });
    return bill.saleId;
  }

  async noteCorrection(actor: Actor, saleId: string, note: string): Promise<void> {
    const sale = await this.get(actor, saleId);
    await audit(this.db, actor, { action: 'SALE_CORRECTION_NOTED', entity: 'SALE', entityId: saleId, details: `Correction noted for ${sale.billNumber}: ${note.trim()}` });
  }

  async get(actor: Actor, id: string) {
    const [sale] = await this.list(actor, { limit: 1, offset: 0 }, id);
    if (!sale) throw new NotFoundException('Sale not found');
    return sale;
  }

  /** Bills with lines, counter receipts and live paid amount (Σ allocations), in a fixed number of queries. */
  async list(actor: Actor, query: Pick<SalesQueryDto, 'limit' | 'offset' | 'from' | 'to'>, saleId?: string) {
    const org = await this.db.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { timezone: true } });
    const rows = await this.db.sale.findMany({
      where: {
        organizationId: actor.organizationId,
        ...(saleId && { id: saleId }),
        ...((query.from || query.to) && {
          saleDate: { ...(query.from && { gte: new Date(`${query.from}T00:00:00Z`) }), ...(query.to && { lte: new Date(`${query.to}T00:00:00Z`) }) },
        }),
      },
      include: {
        items: { orderBy: { lineNo: 'asc' } },
        payments: { where: { kind: 'RECEIPT' }, orderBy: { createdAt: 'asc' }, select: { method: true, amount: true } },
        replaces: { select: { billNumber: true } },
        replacedBy: { select: { id: true, billNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      skip: query.offset,
    });
    if (rows.length === 0) return [];
    const paid = await this.db.paymentAllocation.groupBy({ by: ['saleId'], where: { saleId: { in: rows.map((r) => r.id) } }, _sum: { amount: true } });
    const paidBySale = new Map(paid.map((p) => [p.saleId, toPaise(Number(p._sum.amount ?? 0))]));

    return rows.map((sale) => {
      const totalPaise = toPaise(Number(sale.totalAmount));
      const paidPaise = paidBySale.get(sale.id) ?? 0;
      const extras = toPaise(Number(sale.amaliAmount)) + toPaise(Number(sale.marketFeeAmount)) + toPaise(Number(sale.otherCharges)) + toPaise(Number(sale.taxAmount));
      const pendingTenders = (sale.pendingTenders ?? []) as { method: string; amountPaise: number }[];
      return {
        id: sale.id,
        billNumber: sale.billNumber,
        customerId: sale.customerPartyId ?? '',
        customerName: sale.customerName,
        customerPhone: sale.customerPhone,
        customerAddress: sale.customerAddress,
        date: fromDbDate(sale.saleDate),
        time: businessTime(org.timezone, sale.createdAt),
        items: sale.items.map((line) => ({
          id: line.id,
          markCode: line.markCode,
          lotNumber: line.lotNumber,
          bags: line.bags,
          weightKg: Number(line.weightKg),
          ratePerKg: Number(line.ratePerKg),
          amount: Number(line.amount),
          bagWeights: line.bagWeights as { bagNumber: number; weightKg: number }[],
        })),
        totalBags: sale.totalBags,
        totalWeightKg: Number(sale.totalWeightKg),
        productSubtotal: Number(sale.productSubtotal),
        charges: {
          amaliPerBag: Number(sale.amaliPerBag),
          marketFeePerBag: Number(sale.marketFeePerBag),
          amaliEnabled: sale.amaliEnabled,
          marketFeeEnabled: sale.marketFeeEnabled,
          bagCount: sale.totalBags,
          amaliAmount: Number(sale.amaliAmount),
          marketFeeAmount: Number(sale.marketFeeAmount),
          otherCharges: Number(sale.otherCharges),
          taxPercent: sale.taxPercent == null ? null : Number(sale.taxPercent),
          taxAmount: Number(sale.taxAmount),
          productSubtotal: Number(sale.productSubtotal),
          totalAdditionalCharges: fromPaise(extras),
          finalInvoiceAmount: Number(sale.totalAmount),
        },
        totalAmount: Number(sale.totalAmount),
        paymentType: sale.paymentType,
        paymentStatus: paymentStatusFor(totalPaise, paidPaise),
        tenders: sale.status === 'PENDING_APPROVAL'
          ? pendingTenders.map((t) => ({ method: t.method, amount: fromPaise(t.amountPaise) }))
          : sale.payments.map((p) => ({ method: p.method, amount: Number(p.amount) })),
        ...(sale.creditDays != null && { creditDays: sale.creditDays }),
        ...(sale.dueDate && { dueDate: fromDbDate(sale.dueDate) }),
        paidAmount: fromPaise(paidPaise),
        balanceDue: sale.status === 'CONFIRMED' ? fromPaise(Math.max(0, totalPaise - paidPaise)) : 0,
        status: sale.status,
        createdByUserId: sale.createdByUserId,
        createdByName: sale.createdByName,
        createdByRole: sale.createdByRole,
        ...(sale.notes && { notes: sale.notes }),
        productId: sale.productId,
        productName: sale.productName,
        ...(sale.replaces && { replacesBillNumber: sale.replaces.billNumber }),
        ...(sale.replacedBy && { replacedBySaleId: sale.replacedBy.id, replacedByBillNumber: sale.replacedBy.billNumber }),
        ...(sale.cancelReason && { cancelReason: sale.cancelReason }),
        createdAt: sale.createdAt.toISOString(),
      };
    });
  }

  private async findByKey(actor: Actor, idempotencyKey: string): Promise<string | undefined> {
    const row = await this.db.sale.findUnique({
      where: { organizationId_idempotencyKey: { organizationId: actor.organizationId, idempotencyKey } },
      select: { id: true },
    });
    return row?.id;
  }

  private async fileRequest(actor: Actor, saleId: string, type: 'SALE_CANCEL' | 'SALE_REBILL', reason: string, requested: Prisma.InputJsonValue): Promise<ChangeResult> {
    const approvalId = await this.db.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({ where: { id: saleId, organizationId: actor.organizationId } });
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.status !== 'CONFIRMED') throw new ConflictException(`${sale.billNumber} is ${sale.status.toLowerCase().replace('_', ' ')}`);
      if (await tx.approval.findFirst({ where: { saleId, status: 'PENDING' } })) {
        throw new ConflictException(`${sale.billNumber} already has a request waiting for the owner`);
      }
      const approval = await tx.approval.create({ data: {
        organizationId: actor.organizationId, type, saleId, referenceNo: sale.billNumber,
        requestedById: actor.userId, requestedByName: actor.name, requestedByRole: actor.role, reason,
        originalData: { totalAmount: Number(sale.totalAmount), totalWeightKg: Number(sale.totalWeightKg), date: fromDbDate(sale.saleDate) },
        requestedData: requested,
      } });
      await audit(tx, actor, { action: type === 'SALE_CANCEL' ? 'CANCEL_REQUESTED' : 'REBILL_REQUESTED', entity: 'SALE', entityId: saleId, details: `${sale.billNumber}: ${reason}` });
      return approval.id;
    }, TX_OPTIONS);
    return { status: 'PENDING_APPROVAL', approvalId };
  }
}

function checkedSaleDate(requested: string | undefined, today: string): string {
  if (!requested) return today;
  const offset = daysBetween(today, requested);
  if (offset < -MAX_BACKDATE_DAYS || offset > MAX_FORWARD_DAYS) {
    throw new BadRequestException(`Bill date must be within ${MAX_BACKDATE_DAYS} days before and ${MAX_FORWARD_DAYS} days after today`);
  }
  return requested;
}

export async function describe(tx: Tx, saleId: string): Promise<string> {
  const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, select: { productName: true, totalBags: true, totalWeightKg: true } });
  return `${sale.productName} sale: ${sale.totalBags} bags (${Number(sale.totalWeightKg)} KG)`;
}
