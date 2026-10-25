import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor';
import { toDbDate } from '../../common/dates';
import { fromGrams, fromPaise, toGrams, toPaise } from '../../common/money';
import { nextSequence } from '../../common/sequences';
import type { Tx } from '../../database/prisma.service';
import type { Organization, Prisma, SaleStatus } from '../../generated/prisma/client';
import { applyStockChange } from '../inventory/stock-ledger';
import { customerBalancePaise, lockCustomer, releaseSaleAllocations, settleCustomer } from '../payments/receivables';
import { type PaymentMethod, priceBill, settle, stockDraws } from './sales.calc';
import type { CreateSaleDto } from './sales.dto';

export const COUNTER_SALE = 'Counter sale';
/** Name receipts and refunds of walk-in bills carry, so collections show them under one heading. */
export const COUNTER_COLLECTIONS = 'Counter sales';

export interface BillCustomer {
  partyId: string;
  status: string;
  creditDays: number;
  name: string;
  phone: string;
  address: string;
}

export interface Tender {
  method: PaymentMethod;
  amountPaise: number;
}

export interface PostedBill {
  saleId: string;
  billNumber: string;
  totalPaise: number;
  tenders: Tender[];
}

/** Locks and loads the billed customer (lock order: customer → sequences → lot marks). */
export async function loadCustomer(tx: Tx, actor: Actor, customerId?: string | null): Promise<BillCustomer | null> {
  if (!customerId) return null;
  const locked = await lockCustomer(tx, actor.organizationId, customerId);
  if (!locked) throw new NotFoundException('Customer not found');
  const party = await tx.party.findUniqueOrThrow({ where: { id: customerId } });
  return { partyId: customerId, status: locked.status, creditDays: locked.credit_days, name: party.name, phone: party.phone, address: party.address };
}

/**
 * Prices, numbers and stores a bill and takes its stock. Financial posting is separate (postBillFinancials)
 * because a backdated bill holds stock while it waits for the Owner's approval.
 */
