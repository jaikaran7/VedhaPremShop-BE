import { lineAmountPaise, toGrams, toPaise } from '../../common/money';
import { priceBill, settle, stockDraws } from './sales.calc';

const charges = { amaliPerBag: 20, marketFeePerBag: 10, amaliEnabled: true, marketFeeEnabled: true };
const bags = (...kg: number[]) => kg.map((weightKg, i) => ({ bagNumber: i + 1, weightKg }));

describe('line amount', () => {
  it('rounds kg × rate to the whole rupee, half up, like the frontend', () => {
    expect(lineAmountPaise(toGrams(151), toPaise(69))).toBe(1041900); // VPN-INV-1081 line: 151 kg @ ₹69 = ₹10,419
    expect(lineAmountPaise(toGrams(151.5), toPaise(69))).toBe(1045400); // 10453.5 → 10454
    expect(lineAmountPaise(toGrams(0.1), toPaise(0.3))).toBe(0); // 0.03 → 0
    expect(lineAmountPaise(toGrams(50.125), toPaise(47.35))).toBe(237300); // 2373.41875 → 2373
  });

  it('avoids float drift: 0.1 + 0.2 kg is 0.3 kg exactly', () => {
    expect(toGrams(0.1) + toGrams(0.2)).toBe(toGrams(0.3));
  });
});

describe('priceBill', () => {
  it('derives bags and kg from bag weights and adds per-bag charges once', () => {
    const bill = priceBill([
      { lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.5, 50, 50.5) },
      { lotNumber: 'LOT AP', markCode: 'K', ratePerKg: 58.5, bagWeights: bags(49) },
    ], charges);
    expect(bill.totalBags).toBe(4);
    expect(bill.totalGrams).toBe(200_000);
    expect(bill.lines[0]!.amountPaise).toBe(1041900); // 151 kg × ₹69
    expect(bill.subtotalPaise).toBe(bill.lines[0]!.amountPaise + bill.lines[1]!.amountPaise);
    expect(bill.amaliPaise).toBe(8000);
    expect(bill.marketFeePaise).toBe(4000);
    expect(bill.totalPaise).toBe(bill.subtotalPaise + 12000);
  });

  it('skips disabled charges', () => {
    const bill = priceBill([{ lotNumber: 'L', markCode: 'M', ratePerKg: 10, bagWeights: bags(10) }], { ...charges, amaliEnabled: false });
    expect(bill.amaliPaise).toBe(0);
    expect(bill.totalPaise).toBe(10000 + 1000);
  });

  it('groups lines on the same lot+mark case-insensitively for one stock draw', () => {
    const bill = priceBill([
      { lotNumber: 'LOT AP', markCode: 'aa', ratePerKg: 69, bagWeights: bags(50) },
      { lotNumber: 'lot ap', markCode: 'AA', ratePerKg: 70, bagWeights: bags(49, 51) },
    ], charges);
    expect(stockDraws(bill.lines)).toEqual([{ lotNumber: 'LOT AP', markCode: 'aa', bags: 3, grams: 150_000 }]);
  });
});

describe('settle', () => {
  const base = { totalPaise: 1_000_000, saleDate: '2026-10-25', hasCustomer: true, creditDays: 7 };

  it('cash in full', () => {
    const s = settle({ ...base, tenders: [{ method: 'CASH', amount: 10_000 }] });
    expect(s).toMatchObject({ paymentStatus: 'PAID', paymentType: 'CASH', balancePaise: 0, creditDays: null, dueDate: null });
  });

  it('split in full', () => {
    const s = settle({ ...base, tenders: [{ method: 'CASH', amount: 4000 }, { method: 'UPI', amount: 6000 }] });
    expect(s.paymentType).toBe('SPLIT');
  });

  it('partial: balance on credit with due date', () => {
    const s = settle({ ...base, tenders: [{ method: 'UPI', amount: 4000 }] });
    expect(s).toMatchObject({ paymentStatus: 'PARTIAL', paymentType: 'PARTIAL', paidPaise: 400_000, balancePaise: 600_000, dueDate: '2026-11-01' });
  });

  it('credit: ignores zero tenders', () => {
    const s = settle({ ...base, tenders: [{ method: 'CASH', amount: 0 }] });
    expect(s).toMatchObject({ paymentStatus: 'CREDIT', paymentType: 'CREDIT', tenders: [] });
  });

  it('rejects overpayment at the counter and counter-sale credit', () => {
    expect(() => settle({ ...base, tenders: [{ method: 'CASH', amount: 10_000.01 }] })).toThrow('cannot exceed');
    expect(() => settle({ ...base, hasCustomer: false, tenders: [] })).toThrow('counter sale');
  });

  it('falls back to the customer default credit days', () => {
    expect(settle({ ...base, creditDays: undefined, defaultCreditDays: 14, tenders: [] })).toMatchObject({ creditDays: 14, dueDate: '2026-11-08' });
  });

  it('counts money carried from a replaced counter bill', () => {
    const s = settle({ ...base, hasCustomer: false, carriedPaise: 600_000, tenders: [{ method: 'CASH', amount: 4000 }] });
    expect(s).toMatchObject({ paymentStatus: 'PAID', paymentType: 'SPLIT', paidPaise: 1_000_000 });
    expect(() => settle({ ...base, hasCustomer: false, carriedPaise: 600_000, tenders: [{ method: 'CASH', amount: 4001 }] })).toThrow('cannot exceed');
  });
});
