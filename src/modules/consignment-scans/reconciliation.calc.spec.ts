import { toGrams, toPaise } from '../../common/money';
import { BILL_ROWS, SHEET_ROWS } from '../../../test/fixtures/consignment/reference';
import { type CalcHeader, type CalcLine, type CalcMark, expectedAmountPaise, reconcile, type ReconcileInput, subsetWithBags } from './reconciliation.calc';

const HEADER: CalcHeader = {
  vendorPartyId: 'v', productId: 'p', lotNumber: '22102026 KA', billNumber: '00045', billDate: '2026-10-22', sheetDate: '2026-10-22',
  printedBillBags: 513, printedBillGrams: 25_197_000, printedGrossPaise: 105_765_670, printedExpensesPaise: 8_459_230, printedNetPaise: 114_224_900, printedSheetBags: 513,
};
const line = (position: number, bags: number, kg: number, rate: number, amount: number, assignedMarkId: string | null = null): CalcLine => ({
  id: `L${position}`, position, bags, grams: toGrams(kg), ratePaise: toPaise(rate), amountPaise: toPaise(amount), assignedMarkId, needsReview: false,
});
const mark = (position: number, code: string, bags: number, min: number, max = min): CalcMark => ({
  id: `M${code}`, position, markCode: code, bags, rateMinPaise: toPaise(min), rateMaxPaise: toPaise(max), needsReview: false,
});
const EXPENSES = [
  { id: 'E1', label: 'Hamali', category: 'HAMALI', amountPaise: 410_400, includeInCost: true },
  { id: 'E2', label: 'M/Ses', category: 'MARKET_FEE', amountPaise: 1_110_540, includeInCost: true },
  { id: 'E3', label: 'Commission', category: 'COMMISSION', amountPaise: 6_345_950, includeInCost: true },
  { id: 'E4', label: 'Levy', category: 'LEVY', amountPaise: 92_340, includeInCost: true },
  { id: 'E5', label: 'Driver Advance', category: 'DRIVER_ADVANCE', amountPaise: 500_000, includeInCost: false },
];
const reference = (): ReconcileInput => ({
  header: { ...HEADER },
  rateUnit: 'PER_10_KG',
  lines: BILL_ROWS.map(([bags, kg, rate, amount], i) => line(i + 1, bags, kg, rate, amount)),
  marks: SHEET_ROWS.map(([bags, min, max, code], i) => mark(i + 1, code, bags, min, max)),
  expenses: EXPENSES,
});
const codes = (r: ReturnType<typeof reconcile>) => r.issues.map((i) => i.code);
const markOf = (r: ReturnType<typeof reconcile>, lineId: string) => r.matches.find((m) => m.lineId === lineId);

describe('reconcile — reference consignment (bill 00045 / mark sheet KA56 3515)', () => {
  const result = reconcile(reference(), 4);

  it('proves the vendor quotes rates per 10 kg from the printed amounts', () => {
    expect(result.rateUnitEvidence).toEqual({ checked: 53, agreeing: { PER_KG: 0, PER_10_KG: 53, PER_BAG: 0 }, suggested: 'PER_10_KG' });
    expect(expectedAmountPaise({ bags: 42, grams: 1_986_000, ratePaise: 46_500 }, 'PER_10_KG')).toBe(9_234_900);
  });

  it('cross-checks every printed total exactly', () => {
    expect(result.totals).toMatchObject({ lineBags: 513, markBags: 513, lineGrams: 25_197_000, linesAmountPaise: 105_765_670, expensesPaise: 8_459_230, netPaise: 114_224_900, costExpensesPaise: 7_959_230 });
    expect(codes(result).filter((c) => c.startsWith('BILL_') || c.startsWith('SHEET_'))).toEqual([]);
    expect(codes(result)).not.toContain('LINE_AMOUNT_MISMATCH');
  });

  it('matches single-rate marks to the one bill line with the same bags and rate', () => {
    expect(markOf(result, 'L13')).toMatchObject({ markId: 'MA', method: 'EXACT' });
    expect(markOf(result, 'L14')).toMatchObject({ markId: 'MK', method: 'EXACT' });
    expect(markOf(result, 'L20')).toMatchObject({ markId: 'MP', method: 'EXACT' });
    expect(markOf(result, 'L19')).toMatchObject({ markId: 'M27', method: 'EXACT' });
    expect(markOf(result, 'L44')).toMatchObject({ markId: 'MPB', method: 'EXACT' });
  });

  it('pairs HB and EG (both 5 bags at 300) in order and flags the ambiguity', () => {
    expect(markOf(result, 'L37')?.markId).toBe('MHB');
    expect(markOf(result, 'L48')?.markId).toBe('MEG');
    expect(result.issues.find((i) => i.code === 'AMBIGUOUS_MATCH')?.refs?.markIds).toEqual(['MHB', 'MEG']);
  });

  it('fills range marks only with lines inside the written range, never by averaging', () => {
    const ok = result.marks.find((m) => m.markCode === 'OK');
    const bk = result.marks.find((m) => m.markCode === 'BK');
    expect(ok).toMatchObject({ matchedBags: 23, status: 'SHORT', ratesPaise: [46_000, 47_000] });
    expect(bk).toMatchObject({ matchedBags: 37, status: 'SHORT', ratesPaise: [28_000, 29_000, 30_000, 30_500, 31_000] });
  });

  it('leaves the 25 out-of-range bags unmatched, blocks confirm, and suggests the nearest short mark', () => {
    const free = result.matches.filter((m) => m.markId === null);
    expect(free.map((m) => m.lineId)).toEqual(['L1', 'L4', 'L11', 'L30', 'L33', 'L39', 'L40', 'L43', 'L52']);
    expect(free.map((m) => m.suggestedMarkId)).toEqual(['MOK', 'MOK', 'MOK', 'MBK', 'MBK', 'MBK', 'MBK', 'MBK', 'MBK']);
    expect(result.canConfirm).toBe(false);
    expect(codes(result).filter((c) => c === 'LINE_UNMATCHED')).toHaveLength(9);
    expect(codes(result)).toEqual(expect.arrayContaining(['MARK_SHORT']));
  });

  it('is confirmable once a person accepts the suggestions; range marks become one purchase line per printed rate', () => {
    const input = reference();
    for (const m of result.matches) {
      const target = input.lines.find((l) => l.id === m.lineId) as CalcLine;
      if (m.markId === null) target.assignedMarkId = m.suggestedMarkId;
    }
    const after = reconcile(input, 4);
    expect(after.issues.filter((i) => i.severity === 'CRITICAL')).toEqual([]);
    expect(after.canConfirm).toBe(true);
    expect(after.marks.every((m) => m.status === 'MATCHED')).toBe(true);
    expect(after.purchaseLines).toHaveLength(30);
    expect(after.purchaseLines.filter((l) => l.markCode.startsWith('OK')).map((l) => l.markCode)).toEqual(['OK420', 'OK440', 'OK450', 'OK460', 'OK470']);
    expect(after.purchaseLines.find((l) => l.markCode === 'A')).toMatchObject({ bags: 42, grams: 1_986_000, ratePerKgPaise: 4650, vendorAmountPaise: 9_234_900 });
    expect(after.purchaseLines.reduce((t, l) => t + l.bags, 0)).toBe(513);
    // 82175.20 → 82175, and three ".50" amounts → up: +₹1.30 against the vendor's paise amounts.
    expect(after.roundingDifferencePaise).toBe(130);
    expect(codes(after)).toContain('ROUNDING_DIFFERENCE');
    expect(after.issues.find((i) => i.code === 'DRIVER_ADVANCE')?.message).toContain('not added to');
  });
});

