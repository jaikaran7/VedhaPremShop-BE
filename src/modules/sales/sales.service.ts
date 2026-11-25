import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { businessDate, businessTime, daysBetween, fromDbDate, toDbDate } from '../../common/dates';
import { formatRupees, fromPaise, toPaise } from '../../common/money';
import { isUniqueViolation } from '../../common/pg-error';
import { PrismaService, TX_OPTIONS, type Tx } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { settleCustomer } from '../payments/receivables';
import { cancelBill, COUNTER_SALE, insertBill, loadCustomer, lookupLineMarks, postBillFinancials, pricedItems, reviseSale, type BillCustomer } from './billing';
import { chargeSettings, paymentStatusFor, priceBill } from './sales.calc';
import { sameSaleLines, summarizeExistingSale } from './sale-match';
import type { CreateSaleDto, SalesQueryDto } from './sales.dto';

type SalesFilter = Pick<SalesQueryDto, 'from' | 'to' | 'paymentType' | 'productId' | 'q'>;
import type { Organization } from '../../generated/prisma/client';

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
        await this.rejectPossibleDuplicate(tx, actor, dto, { customer, saleDate, org });
        const bill = await insertBill(tx, actor, org, dto, { customer, saleDate, status: 'CONFIRMED', idempotencyKey });
        await postBillFinancials(tx, actor, org, { ...bill, saleDate, customer, description: await describe(tx, bill.saleId) });
        await audit(tx, actor, {
          action: 'CREATE_SALE', entity: 'SALE', entityId: bill.saleId,
          details: `Sale ${bill.billNumber} for ${customer?.name ?? COUNTER_SALE}: ${formatRupees(fromPaise(bill.totalPaise))}${datedNote(saleDate, today, dto.dateReason)}`,
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

  /** Edit = update the same bill. Owner applies directly; anyone else files a request. */
  async requestRebill(actor: Actor, saleId: string, dto: CreateSaleDto, reason: string): Promise<ChangeResult> {
    if (actor.role !== 'OWNER') {
      // The edited bill keeps the original bill's date, so the request carries no date of its own.
      const bill = { ...dto, date: undefined, dateReason: undefined };
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
   * Edits a confirmed bill in place: same id, number, date and customer. Stock and the balance move together,
   * and the previous items stay on a revision. Returns the same bill id.
   */
  async executeRebill(tx: Tx, actor: Actor, saleId: string, dto: CreateSaleDto, reason: string, approver?: string): Promise<string> {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
    const changed = await reviseSale(tx, actor, org, saleId, dto, reason);
    if (changed) {
      const sale = await tx.sale.findUniqueOrThrow({ where: { id: saleId }, select: { billNumber: true, totalAmount: true } });
      await audit(tx, actor, {
        action: 'REBILL_SALE', entity: 'SALE', entityId: saleId, approver,
        details: `${sale.billNumber} edited to ${formatRupees(Number(sale.totalAmount))}: ${reason}`,
      });
    }
    return saleId;
  }

  async noteCorrection(actor: Actor, saleId: string, note: string): Promise<void> {
    const sale = await this.get(actor, saleId);
    await audit(this.db, actor, { action: 'SALE_CORRECTION_NOTED', entity: 'SALE', entityId: saleId, details: `Correction noted for ${sale.billNumber}: ${note.trim()}` });
  }

  async get(actor: Actor, id: string) {
    const [sale] = await this.list(actor, { limit: 1, offset: 0 }, id);
    if (!sale) throw new NotFoundException('Sale not found');
    const revisions = await this.db.saleRevision.findMany({
      where: { saleId: id, organizationId: actor.organizationId },
      orderBy: { revisionNo: 'desc' },
    });
    return {
      ...sale,
      revisions: revisions.map((revision) => revisionView(revision)),
    };
  }

  /** Bills that have been corrected, newest edit first, with every previous → current change. */
  async listEdits(actor: Actor, query: Pick<SalesQueryDto, 'limit' | 'offset'>) {
    const groups = await this.db.saleRevision.groupBy({
      by: ['saleId'],
      where: { organizationId: actor.organizationId },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      take: query.limit,
      skip: query.offset,
    });
    if (groups.length === 0) return [];
    const sales = await this.db.sale.findMany({
      where: { organizationId: actor.organizationId, id: { in: groups.map((group) => group.saleId) } },
      select: {
        id: true, billNumber: true, customerName: true, saleDate: true, totalBags: true, totalWeightKg: true, totalAmount: true, status: true,
        revisions: {
          orderBy: { revisionNo: 'desc' },
          select: { id: true, revisionNo: true, editedByName: true, editedByRole: true, reason: true, changes: true, before: true, after: true, createdAt: true },
        },
      },
    });
    const byId = new Map(sales.map((sale) => [sale.id, sale]));
    return groups.flatMap((group) => {
      const sale = byId.get(group.saleId);
      if (!sale) return [];
      return [{
        id: sale.id,
        billNumber: sale.billNumber,
        customerName: sale.customerName,
        date: fromDbDate(sale.saleDate),
        totalBags: sale.totalBags,
        totalWeightKg: Number(sale.totalWeightKg),
        totalAmount: Number(sale.totalAmount),
        status: sale.status,
        revisionCount: group._count._all,
        revisions: sale.revisions.map((revision) => revisionView(revision)),
      }];
    });
  }

  /** The bills a list or summary covers: this organization, inside the dates, and matching the payment, product and search filters. */
  private salesWhere(actor: Actor, query: SalesFilter, saleId?: string): Prisma.SaleWhereInput {
    const search = query.q?.trim();
    return {
      organizationId: actor.organizationId,
      ...(saleId && { id: saleId }),
      ...((query.from || query.to) && {
        saleDate: { ...(query.from && { gte: new Date(`${query.from}T00:00:00Z`) }), ...(query.to && { lte: new Date(`${query.to}T00:00:00Z`) }) },
      }),
      ...(query.paymentType && { paymentType: query.paymentType }),
      ...(query.productId && { OR: [{ productId: query.productId }, { items: { some: { productId: query.productId } } }] }),
      ...(search && {
        AND: [{ OR: [{ billNumber: { contains: search, mode: 'insensitive' } }, { customerName: { contains: search, mode: 'insensitive' } }] }],
      }),
    };
  }

  /** One page of bills and how many bills match the filters in all. */
  async listPage(actor: Actor, query: Pick<SalesQueryDto, 'limit' | 'offset'> & SalesFilter) {
    const [rows, total] = await Promise.all([this.list(actor, query), this.db.sale.count({ where: this.salesWhere(actor, query) })]);
    return { rows, total };
  }

  /**
   * Totals for the filtered bills, counted on the database so a long range never has to be sent to the screen. Cancelled and
   * unapproved bills are left out. With `withCredit`, also the part of those bills still unpaid and how many bills hold it.
   */
  async summary(actor: Actor, query: SalesFilter & { withCredit?: boolean }) {
    const where: Prisma.SaleWhereInput = { ...this.salesWhere(actor, query), status: 'CONFIRMED' };
    const totals = await this.db.sale.aggregate({
      where,
      _count: { _all: true },
      _sum: { totalBags: true, totalWeightKg: true, totalAmount: true },
    });
    const base = {
      bills: totals._count._all,
      bags: totals._sum.totalBags ?? 0,
      weightKg: Number(totals._sum.totalWeightKg ?? 0),
      amount: Number(totals._sum.totalAmount ?? 0),
    };
    return query.withCredit ? { ...base, ...(await this.unpaidOf(where)) } : base;
  }

  /** What the matching bills still owe: each bill's total less what receipts have been applied to it, never below zero. */
  private async unpaidOf(where: Prisma.SaleWhereInput) {
    const bills = await this.db.sale.findMany({ where, select: { id: true, totalAmount: true } });
    if (bills.length === 0) return { creditAmount: 0, creditBills: 0 };
    const paid = await this.db.paymentAllocation.groupBy({ by: ['saleId'], where: { saleId: { in: bills.map((bill) => bill.id) } }, _sum: { amount: true } });
    const paidBySale = new Map(paid.map((row) => [row.saleId, toPaise(Number(row._sum.amount ?? 0))]));
    let unpaidPaise = 0;
    let unpaidBills = 0;
    for (const bill of bills) {
      const owed = Math.max(0, toPaise(Number(bill.totalAmount)) - (paidBySale.get(bill.id) ?? 0));
      unpaidPaise += owed;
      if (owed > 0) unpaidBills += 1;
    }
    return { creditAmount: fromPaise(unpaidPaise), creditBills: unpaidBills };
  }

  /** Bills with lines, counter receipts and live paid amount (Σ allocations), in a fixed number of queries. */
  async list(actor: Actor, query: Pick<SalesQueryDto, 'limit' | 'offset'> & SalesFilter, saleId?: string) {
    const org = await this.db.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { timezone: true } });
    const rows = await this.db.sale.findMany({
      where: this.salesWhere(actor, query, saleId),
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
          productId: line.productId,
          productName: line.productName,
          chargesApply: line.chargesApply,
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
          marketFeeBasis: sale.marketFeeBasis,
          marketFeePercent: Number(sale.marketFeePercent),
          amaliEnabled: sale.amaliEnabled,
          marketFeeEnabled: sale.marketFeeEnabled,
          bagCount: sale.items.filter((line) => line.chargesApply).reduce((sum, line) => sum + line.bags, 0),
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

  /** Same customer, same day, same lines and same rupee total needs a second click so a double-save does not post twice. */
  private async rejectPossibleDuplicate(
    tx: Tx,
    actor: Actor,
    dto: CreateSaleDto,
    opts: { customer: BillCustomer | null; saleDate: string; org: Organization },
  ): Promise<void> {
    if (dto.confirmDuplicateSale) return;
    const priced = priceBill(pricedItems(dto.items, await lookupLineMarks(tx, actor.organizationId, dto.items)), chargeSettings(opts.org), { percent: dto.taxPercent, amount: dto.taxAmount });
    const matches = await tx.sale.findMany({
      where: {
        organizationId: actor.organizationId,
        status: 'CONFIRMED',
        saleDate: toDbDate(opts.saleDate),
        customerPartyId: opts.customer?.partyId ?? null,
        totalAmount: fromPaise(priced.totalPaise),
      },
      include: { items: { select: { lotNumber: true, markCode: true, bags: true, weightKg: true, ratePerKg: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const match = matches.find((sale) => sameSaleLines(dto.items, sale.items.map((line) => ({
      lotNumber: line.lotNumber,
      markCode: line.markCode,
      bags: line.bags,
      weightKg: Number(line.weightKg),
      ratePerKg: Number(line.ratePerKg),
    }))));
    if (!match) return;
    throw new ConflictException({
      message: `The same bill was already saved for this customer today as ${match.billNumber}. Confirm if this is a second order, or cancel if it was a duplicate.`,
      code: 'POSSIBLE_DUPLICATE_SALE',
      existingSale: summarizeExistingSale(match),
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

function revisionView(revision: {
  id: string;
  revisionNo: number;
  editedByName: string;
  editedByRole: string;
  reason: string;
  changes: Prisma.JsonValue;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  createdAt: Date;
}) {
  return {
    id: revision.id,
    revisionNo: revision.revisionNo,
    editedBy: revision.editedByName,
    editedByRole: revision.editedByRole,
    reason: revision.reason,
    changes: revision.changes,
    before: revision.before,
    after: revision.after,
    createdAt: revision.createdAt.toISOString(),
  };
}

/** " dated 2026-10-24 (entered 2026-10-26): reason" for a bill on another day; nothing for today's bills. */
function datedNote(saleDate: string, today: string, reason?: string): string {
  if (saleDate === today) return '';
  const why = reason?.trim();
  const suffix = why ? `: ${why}` : '';
  return ` dated ${saleDate} (entered ${today})${suffix}`;
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
