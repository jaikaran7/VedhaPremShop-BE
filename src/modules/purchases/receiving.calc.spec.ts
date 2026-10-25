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
