import { purchaseDrift, stockDrift } from '../src/database/reconciliation';
import { hashPassword } from '../src/modules/auth/passwords';
import { MARK_SHEET_JSON_SCHEMA } from '../src/modules/consignment-scans/extraction/extraction.schema';
import { DocumentExtractor } from '../src/modules/consignment-scans/extraction/document.extractor';
import { REFERENCE_BILL, REFERENCE_SHEET } from './fixtures/consignment/reference';
import { ENV, type Env } from '../src/config/env';
import { auth, type Harness, PASSWORD, startHarness } from './harness';

/**
 * The scanner end to end on the reference consignment, with Gemini replaced by the human transcription of the photos
 * (no network). Exercises the real upload checks, storage, run records, reconciliation, corrections and confirm.
 */
let h: Harness;
let owner: Record<string, string>;
let staff: Record<string, string>;
let vendorId: string;
let onionsId: string;
let model: jest.SpyInstance;

/** A small file the server accepts as WEBP (header only), different per name. The real photos stay out of git: the AI is mocked here. */
const photo = (name: string) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.from(name)]);
const base = '/api/v1/consignment-scans';

interface Line { id: string; bags: number; weightKg: number; rate: number; amount: number; assignedMarkId: string | null; markId: string | null; suggestedMarkId: string | null; provenance: string }
interface Scan {
  id: string; status: string; version: number; lotNumber: string | null; rateUnit: string | null; purchaseId: string | null;
  documents: { id: string; kind: string; pageNo: number; url: string }[];
  runs: { job: string; status: string; model: string; attempts: number; error: string | null; inputTokens: number | null }[];
  lines: Line[]; marks: { id: string; markCode: string }[]; expenses: { label: string; includeInCost: boolean }[];
  reconciliation: { canConfirm: boolean; issues: { code: string; severity: string }[]; rateUnitEvidence: { suggested: string | null }; purchaseLines: unknown[]; roundingDifference: number };
}

/** Gemini stand-in: answers with the reference transcription for whichever document it is asked about. */
const answer = (_model: string, _parts: unknown, schema: unknown) => Promise.resolve({
  text: JSON.stringify(schema === MARK_SHEET_JSON_SCHEMA ? REFERENCE_SHEET : REFERENCE_BILL), inputTokens: 1200, outputTokens: 3400,
});

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  staff = auth(await h.token('salesperson'));
  const products = (await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[];
  onionsId = products.find((p) => p.code === 'ONIONS')!.id;
  vendorId = ((await h.http().get('/api/v1/vendors').set(owner)).body as { id: string; name: string }[]).find((v) => v.name === 'Murade Traders')!.id;
  model = jest.spyOn(h.app.get(DocumentExtractor), 'callModel').mockImplementation(answer);
});
afterEach(async () => {
  model.mockRestore();
  expect(await stockDrift(h.db)).toEqual([]);
  expect(await purchaseDrift(h.db)).toEqual([]);
});

const start = async () => (await h.http().post(base).set(staff).expect(201)).body as Scan;
const upload = (id: string, kind: string, files: string[], token = staff) => {
  const req = h.http().post(`${base}/${id}/documents`).set(token).field('kind', kind);
  for (const f of files) req.attach('files', photo(f), { filename: f, contentType: 'image/webp' });
  return req;
};
const uploaded = async () => {
  const scan = await start();
  await upload(scan.id, 'VENDOR_BILL', ['vendor-bill-p1.webp', 'vendor-bill-p2.webp']).expect(201);
  await upload(scan.id, 'MARK_SHEET', ['mark-sheet.webp']).expect(201);
  return scan;
};
const processed = async () => {
  const scan = await uploaded();
  return (await h.http().post(`${base}/${scan.id}/process`).set(staff).expect(200)).body as Scan;
};
const save = (scan: Scan, body: Record<string, unknown>, token = staff) => h.http().patch(`${base}/${scan.id}`).set(token).send({ version: scan.version, ...body });
const lineDtos = (scan: Scan, assign = false) => scan.lines.map((l) => ({
  id: l.id, bags: l.bags, weightKg: l.weightKg, rate: l.rate, amount: l.amount, assignedMarkId: assign && !l.markId ? l.suggestedMarkId : l.assignedMarkId,
}));
const reviewed = async () => {
  const scan = await processed();
  return (await save(scan, { vendorId, productId: onionsId, rateUnit: 'PER_10_KG', lines: lineDtos(scan, true), reason: 'Accepted suggested marks' }).expect(200)).body as Scan;
};
const confirm = (scan: Scan, key: string, token = owner) => h.http().post(`${base}/${scan.id}/confirm`).set(token).set('Idempotency-Key', key).send({ version: scan.version });
const codes = (scan: Scan) => scan.reconciliation.issues.map((i) => i.code);