export async function insertBill(tx: Tx, actor: Actor, org: Organization, input: CreateSaleDto, opts: {
  customer: BillCustomer | null;
  saleDate: string;
  status: SaleStatus;
  carriedPaise?: number;
  replacesSaleId?: string;
  idempotencyKey?: string;
}): Promise<PostedBill> {
  const product = await tx.product.findFirst({ where: { id: input.productId, organizationId: actor.organizationId } });
  if (!product) throw new NotFoundException('Product not found');

  const bill = priceBill(input.items, {
    amaliPerBag: Number(org.amaliPerBag), marketFeePerBag: Number(org.marketFeePerBag),
    amaliEnabled: org.amaliEnabled, marketFeeEnabled: org.marketFeeEnabled,
  }, { percent: input.taxPercent, amount: input.taxAmount });
  if (input.totalAmount !== undefined && toPaise(input.totalAmount) !== bill.totalPaise) {
    throw new ConflictException(`Bill total is ₹${fromPaise(bill.totalPaise)} with current rates and charges. Review the bill and confirm again.`);
  }
  const settlement = settle({
    totalPaise: bill.totalPaise, tenders: input.tenders ?? [], creditDays: input.creditDays,
    defaultCreditDays: opts.customer?.creditDays, saleDate: opts.saleDate, hasCustomer: !!opts.customer, carriedPaise: opts.carriedPaise,
  });

  // One query for every line's lot mark, however many lines the bill has.
  const wanted = stockDraws(bill.lines);
  const marks = await tx.lotMark.findMany({
    where: { organizationId: actor.organizationId, OR: wanted.map((d) => ({ markCode: d.markCode.trim().toUpperCase(), lot: { lotNumber: d.lotNumber.trim().toUpperCase() } })) },
    include: { lot: { select: { lotNumber: true, productId: true } } },
  });
  const draws: { lotMarkId: string; lotNumber: string; markCode: string; bags: number; grams: number }[] = wanted.map((draw) => {
    const found = marks.find((m) => m.markCode === draw.markCode.trim().toUpperCase() && m.lot.lotNumber === draw.lotNumber.trim().toUpperCase());
    if (!found) throw new NotFoundException(`${draw.lotNumber} has no mark ${draw.markCode}`);
    if (found.lot.productId !== product.id) throw new UnprocessableEntityException(`${found.lot.lotNumber} is not ${product.name} stock`);
    return { ...draw, lotMarkId: found.id, lotNumber: found.lot.lotNumber, markCode: found.markCode };
  });
  const lotMarkOf = (lotNumber: string, markCode: string) =>
    draws.find((d) => d.lotNumber === lotNumber.trim().toUpperCase() && d.markCode === markCode.trim().toUpperCase())!;

  const billNumber = `${org.invoicePrefix}-${await nextSequence(tx, actor.organizationId, 'INVOICE')}`;
  const sale = await tx.sale.create({ data: {
    organizationId: actor.organizationId,
    billNumber,
    customerPartyId: opts.customer?.partyId ?? null,
    customerName: opts.customer?.name ?? COUNTER_SALE,
    customerPhone: opts.customer?.phone ?? '',
    customerAddress: opts.customer?.address ?? '',
    productId: product.id,
    productName: product.name,
    saleDate: toDbDate(opts.saleDate),
    totalBags: bill.totalBags,
    totalWeightKg: String(fromGrams(bill.totalGrams)),
    productSubtotal: fromPaise(bill.subtotalPaise),
    amaliPerBag: org.amaliPerBag,
    marketFeePerBag: org.marketFeePerBag,
    amaliEnabled: org.amaliEnabled,
    marketFeeEnabled: org.marketFeeEnabled,
    amaliAmount: fromPaise(bill.amaliPaise),
    marketFeeAmount: fromPaise(bill.marketFeePaise),
    taxPercent: bill.taxPercent,
    taxAmount: fromPaise(bill.taxPaise),
    totalAmount: fromPaise(bill.totalPaise),
    paymentType: settlement.paymentType,
    creditDays: settlement.creditDays,
    dueDate: settlement.dueDate ? toDbDate(settlement.dueDate) : null,
    status: opts.status,
    pendingTenders: opts.status === 'PENDING_APPROVAL'
      ? (settlement.tenders as unknown as Prisma.InputJsonValue)
      : undefined,
    replacesSaleId: opts.replacesSaleId ?? null,
    notes: input.notes?.trim() ?? '',
    createdByUserId: actor.userId,
    createdByName: actor.name,
    createdByRole: actor.role,
    idempotencyKey: opts.idempotencyKey ?? null,
    items: { create: bill.lines.map((line, index) => {
      const draw = lotMarkOf(line.lotNumber, line.markCode);
      return {
        organizationId: actor.organizationId,
        lineNo: index + 1,
        lotMarkId: draw.lotMarkId,
        lotNumber: draw.lotNumber,
        markCode: draw.markCode,
        bags: line.bags,
        weightKg: String(fromGrams(line.grams)),
        ratePerKg: fromPaise(line.ratePaise),
        amount: fromPaise(line.amountPaise),
        bagWeights: line.bagWeights.map((bag) => ({ bagNumber: bag.bagNumber, weightKg: bag.weightKg })),
      };
    }) },
  } });

  // Sorted lock order prevents deadlocks between bills touching the same lot marks.
  for (const draw of [...draws].sort((a, b) => a.lotMarkId.localeCompare(b.lotMarkId))) {
    await applyStockChange(tx, actor, {
      lotMarkId: draw.lotMarkId, type: 'SALE_OUT', bagsDelta: -draw.bags, gramsDelta: -draw.grams,
      referenceType: 'SALE', referenceId: sale.id, movementDate: opts.saleDate,
      reason: `Dispatched for bill ${billNumber} to ${opts.customer?.name ?? COUNTER_SALE}`,
    });
  }
  return { saleId: sale.id, billNumber, totalPaise: bill.totalPaise, tenders: settlement.tenders };
}

/**
 * Receivable and money for a confirmed bill: ledger debit, a receipt per tender (allocated to this bill),
 * then the customer's advance is applied. For counter sales, money carried from a replaced bill is moved
 * onto this bill and any excess is refunded.
 */
export async function postBillFinancials(tx: Tx, actor: Actor, org: Organization, bill: PostedBill & {
  saleDate: string; customer: BillCustomer | null; description: string; carried?: { paymentId: string; amountPaise: number }[];
}): Promise<void> {
  const { customer } = bill;
  if (customer) {
    await tx.customerLedgerEntry.create({ data: {
      organizationId: actor.organizationId, customerPartyId: customer.partyId, entryDate: toDbDate(bill.saleDate),
      type: 'SALE', referenceNo: bill.billNumber, saleId: bill.saleId, description: bill.description, debit: fromPaise(bill.totalPaise),
    } });
  }
  let remaining = bill.totalPaise;
  for (const carried of bill.carried ?? []) {
    const take = Math.min(remaining, carried.amountPaise);
    if (take > 0) {
      await tx.paymentAllocation.create({ data: { organizationId: actor.organizationId, paymentId: carried.paymentId, saleId: bill.saleId, amount: fromPaise(take) } });
      remaining -= take;
    }
    if (carried.amountPaise > take) await refund(tx, actor, org, carried.paymentId, carried.amountPaise - take, bill.saleId, bill.saleDate, bill.billNumber);
  }
  for (const tender of bill.tenders) {
    const before = customer ? await customerBalancePaise(tx, actor.organizationId, customer.partyId) : 0;
    const receiptNumber = `${org.receiptPrefix}-${await nextSequence(tx, actor.organizationId, 'RECEIPT')}`;
    const payment = await tx.payment.create({ data: {
      organizationId: actor.organizationId, receiptNumber, kind: 'RECEIPT',
      customerPartyId: customer?.partyId ?? null, customerName: customer?.name ?? COUNTER_COLLECTIONS,
      receivedOn: toDbDate(bill.saleDate), amount: fromPaise(tender.amountPaise), method: tender.method,
      referenceNumber: bill.billNumber, notes: `Collected against ${bill.billNumber}`, saleId: bill.saleId,
      previousOutstanding: fromPaise(before), newOutstanding: fromPaise(customer ? before - tender.amountPaise : 0),
      recordedByUserId: actor.userId, recordedByName: actor.name,
    } });
    await tx.paymentAllocation.create({ data: { organizationId: actor.organizationId, paymentId: payment.id, saleId: bill.saleId, amount: fromPaise(tender.amountPaise) } });
    if (customer) {
      await tx.customerLedgerEntry.create({ data: {
        organizationId: actor.organizationId, customerPartyId: customer.partyId, entryDate: toDbDate(bill.saleDate),
        type: 'PAYMENT', referenceNo: receiptNumber, saleId: bill.saleId, paymentId: payment.id,
        description: `Payment received via ${tender.method} against ${bill.billNumber}`, credit: fromPaise(tender.amountPaise),
      } });
    }
  }
  if (customer) await settleCustomer(tx, actor, customer.partyId, bill.saleId);
}

