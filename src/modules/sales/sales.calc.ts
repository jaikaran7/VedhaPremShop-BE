import { UnprocessableEntityException } from '@nestjs/common';
import { addCalendarDays } from '../../common/dates';
import { lineAmountPaise, toGrams, toPaise } from '../../common/money';

export type PaymentMethod = 'CASH' | 'UPI' | 'QR' | 'BANK_TRANSFER' | 'CARD' | 'OTHER' | 'CHEQUE';
export type PaymentStatus = 'PAID' | 'PARTIAL' | 'CREDIT';

export interface LineInput {
  lotNumber: string;
  markCode: string;
  ratePerKg: number;
  bagWeights: { bagNumber: number; weightKg: number }[];
}

export interface PricedLine extends LineInput {
  bags: number;
  grams: number;
  ratePaise: number;
  amountPaise: number;
}

export interface ChargeSettings {
  amaliPerBag: number;
  marketFeePerBag: number;
  amaliEnabled: boolean;
  marketFeeEnabled: boolean;
}

export interface BillTotals {
  lines: PricedLine[];
  totalBags: number;
  totalGrams: number;
  subtotalPaise: number;
  amaliPaise: number;
  marketFeePaise: number;
  totalPaise: number;
}

/** Same arithmetic as the frontend (trading.saleLineAmount + sale-charges.calculateSaleCharges), in integers. */
export function priceBill(items: LineInput[], settings: ChargeSettings): BillTotals {
  const lines = items.map((item) => {
    const grams = item.bagWeights.reduce((sum, bag) => sum + toGrams(bag.weightKg), 0);
    const ratePaise = toPaise(item.ratePerKg);
    return { ...item, bags: item.bagWeights.length, grams, ratePaise, amountPaise: lineAmountPaise(grams, ratePaise) };
  });
  const totalBags = lines.reduce((sum, line) => sum + line.bags, 0);
  const totalGrams = lines.reduce((sum, line) => sum + line.grams, 0);
  const subtotalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
  const amaliPaise = settings.amaliEnabled ? totalBags * toPaise(settings.amaliPerBag) : 0;
  const marketFeePaise = settings.marketFeeEnabled ? totalBags * toPaise(settings.marketFeePerBag) : 0;
  return { lines, totalBags, totalGrams, subtotalPaise, amaliPaise, marketFeePaise, totalPaise: subtotalPaise + amaliPaise + marketFeePaise };
}

/** Lines that hit the same lot and mark draw on one stock row; deduct them together. */
export function stockDraws(lines: PricedLine[]): { lotNumber: string; markCode: string; bags: number; grams: number }[] {
  const byKey = new Map<string, { lotNumber: string; markCode: string; bags: number; grams: number }>();
  for (const line of lines) {
    const key = `${line.lotNumber.trim().toUpperCase()}|${line.markCode.trim().toUpperCase()}`;
    const draw = byKey.get(key) ?? { lotNumber: line.lotNumber.trim(), markCode: line.markCode.trim(), bags: 0, grams: 0 };
    draw.bags += line.bags;
    draw.grams += line.grams;
    byKey.set(key, draw);
  }
  return [...byKey.values()];
}

export interface Settlement {
  tenders: { method: PaymentMethod; amountPaise: number }[];
  paidPaise: number;
  balancePaise: number;
  paymentStatus: PaymentStatus;
  paymentType: string;
  creditDays: number | null;
  dueDate: string | null;
}

/**
 * Server version of the frontend's resolveSettlement: what is paid now and what goes on credit.
 * `carriedPaise` is money already received for the bill being replaced (rebill of a counter sale).
 * A customer's advance is applied after posting, so it is not part of this check.
 */
export function settle(input: {
  totalPaise: number;
  tenders: { method: PaymentMethod; amount: number }[];
  creditDays: number | null | undefined;
  defaultCreditDays?: number;
  saleDate: string;
  hasCustomer: boolean;
  carriedPaise?: number;
}): Settlement {
  const fail = (message: string): never => {
    throw new UnprocessableEntityException(message);
  };
  if (input.totalPaise <= 0) fail('The bill total must be greater than zero.');
  const tenders = input.tenders
    .map((tender) => ({ method: tender.method, amountPaise: toPaise(tender.amount) }))
    .filter((tender) => tender.amountPaise > 0);
  const carried = Math.min(input.carriedPaise ?? 0, input.totalPaise);
  const tenderedPaise = tenders.reduce((sum, tender) => sum + tender.amountPaise, 0);
  if (tenderedPaise > input.totalPaise - carried) fail('Payment total cannot exceed the bill total.');
  const paidPaise = tenderedPaise + carried;
  const balancePaise = input.totalPaise - paidPaise;
  if (balancePaise > 0 && !input.hasCustomer) fail('A counter sale has no credit account. Collect the full amount.');

  const paymentStatus: PaymentStatus = balancePaise === 0 ? 'PAID' : paidPaise === 0 ? 'CREDIT' : 'PARTIAL';
  const paymentType = paymentStatus !== 'PAID' ? paymentStatus : tenders.length === 1 && carried === 0 ? tenders[0]!.method : 'SPLIT';
  const creditDays = balancePaise > 0 ? Math.max(0, input.creditDays ?? input.defaultCreditDays ?? 0) : null;
  return {
    tenders,
    paidPaise,
    balancePaise,
    paymentStatus,
    paymentType,
    creditDays,
    dueDate: creditDays == null ? null : addCalendarDays(input.saleDate, creditDays),
  };
}

export function paymentStatusFor(totalPaise: number, paidPaise: number): PaymentStatus {
  if (paidPaise >= totalPaise) return 'PAID';
  return paidPaise === 0 ? 'CREDIT' : 'PARTIAL';
}
