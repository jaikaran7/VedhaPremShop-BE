// Ported verbatim from the frontend (src/utils/report-differential.ts) so the server computes exactly what the screens used to compute in the browser.
// Only import paths differ. Keep the two in step; the ported tests below prove parity.
import type { Lot, Product, Purchase, Sale, SaleItem, StockMovement } from './frontend-types';
import { buildLotDifferential, landedCostPerKgByMark, STOCK_WEIGHT_EPSILON_KG, type LotDifferentialRow, type LotOutgoingLine } from './lot-differential';
import { lotBelongsToProduct, ONIONS_PRODUCT_CODE } from './products';
import { roundMoney } from './settlement';

/**
 * Bag-weight ranges and unusual-margin thresholds are not stored in Settings.
 * Those rules stay inactive until a range exists. They are not given a guessed cutoff.
 */
export const UNCONFIGURED_REVIEW_RULES = [
  'Average bag weight is not flagged because Settings has no expected bag-weight range.',
  'Unusual margin is not flagged because Settings has no margin threshold.',
] as const;

export type DifferenceStatus = 'NORMAL' | 'POSITIVE' | 'NEGATIVE' | 'NEEDS_REVIEW';

export interface QuantityGap {
  /**
   * Sign convention: recorded remaining − calculated balance.
   * Calculated balance = receipts + approved inbound adjustments − sales − approved outbound adjustments.
   * Positive: recorded stock is higher than the movement formula. Negative: recorded stock is lower.
   * This is a quantity review signal, not a financial loss and not proof that stock is missing.
   */
  bags: number;
  weightKg: number;
}

export interface MarkBreakdown {
  markCode: string;
  purchaseBags: number;
  purchaseKg: number;
  /** One exact purchase rate. Null when this mark was bought at more than one rate. */
  purchaseRate: number | null;
  purchaseRates: number[];
  purchaseAmount: number | null;
  soldBags: number;
  soldKg: number;
  salesAmount: number;
  balanceBags: number;
  balanceKg: number;
  bagDifference: number | null;
  weightDifferenceKg: number | null;
  profit: number | null;
}

export interface CostBreakdown {
  /** Exact normalized ₹/kg. Display rounding is not the group key. */
  rate: number;
  marks: string[];
  purchaseBags: number;
  purchaseKg: number;
  purchaseAmount: number;
  soldBags: number | null;
  soldKg: number | null;
  salesAmount: number | null;
  balanceBags: number | null;
  balanceKg: number | null;
  bagDifference: number | null;
  weightDifferenceKg: number | null;
  profit: number | null;
  /** Sales are not stored against a cost, so a mark bought at two rates cannot be split. */
  salesUnallocated: boolean;
}

export interface ReviewAlert {
  id: string;
  saleId: string | null;
  href: string | null;
  billNumber: string;
  date: string;
  customerName: string;
  lotNumber: string;
  markCode: string;
  bags: number | null;
  weightKg: number | null;
  averageKgPerBag: number | null;
  ratePerKg: number | null;
  amount: number | null;
  reason: string;
}

export interface LotActivityEntry {
  id: string;
  date: string;
  time: string;
  kind: 'Purchase' | 'Receiving' | 'Sale' | 'Adjustment' | 'Opening stock';
  title: string;
  detail: string;
  markCode: string | null;
  href: string | null;
}

export interface DifferentialLot {
  lotId: string;
  lotNumber: string;
  productId: string | null;
  productName: string;
  date: string;
  vendorName: string;
  arrivedBags: number;
  arrivedKg: number;
  soldBags: number;
  soldKg: number;
  balanceBags: number;
  balanceKg: number;
  adjustmentBags: number;
  adjustmentWeightKg: number;
  purchaseAmount: number | null;
  salesAmount: number;
  purchaseExpenses: number | null;
  receivingExpenses: number | null;
  /** Expenses already inside landed cost. Shown once and not subtracted again. */
  expenses: number | null;
  bagDifference: number | null;
  weightDifferenceKg: number | null;
  profit: number | null;
  remainingInventoryCost: number | null;
  status: DifferenceStatus;
  reviewCount: number;
  marks: MarkBreakdown[];
  costs: CostBreakdown[];
  alerts: ReviewAlert[];
  activity: LotActivityEntry[];
  base: LotDifferentialRow;
}

