import { saleItemsFingerprint, sameSaleLines } from './sale-match';

describe('saleItemsFingerprint', () => {
  it('treats the same bags and rate as one bill even when the lines are listed in another order', () => {
    const a = [
      { lotNumber: 'lot ap', markCode: 'aa', ratePerKg: 69, bagWeights: [{ weightKg: 50 }, { weightKg: 50.5 }] },
      { lotNumber: 'LOT AP', markCode: 'J', ratePerKg: 64, bagWeights: [{ weightKg: 48 }] },
    ];
    const b = [
      { lotNumber: 'LOT AP', markCode: 'J', bags: 1, weightKg: 48, ratePerKg: 64 },
      { lotNumber: 'LOT AP', markCode: 'AA', bags: 2, weightKg: 100.5, ratePerKg: 69 },
    ];
    expect(sameSaleLines(a, b)).toBe(true);
  });

  it('does not match a different weight or rate', () => {
    const base = [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: [{ weightKg: 50 }] }];
    expect(saleItemsFingerprint(base)).not.toBe(saleItemsFingerprint([{ ...base[0]!, ratePerKg: 70 }]));
    expect(saleItemsFingerprint(base)).not.toBe(
      saleItemsFingerprint([{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: [{ weightKg: 51 }] }]),
    );
  });
});
