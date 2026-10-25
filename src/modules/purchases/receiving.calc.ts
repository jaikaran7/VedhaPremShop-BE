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

/** FIXED_TOTAL is a pool to spread. PER_BAG and PER_KG are rates charged for each eligible unit. */
export type ExpenseAmountBasis = 'FIXED_TOTAL' | 'PER_BAG' | 'PER_KG';

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
  /** Missing means a fixed pool, which is how expenses were entered before per-unit rates existed. */
  amountBasis?: ExpenseAmountBasis;
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
  /** Null inherits the lot commission, or the settings default when the lot has none. */
  marginPerKg?: number | null;
  overrideReason: string;
  remarks: string;
  bagWeights: BagWeight[];
}

export interface ReceivingDraft {
  expenses: ReceivingExpense[];
  groups: DraftGroup[];
  /** Null uses the settings default. A mark override still wins for that mark. */
  lotMarginPerKg?: number | null;
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
  /** The commission actually added: mark override, else lot override, else the settings default. */
  appliedMarginPerKg: number;
}

export interface EvaluatedGroup extends Omit<DraftGroup, 'receivedWeightKg'> {
  receivedWeightKg: number;
  acceptedWeightKg: number | null;
  preliminarySellingRate: number | null;
  allocatedReceivingCostPerKg: number | null;
  landedCostPerKg: number | null;
  calculatedFinalRate: number | null;
  appliedMarginPerKg: number | null;
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

export function expenseAmountBasis(expense: Pick<ReceivingExpense, 'amountBasis'>): ExpenseAmountBasis {
  return expense.amountBasis ?? 'FIXED_TOTAL';
}

/** Mark override, then the lot override, then the settings default. */
export function effectiveMarginPerKg(group: Pick<DraftGroup, 'marginPerKg'>, lotMarginPerKg: number | null | undefined, settings: CostingSettings): number {
  if (group.marginPerKg != null && Number.isFinite(group.marginPerKg)) return group.marginPerKg;
  if (lotMarginPerKg != null && Number.isFinite(lotMarginPerKg)) return lotMarginPerKg;
  return settings.defaultSellingMarginPerKg;
}

export function sellingRate(costPerKg: number, settings: CostingSettings, margins: readonly MarginComponent[], marginPerKg = settings.defaultSellingMarginPerKg) {
  const additional = margins.reduce((sum, m) => sum + m.perKg, 0);
  const preliminary = costPerKg + marginPerKg + additional;
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

interface Share { perKg: number; warning: string | null }

const NO_SHARE: Share = { perKg: 0, warning: null };
const blocked = (warning: string): Share => ({ perKg: 0, warning });

/** An expense spread over all received kilograms. */
function shareByKg(expense: ReceivingExpense, amount: number, group: Measured, groups: Measured[]): Share {
  const eligible = groups.reduce((sum, g) => sum + positive(g.receivedWeightKg), 0);
  if (eligible <= 0) return blocked(`${expense.expenseTypeName} cannot be spread by kilograms because received weight is missing.`);
  if (group.receivedWeightKg <= 0) return blocked(`${group.markCode} has no received weight, so ${expense.expenseTypeName} cannot be applied per kg.`);
  return { perKg: amount / eligible, warning: null };
}

/** An expense spread over all received bags, stated per kg of this group. */
function shareByBags(expense: ReceivingExpense, amount: number, group: Measured, groups: Measured[]): Share {
  const bags = groups.reduce((sum, g) => sum + positive(g.receivedBags), 0);
  if (bags <= 0) return blocked(`${expense.expenseTypeName} cannot be spread by bags because received bags are missing.`);
  if (group.receivedBags <= 0) return NO_SHARE;
  if (group.receivedWeightKg <= 0) return blocked(`${group.markCode} has received bags but no weight, so ${expense.expenseTypeName} cannot be stated per kg.`);
  return { perKg: (amount * (group.receivedBags / bags)) / group.receivedWeightKg, warning: null };
}

/** An expense charged to one chosen group only. */
function shareToGroup(expense: ReceivingExpense, amount: number, group: Measured): Share {
  if (expense.allocation.method !== 'ASSIGN_TO_GROUP' || expense.allocation.groupId !== group.id) return NO_SHARE;
  if (group.receivedWeightKg <= 0) return blocked(`${expense.expenseTypeName} is assigned to ${group.markCode}, which has no received weight.`);
  return { perKg: amount / group.receivedWeightKg, warning: null };
}

function perUnitShare(expense: ReceivingExpense, amount: number, group: Measured, groups: Measured[]): Share {
  const basis = expenseAmountBasis(expense);
  if (basis === 'PER_BAG' && expense.allocation.method === 'BY_RECEIVED_KG') {
    return blocked(`${expense.expenseTypeName} is a rate per bag, so it cannot be spread by kilograms.`);
  }
  if (basis === 'PER_KG' && expense.allocation.method === 'BY_RECEIVED_BAGS') {
    return blocked(`${expense.expenseTypeName} is a rate per kg, so it cannot be spread by bags.`);
  }
  if (expense.allocation.method === 'ASSIGN_TO_GROUP' && expense.allocation.groupId !== group.id) return NO_SHARE;
  if (group.receivedWeightKg <= 0) return blocked(`${group.markCode} has no received weight, so ${expense.expenseTypeName} cannot be stated per kg.`);
  if (basis === 'PER_KG') return { perKg: amount, warning: null };
  const eligibleBags = expense.allocation.method === 'ASSIGN_TO_GROUP'
    ? positive(group.receivedBags)
    : groups.reduce((sum, item) => sum + positive(item.receivedBags), 0);
  if (eligibleBags <= 0) return blocked(`${expense.expenseTypeName} is a rate per bag, but received bags are missing.`);
  if (group.receivedBags <= 0) return NO_SHARE;
  return { perKg: (group.receivedBags * amount) / group.receivedWeightKg, warning: null };
}

function allocationSharePerKg(expense: ReceivingExpense, group: Measured, groups: Measured[]): Share {
  const amount = Number(expense.amount) || 0;
  if (amount < 0 || !Number.isFinite(amount)) return blocked(`${expense.expenseTypeName} has an invalid amount.`);
  if (amount === 0) return NO_SHARE;
  if (expenseAmountBasis(expense) !== 'FIXED_TOTAL') return perUnitShare(expense, amount, group, groups);
  if (expense.allocation.method === 'BY_RECEIVED_KG') return shareByKg(expense, amount, group, groups);
  if (expense.allocation.method === 'BY_RECEIVED_BAGS') return shareByBags(expense, amount, group, groups);
  return shareToGroup(expense, amount, group);
}

/** Receiving cost per kg for one group (null when an expense cannot be spread), with the warnings that explain why. */
function receivingCostFor(group: DraftGroup, self: Measured, expenses: ReceivingExpense[], measured: Measured[]): { perKg: number | null; warnings: string[] } {
  if (!(positive(group.receivedBags) > 0 || positive(group.acceptedBags) > 0)) return { perKg: 0, warnings: [] };
  const shares = expenses.map((expense) => allocationSharePerKg(expense, self, measured));
  const warnings = shares.flatMap((share) => (share.warning ? [share.warning] : []));
  return { perKg: warnings.length > 0 ? null : shares.reduce((sum, share) => sum + share.perKg, 0), warnings };
}

interface GroupRates {
  landedCostPerKg: number | null;
  calculatedFinalRate: number | null;
  rateSnapshot?: RateSnapshot;
  warnings: string[];
}

function snapshotOf(group: DraftGroup, perKg: number, receivedWeightKg: number | null, landed: number, selling: { preliminary: number; final: number }, settings: CostingSettings, margins: readonly MarginComponent[], appliedMarginPerKg: number): RateSnapshot {
  const weightForSnapshot = receivedWeightKg && receivedWeightKg > 0 ? receivedWeightKg : 1;
  const allocatedAmount = perKg * (receivedWeightKg ?? 0);
  const hasAllocation = allocatedAmount > 0;
  return {
    defaultSellingMarginPerKg: settings.defaultSellingMarginPerKg,
    roundingRule: settings.roundingRule,
    additionalMargins: margins.map((m) => ({ id: m.id, name: m.name, perKg: m.perKg, calculationType: 'PER_KG' as const })),
    originalVendorEnteredRate: group.originalPurchaseRate,
    originalVendorRateUnit: 'PER_KG',
    normalizedVendorPurchaseRatePerKg: group.originalPurchaseRate,
    purchaseExpenses: [],
    stockReceivingExpenses: hasAllocation
      ? [{ id: `alloc-${group.id}`, expenseTypeId: 'allocated-receiving', expenseTypeName: 'Allocated receiving cost', kind: 'STOCK_RECEIVING', basis: 'FIXED_TOTAL', amount: allocatedAmount }]
      : [],
    purchaseExpenseAllocation: { method: 'UNALLOCATED' },
    receivingExpenseAllocation: hasAllocation ? { method: 'SPREAD_FIXED_TOTAL_PER_KG', totalWeightKg: weightForSnapshot } : { method: 'UNALLOCATED' },
    allocatedPurchaseExpensePerKg: 0,
    allocatedReceivingExpensePerKg: hasAllocation ? allocatedAmount / weightForSnapshot : 0,
    allocatedLandedCostPerKg: landed,
    costBaselinePerKg: landed,
    preliminarySellingRatePerKg: selling.preliminary,
    finalSellingRatePerKg: selling.final,
    appliedMarginPerKg,
  };
}

/** Landed cost, calculated selling rate and the frozen rate snapshot for one group. */
function ratesFor(group: DraftGroup, markCode: string, perKg: number | null, receivedWeightKg: number | null, settings: CostingSettings, margins: readonly MarginComponent[], lotMarginPerKg: number | null | undefined): GroupRates {
  if (!Number.isFinite(group.originalPurchaseRate) || group.originalPurchaseRate < 0) {
    return { landedCostPerKg: null, calculatedFinalRate: null, warnings: [`${markCode || 'This group'} has no original purchase rate.`] };
  }
  if (perKg == null) {
    const needsRate = positive(group.acceptedBags) > 0 || positive(group.receivedBags) > 0;
    return { landedCostPerKg: null, calculatedFinalRate: null, warnings: needsRate ? [`${markCode} needs a received weight before a final rate can be calculated.`] : [] };
  }
  const landed = group.originalPurchaseRate + perKg;
  const appliedMarginPerKg = effectiveMarginPerKg(group, lotMarginPerKg, settings);
  const selling = sellingRate(landed, settings, margins, appliedMarginPerKg);
  return { landedCostPerKg: landed, calculatedFinalRate: selling.final, rateSnapshot: snapshotOf(group, perKg, receivedWeightKg, landed, selling, settings, margins, appliedMarginPerKg), warnings: [] };
}

/** Kilograms that are accepted: the received weight in proportion to accepted bags. */
function acceptedWeightFor(group: DraftGroup, markCode: string, receivedWeightKg: number | null): { weightKg: number | null; warning: string | null } {
  if (positive(group.acceptedBags) === 0) return { weightKg: 0, warning: null };
  if (receivedWeightKg == null || positive(group.receivedBags) === 0) {
    return { weightKg: null, warning: `${markCode || 'A group'} has accepted bags but no received weight to post.` };
  }
  return { weightKg: receivedWeightKg * (positive(group.acceptedBags) / positive(group.receivedBags)), warning: null };
}

/** Differences from the vendor bill that are worth a look but do not stop receiving. */
function discrepancyNotes(group: DraftGroup, markCode: string, receivedWeightKg: number | null): ReceivingIssue[] {
  const notes: string[] = [];
  if (group.expectedBags !== group.receivedBags) notes.push(`${markCode}: expected ${group.expectedBags} bags, received ${group.receivedBags}.`);
  if (group.acceptedBags + group.defectiveBags !== group.receivedBags) {
    notes.push(`${markCode}: accepted ${group.acceptedBags} plus defective ${group.defectiveBags} does not equal received ${group.receivedBags}.`);
  }
  if (group.expectedWeightKg > 0 && receivedWeightKg != null && Math.abs(group.expectedWeightKg - receivedWeightKg) > WEIGHT_TOLERANCE_KG) {
    notes.push(`${markCode}: expected ${group.expectedWeightKg.toLocaleString('en-IN')} kg, received ${receivedWeightKg.toFixed(2)} kg.`);
  }
  return notes.map((message) => ({ blocking: false, message }));
}

function evaluateGroup(group: DraftGroup, draft: ReceivingDraft, settings: CostingSettings, margins: readonly MarginComponent[], measured: Measured[]): { group: EvaluatedGroup; issues: ReceivingIssue[] } {
  const markCode = group.markCode.trim().toUpperCase();
  const warnings: string[] = [];
  if (!markCode) warnings.push('A mark code is required.');
  const resolved = resolvedReceivedWeight(group);
  if (resolved.warning) warnings.push(resolved.warning);
  const receivedWeightKg = resolved.weightKg;
  const self: Measured = { id: group.id, markCode: markCode || 'Unnamed', receivedBags: positive(group.receivedBags), receivedWeightKg: receivedWeightKg ?? 0 };

  const cost = receivingCostFor(group, self, draft.expenses, measured);
  const rates = ratesFor(group, markCode, cost.perKg, receivedWeightKg, settings, margins, draft.lotMarginPerKg);
  const accepted = acceptedWeightFor(group, markCode, receivedWeightKg);
  warnings.push(...cost.warnings, ...rates.warnings);
  if (accepted.warning) warnings.push(accepted.warning);
  if (group.revisedSellingRate != null && group.revisedSellingRate !== rates.calculatedFinalRate && !group.overrideReason.trim()) {
    warnings.push(`${markCode} has a manual selling rate without a reason.`);
  }

  const unique = [...new Set(warnings)];
  return {
    issues: [...unique.map((message) => ({ blocking: true, message })), ...discrepancyNotes(group, markCode, receivedWeightKg)],
    group: {
      ...group,
      markCode,
      receivedWeightKg: receivedWeightKg ?? group.receivedWeightKg,
      acceptedWeightKg: accepted.weightKg,
      preliminarySellingRate: Number.isFinite(group.originalPurchaseRate) && group.originalPurchaseRate >= 0
        ? sellingRate(group.originalPurchaseRate, settings, margins, effectiveMarginPerKg(group, draft.lotMarginPerKg, settings)).preliminary
        : null,
      allocatedReceivingCostPerKg: cost.perKg,
      landedCostPerKg: rates.landedCostPerKg,
      calculatedFinalRate: rates.calculatedFinalRate,
      appliedMarginPerKg: Number.isFinite(group.originalPurchaseRate) && group.originalPurchaseRate >= 0
        ? effectiveMarginPerKg(group, draft.lotMarginPerKg, settings)
        : null,
      calculationWarning: unique[0] ?? null,
      ...(rates.rateSnapshot && { rateSnapshot: rates.rateSnapshot }),
    },
  };
}

export function evaluateReceiving(input: { draft: ReceivingDraft; settings: CostingSettings; margins: readonly MarginComponent[] }): {
  groups: EvaluatedGroup[];
  issues: ReceivingIssue[];
} {
  const { draft, settings, margins } = input;
  const measured: Measured[] = draft.groups.map((g) => ({
    id: g.id,
    markCode: g.markCode.trim() || 'Unnamed',
    receivedBags: positive(g.receivedBags),
    receivedWeightKg: resolvedReceivedWeight(g).weightKg ?? 0,
  }));
  const evaluated = draft.groups.map((group) => evaluateGroup(group, draft, settings, margins, measured));

  const markCounts = new Map<string, number>();
  for (const { group } of evaluated) markCounts.set(group.markCode, (markCounts.get(group.markCode) ?? 0) + 1);
  const duplicates: ReceivingIssue[] = [...markCounts]
    .filter(([markCode, count]) => markCode && count > 1)
    .map(([markCode]) => ({ blocking: true, message: `${markCode} is used on more than one group. Give each priced group its own mark.` }));

  const counted = measured.some((item) => item.receivedBags > 0 || item.receivedWeightKg > 0);
  const uncounted: ReceivingIssue[] = !counted && draft.expenses.some((expense) => (Number(expense.amount) || 0) > 0)
    ? [{ blocking: true, message: 'Enter the received bags and weight before allocating a receiving expense.' }]
    : [];

  return { groups: evaluated.map((e) => e.group), issues: [...evaluated.flatMap((e) => e.issues), ...duplicates, ...uncounted] };
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
