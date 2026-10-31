/**
 * Deterministic reconciliation of a scanned vendor bill against the handwritten mark sheet. The AI only reads values;
 * every calculation, match and check happens here, in integer paise and grams. Pure: no I/O, no clock, no randomness.
 */
import { formatRupees, fromPaise, lineAmountPaise } from '../../common/money';

export type RateUnit = 'PER_KG' | 'PER_10_KG' | 'PER_BAG';
export const RATE_UNITS: readonly RateUnit[] = ['PER_KG', 'PER_10_KG', 'PER_BAG'];
export type Severity = 'CRITICAL' | 'WARNING' | 'INFO';
export type MatchMethod = 'MANUAL' | 'EXACT' | 'GROUPED' | 'RANGE';

/** Purchase lines a vendor bill may become (PurchaseItemDto's limit). */
export const MAX_PURCHASE_LINES = 50;
const MAX_MARK_CODE = 16;
/** Bags searched by the subset matcher; larger sums are left to a person. */
const MAX_SUBSET_BAGS = 5000;

export interface CalcLine {
  id: string;
  position: number;
  bags: number;
  grams: number;
  ratePaise: number;
  amountPaise: number;
  assignedMarkId: string | null;
  needsReview: boolean;
}

export interface CalcMark {
  id: string;
  position: number;
  markCode: string;
  bags: number;
  rateMinPaise: number;
  rateMaxPaise: number;
  needsReview: boolean;
}

export interface CalcExpense {
  id: string;
  label: string;
  category: string;
  amountPaise: number;
  includeInCost: boolean;
}

export interface CalcHeader {
  vendorPartyId: string | null;
  productId: string | null;
  lotNumber: string | null;
  billNumber: string | null;
  billDate: string | null;
  sheetDate: string | null;
  printedBillBags: number | null;
  printedBillGrams: number | null;
  printedGrossPaise: number | null;
  printedExpensesPaise: number | null;
  printedNetPaise: number | null;
  printedSheetBags: number | null;
}

export interface ReconcileInput {
  header: CalcHeader;
  rateUnit: RateUnit | null;
  lines: CalcLine[];
  marks: CalcMark[];
  expenses: CalcExpense[];
}

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  refs?: { lineIds?: string[]; markIds?: string[]; expenseIds?: string[] };
}

export interface LineMatch {
  lineId: string;
  markId: string | null;
  method: MatchMethod | null;
  suggestedMarkId: string | null;
}

export interface MarkSummary {
  markId: string;
  markCode: string;
  expectedBags: number;
  matchedBags: number;
  grams: number;
  amountPaise: number;
  ratesPaise: number[];
  status: 'MATCHED' | 'SHORT' | 'OVER';
}

/** One purchase line the confirmed bill gets: a mark at one printed rate. */
export interface PurchaseLine {
  markCode: string;
  bags: number;
  grams: number;
  printedRatePaise: number;
  ratePerKgPaise: number;
  vendorAmountPaise: number;
  lineIds: string[];
}

export interface Reconciliation {
  matches: LineMatch[];
  marks: MarkSummary[];
  totals: { lineBags: number; lineGrams: number; linesAmountPaise: number; expensesPaise: number; netPaise: number; markBags: number; costExpensesPaise: number };
  rateUnitEvidence: { checked: number; agreeing: Record<RateUnit, number>; suggested: RateUnit | null };
  purchaseLines: PurchaseLine[];
  /** Whole-rupee purchase line rounding minus the vendor's paise amounts. */
  roundingDifferencePaise: number;
  issues: Issue[];
  canConfirm: boolean;
}

