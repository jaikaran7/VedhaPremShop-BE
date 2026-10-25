// Ported verbatim from the frontend (src/utils/lot-differential.ts) so the server computes exactly what the screens used to compute in the browser.
// Only import paths differ. Keep the two in step; the ported tests below prove parity.
import type { Lot, Purchase, Sale, StockMovement } from './frontend-types';
import { chargesForSale } from './sale-charges';
import { roundMoney } from './settlement';

/** Remaining weight at or below this is treated as physically depleted. */
export const STOCK_WEIGHT_EPSILON_KG = 0.05;

export const LOT_COST_METHOD =
  'Landed cost is purchase amount plus purchase expenses and stock-receiving expenses. Each mark with one purchase rate is costed at that mark’s landed rate; mixed-rate marks fall back to the lot average. Selling Amali and market fee are split across lots by bag count on each invoice and are not added twice. Inward expenses are already inside landed cost.';

export type LotProgressStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';

export interface LotOutgoingLine {
  saleId: string;
  billNumber: string;
  customerName: string;
  date: string;
  markCode: string;
  bags: number;
  weightKg: number;
  ratePerKg: number;
  productAmount: number;
  amali: number;
  marketFee: number;
  lineInvoiceAmount: number;
}

export interface LotDifferentialRow {
  lotId: string;
  lotNumber: string;
  vendorId: string;
  vendorName: string;
  purchaseDate: string | null;
  vendorBill: string | null;
  initialBags: number;
  incomingWeightKg: number;
  outgoingBags: number;
  outgoingWeightKg: number;
  remainingBags: number;
  remainingWeightKg: number;
  adjustmentBags: number;
  adjustmentWeightKg: number;
  purchaseRate: number | null;
  purchaseAmount: number | null;
  purchaseCost: number | null;
  /** Unrounded landed cost per purchased KG. Profit must use this rate, not a second formula. */
  landedCostPerKg: number | null;
  otherAllocatedExpenses: number | null;
  salesRealization: number;
  amali: number;
  marketFee: number;
  cogs: number | null;
  remainingInventoryCost: number | null;
  realizedProfit: number | null;
  estimatedProfit: number | null;
  status: LotProgressStatus;
  closureStatus: 'OPEN' | 'CLOSED';
  marks: string[];
  outgoingLines: LotOutgoingLine[];
  costNote: string;
}

export interface LotDifferentialReport {
  lots: LotDifferentialRow[];
  totalLots: number;
  lotsInProgress: number;
  lotsCompleted: number;
  lotsNotStarted: number;
  lotsWithRemainingStock: number;
  totalIncomingWeightKg: number;
  totalOutgoingWeightKg: number;
  remainingWeightKg: number;
  totalPurchaseCost: number | null;
  totalSalesRealization: number;
  realizedProfit: number | null;
  estimatedProfit: number | null;
  costMethod: string;
}

interface BuildInput {
  lots: Lot[];
  purchases: Purchase[];
  sales: Sale[];
  stockMovements: StockMovement[];
}

function sameLot(left: string, right: string) {
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}

function depleted(bags: number, weightKg: number) {
  return bags <= 0 && weightKg <= STOCK_WEIGHT_EPSILON_KG;
}

function receivingExpensesOf(purchase: Purchase) {
  return purchase.receiving?.expenses.reduce((sum, expense) => sum + expense.amount, 0) ?? 0;
}

function inwardExpensesOf(purchases: Purchase[]) {
  return purchases.reduce((sum, purchase) => sum + purchase.totalExpenses + receivingExpensesOf(purchase), 0);
}

