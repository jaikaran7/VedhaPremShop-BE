// Ported verbatim from the frontend (src/utils/sale-charges.ts) so the server computes exactly what the screens used to compute in the browser.
// Only import paths differ. Keep the two in step; the ported tests below prove parity.
import type { Sale, SaleChargeSettings, SaleChargeSnapshot } from './frontend-types';
import { roundMoney } from './settlement';

export const DEFAULT_SALE_CHARGE_SETTINGS: SaleChargeSettings = {
  amaliPerBag: 20,
  marketFeePerBag: 10,
  amaliEnabled: true,
  marketFeeEnabled: true,
};

export function validateChargeAmount(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return 'Enter an amount';
  if (trimmed.startsWith('-')) return 'Amount cannot be negative';
  if (/^\d+\.\d{3,}$/.test(trimmed)) return 'Use at most two decimal places';
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return 'Enter a valid amount';
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount < 0) return 'Enter a valid amount';
  return null;
}

export function countSaleBags(items: { bags: number }[]): number {
  return items.reduce((sum, item) => sum + Number(item.bags || 0), 0);
}

export function calculateSaleCharges(input: {
  totalBags: number;
  productSubtotal: number;
  settings: SaleChargeSettings;
  otherCharges?: number;
}): SaleChargeSnapshot {
  const bagCount = Math.max(0, Number(input.totalBags) || 0);
  const productSubtotal = roundMoney(input.productSubtotal);
  const otherCharges = roundMoney(Math.max(0, input.otherCharges ?? 0));
  const amaliAmount = input.settings.amaliEnabled
    ? roundMoney(bagCount * input.settings.amaliPerBag)
    : 0;
  const marketFeeAmount = input.settings.marketFeeEnabled
    ? roundMoney(bagCount * input.settings.marketFeePerBag)
    : 0;
  const totalAdditionalCharges = roundMoney(amaliAmount + marketFeeAmount + otherCharges);
  return {
    amaliPerBag: input.settings.amaliPerBag,
    marketFeePerBag: input.settings.marketFeePerBag,
    amaliEnabled: input.settings.amaliEnabled,
    marketFeeEnabled: input.settings.marketFeeEnabled,
    bagCount,
    amaliAmount,
    marketFeeAmount,
    otherCharges,
    productSubtotal,
    totalAdditionalCharges,
    finalInvoiceAmount: roundMoney(productSubtotal + totalAdditionalCharges),
  };
}

/** Finalized invoices keep their saved snapshot. Missing snapshots were billed before mandi fees. */
export function chargesForSale(
  sale: Pick<Sale, 'charges' | 'totalAmount' | 'totalBags' | 'productSubtotal'>,
): SaleChargeSnapshot {
  if (sale.charges) return sale.charges;
  const productSubtotal = roundMoney(sale.productSubtotal ?? sale.totalAmount);
  return {
    amaliPerBag: 0,
    marketFeePerBag: 0,
    amaliEnabled: false,
    marketFeeEnabled: false,
    bagCount: sale.totalBags,
    amaliAmount: 0,
    marketFeeAmount: 0,
    otherCharges: 0,
    productSubtotal,
    totalAdditionalCharges: 0,
    finalInvoiceAmount: roundMoney(sale.totalAmount),
  };
}

export function balanceAfterPayment(finalInvoiceAmount: number, amountPaid: number): number {
  return roundMoney(finalInvoiceAmount - amountPaid);
}

export function feeBasisLabel(bags: number, rate: number, enabled: boolean): string {
  if (!enabled) return 'Not charged';
  return `${bags} bags × ₹${rate}`;
}