describe('reconcile — rules', () => {
  const base = (lines: CalcLine[], marks: CalcMark[]): ReconcileInput => ({
    header: { ...HEADER, printedBillBags: null, printedBillGrams: null, printedGrossPaise: null, printedExpensesPaise: null, printedNetPaise: null, printedSheetBags: null },
    rateUnit: 'PER_KG', lines, marks, expenses: [],
  });

  it('groups several lines at one rate whose bags add up to the mark', () => {
    const r = reconcile(base([line(1, 3, 150, 40, 6000), line(2, 2, 100, 40, 4000), line(3, 4, 200, 50, 10_000)], [mark(1, 'A', 5, 40), mark(2, 'B', 4, 50)]));
    expect(r.matches.map((m) => [m.markId, m.method])).toEqual([['MA', 'GROUPED'], ['MA', 'GROUPED'], ['MB', 'EXACT']]);
    expect(r.canConfirm).toBe(true);
  });

  it('a manual assignment always wins over an automatic match', () => {
    const r = reconcile(base([line(1, 5, 250, 40, 10_000, 'MB')], [mark(1, 'A', 5, 40), mark(2, 'B', 5, 41)]));
    expect(r.matches[0]).toMatchObject({ markId: 'MB', method: 'MANUAL' });
    expect(codes(r)).toEqual(expect.arrayContaining(['MARK_SHORT']));
  });

  it('takes a subset when in-range lines exceed a range mark', () => {
    const r = reconcile(base([line(1, 3, 150, 40, 6000), line(2, 2, 100, 42, 4200), line(3, 4, 200, 41, 8200)], [mark(1, 'R', 5, 40, 42)]));
    expect(r.matches.filter((m) => m.markId === 'MR').map((m) => m.lineId)).toEqual(['L1', 'L2']);
    expect(codes(r)).toEqual(expect.arrayContaining(['AMBIGUOUS_MATCH', 'LINE_UNMATCHED']));
  });

  it('flags a misread amount, an unknown convention, duplicate marks and missing header fields', () => {
    const input = base([line(1, 5, 250, 40, 9999)], [mark(1, 'A', 5, 40), mark(2, 'a', 0, 40)]);
    expect(codes(reconcile(input))).toEqual(expect.arrayContaining(['LINE_AMOUNT_MISMATCH', 'DUPLICATE_MARK']));
    expect(codes(reconcile({ ...input, rateUnit: null }))).toContain('RATE_UNIT_UNKNOWN');
    expect(codes(reconcile({ ...input, rateUnit: 'PER_BAG' }))).toContain('RATE_UNIT_PER_BAG_UNSUPPORTED');
    expect(reconcile({ ...input, header: { ...input.header, vendorPartyId: null, billNumber: ' ' } }).issues.filter((i) => i.code === 'MISSING_FIELD')).toHaveLength(2);
  });

  it('subset search prefers earlier lines and returns null when no combination fits', () => {
    expect(subsetWithBags([{ bags: 2 }, { bags: 3 }, { bags: 5 }], 5)).toEqual([0, 1]);
    expect(subsetWithBags([{ bags: 2 }, { bags: 4 }], 5)).toBeNull();
    expect(subsetWithBags([{ bags: 0 }, { bags: 5 }], 5)).toEqual([1]);
  });
});