export interface DifferentialReport {
  lots: DifferentialLot[];
  unconfiguredRules: readonly string[];
}

interface BuildInput {
  lots: Lot[];
  purchases: Purchase[];
  sales: Sale[];
  stockMovements: StockMovement[];
  products: Product[];
}

interface MarkMath {
  markCode: string;
  receivedBags: number;
  receivedKg: number;
  soldBags: number;
  soldKg: number;
  salesAmount: number;
  fees: number;
  recordedBags: number;
  recordedKg: number;
  adjustmentInBags: number;
  adjustmentOutBags: number;
  adjustmentInKg: number;
  adjustmentOutKg: number;
  rates: number[];
  purchaseAmount: number | null;
}

function sameCode(left: string, right: string) {
  return left.trim().toUpperCase() === right.trim().toUpperCase();
}

function signedAdjustment(movement: StockMovement) {
  if (movement.type === 'ADJUSTMENT_ADD') return { bags: movement.bags, weightKg: movement.weightKg };
  if (movement.type === 'ADJUSTMENT_SUB') return { bags: -movement.bags, weightKg: -movement.weightKg };
  return null;
}

/** Difference is recorded remaining minus calculated balance. See QuantityGap. */
function gap(recordedBags: number, recordedKg: number, formulaBags: number, formulaKg: number): QuantityGap {
  return {
    bags: recordedBags - formulaBags,
    weightKg: roundKg(recordedKg - formulaKg),
  };
}

function roundKg(value: number) {
  return Math.round(value * 1000) / 1000;
}

function formulaBalance(input: {
  receivedBags: number;
  receivedKg: number;
  soldBags: number;
  soldKg: number;
  inBags: number;
  outBags: number;
  inKg: number;
  outKg: number;
}) {
  return {
    bags: input.receivedBags + input.inBags - input.soldBags - input.outBags,
    weightKg: input.receivedKg + input.inKg - input.soldKg - input.outKg,
  };
}

function nearZeroKg(value: number) {
  return Math.abs(value) <= STOCK_WEIGHT_EPSILON_KG;
}

function productOf(lot: Lot, products: Product[]) {
  if (lot.productId) {
    const match = products.find((product) => product.id === lot.productId);
    return { id: match?.id ?? lot.productId, name: match?.name ?? 'Not available' };
  }
  const onions = products.find((product) => product.code === ONIONS_PRODUCT_CODE);
  return { id: onions?.id ?? null, name: onions?.name ?? 'Onions' };
}

function uniqueRates(rates: number[]) {
  const seen = new Set<string>();
  const unique: number[] = [];
  rates.forEach((rate) => {
    const key = rateKey(rate);
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(rate);
  });
  return unique;
}

/** Exact numeric identity. 48 and 48.5 stay apart even if a display rounds both. */
export function rateKey(rate: number) {
  return String(rate);
}

function confirmedItems(sales: Sale[], lotNumber: string) {
  const lines: { sale: Sale; item: SaleItem }[] = [];
  sales
    .filter((sale) => sale.status === 'CONFIRMED')
    .forEach((sale) => {
      sale.items.forEach((item) => {
        if (sameCode(item.lotNumber, lotNumber)) lines.push({ sale, item });
      });
    });
  return lines.sort((left, right) => {
    const date = left.sale.date.localeCompare(right.sale.date) || left.sale.time.localeCompare(right.sale.time);
    return date || left.item.id.localeCompare(right.item.id);
  });
}