/** Landed ₹/kg by mark. Mixed-rate marks use the lot average because sales are not tagged to a cost. */
export function landedCostPerKgByMark(
  purchases: Purchase[],
  inwardExpenses: number,
  fallbackPerKg: number | null,
) {
  const marks = new Map<string, { amount: number; kg: number; rates: string[] }>();
  purchases.forEach((purchase) => {
    purchase.items.forEach((item) => {
      const key = item.markCode.trim().toUpperCase();
      const current = marks.get(key) ?? { amount: 0, kg: 0, rates: [] };
      current.amount += item.totalAmount;
      current.kg += item.weightKg;
      const rate = String(item.ratePerKg);
      if (!current.rates.includes(rate)) current.rates.push(rate);
      marks.set(key, current);
    });
  });
  const receivedKg = [...marks.values()].reduce((sum, mark) => sum + mark.kg, 0);
  const result = new Map<string, number | null>();
  marks.forEach((mark, key) => {
    if (mark.kg <= 0) {
      result.set(key, fallbackPerKg);
      return;
    }
    const share = receivedKg > 0 ? inwardExpenses * (mark.kg / receivedKg) : 0;
    result.set(key, mark.rates.length === 1 ? (mark.amount + share) / mark.kg : fallbackPerKg);
  });
  return result;
}

function allocateByBags(total: number, shares: { key: string; bags: number }[]) {
  const result = new Map<string, number>();
  const bagTotal = shares.reduce((sum, share) => sum + share.bags, 0);
  if (bagTotal <= 0 || total === 0) {
    shares.forEach((share) => result.set(share.key, 0));
    return result;
  }
  let allocated = 0;
  shares.forEach((share, index) => {
    if (index === shares.length - 1) {
      result.set(share.key, roundMoney(total - allocated));
      return;
    }
    const portion = roundMoney(total * (share.bags / bagTotal));
    allocated = roundMoney(allocated + portion);
    result.set(share.key, portion);
  });
  return result;
}

function lotStatus(input: {
  initialBags: number;
  initialWeightKg: number;
  remainingBags: number;
  remainingWeightKg: number;
  outgoingBags: number;
  outgoingWeightKg: number;
  adjustmentWeightKg: number;
}): LotProgressStatus {
  if (depleted(input.remainingBags, input.remainingWeightKg)) return 'COMPLETED';
  const untouched =
    input.outgoingBags === 0 &&
    input.outgoingWeightKg <= STOCK_WEIGHT_EPSILON_KG &&
    Math.abs(input.adjustmentWeightKg) <= STOCK_WEIGHT_EPSILON_KG &&
    input.remainingBags === input.initialBags &&
    Math.abs(input.remainingWeightKg - input.initialWeightKg) <= STOCK_WEIGHT_EPSILON_KG;
  return untouched ? 'NOT_STARTED' : 'IN_PROGRESS';
}