/** Gives stock back for every line of a bill (SALE_REVERSAL movements). */
export async function reverseBillStock(tx: Tx, actor: Actor, saleId: string, billNumber: string, date: string, reason: string): Promise<void> {
  const lines = await tx.saleItem.findMany({ where: { saleId }, orderBy: { lotMarkId: 'asc' } });
  for (const line of lines) {
    await applyStockChange(tx, actor, {
      lotMarkId: line.lotMarkId, type: 'SALE_REVERSAL', bagsDelta: line.bags, gramsDelta: toGrams(Number(line.weightKg)),
      referenceType: 'SALE', referenceId: saleId, movementDate: date, reason: `Bill ${billNumber} ${reason}`,
    });
  }
}

/** Locks a bill row for a state change. */
export async function lockSale(tx: Tx, actor: Actor, saleId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sales WHERE id = ${saleId}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
  if (!rows[0]) throw new NotFoundException('Sale not found');
  return tx.sale.findUniqueOrThrow({ where: { id: saleId } });
}

/**
 * Cancels a confirmed bill: stock returns, receipts allocated to it are released, the receivable is credited.
 * Released customer money becomes credit (applied to other dues or kept as advance); released counter money is
 * refunded unless the caller carries it to a replacement bill. Returns the released counter money.
 */
export async function cancelBill(tx: Tx, actor: Actor, org: Organization, saleId: string, reason: string, date: string, opts: { keepCounterMoney: boolean }) {
  const sale = await lockSale(tx, actor, saleId);
  if (sale.status !== 'CONFIRMED') throw new ConflictException(`${sale.billNumber} is ${sale.status.toLowerCase().replace('_', ' ')}`);
  await reverseBillStock(tx, actor, saleId, sale.billNumber, date, `cancelled: ${reason}`);
  const released = await releaseSaleAllocations(tx, actor, saleId);
  if (sale.customerPartyId) {
    await tx.customerLedgerEntry.create({ data: {
      organizationId: actor.organizationId, customerPartyId: sale.customerPartyId, entryDate: toDbDate(date), type: 'ADJUSTMENT',
      referenceNo: `${sale.billNumber}-CXL`, saleId, description: `Bill ${sale.billNumber} cancelled: ${reason}`, credit: sale.totalAmount,
    } });
  } else if (!opts.keepCounterMoney) {
    for (const r of released) await refund(tx, actor, org, r.paymentId, r.amountPaise, saleId, date, sale.billNumber);
  }
  await tx.sale.update({ where: { id: saleId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actor.name, cancelReason: reason } });
  return { sale, released: sale.customerPartyId || !opts.keepCounterMoney ? [] : released };
}

/** Money handed back at the counter: a negative receipt, so collections net it out. */
async function refund(tx: Tx, actor: Actor, org: Organization, paymentId: string, amountPaise: number, saleId: string, date: string, billNumber: string) {
  const original = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const receiptNumber = `${org.receiptPrefix}-${await nextSequence(tx, actor.organizationId, 'RECEIPT')}`;
  await tx.payment.create({ data: {
    organizationId: actor.organizationId, receiptNumber, kind: 'REFUND', customerPartyId: null, customerName: COUNTER_COLLECTIONS,
    receivedOn: toDbDate(date), amount: fromPaise(-amountPaise), method: original.method, referenceNumber: billNumber,
    notes: `Refund of ${original.receiptNumber} for ${billNumber}`, saleId, previousOutstanding: 0, newOutstanding: 0,
    recordedByUserId: actor.userId, recordedByName: actor.name,
  } });
}