function buildMarkMath(
  lot: Lot,
  purchases: Purchase[],
  lines: { sale: Sale; item: SaleItem }[],
  movements: StockMovement[],
  outgoing: LotOutgoingLine[],
): MarkMath[] {
  const codes = new Set<string>();
  lot.marks.forEach((mark) => codes.add(mark.markCode));
  lines.forEach((line) => codes.add(line.item.markCode));
  movements.forEach((movement) => codes.add(movement.markCode));
  purchases.forEach((purchase) => purchase.items.forEach((item) => codes.add(item.markCode)));

  return [...codes].sort((left, right) => left.localeCompare(right)).map((markCode) => {
    const mark = lot.marks.find((entry) => sameCode(entry.markCode, markCode));
    const purchaseItems = purchases.flatMap((purchase) => purchase.items.filter((item) => sameCode(item.markCode, markCode)));
    const sold = lines.filter((line) => sameCode(line.item.markCode, markCode));
    const fees = outgoing
      .filter((line) => sameCode(line.markCode, markCode))
      .reduce((sum, line) => sum + line.amali + line.marketFee, 0);
    let inBags = 0;
    let outBags = 0;
    let inKg = 0;
    let outKg = 0;
    movements
      .filter((movement) => sameCode(movement.markCode, markCode))
      .forEach((movement) => {
        if (movement.type === 'ADJUSTMENT_ADD') {
          inBags += movement.bags;
          inKg += movement.weightKg;
        }
        if (movement.type === 'ADJUSTMENT_SUB') {
          outBags += movement.bags;
          outKg += movement.weightKg;
        }
      });
    const receivedBags = purchaseItems.length
      ? purchaseItems.reduce((sum, item) => sum + item.bags, 0)
      : mark?.initialBags ?? 0;
    const receivedKg = purchaseItems.length
      ? purchaseItems.reduce((sum, item) => sum + item.weightKg, 0)
      : mark?.initialWeightKg ?? 0;
    const rates = uniqueRates(
      purchaseItems.length
        ? purchaseItems.map((item) => item.ratePerKg)
        : mark ? [mark.purchaseRate] : [],
    );
    return {
      markCode,
      receivedBags,
      receivedKg,
      soldBags: sold.reduce((sum, line) => sum + line.item.bags, 0),
      soldKg: sold.reduce((sum, line) => sum + line.item.weightKg, 0),
      salesAmount: roundMoney(sold.reduce((sum, line) => sum + line.item.amount, 0)),
      fees: roundMoney(fees),
      recordedBags: mark?.remainingBags ?? 0,
      recordedKg: mark?.remainingWeightKg ?? 0,
      adjustmentInBags: inBags,
      adjustmentOutBags: outBags,
      adjustmentInKg: inKg,
      adjustmentOutKg: outKg,
      rates,
      purchaseAmount: purchaseItems.length
        ? roundMoney(purchaseItems.reduce((sum, item) => sum + item.totalAmount, 0))
        : mark
          ? roundMoney(mark.initialWeightKg * mark.purchaseRate)
          : null,
    };
  });
}

function markGap(mark: MarkMath): QuantityGap | null {
  if (mark.receivedBags === 0 && mark.receivedKg <= STOCK_WEIGHT_EPSILON_KG && mark.purchaseAmount == null) {
    return null;
  }
  const expected = formulaBalance({
    receivedBags: mark.receivedBags,
    receivedKg: mark.receivedKg,
    soldBags: mark.soldBags,
    soldKg: mark.soldKg,
    inBags: mark.adjustmentInBags,
    outBags: mark.adjustmentOutBags,
    inKg: mark.adjustmentInKg,
    outKg: mark.adjustmentOutKg,
  });
  return gap(mark.recordedBags, mark.recordedKg, expected.bags, expected.weightKg);
}

