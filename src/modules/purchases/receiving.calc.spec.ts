import { appliedSellingRate, ceilWholeRupee, type DraftGroup, type EvaluatedGroup, evaluateReceiving, type ReceivingExpense, takenInspectionQuantity } from './receiving.calc';

const settings = { defaultSellingMarginPerKg: 6, roundingRule: 'CEIL_WHOLE_RUPEE' as const };

const group = (over: Partial<DraftGroup> = {}): DraftGroup => ({
  id: 'g1', markCode: 'aa', fromVendorBill: true, expectedBags: 10, expectedWeightKg: 500, receivedBags: 10, acceptedBags: 10, defectiveBags: 0,
  receivedWeightKg: 500, originalPurchaseRate: 47, revisedSellingRate: null, overrideReason: '', remarks: '', bagWeights: [], ...over,
});
const expense = (over: Partial<ReceivingExpense> = {}): ReceivingExpense => ({
  id: 'e1', expenseTypeId: 'cet', expenseTypeName: 'Transport', description: '', amount: 1000, remarks: '', allocation: { method: 'BY_RECEIVED_KG' }, ...over,
});
const run = (groups: DraftGroup[], expenses: ReceivingExpense[] = [], margins: { id: string; name: string; perKg: number }[] = []) =>
  evaluateReceiving({ draft: { groups, expenses }, settings, margins });

/** Indexed access that fails the test, not the compiler, when a group is missing. */
const at = (groups: EvaluatedGroup[], i: number): EvaluatedGroup => {
  const found = groups[i];
  if (!found) throw new Error(`no group at ${i}`);
  return found;
};

describe('ceilWholeRupee', () => {
  it('keeps exact rupees and rounds anything above up', () => {
    expect(ceilWholeRupee(53)).toBe(53);
    expect(ceilWholeRupee(53.01)).toBe(54);
    expect(ceilWholeRupee(53.999)).toBe(54);
  });
});

describe('evaluateReceiving', () => {
  it('vendor rate + default margin, rounded up, with no receiving cost', () => {
    const { groups, issues } = run([group()]);
    expect(issues).toEqual([]);
    expect(at(groups, 0)).toMatchObject({ markCode: 'AA', landedCostPerKg: 47, calculatedFinalRate: 53, acceptedWeightKg: 500 });
  });

  it('spreads a receiving expense across groups by received kg', () => {
    const { groups } = run([group(), group({ id: 'g2', markCode: 'J', receivedBags: 5, acceptedBags: 5, receivedWeightKg: 250, originalPurchaseRate: 40 })], [expense({ amount: 750 })]);
    expect(groups.map((g) => g.allocatedReceivingCostPerKg)).toEqual([1, 1]); // 750 / 750 kg
    expect(groups.map((g) => g.calculatedFinalRate)).toEqual([54, 47]); // 47+1+6 = 54 ; 40+1+6 = 47
    expect(at(groups, 0).rateSnapshot).toMatchObject({ allocatedReceivingExpensePerKg: 1, finalSellingRatePerKg: 54 });
  });

  it('assigns an expense to one group only and adds extra margins', () => {
    const { groups } = run(
      [group(), group({ id: 'g2', markCode: 'J', originalPurchaseRate: 40 })],
      [expense({ amount: 500, allocation: { method: 'ASSIGN_TO_GROUP', groupId: 'g2' } })],
      [{ id: 'm1', name: 'Quality', perKg: 2 }],
    );
    expect(at(groups, 0).allocatedReceivingCostPerKg).toBe(0);
    expect(at(groups, 1).allocatedReceivingCostPerKg).toBe(1);
    expect(groups.map((g) => g.calculatedFinalRate)).toEqual([55, 49]);
  });

  it('posts accepted + defective bags and weights them from the received weight', () => {
    const { groups } = run([group({ receivedBags: 10, acceptedBags: 7, defectiveBags: 1, receivedWeightKg: 500 })]);
    expect(takenInspectionQuantity(at(groups, 0))).toEqual({ bags: 8, weightKg: 400 });
    expect(at(groups, 0).acceptedWeightKg).toBe(350);
  });

  it('per-bag weights win over the typed total; a mismatch blocks', () => {
    const bagWeights = [50, 50, 49.5].map((weightKg, i) => ({ bagNumber: i + 1, weightKg }));
    const mismatch = run([group({ receivedBags: 3, acceptedBags: 3, receivedWeightKg: 200, bagWeights })]);
    expect(mismatch.issues.find((i) => i.blocking)?.message).toMatch(/Bag weights total 149\.50 kg/);
    const ok = run([group({ receivedBags: 3, acceptedBags: 3, receivedWeightKg: 149.5, bagWeights })]);
    expect(ok.issues.filter((i) => i.blocking)).toEqual([]);
    expect(at(ok.groups, 0).receivedWeightKg).toBe(149.5);
  });

  it('blocks a manual rate without a reason and allows it with one', () => {
    expect(run([group({ revisedSellingRate: 60 })]).issues.some((i) => i.blocking && /without a reason/.test(i.message))).toBe(true);
    const ok = run([group({ revisedSellingRate: 60, overrideReason: 'Market fell' })]);
    expect(ok.issues.filter((i) => i.blocking)).toEqual([]);
    expect(appliedSellingRate(at(ok.groups, 0))).toBe(60);
  });

  it('blocks duplicate marks and weightless spread; mismatches only warn', () => {
    expect(run([group(), group({ id: 'g2' })]).issues.some((i) => i.blocking && /more than one group/.test(i.message))).toBe(true);
    const noWeight = run([group({ receivedWeightKg: 0 })], [expense()]);
    expect(noWeight.issues.some((i) => i.blocking)).toBe(true);
    const short = run([group({ receivedBags: 9, acceptedBags: 9, receivedWeightKg: 450 })]);
    expect(short.issues.every((i) => !i.blocking)).toBe(true);
    expect(short.issues).toHaveLength(2); // expected-vs-received bags and kg
  });
});

