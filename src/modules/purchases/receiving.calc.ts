/**
 * Receiving and selling-rate rules for a vendor consignment, as pure functions.
 * Server-side port of the frontend's utils/costing.ts + utils/receiving.ts: the screen previews with the
 * frontend copy, but this one is authoritative (the server re-evaluates the submitted draft). Keep the two in step.
 */

export const WEIGHT_TOLERANCE_KG = 0.05;

export interface CostingSettings {
  defaultSellingMarginPerKg: number;
  roundingRule: 'CEIL_WHOLE_RUPEE';
}

/** Active, per-kg margin components only; other formulas are not defined, so the service never passes them. */
export interface MarginComponent {
  id: string;
  name: string;
  perKg: number;
}

export type AllocationChoice = { method: 'BY_RECEIVED_KG' } | { method: 'BY_RECEIVED_BAGS' } | { method: 'ASSIGN_TO_GROUP'; groupId: string };

export interface BagWeight {
  bagNumber: number;
  weightKg: number;
}

export interface ReceivingExpense {
  id: string;
  expenseTypeId: string;
  expenseTypeName: string;
  description: string;
  amount: number;
  remarks: string;
  allocation: AllocationChoice;
}

export interface DraftGroup {
  id: string;
  markCode: string;
  fromVendorBill: boolean;
  expectedBags: number;
  expectedWeightKg: number;
  receivedBags: number;
  acceptedBags: number;
  defectiveBags: number;
  receivedWeightKg: number;
  originalPurchaseRate: number;
  revisedSellingRate: number | null;
  overrideReason: string;
  remarks: string;
  bagWeights: BagWeight[];
}

export interface ReceivingDraft {
  expenses: ReceivingExpense[];
  groups: DraftGroup[];
}

export interface RateSnapshot {
  defaultSellingMarginPerKg: number;
  roundingRule: 'CEIL_WHOLE_RUPEE';
  additionalMargins: { id: string; name: string; perKg: number; calculationType: 'PER_KG' }[];
  originalVendorEnteredRate: number;
  originalVendorRateUnit: 'PER_KG';
  normalizedVendorPurchaseRatePerKg: number;
  purchaseExpenses: never[];
  stockReceivingExpenses: { id: string; expenseTypeId: string; expenseTypeName: string; kind: 'STOCK_RECEIVING'; basis: 'FIXED_TOTAL'; amount: number }[];
  purchaseExpenseAllocation: { method: 'UNALLOCATED' };
  receivingExpenseAllocation: { method: 'UNALLOCATED' } | { method: 'SPREAD_FIXED_TOTAL_PER_KG'; totalWeightKg: number };
  allocatedPurchaseExpensePerKg: number;
  allocatedReceivingExpensePerKg: number;
  allocatedLandedCostPerKg: number;
  costBaselinePerKg: number;
  preliminarySellingRatePerKg: number;
  finalSellingRatePerKg: number;
}

export interface EvaluatedGroup extends Omit<DraftGroup, 'receivedWeightKg'> {
  receivedWeightKg: number;
  acceptedWeightKg: number | null;
  preliminarySellingRate: number | null;
  allocatedReceivingCostPerKg: number | null;
  landedCostPerKg: number | null;
  calculatedFinalRate: number | null;
  calculationWarning: string | null;
  rateSnapshot?: RateSnapshot;
}

export interface ReceivingIssue {
  blocking: boolean;
  message: string;
}

const positive = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** Round only the finished selling rate up to the next whole rupee; exact whole rupees stay as they are. */
export function ceilWholeRupee(rate: number): number {
  const paise = Math.round(rate * 100);
  return paise % 100 === 0 ? paise / 100 : Math.floor(paise / 100) + 1;
}

export function sellingRate(costPerKg: number, settings: CostingSettings, margins: readonly MarginComponent[]) {
  const additional = margins.reduce((sum, m) => sum + m.perKg, 0);
  const preliminary = costPerKg + settings.defaultSellingMarginPerKg + additional;
  return { preliminary, final: ceilWholeRupee(preliminary) };
}

/** Weight from the per-bag list wins over the typed total; a mismatch beyond tolerance is a blocking warning. */
export function resolvedReceivedWeight(group: Pick<DraftGroup, 'receivedWeightKg' | 'bagWeights'>): { weightKg: number | null; warning: string | null } {
  if (group.bagWeights.length > 0) {
    const total = group.bagWeights.reduce((sum, bag) => sum + bag.weightKg, 0);
    if (group.receivedWeightKg > 0 && Math.abs(total - group.receivedWeightKg) > WEIGHT_TOLERANCE_KG) {
      return {
        weightKg: total,
        warning: `Bag weights total ${total.toFixed(2)} kg, which does not match the entered received weight of ${group.receivedWeightKg.toFixed(2)} kg.`,
      };
    }
    return { weightKg: total, warning: null };
  }
  return { weightKg: group.receivedWeightKg > 0 ? group.receivedWeightKg : null, warning: null };
}