function saleAnomalies(
  lot: Lot,
  lines: { sale: Sale; item: SaleItem }[],
  marks: MarkMath[],
  movements: StockMovement[],
): ReviewAlert[] {
  const alerts: ReviewAlert[] = [];
  const running = new Map<string, { bags: number; kg: number }>();
  marks.forEach((mark) => running.set(mark.markCode.toUpperCase(), { bags: mark.receivedBags, kg: mark.receivedKg }));

  const events: Array<{ date: string; order: number; apply: () => void }> = [];
  movements.forEach((movement) => {
    const delta = signedAdjustment(movement);
    if (!delta) return;
    events.push({
      date: movement.date,
      order: -1,
      apply: () => {
        const key = movement.markCode.toUpperCase();
        const stock = running.get(key) ?? { bags: 0, kg: 0 };
        stock.bags += delta.bags;
        stock.kg += delta.weightKg;
        running.set(key, stock);
      },
    });
  });
  lines.forEach((line, index) => {
    events.push({
      date: line.sale.date,
      order: index,
      apply: () => {
        const key = line.item.markCode.toUpperCase();
        const stock = running.get(key) ?? { bags: 0, kg: 0 };
        const average = line.item.bags > 0 ? line.item.weightKg / line.item.bags : null;
        const reasons: string[] = [];
        if (line.item.bags > stock.bags || line.item.weightKg > stock.kg + STOCK_WEIGHT_EPSILON_KG) {
          reasons.push('Sale quantity is larger than the stock still available on this mark');
        }
        const floor = lot.marks.find((mark) => sameCode(mark.markCode, line.item.markCode))?.finalizedSellingRate;
        if (floor != null && line.item.ratePerKg + 0.001 < floor) {
          reasons.push('Selling rate below finalized floor rate');
        }
        if (line.item.bagWeights.length > 0) {
          const weighed = line.item.bagWeights.reduce((sum, bag) => sum + bag.weightKg, 0);
          if (Math.abs(weighed - line.item.weightKg) > STOCK_WEIGHT_EPSILON_KG) {
            reasons.push('Recorded bag weights do not add up to the line weight');
          }
          if (line.item.bagWeights.length !== line.item.bags) {
            reasons.push('Bag count does not match the number of recorded bag weights');
          }
        }
        reasons.forEach((reason, reasonIndex) => {
          alerts.push({
            id: `${line.sale.id}-${line.item.id}-${reasonIndex}`,
            saleId: line.sale.id,
            href: `/sales/${line.sale.id}`,
            billNumber: line.sale.billNumber,
            date: line.sale.date,
            customerName: line.sale.customerName,
            lotNumber: lot.lotNumber,
            markCode: line.item.markCode,
            bags: line.item.bags,
            weightKg: line.item.weightKg,
            averageKgPerBag: average,
            ratePerKg: line.item.ratePerKg,
            amount: line.item.amount,
            reason,
          });
        });
        stock.bags -= line.item.bags;
        stock.kg -= line.item.weightKg;
        running.set(key, stock);
      },
    });
  });

  events
    .sort((left, right) => left.date.localeCompare(right.date) || left.order - right.order)
    .forEach((event) => event.apply());
  return alerts;
}

function balanceAlerts(lot: Lot, marks: MarkMath[]): ReviewAlert[] {
  return marks.flatMap((mark): ReviewAlert[] => {
    const difference = markGap(mark);
    if (!difference) {
      return [{
        id: `${lot.id}-${mark.markCode}-pending`,
        saleId: null,
        href: `/lots/${lot.id}`,
        billNumber: '—',
        date: lot.arrivalDate,
        customerName: '—',
        lotNumber: lot.lotNumber,
        markCode: mark.markCode,
        bags: null,
        weightKg: null,
        averageKgPerBag: null,
        ratePerKg: null,
        amount: null,
        reason: 'Pending reconciliation — receipts for this mark are not recorded',
      }];
    }
    const bagOff = difference.bags !== 0;
    const kgOff = !nearZeroKg(difference.weightKg);
    if (!bagOff && !kgOff) return [];
    const parts = [
      bagOff ? `${difference.bags > 0 ? '+' : ''}${difference.bags} bags` : null,
      kgOff ? `${difference.weightKg > 0 ? '+' : ''}${difference.weightKg} KG` : null,
    ].filter(Boolean);
    return [{
      id: `${lot.id}-${mark.markCode}-balance`,
      saleId: null,
      href: `/lots/${lot.id}`,
      billNumber: '—',
      date: lot.arrivalDate,
      customerName: '—',
      lotNumber: lot.lotNumber,
      markCode: mark.markCode,
      bags: mark.recordedBags,
      weightKg: mark.recordedKg,
      averageKgPerBag: null,
      ratePerKg: null,
      amount: null,
      reason: `Recorded balance does not match receipts, sales, and approved adjustments (${parts.join(', ')})`,
    }];
  });
}

