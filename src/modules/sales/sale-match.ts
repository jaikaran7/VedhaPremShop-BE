import { fromDbDate } from '../../common/dates';

/** Same customer, same day, same lines and same rupee total is treated as a possible second click of one bill. */
export type SaleLineMatch = {
  lotNumber: string;
  markCode: string;
  bags?: number;
  weightKg?: number;
  ratePerKg: number;
  bagWeights?: readonly { weightKg: number }[];
};

export type ExistingSaleSummary = {
  id: string;
  billNumber: string;
  date: string;
  customerName: string;
  totalAmount: number;
  items: { lotNumber: string; markCode: string; bags: number; weightKg: number; ratePerKg: number }[];
};

export function saleItemsFingerprint(items: readonly SaleLineMatch[]): string {
  return items
    .map((item) => {
      const bags = item.bagWeights?.length ?? item.bags ?? 0;
      const weightKg = item.bagWeights
        ? item.bagWeights.reduce((sum, bag) => sum + Number(bag.weightKg), 0)
        : Number(item.weightKg ?? 0);
      return [
        item.lotNumber.trim().toUpperCase(),
        item.markCode.trim().toUpperCase(),
        bags,
        weightKg.toFixed(3),
        Number(item.ratePerKg).toFixed(2),
      ].join('|');
    })
    .sort()
    .join(';');
}

export function sameSaleLines(left: readonly SaleLineMatch[], right: readonly SaleLineMatch[]): boolean {
  return saleItemsFingerprint(left) === saleItemsFingerprint(right);
}

export function summarizeExistingSale(sale: {
  id: string;
  billNumber: string;
  saleDate: Date;
  customerName: string;
  totalAmount: { toString(): string } | number;
  items: { lotNumber: string; markCode: string; bags: number; weightKg: { toString(): string } | number; ratePerKg: { toString(): string } | number }[];
}): ExistingSaleSummary {
  return {
    id: sale.id,
    billNumber: sale.billNumber,
    date: fromDbDate(sale.saleDate),
    customerName: sale.customerName,
    totalAmount: Number(sale.totalAmount),
    items: sale.items.map((line) => ({
      lotNumber: line.lotNumber,
      markCode: line.markCode,
      bags: line.bags,
      weightKg: Number(line.weightKg),
      ratePerKg: Number(line.ratePerKg),
    })),
  };
}