describe('upload', () => {
  it('stores the photos privately and serves them only through a signed, expiring link', async () => {
    const scan = await uploaded();
    const view = (await h.http().get(`${base}/${scan.id}`).set(staff).expect(200)).body as Scan;
    expect(view.documents.map((d) => [d.kind, d.pageNo])).toEqual([['VENDOR_BILL', 1], ['VENDOR_BILL', 2], ['MARK_SHEET', 1]]);
    const file = await h.http().get(`/api/v1${view.documents[2]!.url}`).expect(200);
    expect(file.headers['content-type']).toBe('image/webp');
    expect(Buffer.compare(file.body as Buffer, photo('mark-sheet.webp'))).toBe(0);
    await h.http().get(`/api/v1${view.documents[2]!.url.replace(/sig=.{5}/, 'sig=AAAAA')}`).expect(403);
    await h.http().get(`/api/v1${view.documents[2]!.url.replace(/exp=\d+/, 'exp=1')}`).expect(403);
  });

  it('rejects a file whose bytes are not an accepted document, and the same file twice', async () => {
    const scan = await start();
    await h.http().post(`${base}/${scan.id}/documents`).set(staff).field('kind', 'MARK_SHEET')
      .attach('files', Buffer.from('<?php system($_GET["c"]); ?>'), { filename: 'sheet.png', contentType: 'image/png' }).expect(422);
    await h.http().post(`${base}/${scan.id}/documents`).set(staff).field('kind', 'INVOICE').attach('files', photo('mark-sheet.webp'), { filename: 'a.webp', contentType: 'image/webp' }).expect(400);
    await upload(scan.id, 'MARK_SHEET', ['mark-sheet.webp']).expect(201);
    await upload(scan.id, 'MARK_SHEET', ['mark-sheet.webp']).expect(409);
    expect(await h.db.consignmentScanDocument.count()).toBe(1);
  });
});