function activityFor(
  lot: Lot,
  purchases: Purchase[],
  lines: { sale: Sale; item: SaleItem }[],
  movements: StockMovement[],
): LotActivityEntry[] {
  const entries: LotActivityEntry[] = [];
  purchases.forEach((purchase) => {
    entries.push({
      id: `purchase-${purchase.id}`,
      date: purchase.date,
      time: purchase.createdAt,
      kind: 'Purchase',
      title: purchase.billNumber,
      detail: `${purchase.vendorName} · ${purchase.items.reduce((sum, item) => sum + item.bags, 0)} bags`,
      markCode: null,
      href: `/purchases/${purchase.id}`,
    });
    if (purchase.receiving) {
      entries.push({
        id: `receiving-${purchase.id}`,
        date: purchase.receiving.receivedAt.slice(0, 10),
        time: purchase.receiving.receivedAt,
        kind: 'Receiving',
        title: purchase.receiving.stockPosted ? 'Stock received' : 'Receiving in progress',
        detail: `${purchase.receiving.groups.length} mark groups`,
        markCode: null,
        href: `/purchases/${purchase.id}/receive`,
      });
    }
  });
  lines.forEach((line) => {
    entries.push({
      id: `sale-${line.sale.id}-${line.item.id}`,
      date: line.sale.date,
      time: line.sale.createdAt,
      kind: 'Sale',
      title: line.sale.billNumber,
      detail: `${line.sale.customerName} · ${line.item.markCode} · ${line.item.bags} bags · ${line.item.weightKg} KG`,
      markCode: line.item.markCode,
      href: `/sales/${line.sale.id}`,
    });
  });
  movements.forEach((movement) => {
    if (movement.type === 'ADJUSTMENT_ADD' || movement.type === 'ADJUSTMENT_SUB') {
      entries.push({
        id: `adj-${movement.id}`,
        date: movement.date,
        time: movement.date,
        kind: 'Adjustment',
        title: movement.type === 'ADJUSTMENT_ADD' ? 'Approved addition' : 'Approved reduction',
        detail: `${movement.markCode} · ${movement.bags} bags · ${movement.weightKg} KG${movement.reason ? ` · ${movement.reason}` : ''}`,
        markCode: movement.markCode,
        href: '/stock',
      });
    }
    if (movement.type === 'OPENING_STOCK') {
      entries.push({
        id: `open-${movement.id}`,
        date: movement.date,
        time: movement.date,
        kind: 'Opening stock',
        title: 'Opening stock',
        detail: `${movement.markCode} · ${movement.bags} bags · ${movement.weightKg} KG`,
        markCode: movement.markCode,
        href: null,
      });
    }
  });
  return entries.sort((left, right) => left.date.localeCompare(right.date) || left.time.localeCompare(right.time) || left.id.localeCompare(right.id));
}

function costGroups(marks: MarkBreakdown[], math: MarkMath[]): CostBreakdown[] {
  const groups = new Map<string, { rate: number; math: MarkMath[]; view: MarkBreakdown[] }>();
  math.forEach((mark) => {
    const view = marks.find((entry) => entry.markCode === mark.markCode);
    if (!view || mark.rates.length === 0) return;
    mark.rates.forEach((rate) => {
      const key = rateKey(rate);
      const current = groups.get(key) ?? { rate, math: [], view: [] };
      current.math.push(mark);
      current.view.push(view);
      groups.set(key, current);
    });
  });

  return [...groups.values()]
    .sort((left, right) => left.rate - right.rate || left.math[0]!.markCode.localeCompare(right.math[0]!.markCode) /* backend: index checks are strict */)
    .map((group) => {
      const split = group.math.some((mark) => mark.rates.length > 1);
      const single = group.view;
      return {
        rate: group.rate,
        marks: [...new Set(single.map((mark) => mark.markCode))],
        purchaseBags: split ? 0 : single.reduce((sum, mark) => sum + mark.purchaseBags, 0),
        purchaseKg: split ? 0 : single.reduce((sum, mark) => sum + mark.purchaseKg, 0),
        purchaseAmount: split ? 0 : roundMoney(single.reduce((sum, mark) => sum + (mark.purchaseAmount ?? 0), 0)),
        soldBags: split ? null : single.reduce((sum, mark) => sum + mark.soldBags, 0),
        soldKg: split ? null : single.reduce((sum, mark) => sum + mark.soldKg, 0),
        salesAmount: split ? null : roundMoney(single.reduce((sum, mark) => sum + mark.salesAmount, 0)),
        balanceBags: split ? null : single.reduce((sum, mark) => sum + mark.balanceBags, 0),
        balanceKg: split ? null : roundKg(single.reduce((sum, mark) => sum + mark.balanceKg, 0)),
        bagDifference: split || single.some((mark) => mark.bagDifference == null)
          ? null
          : single.reduce((sum, mark) => sum + (mark.bagDifference ?? 0), 0),
        weightDifferenceKg: split || single.some((mark) => mark.weightDifferenceKg == null)
          ? null
          : roundKg(single.reduce((sum, mark) => sum + (mark.weightDifferenceKg ?? 0), 0)),
        profit: split || single.some((mark) => mark.soldKg > STOCK_WEIGHT_EPSILON_KG && mark.profit == null)
          ? null
          : single.every((mark) => mark.profit == null)
            ? null
            : roundMoney(single.reduce((sum, mark) => sum + (mark.profit ?? 0), 0)),
        salesUnallocated: split,
      };
    });
}

