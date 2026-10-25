import { settleBills, vendorPosition } from './vendor-ledger.calc';

describe('vendorPosition', () => {
  it('no payment: old dues and new bills both owed', () => {
    expect(vendorPosition(250_000_00, 100_000_00, 0)).toEqual({ previousDuePaise: 250_000_00, newDuePaise: 100_000_00, advancePaise: 0, payablePaise: 350_000_00 });
  });

  it('payments clear the old dues before the new bills', () => {
    // owed 2,50,000 before + 1,00,000 new; paid 1,80,000 -> 70,000 of old dues left, new bill untouched
    expect(vendorPosition(250_000_00, 100_000_00, 180_000_00)).toMatchObject({ previousDuePaise: 70_000_00, newDuePaise: 100_000_00, payablePaise: 170_000_00 });
    // paid 3,00,000 -> old cleared, 50,000 goes to the new bill
    expect(vendorPosition(250_000_00, 100_000_00, 300_000_00)).toMatchObject({ previousDuePaise: 0, newDuePaise: 50_000_00, payablePaise: 50_000_00 });
  });

  it('paying more than owed becomes an advance, and a later bill uses it up', () => {
    expect(vendorPosition(0, 100_000_00, 120_000_00)).toEqual({ previousDuePaise: 0, newDuePaise: 0, advancePaise: 20_000_00, payablePaise: 0 });
    // next bill of 50,000: the 20,000 advance is used, 30,000 is owed
    expect(vendorPosition(0, 150_000_00, 120_000_00)).toMatchObject({ newDuePaise: 30_000_00, advancePaise: 0 });
  });

  it('an advance paid before go-live (negative opening) is used by the first bills', () => {
    expect(vendorPosition(-10_000_00, 25_000_00, 0)).toMatchObject({ previousDuePaise: 0, newDuePaise: 15_000_00, advancePaise: 0 });
  });

  it('always: payable − advance = opening + billed − paid', () => {
    for (const opening of [-5_000_00, 0, 7_000_00]) for (const billed of [0, 3_000_00, 12_000_00]) for (const paid of [0, 4_000_00, 9_000_00, 30_000_00]) {
      const p = vendorPosition(opening, billed, paid);
      expect(p.payablePaise - p.advancePaise).toBe(opening + billed - paid);
      expect(p.previousDuePaise).toBeGreaterThanOrEqual(0);
      expect(p.newDuePaise).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('settleBills', () => {
  const bills = [{ id: 'a', netPaise: 100_00 }, { id: 'b', netPaise: 200_00 }, { id: 'c', netPaise: 300_00 }];

  it('clears oldest bills first after the old dues', () => {
    expect(settleBills(50_00, bills, 200_00).map((b) => [b.id, b.paidPaise, b.status])).toEqual([['a', 100_00, 'PAID'], ['b', 50_00, 'PARTIAL'], ['c', 0, 'UNPAID']]);
  });

  it('payments that only cover the old dues leave every bill unpaid', () => {
    expect(settleBills(500_00, bills, 400_00).every((b) => b.status === 'UNPAID')).toBe(true);
  });

  it('settled amounts add up to what the position says is paid on bills', () => {
    const settled = settleBills(100_00, bills, 650_00);
    expect(settled.reduce((t, b) => t + b.paidPaise, 0)).toBe(550_00);
    expect(settled.reduce((t, b) => t + b.balancePaise, 0)).toBe(vendorPosition(100_00, 600_00, 650_00).newDuePaise);
  });
});
