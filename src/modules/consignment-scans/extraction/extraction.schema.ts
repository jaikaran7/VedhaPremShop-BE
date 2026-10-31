/**
 * What the AI must return, as JSON Schema (sent to Gemini as responseJsonSchema) and as a strict validator (the model's
 * output is untrusted input). Every value carries the raw text it was read from and a confidence band; rows carry their
 * source page and row. The model never calculates: totals are the numbers printed on the document.
 */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export interface Field<T> {
  value: T | null;
  raw: string;
  confidence: Confidence;
}

export interface BillLineOut {
  page: number;
  row: number;
  itemName: Field<string>;
  bags: Field<number>;
  weightKg: Field<number>;
  rate: Field<number>;
  amount: Field<number>;
}

export interface BillExpenseOut {
  label: string;
  category: 'HAMALI' | 'MARKET_FEE' | 'COMMISSION' | 'LEVY' | 'DRIVER_ADVANCE' | 'FREIGHT' | 'OTHER';
  amount: Field<number>;
}

export interface VendorBillOut {
  vendorName: Field<string>;
  buyerName: Field<string>;
  billNumber: Field<string>;
  billDate: Field<string>;
  lines: BillLineOut[];
  expenses: BillExpenseOut[];
  totals: { bags: Field<number>; weightKg: Field<number>; goodsTotal: Field<number>; totalExpenses: Field<number>; totalAmount: Field<number> };
}

export interface MarkRowOut {
  page: number;
  row: number;
  side: 'LEFT' | 'RIGHT' | 'SINGLE';
  bags: Field<number>;
  rateMin: Field<number>;
  rateMax: Field<number>;
  mark: Field<string>;
}

export interface MarkSheetOut {
  date: Field<string>;
  lotRef: Field<string>;
  totalBags: Field<number>;
  marks: MarkRowOut[];
}

export const EXPENSE_CATEGORIES = ['HAMALI', 'MARKET_FEE', 'COMMISSION', 'LEVY', 'DRIVER_ADVANCE', 'FREIGHT', 'OTHER'] as const;
const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
const MAX_ROWS = 300;

// ---- JSON Schema for the model -------------------------------------------------------------------------------------
// No maxItems: Gemini rejects the request with it (400, checked 2026-10-31). Row limits are enforced by the validator below.
const field = (type: 'string' | 'number') => ({
  type: 'object',
  properties: { value: { type: [type, 'null'] }, raw: { type: 'string' }, confidence: { type: 'string', enum: CONFIDENCES } },
  required: ['value', 'raw', 'confidence'],
});
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties) });

export const VENDOR_BILL_JSON_SCHEMA = obj({
  vendorName: field('string'), buyerName: field('string'), billNumber: field('string'), billDate: field('string'),
  lines: { type: 'array', items: obj({ page: { type: 'integer' }, row: { type: 'integer' }, itemName: field('string'), bags: field('number'), weightKg: field('number'), rate: field('number'), amount: field('number') }) },
  expenses: { type: 'array', items: obj({ label: { type: 'string' }, category: { type: 'string', enum: EXPENSE_CATEGORIES }, amount: field('number') }) },
  totals: obj({ bags: field('number'), weightKg: field('number'), goodsTotal: field('number'), totalExpenses: field('number'), totalAmount: field('number') }),
});

export const MARK_SHEET_JSON_SCHEMA = obj({
  date: field('string'), lotRef: field('string'), totalBags: field('number'),
  marks: { type: 'array', items: obj({ page: { type: 'integer' }, row: { type: 'integer' }, side: { type: 'string', enum: ['LEFT', 'RIGHT', 'SINGLE'] }, bags: field('number'), rateMin: field('number'), rateMax: field('number'), mark: field('string') }) },
});

// ---- Validation ------------------------------------------------------------------------------------------------------
export class ExtractionShapeError extends Error {}