describe('process → review → confirm', () => {
  it('reads both documents in parallel runs and reconciles the reference consignment', async () => {
    const scan = await processed();
    expect(model).toHaveBeenCalledTimes(2);
    expect(scan.runs.map((r) => [r.job, r.status, r.attempts]).sort()).toEqual([['MARK_SHEET', 'SUCCEEDED', 1], ['VENDOR_BILL', 'SUCCEEDED', 1]]);
    expect(scan.runs[0]!.inputTokens).toBe(1200);
    expect([scan.lines.length, scan.marks.length, scan.expenses.length]).toEqual([53, 18, 5]);
    expect(scan.expenses.find((e) => e.label === 'Driver Advance')?.includeInCost).toBe(false);
    expect(scan.lotNumber).toBe('22102026 KA56');
    expect(scan.status).toBe('NEEDS_REVIEW');
    expect(scan.reconciliation.rateUnitEvidence.suggested).toBe('PER_10_KG');
    expect(codes(scan)).toEqual(expect.arrayContaining(['RATE_UNIT_UNKNOWN', 'MISSING_FIELD', 'LINE_UNMATCHED', 'MARK_SHORT']));
    expect(scan.lines.filter((l) => l.provenance === 'UNRESOLVED')).toHaveLength(9);
  });

  it('blocks confirmation while critical issues are open, and for anyone but the owner', async () => {
    const scan = await processed();
    await confirm(scan, 'key-blocked-1').expect(422);
    await confirm(scan, 'key-blocked-2', staff).expect(403);
    await h.http().post(`${base}/${scan.id}/confirm`).set(owner).send({ version: scan.version }).expect(400);
    expect(await h.db.purchase.count({ where: { billNumber: '00045' } })).toBe(0);
  });

  it('a correction recalculates; a stale version is refused', async () => {
    const scan = await reviewed();
    expect(scan.status).toBe('READY');
    expect(scan.reconciliation.canConfirm).toBe(true);
    const lines = lineDtos(scan);
    lines[12] = { ...lines[12]!, weightKg: 1968 }; // a misread 1986 kg
    const changed = (await save(scan, { lines }).expect(200)).body as Scan;
    expect(codes(changed)).toEqual(expect.arrayContaining(['LINE_AMOUNT_MISMATCH', 'BILL_WEIGHT_MISMATCH']));
    expect(changed.status).toBe('NEEDS_REVIEW');
    await save(scan, { lotNumber: '22102026 KB' }).expect(409);
    expect((await h.http().get(`${base}/${scan.id}/versions`).set(staff).expect(200)).body).toHaveLength(3); // read by AI, accepted marks, weight correction
  });

  it('confirm posts the purchase and the stock once; repeating it returns the same purchase', async () => {
    const scan = await reviewed();
    const first = await confirm(scan, 'key-confirm-1').expect(200);
    const purchaseId = first.body.purchaseId as string;
    expect(first.body).toMatchObject({ replayed: false, scan: { status: 'CONFIRMED', purchaseId } });

    const purchase = (await h.http().get(`/api/v1/purchases/${purchaseId}`).set(owner).expect(200)).body as { items: { markCode: string; bags: number }[]; receiptStatus: string; grossAmount: number; totalExpenses: number; netAmount: number; billNumber: string };
    expect(purchase).toMatchObject({ billNumber: '00045', receiptStatus: 'RECEIVED', totalExpenses: 84592.3 });
    expect(purchase.items).toHaveLength(30);
    expect(purchase.items.reduce((t, i) => t + i.bags, 0)).toBe(513);
    expect(purchase.items.map((i) => i.markCode)).toEqual(expect.arrayContaining(['KA56A', 'KA56OK460', 'KA56BK280']));
    // Purchase lines round to whole rupees: ₹1.30 above the vendor's 1057656.70 (reported as ROUNDING_DIFFERENCE).
    expect(purchase.grossAmount).toBe(1057658);
    const movements = await h.db.stockMovement.aggregate({ where: { referenceId: purchaseId, type: 'PURCHASE_IN' }, _sum: { bagsDelta: true }, _count: true });
    expect(movements._sum.bagsDelta).toBe(513);
    expect((await h.db.vendor.findUnique({ where: { partyId: vendorId } }))?.billRateUnit).toBe('PER_10_KG');

    const again = await confirm(scan, 'key-confirm-2').expect(200);
    expect(again.body).toMatchObject({ purchaseId, replayed: true });
    expect(await h.db.stockMovement.count({ where: { referenceId: purchaseId, type: 'PURCHASE_IN' } })).toBe(movements._count);
    expect(await h.db.purchase.count({ where: { billNumber: '00045' } })).toBe(1);

    await save(again.body.scan as Scan, { lotNumber: 'X' }).expect(409);
    await expect(h.db.consignmentScan.update({ where: { id: scan.id }, data: { lotNumber: 'X' } })).rejects.toThrow(/cannot be changed/);
    expect(await h.db.auditLog.count({ where: { action: 'CONFIRM_CONSIGNMENT_SCAN', entityId: scan.id } })).toBe(1);
  });
});

describe('AI failure', () => {
  it('retries an invalid answer on the same model (no escalation by default), records the failed run and leaves the scan retryable', async () => {
    model.mockImplementation(() => Promise.resolve({ text: '{"not":"the schema"}', inputTokens: 10, outputTokens: 5 }));
    const scan = await uploaded();
    const failed = (await h.http().post(`${base}/${scan.id}/process`).set(staff).expect(200)).body as Scan;
    expect(failed.status).toBe('FAILED');
    expect(failed.runs.every((r) => r.status === 'FAILED' && r.attempts === 3 && r.model === 'gemini-3.5-flash-lite')).toBe(true);
    expect(failed.runs[0]!.error).toMatch(/expected/);
    expect(new Set(model.mock.calls.map((c) => c[0]))).toEqual(new Set(['gemini-3.5-flash-lite']));

    model.mockImplementation(answer);
    const retried = (await h.http().post(`${base}/${scan.id}/process`).set(staff).expect(200)).body as Scan;
    expect(retried.status).toBe('NEEDS_REVIEW');
    expect(retried.lines).toHaveLength(53);
  }, 20_000);

  it('uses GEMINI_ESCALATION_MODEL for the last attempt only when it is configured', async () => {
    const env = h.app.get<Env>(ENV);
    env.gemini.escalationModel = 'gemini-3.8-flash';
    try {
      model.mockImplementation((name: string) => (name === 'gemini-3.8-flash' ? answer(name, null, MARK_SHEET_JSON_SCHEMA) : Promise.reject(Object.assign(new Error('Overloaded'), { status: 503 }))));
      const scan = await start();
      await upload(scan.id, 'MARK_SHEET', ['mark-sheet.webp']).expect(201);
      const read = (await h.http().post(`${base}/${scan.id}/process`).set(staff).expect(200)).body as Scan;
      expect(read.runs[0]).toMatchObject({ status: 'SUCCEEDED', model: 'gemini-3.8-flash', attempts: 3 });
    } finally {
      env.gemini.escalationModel = '';
    }
  }, 20_000);
});