const RATE_LABEL: Record<RateUnit, string> = { PER_KG: 'per kg', PER_10_KG: 'per 10 kg', PER_BAG: 'per bag' };
const rupees = (paise: number): string => formatRupees(fromPaise(paise));
const rateText = (paise: number): string => String(fromPaise(paise));
const markRange = (m: CalcMark): string => (m.rateMinPaise === m.rateMaxPaise ? rateText(m.rateMinPaise) : `${rateText(m.rateMinPaise)}–${rateText(m.rateMaxPaise)}`);
const isRange = (m: CalcMark): boolean => m.rateMinPaise < m.rateMaxPaise;
const inRange = (m: CalcMark, ratePaise: number): boolean => ratePaise >= m.rateMinPaise && ratePaise <= m.rateMaxPaise;
const lineLabel = (l: CalcLine): string => `Bill line ${l.position} (${l.bags} bags @ ${rateText(l.ratePaise)})`;
const sum = <T>(rows: readonly T[], pick: (row: T) => number): number => rows.reduce((t, r) => t + pick(r), 0);

/** The amount a line should carry under a rate convention, half-up to the paisa. */
export function expectedAmountPaise(line: Pick<CalcLine, 'bags' | 'grams' | 'ratePaise'>, unit: RateUnit): number {
  if (unit === 'PER_BAG') return line.bags * line.ratePaise;
  const divisor = unit === 'PER_KG' ? 1000 : 10_000;
  return Math.floor((line.grams * line.ratePaise + divisor / 2) / divisor);
}

/** Rate per kg in paise for a purchase line, or null when the convention cannot be expressed per kg exactly. */
export function ratePerKgPaise(printedRatePaise: number, unit: RateUnit): number | null {
  if (unit === 'PER_KG') return printedRatePaise;
  if (unit === 'PER_10_KG') return printedRatePaise % 10 === 0 ? printedRatePaise / 10 : null;
  return null;
}

/** Which convention the printed amounts support. Suggests one only when it explains at least 80% of the checked lines. */
export function rateUnitEvidence(lines: readonly CalcLine[]): Reconciliation['rateUnitEvidence'] {
  const checked = lines.filter((l) => l.amountPaise > 0 && l.ratePaise > 0);
  const agreeing = Object.fromEntries(RATE_UNITS.map((u) => [u, checked.filter((l) => expectedAmountPaise(l, u) === l.amountPaise).length])) as Record<RateUnit, number>;
  const best = [...RATE_UNITS].sort((a, b) => agreeing[b] - agreeing[a])[0] as RateUnit;
  const suggested = checked.length > 0 && agreeing[best] * 5 >= checked.length * 4 ? best : null;
  return { checked: checked.length, agreeing, suggested };
}

/** Indexes of `lines` whose bags add up to exactly `target`, preferring earlier lines; null if none. */
export function subsetWithBags(lines: readonly { bags: number }[], target: number): number[] | null {
  if (target <= 0 || target > MAX_SUBSET_BAGS) return null;
  // reach[s] = index of the line that first reached sum s; built forward so earlier lines win.
  const reach = new Array<number>(target + 1).fill(-2);
  reach[0] = -1;
  lines.forEach((line, index) => {
    for (let s = target; s >= line.bags; s -= 1) {
      if (reach[s] === -2 && reach[s - line.bags] !== -2 && reach[s - line.bags] !== index) reach[s] = index;
    }
  });
  if (reach[target] === -2) return null;
  const picked: number[] = [];
  for (let s = target; s > 0;) {
    const index = reach[s] as number;
    picked.push(index);
    s -= (lines[index] as { bags: number }).bags;
  }
  return picked.reverse();
}

class Matcher {
  readonly assigned = new Map<string, { markId: string; method: MatchMethod }>();
  readonly issues: Issue[] = [];
  private readonly marksById: Map<string, CalcMark>;

  constructor(private readonly lines: CalcLine[], private readonly marks: CalcMark[]) {
    this.marksById = new Map(marks.map((m) => [m.id, m]));
  }

  run(): void {
    this.manual();
    this.exact();
    this.grouped();
    this.ranges();
  }

  remaining(mark: CalcMark): number {
    return mark.bags - sum(this.linesOf(mark.id), (l) => l.bags);
  }