describe('amount basis and commission precedence', () => {
  const ok = group({
    id: 'ok', markCode: 'KAOK', expectedBags: 35, receivedBags: 35, acceptedBags: 35,
    expectedWeightKg: 1167, receivedWeightKg: 1167, originalPurchaseRate: 46.5,
  });
  const rest = group({
    id: 'rest', markCode: 'REST', expectedBags: 478, receivedBags: 478, acceptedBags: 478,
    expectedWeightKg: 24030, receivedWeightKg: 24030, originalPurchaseRate: 40,
  });

  it('keeps an exact rupee and ceilings any paise above it', () => {
    expect(ceilWholeRupee(52)).toBe(52);
    expect(ceilWholeRupee(52.01)).toBe(53);
    expect(ceilWholeRupee(52.2)).toBe(53);
    expect(ceilWholeRupee(52.99)).toBe(53);
    expect(ceilWholeRupee(53)).toBe(53);
  });

  it('spreads a fixed transport total by received kg without rounding the share to a rupee', () => {
    const { groups, issues } = run([ok, rest], [expense({ amount: 20000, amountBasis: 'FIXED_TOTAL' })]);
    expect(issues.filter((issue) => issue.blocking)).toEqual([]);
    const perKg = 20000 / 25197;
    expect(at(groups, 0).allocatedReceivingCostPerKg).toBeCloseTo(perKg, 10);
    expect(at(groups, 0).allocatedReceivingCostPerKg).not.toBe(Math.round(perKg));
    expect((at(groups, 0).allocatedReceivingCostPerKg ?? 0) * 1167).toBeCloseTo((1167 * 20000) / 25197, 6);
    const allocated = groups.reduce((sum, item) => sum + (item.allocatedReceivingCostPerKg ?? 0) * item.receivedWeightKg, 0);
    expect(allocated).toBeCloseTo(20000, 6);
  });

  it('charges a per-bag rate for every eligible bag, then states that mark cost per kg', () => {
    const { groups, issues } = run([ok, rest], [expense({
      amount: 5, amountBasis: 'PER_BAG', expenseTypeName: 'Loading', allocation: { method: 'BY_RECEIVED_BAGS' },
    })]);
    expect(issues.filter((issue) => issue.blocking)).toEqual([]);
    expect(at(groups, 0).allocatedReceivingCostPerKg).toBeCloseTo(175 / 1167, 10);
    expect(at(groups, 0).allocatedReceivingCostPerKg).not.toBeCloseTo(5 / 513, 6);
    const allocated = groups.reduce((sum, item) => sum + (item.allocatedReceivingCostPerKg ?? 0) * item.receivedWeightKg, 0);
    expect(allocated).toBeCloseTo(513 * 5, 6);
  });

  it('refuses a per-bag rate spread by kilograms and a per-kg rate spread by bags', () => {
    expect(run([ok], [expense({ amount: 5, amountBasis: 'PER_BAG' })]).issues.some((issue) => issue.blocking)).toBe(true);
    expect(run([ok], [expense({ amount: 1, amountBasis: 'PER_KG', allocation: { method: 'BY_RECEIVED_BAGS' } })]).issues.some((issue) => issue.blocking)).toBe(true);
    expect(run([group({ receivedBags: 0, acceptedBags: 0, receivedWeightKg: 0 })], [expense({ amount: 5, amountBasis: 'PER_BAG', allocation: { method: 'BY_RECEIVED_BAGS' } })]).issues.some((issue) => issue.blocking)).toBe(true);
  });

  it('uses mark commission, then the lot commission, then the settings default', () => {
    const lot = evaluateReceiving({
      draft: { groups: [group({ id: 'a', markCode: 'A' }), group({ id: 'b', markCode: 'B', marginPerKg: 4 })], expenses: [], lotMarginPerKg: 8 },
      settings, margins: [],
    });
    expect(lot.groups.map((item) => item.calculatedFinalRate)).toEqual([55, 51]);
    expect(lot.groups.map((item) => item.appliedMarginPerKg)).toEqual([8, 4]);
    expect(at(lot.groups, 0).rateSnapshot?.appliedMarginPerKg).toBe(8);

    const markReset = evaluateReceiving({
      draft: { groups: [group({ id: 'a', markCode: 'A' }), group({ id: 'b', markCode: 'B', marginPerKg: null })], expenses: [], lotMarginPerKg: 8 },
      settings, margins: [],
    });
    expect(markReset.groups.map((item) => item.calculatedFinalRate)).toEqual([55, 55]);

    const lotReset = evaluateReceiving({
      draft: { groups: [group({ id: 'a', markCode: 'A' }), group({ id: 'b', markCode: 'B' })], expenses: [] },
      settings, margins: [],
    });
    expect(lotReset.groups.map((item) => item.calculatedFinalRate)).toEqual([53, 53]);
  });

  it('recalculates transport, the per-bag rate and the lot commission once', () => {
    const loading = (amount: number): ReceivingExpense => expense({
      id: 'load', amount, amountBasis: 'PER_BAG', expenseTypeName: 'Loading', allocation: { method: 'BY_RECEIVED_BAGS' },
    });
    const first = run([ok, rest], [expense({ amount: 20000 }), loading(5)]);
    const second = evaluateReceiving({
      draft: { groups: [ok, rest], expenses: [expense({ amount: 10000 }), loading(4)], lotMarginPerKg: 7 },
      settings, margins: [],
    });
    const transport = 10000 / 25197;
    const loadingPerKg = (35 * 4) / 1167;
    const unrounded = 46.5 + transport + loadingPerKg + 7;
    expect(at(second.groups, 0).allocatedReceivingCostPerKg).toBeCloseTo(transport + loadingPerKg, 10);
    expect(at(second.groups, 0).preliminarySellingRate).toBeCloseTo(46.5 + 7, 10);
    expect(at(second.groups, 0).calculatedFinalRate).toBe(ceilWholeRupee(unrounded));
    expect(at(second.groups, 0).calculatedFinalRate).not.toBe(at(first.groups, 0).calculatedFinalRate);
    const allocated = second.groups.reduce((sum, item) => sum + (item.allocatedReceivingCostPerKg ?? 0) * item.receivedWeightKg, 0);
    expect(allocated).toBeCloseTo(10000 + 513 * 4, 4);
  });

  it('spreads a fixed ₹10,000 total by bags, then states that mark share per kg', () => {
    const { groups, issues } = run([ok, rest], [expense({ amount: 10000, amountBasis: 'FIXED_TOTAL', allocation: { method: 'BY_RECEIVED_BAGS' } })]);
    expect(issues.filter((issue) => issue.blocking)).toEqual([]);
    const markRupees = (35 * 10000) / 513;
    expect(markRupees).toBeCloseTo(682.26, 2);
    expect((at(groups, 0).allocatedReceivingCostPerKg ?? 0) * 1167).toBeCloseTo(markRupees, 8);
    expect(at(groups, 0).allocatedReceivingCostPerKg).toBeCloseTo(markRupees / 1167, 10);
    expect(at(groups, 1).allocatedReceivingCostPerKg).toBeGreaterThan(0);
  });

  it('keeps a direct mark expense on that mark', () => {
    const { groups } = run([ok, rest], [expense({ amount: 500, allocation: { method: 'ASSIGN_TO_GROUP', groupId: 'ok' } })]);
    expect(at(groups, 0).allocatedReceivingCostPerKg).toBeCloseTo(500 / 1167, 10);
    expect(at(groups, 1).allocatedReceivingCostPerKg).toBe(0);
  });

  it('ceilings 54.20 to 55 and leaves an exact 54', () => {
    expect(ceilWholeRupee(54.2)).toBe(55);
    expect(ceilWholeRupee(54)).toBe(54);
    const above = run([group({ originalPurchaseRate: 48.2 })]);
    const exact = run([group({ originalPurchaseRate: 48 })]);
    expect(at(above.groups, 0).calculatedFinalRate).toBe(55);
    expect(at(exact.groups, 0).calculatedFinalRate).toBe(54);
  });

  it('ceilings 52.20 to 53 and leaves an exact 52', () => {
    const above = run([group({ originalPurchaseRate: 46.2 })]);
    const exact = run([group({ originalPurchaseRate: 46 })]);
    expect(at(above.groups, 0).preliminarySellingRate).toBeCloseTo(52.2, 10);
    expect(at(above.groups, 0).calculatedFinalRate).toBe(53);
    expect(at(exact.groups, 0).calculatedFinalRate).toBe(52);
  });
});