describe('Groq Qwen backup', () => {
  let groq: jest.SpyInstance;
  let env: Env;
  beforeEach(() => {
    env = h.app.get<Env>(ENV);
    env.groq.apiKey = 'test-groq-key';
    groq = jest.spyOn(h.app.get(DocumentExtractor), 'callGroq').mockImplementation(answer);
  });
  afterEach(() => {
    env.groq.apiKey = '';
    groq.mockRestore();
  });

  it('reads with Qwen on Groq when Gemini has no key or quota, and records which model answered', async () => {
    model.mockRejectedValue(Object.assign(new Error('Quota exceeded'), { status: 429 }));
    const scan = await uploaded();
    const read = (await h.http().post(`${base}/${scan.id}/process`).set(staff).expect(200)).body as Scan;
    expect(read.runs.map((r) => [r.status, r.model, r.attempts])).toEqual([['SUCCEEDED', 'groq:qwen/qwen3.8-27b', 4], ['SUCCEEDED', 'groq:qwen/qwen3.8-27b', 4]]);
    expect(read.lines).toHaveLength(53);
    expect(groq).toHaveBeenCalledTimes(2);
    expect(groq.mock.calls[0]![0]).toBe('qwen/qwen3.8-27b');
  }, 20_000);

  it('goes straight to the backup when Gemini refuses the request, and does not use it for photos it cannot take', async () => {
    model.mockRejectedValue(Object.assign(new Error('GEMINI_API_KEY is not set'), { status: 401 }));
    const scan = await uploaded();
    const read = (await h.http().post(`${base}/${scan.id}/process`).set(staff).expect(200)).body as Scan;
    expect(read.runs.every((r) => r.status === 'SUCCEEDED' && r.attempts === 4)).toBe(true);
    expect(model).toHaveBeenCalledTimes(2); // one refused call per document, no retries

    const heavy = await start();
    for (const f of ['vendor-bill-p1.webp', 'vendor-bill-p2.webp', 'mark-sheet.webp']) await upload(heavy.id, 'VENDOR_BILL', [f]).expect(201);
    await h.http().post(`${base}/${heavy.id}/documents`).set(staff).field('kind', 'VENDOR_BILL')
      .attach('files', Buffer.concat([photo('mark-sheet.webp'), Buffer.from('x')]), { filename: 'p4.webp', contentType: 'image/webp' }).expect(201);
    groq.mockClear();
    const failed = (await h.http().post(`${base}/${heavy.id}/process`).set(staff).expect(200)).body as Scan;
    expect(groq).not.toHaveBeenCalled();
    expect(failed.runs[0]!.error).toMatch(/Groq backup not used: the backup reads at most 3 photos/);
  });
});

describe('organization isolation', () => {
  it('another organization cannot see, change, process or confirm a scan', async () => {
    const scan = await reviewed();
    const org = await h.db.organization.create({ data: { slug: 'other-mandi', shopName: 'Other Mandi' } });
    const user = await h.db.user.create({ data: { username: 'other-owner', name: 'Other', passwordHash: await hashPassword(PASSWORD) } });
    await h.db.membership.create({ data: { userId: user.id, organizationId: org.id, role: 'OWNER' } });
    const other = auth((await h.http().post('/api/v1/auth/login').send({ username: 'other-owner', password: PASSWORD }).expect(200)).body.accessToken);
    expect((await h.http().get(base).set(other).expect(200)).body).toEqual([]);
    await h.http().get(`${base}/${scan.id}`).set(other).expect(404);
    await save(scan, { lotNumber: 'X' }, other).expect(404);
    await h.http().post(`${base}/${scan.id}/process`).set(other).expect(404);
    await upload(scan.id, 'MARK_SHEET', ['vendor-bill-p2.webp'], other).expect(404);
    await confirm(scan, 'key-other-org', other).expect(404);
    expect(await h.db.purchase.count({ where: { billNumber: '00045' } })).toBe(0);
  });
});