export function buildDifferentialReport(input: BuildInput): DifferentialReport {
  const base = buildLotDifferential(input);
  const confirmed = input.sales.filter((sale) => sale.status === 'CONFIRMED');
  const lots = input.lots.map((lot) => {
    const row = base.lots.find((entry) => entry.lotId === lot.id);
    if (!row) return null;
    const purchases = input.purchases.filter(
      (purchase) => purchase.receiptStatus !== 'PENDING_RECEIPT' && sameCode(purchase.lotNumber, lot.lotNumber),
    );
    const movements = input.stockMovements.filter((movement) => sameCode(movement.lotNumber, lot.lotNumber));
    const lines = confirmedItems(confirmed, lot.lotNumber);
    const math = buildMarkMath(lot, purchases, lines, movements, row.outgoingLines);
    const inwardExpenses = purchases.reduce(
      (sum, purchase) => sum + purchase.totalExpenses + (purchase.receiving?.expenses.reduce((expenseSum, expense) => expenseSum + expense.amount, 0) ?? 0),
      0,
    );
    const markRates = landedCostPerKgByMark(purchases, inwardExpenses, row.landedCostPerKg);
    const marks: MarkBreakdown[] = math.map((mark) => {
      const difference = markGap(mark);
      const expected = formulaBalance({
        receivedBags: mark.receivedBags,
        receivedKg: mark.receivedKg,
        soldBags: mark.soldBags,
        soldKg: mark.soldKg,
        inBags: mark.adjustmentInBags,
        outBags: mark.adjustmentOutBags,
        inKg: mark.adjustmentInKg,
        outKg: mark.adjustmentOutKg,
      });
      const rate = markRates.get(mark.markCode.trim().toUpperCase()) ?? row.landedCostPerKg;
      const profit = mark.soldKg <= STOCK_WEIGHT_EPSILON_KG || rate == null
        ? null
        : roundMoney(mark.salesAmount - roundMoney(mark.soldKg * rate) - mark.fees);
      return {
        markCode: mark.markCode,
        purchaseBags: mark.receivedBags,
        purchaseKg: mark.receivedKg,
        purchaseRate: mark.rates.length === 1 ? (mark.rates[0] ?? null) : null, // backend: index checks are strict
        purchaseRates: mark.rates,
        purchaseAmount: mark.purchaseAmount,
        soldBags: mark.soldBags,
        soldKg: mark.soldKg,
        salesAmount: mark.salesAmount,
        balanceBags: expected.bags,
        balanceKg: roundKg(expected.weightKg),
        bagDifference: difference?.bags ?? null,
        weightDifferenceKg: difference ? roundKg(difference.weightKg) : null,
        profit,
      };
    });

    const purchaseExpenses = purchases.length
      ? roundMoney(purchases.reduce((sum, purchase) => sum + purchase.totalExpenses, 0))
      : null;
    const receivingExpenses = purchases.some((purchase) => purchase.receiving)
      ? roundMoney(purchases.reduce(
        (sum, purchase) => sum + (purchase.receiving?.expenses.reduce((expenseSum, expense) => expenseSum + expense.amount, 0) ?? 0),
        0,
      ))
      : null;
    const lotExpected = formulaBalance({
      receivedBags: lot.totalBags,
      receivedKg: lot.totalWeightKg,
      soldBags: row.outgoingBags,
      soldKg: row.outgoingWeightKg,
      inBags: Math.max(0, row.adjustmentBags),
      outBags: Math.max(0, -row.adjustmentBags),
      inKg: Math.max(0, row.adjustmentWeightKg),
      outKg: Math.max(0, -row.adjustmentWeightKg),
    });
    const lotDifference = gap(lot.remainingBags, lot.remainingWeightKg, lotExpected.bags, lotExpected.weightKg);
    const alerts = [...balanceAlerts(lot, math), ...saleAnomalies(lot, lines, math, movements)];
    const signed = !nearZeroKg(lotDifference.weightKg) || lotDifference.bags !== 0;
    const status: DifferenceStatus = alerts.some((alert) => alert.saleId)
      ? 'NEEDS_REVIEW'
      : signed
        ? (lotDifference.bags > 0 || lotDifference.weightKg > STOCK_WEIGHT_EPSILON_KG ? 'POSITIVE' : 'NEGATIVE')
        : alerts.length
          ? 'NEEDS_REVIEW'
          : 'NORMAL';
    const product = productOf(lot, input.products);

    const view: DifferentialLot = {
      lotId: lot.id,
      lotNumber: lot.lotNumber,
      productId: product.id,
      productName: product.name,
      date: row.purchaseDate ?? lot.arrivalDate,
      vendorName: lot.vendorName,
      arrivedBags: lot.totalBags,
      arrivedKg: lot.totalWeightKg,
      soldBags: row.outgoingBags,
      soldKg: row.outgoingWeightKg,
      balanceBags: lotExpected.bags,
      balanceKg: roundKg(lotExpected.weightKg),
      adjustmentBags: row.adjustmentBags,
      adjustmentWeightKg: row.adjustmentWeightKg,
      purchaseAmount: row.purchaseAmount,
      salesAmount: row.salesRealization,
      purchaseExpenses,
      receivingExpenses,
      expenses: purchaseExpenses == null && receivingExpenses == null
        ? null
        : roundMoney((purchaseExpenses ?? 0) + (receivingExpenses ?? 0)),
      bagDifference: lotDifference.bags,
      weightDifferenceKg: roundKg(lotDifference.weightKg),
      profit: row.realizedProfit,
      remainingInventoryCost: row.remainingInventoryCost,
      status,
      reviewCount: alerts.length,
      marks,
      costs: [],
      alerts,
      activity: activityFor(lot, purchases, lines, movements),
      base: row,
    };
    view.costs = costGroups(marks, math).map((group) => fillCostQuantities(group, purchases, lot.lotNumber));
    return view;
  }).filter((lot): lot is DifferentialLot => lot != null);

  return { lots, unconfiguredRules: UNCONFIGURED_REVIEW_RULES };
}

function fillCostQuantities(group: CostBreakdown, purchases: Purchase[], lotNumber: string): CostBreakdown {
  const lines = purchases
    .filter((purchase) => sameCode(purchase.lotNumber, lotNumber))
    .flatMap((purchase) => purchase.items)
    .filter((item) => rateKey(item.ratePerKg) === rateKey(group.rate) && group.marks.some((mark) => sameCode(mark, item.markCode)));
  if (lines.length === 0) return group;
  return {
    ...group,
    purchaseBags: lines.reduce((sum, item) => sum + item.bags, 0),
    purchaseKg: lines.reduce((sum, item) => sum + item.weightKg, 0),
    purchaseAmount: roundMoney(lines.reduce((sum, item) => sum + item.totalAmount, 0)),
  };
}

export function lotMatchesProduct(lot: Pick<Lot, 'productId'>, product: Pick<Product, 'id' | 'code'>) {
  return lotBelongsToProduct(lot, product);
}

export function differenceStatusLabel(status: DifferenceStatus) {
  if (status === 'POSITIVE') return 'Positive Difference';
  if (status === 'NEGATIVE') return 'Negative Difference';
  if (status === 'NEEDS_REVIEW') return 'Needs Review';
  return 'Normal';
}
