import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../src/config/env';
import type { Field } from '../src/modules/consignment-scans/extraction/extraction.schema';
import { DocumentExtractor } from '../src/modules/consignment-scans/extraction/document.extractor';
import { normalizeMark } from '../src/modules/consignment-scans/reconciliation.calc';
import { REFERENCE_BILL, REFERENCE_SHEET } from '../test/fixtures/consignment/reference';

/**
 * Performance and accuracy test of the AI read on the reference consignment, against the human transcription. Makes real
 * (billable) calls, so it runs only when asked:
 *   npm run scanner:eval                                   one run (Gemini, Groq backup when Gemini fails)
 *   SCANNER_EVAL_RUNS=5 npm run scanner:eval               five runs, 15 s apart, with latency percentiles
 *   GEMINI_API_KEY= npm run scanner:eval                   the Groq backup alone
 * Field accuracy = values read exactly right / values on the document (a missed or extra row counts every field wrong).
 * Each run reads the bill and the mark sheet in parallel, exactly as the server does.
 */
const FIXTURES = join(__dirname, '../test/fixtures/consignment');
const page = (pageNo: number, fileName: string) => {
  const path = join(FIXTURES, fileName);
  if (!existsSync(path)) throw new Error(`${path} is missing. The reference photos are kept out of git; copy them there first.`);
  return { pageNo, fileName, mimeType: 'image/webp', data: readFileSync(path) };
};
const BILL_PAGES = [page(1, 'vendor-bill-p1.webp'), page(2, 'vendor-bill-p2.webp')];
const SHEET_PAGES = [page(1, 'mark-sheet.webp')];

/** Mark codes are compared as the app stores them (upper case, letters and digits only). */
const same = (a: unknown, b: unknown) => (typeof a === 'string' && typeof b === 'string' ? normalizeMark(a) === normalizeMark(b) : a === b);

interface Score { right: number; total: number; misses: string[] }

function score<T>(expected: T[], actual: T[], fields: [string, (row: T) => Field<unknown>][]): Score {
  const result: Score = { right: 0, total: expected.length * fields.length, misses: [] };
  expected.forEach((row, i) => {
    const got = actual[i];
    for (const [name, pick] of fields) {
      if (got && same(pick(row).value, pick(got).value)) result.right += 1;
      else result.misses.push(`row ${i + 1} ${name}: expected ${JSON.stringify(pick(row).value)}, read ${JSON.stringify(got ? pick(got).value : null)}`);
    }
  });
  return result;
}

interface Run { wallMs: number; billMs: number; sheetMs: number; models: string; tokens: number; scores: Record<string, Score> }