  linesOf(markId: string): CalcLine[] {
    return this.lines.filter((l) => this.assigned.get(l.id)?.markId === markId);
  }

  free(): CalcLine[] {
    return this.lines.filter((l) => !this.assigned.has(l.id));
  }

  private assign(lines: readonly CalcLine[], mark: CalcMark, method: MatchMethod): void {
    for (const line of lines) this.assigned.set(line.id, { markId: mark.id, method });
  }

  /** A person's assignment always wins. */
  private manual(): void {
    for (const line of this.lines) {
      const mark = line.assignedMarkId ? this.marksById.get(line.assignedMarkId) : undefined;
      if (mark) this.assign([line], mark, 'MANUAL');
    }
  }

  /** One bill line with exactly the mark's bags and rate. Identical (bags, rate) pairs are paired in order and flagged. */
  private exact(): void {
    const keyed = new Map<string, { marks: CalcMark[]; lines: CalcLine[] }>();
    const key = (bags: number, rate: number) => `${bags}@${rate}`;
    for (const mark of this.marks) {
      if (isRange(mark) || this.remaining(mark) !== mark.bags || mark.bags <= 0) continue;
      const k = key(mark.bags, mark.rateMinPaise);
      keyed.set(k, { marks: [...(keyed.get(k)?.marks ?? []), mark], lines: [] });
    }
    for (const line of this.free()) keyed.get(key(line.bags, line.ratePaise))?.lines.push(line);
    for (const { marks, lines } of keyed.values()) {
      const pairs = Math.min(marks.length, lines.length);
      for (let i = 0; i < pairs; i += 1) this.assign([lines[i] as CalcLine], marks[i] as CalcMark, 'EXACT');
      if (marks.length > 1 && lines.length > 1) {
        this.issues.push({
          code: 'AMBIGUOUS_MATCH', severity: 'WARNING',
          message: `${marks.map((m) => m.markCode).join(', ')} have the same bags and rate; bill lines were paired in order. Swap them if the weights belong the other way.`,
          refs: { markIds: marks.map((m) => m.id), lineIds: lines.slice(0, pairs).map((l) => l.id) },
        });
      }
    }
  }

  /** Several bill lines at a mark's single rate whose bags add up to the mark's bags. */
  private grouped(): void {
    const singleRate = this.marks.filter((m) => !isRange(m) && this.remaining(m) > 0);
    const sharedRates = new Set(singleRate.map((m) => m.rateMinPaise).filter((rate, i, all) => all.indexOf(rate) !== i));
    for (const mark of singleRate) {
      const candidates = this.free().filter((l) => l.ratePaise === mark.rateMinPaise);
      const picked = subsetWithBags(candidates, this.remaining(mark));
      if (!picked) continue;
      this.assign(picked.map((i) => candidates[i] as CalcLine), mark, 'GROUPED');
      if (sharedRates.has(mark.rateMinPaise)) {
        this.issues.push({
          code: 'AMBIGUOUS_MATCH', severity: 'WARNING',
          message: `Several marks share rate ${rateText(mark.rateMinPaise)}; ${mark.markCode} took the first bill lines that add up to ${mark.bags} bags. Check the weights.`,
          refs: { markIds: [mark.id], lineIds: picked.map((i) => (candidates[i] as CalcLine).id) },
        });
      }
    }
  }

