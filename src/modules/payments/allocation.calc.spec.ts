import { planAllocation } from './allocation.calc';

const debts = [
  { saleId: null, balancePaise: 10_000 }, // opening balance, oldest
  { saleId: 'old', balancePaise: 30_000 },
  { saleId: 'new', balancePaise: 20_000 },
];

describe('planAllocation', () => {
  it('settles debts in the given order (FIFO)', () => {
    expect(planAllocation([{ paymentId: 'p1', availablePaise: 25_000 }], debts)).toEqual([
      { paymentId: 'p1', saleId: null, amountPaise: 10_000 },
      { paymentId: 'p1', saleId: 'old', amountPaise: 15_000 },
    ]);
  });

  it('spreads several receipts, oldest first', () => {
    expect(planAllocation([{ paymentId: 'p1', availablePaise: 5_000 }, { paymentId: 'p2', availablePaise: 50_000 }], debts.slice(1))).toEqual([
      { paymentId: 'p1', saleId: 'old', amountPaise: 5_000 },
      { paymentId: 'p2', saleId: 'old', amountPaise: 25_000 },
      { paymentId: 'p2', saleId: 'new', amountPaise: 20_000 },
    ]);
  });

  it('leaves excess credit unallocated (advance) and excess debt open', () => {
    const lines = planAllocation([{ paymentId: 'p1', availablePaise: 100_000 }], debts);
    expect(lines.reduce((s, l) => s + l.amountPaise, 0)).toBe(60_000);
    expect(planAllocation([], debts)).toEqual([]);
  });
});
