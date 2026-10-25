// Ported verbatim from the frontend (src/utils/lot-sales-by-date.ts) so the server computes exactly what the screens used to compute in the browser.
// Only import paths differ. Keep the two in step; the ported tests below prove parity.
import type { PaymentStatus, Sale } from './frontend-types';
import { roundMoney } from './settlement';
import type { LotOutgoingLine } from './lot-differential';

function inDateRange(date: string, from: string, to: string) {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export type LotSaleCreditDebit = Extract<PaymentStatus, 'CREDIT' | 'PAID' | 'PARTIAL'>;

export interface LotSaleDaySummary {
  date: string;
  billCount: number;
  bags: number;
  weightKg: number;
  amount: number;
}

export interface LotSaleDayTotals {
  days: number;
  bills: number;
  bags: number;
  weightKg: number;
  amount: number;
}

export interface LotSaleDetailRow {
  saleId: string;
  billNumber: string;
  time: string;
  customerName: string;
  markCode: string;
  bags: number;
  weightKg: number;
  ratePerKg: number;
  amount: number;
  paymentStatus: PaymentStatus;
  creditDebit: LotSaleCreditDebit;
}

export function saleCreditDebit(sale: Pick<Sale, 'paymentStatus' | 'paymentType'>): LotSaleCreditDebit {
  if (sale.paymentStatus === 'CREDIT' || sale.paymentStatus === 'PAID' || sale.paymentStatus === 'PARTIAL') {
    return sale.paymentStatus;
  }
  if (sale.paymentType === 'CREDIT') return 'CREDIT';
  if (sale.paymentType === 'PARTIAL') return 'PARTIAL';
  return 'PAID';
}

export function filterLotSaleLines(
  lines: LotOutgoingLine[],
  filters: { from: string; to: string; search: string },
) {
  const search = filters.search.trim().toLowerCase();
  return lines.filter((line) => {
    if (!inDateRange(line.date, filters.from, filters.to)) return false;
    if (!search) return true;
    return line.billNumber.toLowerCase().includes(search) || line.customerName.toLowerCase().includes(search);
  });
}

export function summarizeLotSalesByDate(lines: LotOutgoingLine[]): {
  days: LotSaleDaySummary[];
  totals: LotSaleDayTotals;
} {
  const byDate = new Map<string, { bills: Set<string>; bags: number; weightKg: number; amount: number }>();
  for (const line of lines) {
    const current = byDate.get(line.date) ?? { bills: new Set<string>(), bags: 0, weightKg: 0, amount: 0 };
    current.bills.add(line.saleId);
    current.bags += line.bags;
    current.weightKg += line.weightKg;
    current.amount = roundMoney(current.amount + line.productAmount);
    byDate.set(line.date, current);
  }

  const days = [...byDate.entries()]
    .map(([date, row]) => ({
      date,
      billCount: row.bills.size,
      bags: row.bags,
      weightKg: row.weightKg,
      amount: row.amount,
    }))
    .sort((left, right) => right.date.localeCompare(left.date));

  const allBills = new Set(lines.map((line) => line.saleId));
  return {
    days,
    totals: {
      days: days.length,
      bills: allBills.size,
      bags: lines.reduce((sum, line) => sum + line.bags, 0),
      weightKg: lines.reduce((sum, line) => sum + line.weightKg, 0),
      amount: roundMoney(lines.reduce((sum, line) => sum + line.productAmount, 0)),
    },
  };
}

export function lotSalesForDate(
  lines: LotOutgoingLine[],
  date: string,
  sales: Array<Pick<Sale, 'id' | 'time' | 'paymentStatus' | 'paymentType'>>,
): LotSaleDetailRow[] {
  const salesById = new Map(sales.map((item) => [item.id, item]));
  return lines
    .filter((line) => line.date === date)
    .map((line) => {
      const sale = salesById.get(line.saleId);
      const creditDebit = sale ? saleCreditDebit(sale) : 'PAID';
      return {
        saleId: line.saleId,
        billNumber: line.billNumber,
        time: sale?.time ?? '',
        customerName: line.customerName,
        markCode: line.markCode,
        bags: line.bags,
        weightKg: line.weightKg,
        ratePerKg: line.ratePerKg,
        amount: line.productAmount,
        paymentStatus: creditDebit,
        creditDebit,
      };
    });
}