async function once(extractor: DocumentExtractor): Promise<Run> {
  const started = Date.now();
  const [bill, sheet] = await Promise.all([extractor.extract('VENDOR_BILL', BILL_PAGES), extractor.extract('MARK_SHEET', SHEET_PAGES)]);
  const wallMs = Date.now() - started;
  const totals = (b: typeof REFERENCE_BILL) => [b.billNumber, b.billDate, b.totals.bags, b.totals.weightKg, b.totals.goodsTotal, b.totals.totalExpenses, b.totals.totalAmount];
  const header = ['bill no.', 'bill date', 'total bags', 'total kg', 'goods total', 'total charges', 'total amount'];
  return {
    wallMs, billMs: bill.latencyMs, sheetMs: sheet.latencyMs,
    models: `${bill.model} ×${bill.attempts} / ${sheet.model} ×${sheet.attempts}`,
    tokens: bill.inputTokens + bill.outputTokens + sheet.inputTokens + sheet.outputTokens,
    scores: {
      'Bill lines (53 × bags, kg, rate, amount)': score(REFERENCE_BILL.lines, bill.parsed.lines, [['bags', (l) => l.bags], ['kg', (l) => l.weightKg], ['rate', (l) => l.rate], ['amount', (l) => l.amount]]),
      'Bill charges (5)': score(REFERENCE_BILL.expenses, bill.parsed.expenses, [['amount', (e) => e.amount]]),
      'Bill header + printed totals (7)': score([totals(REFERENCE_BILL)], [totals(bill.parsed)], header.map((name, i): [string, (row: Field<unknown>[]) => Field<unknown>] => [name, (row) => row[i] as Field<unknown>])),
      'Mark sheet (18 × bags, rate min, rate max, mark)': score(REFERENCE_SHEET.marks, sheet.parsed.marks, [['bags', (m) => m.bags], ['rate min', (m) => m.rateMin], ['rate max', (m) => m.rateMax], ['mark', (m) => m.mark]]),
    },
  };
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function summarize(runs: Run[], failures: string[]): void {
  console.log('\n| Run | Wall (parallel) | Vendor bill | Mark sheet | Serial would be | Models × attempts | Tokens |');
  console.log('|---|---|---|---|---|---|---|');
  runs.forEach((r, i) => console.log(`| ${i + 1} | ${seconds(r.wallMs)} | ${seconds(r.billMs)} | ${seconds(r.sheetMs)} | ${seconds(r.billMs + r.sheetMs)} | ${r.models} | ${r.tokens} |`));
  console.log('\n| Latency | min | median | p95 | max | mean |');
  console.log('|---|---|---|---|---|---|');
  for (const [label, pick] of [['Wall (both in parallel)', (r: Run) => r.wallMs], ['Vendor bill', (r: Run) => r.billMs], ['Mark sheet', (r: Run) => r.sheetMs]] as const) {
    const values = runs.map(pick).sort((a, b) => a - b);
    const mean = values.reduce((t, v) => t + v, 0) / values.length;
    console.log(`| ${label} | ${seconds(values[0] as number)} | ${seconds(percentile(values, 50))} | ${seconds(percentile(values, 95))} | ${seconds(values.at(-1) as number)} | ${seconds(mean)} |`);
  }
  console.log('\n| Accuracy (all runs) | Fields exact | % |');
  console.log('|---|---|---|');
  for (const section of Object.keys(runs[0]?.scores ?? {})) {
    const right = runs.reduce((t, r) => t + (r.scores[section]?.right ?? 0), 0);
    const total = runs.reduce((t, r) => t + (r.scores[section]?.total ?? 0), 0);
    console.log(`| ${section} | ${right}/${total} | ${((100 * right) / total).toFixed(1)}% |`);
  }
  const misses = runs.flatMap((r, i) => Object.entries(r.scores).flatMap(([section, s]) => s.misses.map((m) => `run ${i + 1} · ${section} · ${m}`)));
  const bullets = (lines: string[]) => lines.map((line) => '- ' + line).join('\n');
  console.log(misses.length ? '\nMisread values:\n' + bullets(misses) : '\nNo misread values.');
  console.log('\nFailed runs: ' + failures.length + (failures.length ? '\n' + bullets(failures) : ''));
}

async function main() {
  const env = loadEnv({ ...process.env, DATABASE_URL: process.env.DATABASE_URL || 'postgres://unused', JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'x'.repeat(32) });
  if (!env.gemini.apiKey && !env.groq.apiKey) throw new Error('Neither GEMINI_API_KEY nor GROQ_API_KEY is set; nothing was measured.');
  const count = Math.max(1, Math.min(20, Number(process.env.SCANNER_EVAL_RUNS) || 1));
  const pauseMs = Number(process.env.SCANNER_EVAL_PAUSE_MS ?? 15_000);
  const extractor = new DocumentExtractor(env);
  const runs: Run[] = [];
  const failures: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs)); // stay under per-minute quotas
    try {
      runs.push(await once(extractor));
      console.log(`run ${i + 1}/${count}: ${seconds(runs.at(-1)?.wallMs ?? 0)}`);
    } catch (error) {
      failures.push(`run ${i + 1}: ${error instanceof Error ? error.message.slice(0, 200) : 'failed'}`);
    }
  }
  if (runs.length === 0) throw new Error(`Every run failed:\n${failures.join('\n')}`);
  summarize(runs, failures);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