  /** Lines whose rate lies inside a mark's written range. Never averaged; a line inside two ranges is left to a person. */
  private ranges(): void {
    const open = this.marks.filter((m) => isRange(m) && this.remaining(m) > 0);
    for (const mark of open) {
      const candidates = this.free().filter((l) => inRange(mark, l.ratePaise) && open.filter((m) => inRange(m, l.ratePaise)).length === 1);
      if (candidates.length === 0) continue;
      const need = this.remaining(mark);
      if (sum(candidates, (l) => l.bags) <= need) {
        this.assign(candidates, mark, 'RANGE');
        continue;
      }
      const picked = subsetWithBags(candidates, need);
      if (!picked) {
        this.issues.push({
          code: 'RANGE_OVERFLOW', severity: 'CRITICAL',
          message: `${mark.markCode} (${markRange(mark)}) needs ${need} bags but its in-range bill lines hold ${sum(candidates, (l) => l.bags)} and no combination fits. Assign them by hand.`,
          refs: { markIds: [mark.id], lineIds: candidates.map((l) => l.id) },
        });
        continue;
      }
      this.assign(picked.map((i) => candidates[i] as CalcLine), mark, 'RANGE');
      this.issues.push({
        code: 'AMBIGUOUS_MATCH', severity: 'WARNING',
        message: `${mark.markCode} (${markRange(mark)}) took the first in-range bill lines that make ${mark.bags} bags; other in-range lines are left over.`,
        refs: { markIds: [mark.id] },
      });
    }
  }
}

/** Nearest mark (by rate distance; 0 inside its range) that still lacks bags, for each unmatched line. */
function suggestions(matcher: Matcher, marks: readonly CalcMark[]): Map<string, string> {
  const short = marks.filter((m) => matcher.remaining(m) > 0);
  const distance = (m: CalcMark, rate: number) => (inRange(m, rate) ? 0 : Math.min(Math.abs(rate - m.rateMinPaise), Math.abs(rate - m.rateMaxPaise)));
  const result = new Map<string, string>();
  for (const line of matcher.free()) {
    const best = [...short].sort((a, b) => distance(a, line.ratePaise) - distance(b, line.ratePaise) || a.position - b.position)[0];
    if (best) result.set(line.id, best.id);
  }
  return result;
}

function markStatus(matched: number, expected: number): MarkSummary['status'] {
  if (matched === expected) return 'MATCHED';
  return matched < expected ? 'SHORT' : 'OVER';
}

function markSummaries(matcher: Matcher, marks: readonly CalcMark[], unit: RateUnit | null): MarkSummary[] {
  return marks.map((mark) => {
    const lines = matcher.linesOf(mark.id);
    const matchedBags = sum(lines, (l) => l.bags);
    return {
      markId: mark.id, markCode: mark.markCode, expectedBags: mark.bags, matchedBags,
      grams: sum(lines, (l) => l.grams),
      amountPaise: sum(lines, (l) => (unit ? expectedAmountPaise(l, unit) : l.amountPaise)),
      ratesPaise: [...new Set(lines.map((l) => l.ratePaise))].sort((a, b) => a - b),
      status: markStatus(matchedBags, mark.bags),
    };
  });
}

const nearestHint = (mark: CalcMark): string => ` Nearest mark still short of bags: ${mark.markCode} (${markRange(mark)}).`;

function matchIssues(matcher: Matcher, marks: readonly CalcMark[], summaries: readonly MarkSummary[], suggested: Map<string, string>): Issue[] {
  const byId = new Map(marks.map((m) => [m.id, m]));
  const issues: Issue[] = matcher.free().map((line) => {
    const mark = byId.get(suggested.get(line.id) ?? '');
    return {
      code: 'LINE_UNMATCHED', severity: 'CRITICAL',
      message: `${lineLabel(line)} matches no mark.${mark ? nearestHint(mark) : ''}`,
      refs: { lineIds: [line.id], ...(mark && { markIds: [mark.id] }) },
    };
  });
  for (const s of summaries) {
    if (s.status === 'MATCHED') continue;
    issues.push({
      code: s.status === 'SHORT' ? 'MARK_SHORT' : 'MARK_OVER', severity: 'CRITICAL',
      message: `${s.markCode}: the sheet says ${s.expectedBags} bags, matched bill lines hold ${s.matchedBags}.`,
      refs: { markIds: [s.markId] },
    });
  }
  return issues;
}