interface Measured { id: string; markCode: string; receivedBags: number; receivedWeightKg: number }

function allocationSharePerKg(expense: ReceivingExpense, group: Measured, groups: Measured[]): { perKg: number; warning: string | null } {
  const amount = Number(expense.amount) || 0;
  if (amount < 0 || !Number.isFinite(amount)) return { perKg: 0, warning: `${expense.expenseTypeName} has an invalid amount.` };
  if (amount === 0) return { perKg: 0, warning: null };

  if (expense.allocation.method === 'BY_RECEIVED_KG') {
    const eligible = groups.reduce((sum, g) => sum + positive(g.receivedWeightKg), 0);
    if (eligible <= 0) return { perKg: 0, warning: `${expense.expenseTypeName} cannot be spread by kilograms because received weight is missing.` };
    if (group.receivedWeightKg <= 0) return { perKg: 0, warning: `${group.markCode} has no received weight, so ${expense.expenseTypeName} cannot be applied per kg.` };
    return { perKg: amount / eligible, warning: null };
  }

  if (expense.allocation.method === 'BY_RECEIVED_BAGS') {
    const bags = groups.reduce((sum, g) => sum + positive(g.receivedBags), 0);
    if (bags <= 0) return { perKg: 0, warning: `${expense.expenseTypeName} cannot be spread by bags because received bags are missing.` };
    if (group.receivedBags <= 0) return { perKg: 0, warning: null };
    if (group.receivedWeightKg <= 0) return { perKg: 0, warning: `${group.markCode} has received bags but no weight, so ${expense.expenseTypeName} cannot be stated per kg.` };
    return { perKg: (amount * (group.receivedBags / bags)) / group.receivedWeightKg, warning: null };
  }

  if (expense.allocation.groupId !== group.id) return { perKg: 0, warning: null };
  if (group.receivedWeightKg <= 0) return { perKg: 0, warning: `${expense.expenseTypeName} is assigned to ${group.markCode}, which has no received weight.` };
  return { perKg: amount / group.receivedWeightKg, warning: null };
}