export function buildLotDifferential(input: BuildInput): LotDifferentialReport {
  const confirmedSales = input.sales.filter((sale) => sale.status === 'CONFIRMED');
  const purchasesByLot = new Map<string, Purchase[]>();
  input.purchases.forEach((purchase) => {
    if (purchase.receiptStatus === 'PENDING_RECEIPT') return;
    const key = purchase.lotNumber.trim().toUpperCase();
    purchasesByLot.set(key, [...(purchasesByLot.get(key) ?? []), purchase]);
  });

  const feeBySaleLot = new Map<string, { amali: number; marketFee: number }>();
  confirmedSales.forEach((sale) => {
    const charges = chargesForSale(sale);
    const grouped = new Map<string, number>();
    sale.items.forEach((item) => {
      const key = item.lotNumber.trim().toUpperCase();
      grouped.set(key, (grouped.get(key) ?? 0) + item.bags);
    });
    const shares = [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, bags]) => ({ key, bags }));
    const amaliShares = allocateByBags(charges.amaliAmount, shares);
    const marketShares = allocateByBags(charges.marketFeeAmount, shares);
    shares.forEach((share) => {
      feeBySaleLot.set(`${sale.id}::${share.key}`, {
        amali: amaliShares.get(share.key) ?? 0,
        marketFee: marketShares.get(share.key) ?? 0,
      });
    });
  });

  const lots = input.lots.map((lot) => {
    const key = lot.lotNumber.trim().toUpperCase();
    const lotPurchases = purchasesByLot.get(key) ?? [];
    const purchaseGoods = lotPurchases.reduce(
      (sum, purchase) => sum + purchase.items.reduce((itemSum, item) => itemSum + item.totalAmount, 0),
      0,
    );
    const purchaseExpenses = inwardExpensesOf(lotPurchases);
    const purchaseWeight = lotPurchases.reduce(
      (sum, purchase) => sum + purchase.items.reduce((itemSum, item) => itemSum + item.weightKg, 0),
      0,
    );
    const hasPurchase = lotPurchases.length > 0 && purchaseWeight > 0;
    const landedCost = hasPurchase ? roundMoney(purchaseGoods + purchaseExpenses) : null;
    const costPerKg = hasPurchase ? landedCost! / purchaseWeight : null;
    const goodsRate = hasPurchase && purchaseWeight > 0 ? purchaseGoods / purchaseWeight : null;
    const markCostPerKg = landedCostPerKgByMark(lotPurchases, purchaseExpenses, costPerKg);

    const movements = input.stockMovements.filter((movement) => sameLot(movement.lotNumber, lot.lotNumber));
    const adjustmentWeightKg = movements.reduce((sum, movement) => {
      if (movement.type === 'ADJUSTMENT_ADD') return sum + movement.weightKg;
      if (movement.type === 'ADJUSTMENT_SUB') return sum - movement.weightKg;
      return sum;
    }, 0);
    const adjustmentBags = movements.reduce((sum, movement) => {
      if (movement.type === 'ADJUSTMENT_ADD') return sum + movement.bags;
      if (movement.type === 'ADJUSTMENT_SUB') return sum - movement.bags;
      return sum;
    }, 0);

    const outgoingLines: LotOutgoingLine[] = [];
    confirmedSales.forEach((sale) => {
      const lotItems = sale.items.filter((item) => sameLot(item.lotNumber, lot.lotNumber));
      if (lotItems.length === 0) return;
      const fees = feeBySaleLot.get(`${sale.id}::${key}`) ?? { amali: 0, marketFee: 0 };
      const lineShares = lotItems.map((item) => ({ key: item.id, bags: item.bags }));
      const lineAmali = allocateByBags(fees.amali, lineShares);
      const lineMarket = allocateByBags(fees.marketFee, lineShares);
      lotItems.forEach((item) => {
        const amali = lineAmali.get(item.id) ?? 0;
        const marketFee = lineMarket.get(item.id) ?? 0;
        outgoingLines.push({
          saleId: sale.id,
          billNumber: sale.billNumber,
          customerName: sale.customerName,
          date: sale.date,
          markCode: item.markCode,
          bags: item.bags,
          weightKg: item.weightKg,
          ratePerKg: item.ratePerKg,
          productAmount: roundMoney(item.amount),
          amali,
          marketFee,
          lineInvoiceAmount: roundMoney(item.amount + amali + marketFee),
        });
      });
    });

    const outgoingBags = outgoingLines.reduce((sum, line) => sum + line.bags, 0);
    const outgoingWeightKg = outgoingLines.reduce((sum, line) => sum + line.weightKg, 0);
    const salesRealization = roundMoney(outgoingLines.reduce((sum, line) => sum + line.productAmount, 0));
    const amali = roundMoney(outgoingLines.reduce((sum, line) => sum + line.amali, 0));
    const marketFee = roundMoney(outgoingLines.reduce((sum, line) => sum + line.marketFee, 0));
    const sellingFees = roundMoney(amali + marketFee);
    const soldShare = hasPurchase && purchaseWeight > 0 ? outgoingWeightKg / purchaseWeight : 0;
    const otherAllocatedExpenses = hasPurchase
      ? roundMoney(purchaseExpenses * (depleted(lot.remainingBags, lot.remainingWeightKg) ? 1 : soldShare))
      : null;
    const cogs = costPerKg == null
      ? null
      : roundMoney(outgoingLines.reduce((sum, line) => {
        const rate = markCostPerKg.get(line.markCode.trim().toUpperCase()) ?? costPerKg;
        return sum + line.weightKg * (rate ?? 0);
      }, 0));
    const remainingInventoryCost = landedCost == null || costPerKg == null
      ? null
      : roundMoney(Math.max(0, landedCost - (cogs ?? 0) + adjustmentWeightKg * costPerKg));
    const status = lotStatus({
      initialBags: lot.totalBags,
      initialWeightKg: lot.totalWeightKg,
      remainingBags: lot.remainingBags,
      remainingWeightKg: lot.remainingWeightKg,
      outgoingBags,
      outgoingWeightKg,
      adjustmentWeightKg,
    });
    const realizedProfit = cogs == null || outgoingWeightKg <= STOCK_WEIGHT_EPSILON_KG
      ? null
      : roundMoney(salesRealization - cogs - sellingFees);
    const estimatedProfit = status === 'COMPLETED' ? realizedProfit : null;
    const firstPurchase = lotPurchases[0];

    return {
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      vendorId: lot.vendorId,
      vendorName: lot.vendorName,
      purchaseDate: firstPurchase?.date ?? lot.arrivalDate,
      vendorBill: firstPurchase?.billNumber ?? lot.purchaseBillNo,
      initialBags: lot.totalBags,
      incomingWeightKg: lot.totalWeightKg,
      outgoingBags,
      outgoingWeightKg,
      remainingBags: lot.remainingBags,
      remainingWeightKg: lot.remainingWeightKg,
      adjustmentBags,
      adjustmentWeightKg,
      purchaseRate: goodsRate == null ? null : roundMoney(goodsRate),
      purchaseAmount: hasPurchase ? roundMoney(purchaseGoods) : null,
      purchaseCost: landedCost,
      landedCostPerKg: costPerKg,
      otherAllocatedExpenses,
      salesRealization,
      amali,
      marketFee,
      cogs,
      remainingInventoryCost,
      realizedProfit,
      estimatedProfit,
      status,
      closureStatus: lot.status === 'EXHAUSTED' ? 'CLOSED' as const : 'OPEN' as const,
      marks: lot.marks.map((mark) => mark.markCode),
      outgoingLines,
      costNote: hasPurchase
        ? LOT_COST_METHOD
        : 'Purchase cost is not available for this lot, so profit is not calculated.',
    } satisfies LotDifferentialRow;
  });

  const knownCosts = lots.map((row) => row.purchaseCost).filter((cost): cost is number => cost != null);
  const knownProfits = lots.map((row) => row.realizedProfit).filter((profit): profit is number => profit != null);
  const completedProfits = lots
    .filter((row) => row.status === 'COMPLETED' && row.estimatedProfit != null)
    .map((row) => row.estimatedProfit as number);

  return {
    lots,
    totalLots: lots.length,
    lotsInProgress: lots.filter((row) => row.status === 'IN_PROGRESS').length,
    lotsCompleted: lots.filter((row) => row.status === 'COMPLETED').length,
    lotsNotStarted: lots.filter((row) => row.status === 'NOT_STARTED').length,
    lotsWithRemainingStock: lots.filter((row) => !depleted(row.remainingBags, row.remainingWeightKg)).length,
    totalIncomingWeightKg: lots.reduce((sum, row) => sum + row.incomingWeightKg, 0),
    totalOutgoingWeightKg: lots.reduce((sum, row) => sum + row.outgoingWeightKg, 0),
    remainingWeightKg: lots.reduce((sum, row) => sum + row.remainingWeightKg, 0),
    totalPurchaseCost: knownCosts.length ? roundMoney(knownCosts.reduce((sum, cost) => sum + cost, 0)) : null,
    totalSalesRealization: roundMoney(lots.reduce((sum, row) => sum + row.salesRealization, 0)),
    realizedProfit: knownProfits.length ? roundMoney(knownProfits.reduce((sum, profit) => sum + profit, 0)) : null,
    estimatedProfit: completedProfits.length && lots.every((row) => row.status !== 'IN_PROGRESS' && row.status !== 'NOT_STARTED')
      ? roundMoney(completedProfits.reduce((sum, profit) => sum + profit, 0))
      : null,
    costMethod: LOT_COST_METHOD,
  };
}

export function lotStatusLabel(status: LotProgressStatus) {
  if (status === 'NOT_STARTED') return 'Not Started';
  if (status === 'COMPLETED') return 'Completed';
  return 'In Progress';
}