function compare(label: string, code: string, printed: number | null, computed: number, show: (n: number) => string): Issue | null {
  if (printed === null) return { code: `${code}_NOT_READ`, severity: 'WARNING', message: `${label} was not read from the document, so it could not be cross-checked.` };
  if (printed === computed) return null;
  return { code, severity: 'CRITICAL', message: `${label}: printed ${show(printed)}, the lines add up to ${show(computed)}.` };
}

function totalIssues(input: ReconcileInput, totals: Reconciliation['totals']): Issue[] {
  const h = input.header;
  const bags = (n: number) => `${n} bags`;
  const kg = (g: number) => `${g / 1000} kg`;
  const issues = [
    compare('Bill total bags', 'BILL_BAGS_MISMATCH', h.printedBillBags, totals.lineBags, bags),
    compare('Bill total weight', 'BILL_WEIGHT_MISMATCH', h.printedBillGrams, totals.lineGrams, kg),
    compare('Bill goods total', 'BILL_GROSS_MISMATCH', h.printedGrossPaise, totals.linesAmountPaise, rupees),
    compare('Bill total expenses', 'BILL_EXPENSES_MISMATCH', h.printedExpensesPaise, totals.expensesPaise, rupees),
    compare('Bill total amount', 'BILL_NET_MISMATCH', h.printedNetPaise, totals.netPaise, rupees),
    compare('Mark sheet total bags', 'SHEET_BAGS_MISMATCH', h.printedSheetBags, totals.markBags, bags),
  ].filter((i): i is Issue => i !== null);
  if (input.lines.length > 0 && input.marks.length > 0 && totals.lineBags !== totals.markBags) {
    issues.push({ code: 'BILL_SHEET_BAGS_MISMATCH', severity: 'CRITICAL', message: `The bill has ${totals.lineBags} bags, the mark sheet ${totals.markBags}.` });
  }
  return issues;
}

function identityIssues(input: ReconcileInput): Issue[] {
  const h = input.header;
  const required: [string | null, string][] = [
    [h.vendorPartyId, 'Choose the vendor'], [h.productId, 'Choose the product'], [h.lotNumber?.trim() || null, 'Enter the lot number'],
    [h.billNumber?.trim() || null, 'Enter the vendor bill number'], [h.billDate, 'Enter the bill date'],
  ];
  const issues: Issue[] = required.filter(([value]) => !value).map(([, message]) => ({ code: 'MISSING_FIELD', severity: 'CRITICAL', message: `${message}.` }));
  if (h.billDate && h.sheetDate && h.billDate !== h.sheetDate) {
    issues.push({ code: 'DATE_MISMATCH', severity: 'WARNING', message: `The bill is dated ${h.billDate} but the mark sheet ${h.sheetDate}. Check both belong to this consignment.` });
  }
  if (input.lines.length === 0) issues.push({ code: 'NO_BILL_LINES', severity: 'CRITICAL', message: 'No vendor bill lines. Upload and read the bill, or add the lines.' });
  if (input.marks.length === 0) issues.push({ code: 'NO_MARKS', severity: 'CRITICAL', message: 'No mark sheet rows. Upload and read the mark sheet, or add the marks.' });
  return issues;
}