const fail = (path: string, what: string): never => {
  throw new ExtractionShapeError(`${path}: ${what}`);
};
const record = (v: unknown, path: string): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(path, 'expected an object'));
const list = (v: unknown, path: string, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : fail(path, `expected an array of at most ${max}`));
const int = (v: unknown, path: string): number => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 10_000 ? (v as number) : fail(path, 'expected a small whole number'));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], path: string): T => (allowed.includes(v as T) ? (v as T) : fail(path, `expected one of ${allowed.join(', ')}`));

function readField<T extends string | number>(v: unknown, kind: 'string' | 'number', path: string): Field<T> {
  const f = record(v, path);
  const raw = typeof f.raw === 'string' ? f.raw.slice(0, 200) : fail(`${path}.raw`, 'expected text');
  const confidence = oneOf(f.confidence, CONFIDENCES, `${path}.confidence`);
  if (f.value === null || f.value === undefined) return { value: null, raw, confidence };
  if (kind === 'number' && (typeof f.value !== 'number' || !Number.isFinite(f.value) || f.value < 0 || f.value > 1e9)) fail(`${path}.value`, 'expected a non-negative number');
  if (kind === 'string' && typeof f.value !== 'string') fail(`${path}.value`, 'expected text');
  const value = (kind === 'string' ? (f.value as string).trim().slice(0, 200) : f.value) as T;
  return { value, raw, confidence };
}

const num = (v: unknown, path: string) => readField<number>(v, 'number', path);
const str = (v: unknown, path: string) => readField<string>(v, 'string', path);

export function parseVendorBill(input: unknown): VendorBillOut {
  const o = record(input, 'bill');
  const totals = record(o.totals, 'bill.totals');
  return {
    vendorName: str(o.vendorName, 'vendorName'), buyerName: str(o.buyerName, 'buyerName'), billNumber: str(o.billNumber, 'billNumber'), billDate: str(o.billDate, 'billDate'),
    lines: list(o.lines, 'lines', MAX_ROWS).map((x, i) => {
      const l = record(x, `lines[${i}]`);
      const p = `lines[${i}]`;
      return { page: int(l.page, `${p}.page`), row: int(l.row, `${p}.row`), itemName: str(l.itemName, `${p}.itemName`), bags: num(l.bags, `${p}.bags`), weightKg: num(l.weightKg, `${p}.weightKg`), rate: num(l.rate, `${p}.rate`), amount: num(l.amount, `${p}.amount`) };
    }),
    expenses: list(o.expenses, 'expenses', 30).map((x, i) => {
      const e = record(x, `expenses[${i}]`);
      const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, 80) : fail(`expenses[${i}].label`, 'expected text');
      return { label, category: oneOf(e.category, EXPENSE_CATEGORIES, `expenses[${i}].category`), amount: num(e.amount, `expenses[${i}].amount`) };
    }),
    totals: {
      bags: num(totals.bags, 'totals.bags'), weightKg: num(totals.weightKg, 'totals.weightKg'), goodsTotal: num(totals.goodsTotal, 'totals.goodsTotal'),
      totalExpenses: num(totals.totalExpenses, 'totals.totalExpenses'), totalAmount: num(totals.totalAmount, 'totals.totalAmount'),
    },
  };
}

export function parseMarkSheet(input: unknown): MarkSheetOut {
  const o = record(input, 'sheet');
  return {
    date: str(o.date, 'date'), lotRef: str(o.lotRef, 'lotRef'), totalBags: num(o.totalBags, 'totalBags'),
    marks: list(o.marks, 'marks', MAX_ROWS).map((x, i) => {
      const m = record(x, `marks[${i}]`);
      const p = `marks[${i}]`;
      return { page: int(m.page, `${p}.page`), row: int(m.row, `${p}.row`), side: oneOf(m.side, ['LEFT', 'RIGHT', 'SINGLE'] as const, `${p}.side`), bags: num(m.bags, `${p}.bags`), rateMin: num(m.rateMin, `${p}.rateMin`), rateMax: num(m.rateMax, `${p}.rateMax`), mark: str(m.mark, `${p}.mark`) };
    }),
  };
}