export function evaluateReceiving(input: { draft: ReceivingDraft; settings: CostingSettings; margins: readonly MarginComponent[] }): {
  groups: EvaluatedGroup[];
  issues: ReceivingIssue[];
} {
  const { draft, settings, margins } = input;
  const issues: ReceivingIssue[] = [];
  const measured: Measured[] = draft.groups.map((g) => ({
    id: g.id,
    markCode: g.markCode.trim() || 'Unnamed',
    receivedBags: positive(g.receivedBags),
    receivedWeightKg: resolvedReceivedWeight(g).weightKg ?? 0,
  }));

  const seenMarks = new Map<string, number>();
  const groups = draft.groups.map((group): EvaluatedGroup => {
    const markCode = group.markCode.trim().toUpperCase();
    const warnings: string[] = [];
    if (!markCode) warnings.push('A mark code is required.');
    seenMarks.set(markCode, (seenMarks.get(markCode) ?? 0) + 1);
    const resolved = resolvedReceivedWeight(group);
    if (resolved.warning) warnings.push(resolved.warning);
    const receivedWeightKg = resolved.weightKg;
    const self: Measured = { id: group.id, markCode: markCode || 'Unnamed', receivedBags: positive(group.receivedBags), receivedWeightKg: receivedWeightKg ?? 0 };

    const active = positive(group.receivedBags) > 0 || positive(group.acceptedBags) > 0;
    const shares = active ? draft.expenses.map((expense) => allocationSharePerKg(expense, self, measured)) : [];
    shares.forEach((share) => share.warning && warnings.push(share.warning));
    const allocatedReceivingCostPerKg = !active ? 0 : shares.some((s) => s.warning) ? null : shares.reduce((sum, s) => sum + s.perKg, 0);

    const preliminary = Number.isFinite(group.originalPurchaseRate) && group.originalPurchaseRate >= 0
      ? sellingRate(group.originalPurchaseRate, settings, margins).preliminary
      : null;
    let landedCostPerKg: number | null = null;
    let calculatedFinalRate: number | null = null;
    let rateSnapshot: RateSnapshot | undefined;
    const needsRate = positive(group.acceptedBags) > 0 || positive(group.receivedBags) > 0;
    if (!Number.isFinite(group.originalPurchaseRate) || group.originalPurchaseRate < 0) {
      warnings.push(`${markCode || 'This group'} has no original purchase rate.`);
    } else if (needsRate && allocatedReceivingCostPerKg == null) {
      warnings.push(`${markCode} needs a received weight before a final rate can be calculated.`);
    } else if (allocatedReceivingCostPerKg != null) {
      landedCostPerKg = group.originalPurchaseRate + allocatedReceivingCostPerKg;
      const selling = sellingRate(landedCostPerKg, settings, margins);
      calculatedFinalRate = selling.final;
      const weightForSnapshot = receivedWeightKg && receivedWeightKg > 0 ? receivedWeightKg : 1;
      const allocatedAmount = allocatedReceivingCostPerKg * (receivedWeightKg ?? 0);
      const perKg = allocatedAmount > 0 ? allocatedAmount / weightForSnapshot : 0;
      rateSnapshot = {
        defaultSellingMarginPerKg: settings.defaultSellingMarginPerKg,
        roundingRule: settings.roundingRule,
        additionalMargins: margins.map((m) => ({ id: m.id, name: m.name, perKg: m.perKg, calculationType: 'PER_KG' as const })),
        originalVendorEnteredRate: group.originalPurchaseRate,
        originalVendorRateUnit: 'PER_KG',
        normalizedVendorPurchaseRatePerKg: group.originalPurchaseRate,
        purchaseExpenses: [],
        stockReceivingExpenses: allocatedAmount > 0
          ? [{ id: `alloc-${group.id}`, expenseTypeId: 'allocated-receiving', expenseTypeName: 'Allocated receiving cost', kind: 'STOCK_RECEIVING', basis: 'FIXED_TOTAL', amount: allocatedAmount }]
          : [],
        purchaseExpenseAllocation: { method: 'UNALLOCATED' },
        receivingExpenseAllocation: allocatedAmount > 0 ? { method: 'SPREAD_FIXED_TOTAL_PER_KG', totalWeightKg: weightForSnapshot } : { method: 'UNALLOCATED' },
        allocatedPurchaseExpensePerKg: 0,
        allocatedReceivingExpensePerKg: perKg,
        allocatedLandedCostPerKg: landedCostPerKg,
        costBaselinePerKg: landedCostPerKg,
        preliminarySellingRatePerKg: selling.preliminary,
        finalSellingRatePerKg: selling.final,
      };
    }

    let acceptedWeightKg: number | null = null;
    if (positive(group.acceptedBags) === 0) acceptedWeightKg = 0;
    else if (receivedWeightKg == null || positive(group.receivedBags) === 0) warnings.push(`${markCode || 'A group'} has accepted bags but no received weight to post.`);
    else acceptedWeightKg = receivedWeightKg * (positive(group.acceptedBags) / positive(group.receivedBags));

    if (group.revisedSellingRate != null && group.revisedSellingRate !== calculatedFinalRate && !group.overrideReason.trim()) {
      warnings.push(`${markCode} has a manual selling rate without a reason.`);
    }

    const unique = [...new Set(warnings)];
    unique.forEach((message) => issues.push({ blocking: true, message }));
    if (group.expectedBags !== group.receivedBags) issues.push({ blocking: false, message: `${markCode}: expected ${group.expectedBags} bags, received ${group.receivedBags}.` });
    if (group.acceptedBags + group.defectiveBags !== group.receivedBags) {
      issues.push({ blocking: false, message: `${markCode}: accepted ${group.acceptedBags} plus defective ${group.defectiveBags} does not equal received ${group.receivedBags}.` });
    }
    if (group.expectedWeightKg > 0 && receivedWeightKg != null && Math.abs(group.expectedWeightKg - receivedWeightKg) > WEIGHT_TOLERANCE_KG) {
      issues.push({ blocking: false, message: `${markCode}: expected ${group.expectedWeightKg.toLocaleString('en-IN')} kg, received ${receivedWeightKg.toFixed(2)} kg.` });
    }

    return {
      ...group,
      markCode,
      receivedWeightKg: receivedWeightKg ?? group.receivedWeightKg,
      acceptedWeightKg,
      preliminarySellingRate: preliminary,
      allocatedReceivingCostPerKg,
      landedCostPerKg,
      calculatedFinalRate,
      calculationWarning: unique[0] ?? null,
      ...(rateSnapshot && { rateSnapshot }),
    };
  });

  seenMarks.forEach((count, markCode) => {
    if (markCode && count > 1) issues.push({ blocking: true, message: `${markCode} is used on more than one group. Give each priced group its own mark.` });
  });
  return { groups, issues };
}

/** Bags and kilograms that go into stock: accepted plus defective (defective bags are still posted once). */
export function takenInspectionQuantity(group: Pick<DraftGroup, 'acceptedBags' | 'defectiveBags' | 'receivedBags'> & { receivedWeightKg: number }): { bags: number; weightKg: number } {
  const bags = Math.max(0, group.acceptedBags) + Math.max(0, group.defectiveBags);
  if (bags <= 0 || group.receivedWeightKg <= 0) return { bags: 0, weightKg: 0 };
  if (group.receivedBags > 0 && bags === group.receivedBags) return { bags, weightKg: group.receivedWeightKg };
  if (group.receivedBags > 0) return { bags, weightKg: group.receivedWeightKg * (bags / group.receivedBags) };
  return { bags, weightKg: group.receivedWeightKg };
}

/** A manual rate wins over the calculated one. */
export function appliedSellingRate(group: Pick<EvaluatedGroup, 'revisedSellingRate' | 'calculatedFinalRate'>): number | null {
  if (group.revisedSellingRate != null && Number.isFinite(group.revisedSellingRate)) return group.revisedSellingRate;
  return group.calculatedFinalRate;
}