function rateUnitIssues(input: ReconcileInput, evidence: Reconciliation['rateUnitEvidence']): Issue[] {
  if (!input.rateUnit) {
    const hint = evidence.suggested ? ` The printed amounts fit ${RATE_LABEL[evidence.suggested]} on ${evidence.agreeing[evidence.suggested]} of ${evidence.checked} lines.` : '';
    return [{ code: 'RATE_UNIT_UNKNOWN', severity: 'CRITICAL', message: `Choose how this vendor quotes rates (per kg, per 10 kg or per bag).${hint}` }];
  }
  const unit = input.rateUnit;
  const issues: Issue[] = [];
  if (unit === 'PER_BAG') {
    issues.push({ code: 'RATE_UNIT_PER_BAG_UNSUPPORTED', severity: 'CRITICAL', message: 'Purchase lines are priced per kg, so a per-bag bill cannot be posted from a scan yet. Enter it as a vendor bill by hand.' });
  }
  for (const line of input.lines) {
    const expected = expectedAmountPaise(line, unit);
    if (expected !== line.amountPaise) {
      issues.push({
        code: 'LINE_AMOUNT_MISMATCH', severity: 'CRITICAL',
        message: `${lineLabel(line)}: printed amount ${rupees(line.amountPaise)}, but ${line.grams / 1000} kg at ${rateText(line.ratePaise)} ${RATE_LABEL[unit]} is ${rupees(expected)}. Correct the misread value.`,
        refs: { lineIds: [line.id] },
      });
    }
    if (unit !== 'PER_BAG' && ratePerKgPaise(line.ratePaise, unit) === null) {
      issues.push({ code: 'RATE_PRECISION', severity: 'CRITICAL', message: `${lineLabel(line)}: the rate per kg would need more than 2 decimals.`, refs: { lineIds: [line.id] } });
    }
  }
  return issues;
}

function reviewIssues(input: ReconcileInput): Issue[] {
  const lowLines = input.lines.filter((l) => l.needsReview);
  const lowMarks = input.marks.filter((m) => m.needsReview);
  const issues: Issue[] = [];
  if (lowLines.length) issues.push({ code: 'LOW_CONFIDENCE', severity: 'WARNING', message: `${lowLines.length} bill line(s) were hard to read. Check them against the photo.`, refs: { lineIds: lowLines.map((l) => l.id) } });
  if (lowMarks.length) issues.push({ code: 'LOW_CONFIDENCE', severity: 'WARNING', message: `${lowMarks.length} mark sheet row(s) were hard to read. Check them against the photo.`, refs: { markIds: lowMarks.map((m) => m.id) } });
  const codes = input.marks.map((m) => normalizeMark(m.markCode));
  const repeated = input.marks.filter((m, i) => codes.indexOf(codes[i] as string) !== i);
  if (repeated.length) issues.push({ code: 'DUPLICATE_MARK', severity: 'CRITICAL', message: `Mark ${repeated.map((m) => m.markCode).join(', ')} appears more than once on the sheet. Merge or rename.`, refs: { markIds: repeated.map((m) => m.id) } });
  const blank = input.marks.filter((m) => !normalizeMark(m.markCode));
  if (blank.length) issues.push({ code: 'MARK_CODE_MISSING', severity: 'CRITICAL', message: 'A mark sheet row has no mark code.', refs: { markIds: blank.map((m) => m.id) } });
  for (const e of input.expenses.filter((x) => x.category === 'DRIVER_ADVANCE')) {
    issues.push({
      code: 'DRIVER_ADVANCE', severity: 'INFO', refs: { expenseIds: [e.id] },
      message: `${e.label} ${rupees(e.amountPaise)} stays on the vendor bill (owed to the vendor) and is ${e.includeInCost ? 'added to' : 'not added to'} the lot's landed cost.`,
    });
  }
  return issues;
}

export const normalizeMark = (code: string): string => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Purchase lines: one per mark, or one per printed rate when a range mark's lines carry several rates. */
function purchaseLines(matcher: Matcher, marks: readonly CalcMark[], unit: RateUnit | null): PurchaseLine[] {
  return marks.flatMap((mark) => {
    const lines = matcher.linesOf(mark.id);
    const rates = [...new Set(lines.map((l) => l.ratePaise))].sort((a, b) => a - b);
    return rates.map((rate) => {
      const atRate = lines.filter((l) => l.ratePaise === rate);
      const code = normalizeMark(mark.markCode);
      return {
        markCode: rates.length === 1 ? code : `${code}${rateText(rate).replace('.', '')}`,
        bags: sum(atRate, (l) => l.bags),
        grams: sum(atRate, (l) => l.grams),
        printedRatePaise: rate,
        ratePerKgPaise: (unit && ratePerKgPaise(rate, unit)) ?? 0,
        vendorAmountPaise: sum(atRate, (l) => l.amountPaise),
        lineIds: atRate.map((l) => l.id),
      };
    });
  });
}

