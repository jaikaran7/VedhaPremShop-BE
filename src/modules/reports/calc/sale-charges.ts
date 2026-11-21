// Ported verbatim from the frontend (src/utils/sale-charges.ts) so the server computes exactly what the screens used to compute in the browser.
// Only import paths differ. Keep the two in step; the ported tests below prove parity.
import type { Sale, SaleChargeSettings, SaleChargeSnapshot } from './frontend-types';
import { roundMoney } from './settlement';

export const DEFAULT_SALE_CHARGE_SETTINGS: SaleChargeSettings = {
  amaliPerBag: 20,
  marketFeePerBag: 10,
  marketFeeBasis: 'BILL_PERCENT',
  marketFeePercent: 1,
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
  const exactMarketFee = marketFeeFor(bagCount, productSubtotal, input.settings);
  const exactTotal = roundMoney(productSubtotal + amaliAmount + exactMarketFee + otherCharges);
  const finalInvoiceAmount = roundUpRupee(exactTotal);
  const lift = roundMoney(finalInvoiceAmount - exactTotal);
  const ontoFee = input.settings.marketFeeEnabled;
  const marketFeeAmount = roundMoney(exactMarketFee + (ontoFee ? lift : 0));
  const billedOther = roundMoney(otherCharges + (ontoFee ? 0 : lift));
  const totalAdditionalCharges = roundMoney(amaliAmount + marketFeeAmount + billedOther);
  return {
    amaliPerBag: input.settings.amaliPerBag,
    marketFeePerBag: input.settings.marketFeePerBag,
    marketFeeBasis: input.settings.marketFeeBasis,
    marketFeePercent: input.settings.marketFeePercent,
    amaliEnabled: input.settings.amaliEnabled,
    marketFeeEnabled: input.settings.marketFeeEnabled,
    bagCount,
    amaliAmount,
    marketFeeAmount,
    otherCharges: billedOther,
    productSubtotal,
    totalAdditionalCharges,
    finalInvoiceAmount,
  };
}

function roundUpRupee(amount: number): number {
  const paise = Math.round(roundMoney(amount) * 100);
  if (paise % 100 === 0) return paise / 100;
  return Math.floor(paise / 100) + 1;
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
    marketFeeBasis: 'PER_BAG',
    marketFeePercent: 0,
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

function marketFeeFor(bagCount: number, productSubtotal: number, settings: SaleChargeSettings): number {
  if (!settings.marketFeeEnabled) return 0;
  if (settings.marketFeeBasis === 'BILL_PERCENT') {
    const paise = Math.round(productSubtotal * 100);
    const hundredths = Math.round(settings.marketFeePercent * 100);
    return Math.round((paise * hundredths) / 10_000) / 100;
  }
  return roundMoney(bagCount * settings.marketFeePerBag);
}