function purchaseIssues(lines: readonly PurchaseLine[], lotCodeLength: number): Issue[] {
  const issues: Issue[] = [];
  if (lines.length > MAX_PURCHASE_LINES) issues.push({ code: 'TOO_MANY_PURCHASE_LINES', severity: 'CRITICAL', message: `The bill would need ${lines.length} purchase lines; at most ${MAX_PURCHASE_LINES} are allowed.` });
  const long = lines.filter((l) => l.markCode.length + lotCodeLength > MAX_MARK_CODE);
  if (long.length) issues.push({ code: 'MARK_CODE_TOO_LONG', severity: 'CRITICAL', message: `With the lot code, ${long.map((l) => l.markCode).join(', ')} would be longer than ${MAX_MARK_CODE} characters.` });
  const codes = lines.map((l) => l.markCode);
  const clash = codes.filter((c, i) => codes.indexOf(c) !== i);
  if (clash.length) issues.push({ code: 'MARK_CODE_CLASH', severity: 'CRITICAL', message: `Purchase line code ${[...new Set(clash)].join(', ')} would repeat. Rename a mark.` });
  return issues;
}

/** Runs every match and check. `lotCodeLength` is the length of the lot code that will prefix mark codes. */
export function reconcile(input: ReconcileInput, lotCodeLength = 0): Reconciliation {
  const matcher = new Matcher(input.lines, input.marks);
  matcher.run();
  const unit = input.rateUnit;
  const suggested = suggestions(matcher, input.marks);
  const summaries = markSummaries(matcher, input.marks, unit);
  const linesAmountPaise = sum(input.lines, (l) => l.amountPaise);
  const expensesPaise = sum(input.expenses, (e) => e.amountPaise);
  const totals = {
    lineBags: sum(input.lines, (l) => l.bags), lineGrams: sum(input.lines, (l) => l.grams), linesAmountPaise, expensesPaise,
    netPaise: linesAmountPaise + expensesPaise, markBags: sum(input.marks, (m) => m.bags),
    costExpensesPaise: sum(input.expenses.filter((e) => e.includeInCost), (e) => e.amountPaise),
  };
  const evidence = rateUnitEvidence(input.lines);
  const lines = purchaseLines(matcher, input.marks, unit);
  const usable = unit !== null && unit !== 'PER_BAG';
  const roundingDifferencePaise = usable ? sum(lines, (l) => sum(input.lines.filter((x) => l.lineIds.includes(x.id)), (x) => lineAmountPaise(x.grams, l.ratePerKgPaise) - x.amountPaise)) : 0;

  const issues = [
    ...identityIssues(input), ...rateUnitIssues(input, evidence), ...totalIssues(input, totals), ...matcher.issues,
    ...matchIssues(matcher, input.marks, summaries, suggested), ...reviewIssues(input), ...purchaseIssues(lines, lotCodeLength),
  ];
  if (roundingDifferencePaise !== 0) {
    issues.push({
      code: 'ROUNDING_DIFFERENCE', severity: 'WARNING',
      message: `Purchase lines are rounded to whole rupees, so the recorded bill differs from the vendor's paise amounts by ${rupees(roundingDifferencePaise)}.`,
    });
  }
  return {
    matches: input.lines.map((l) => {
      const hit = matcher.assigned.get(l.id);
      return { lineId: l.id, markId: hit?.markId ?? null, method: hit?.method ?? null, suggestedMarkId: suggested.get(l.id) ?? null };
    }),
    marks: summaries,
    totals,
    rateUnitEvidence: evidence,
    purchaseLines: lines,
    roundingDifferencePaise,
    issues,
    canConfirm: !issues.some((i) => i.severity === 'CRITICAL'),
  };
}
