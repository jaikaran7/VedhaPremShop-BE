import { PrismaService } from '../src/database/prisma.service';
import { counterCashDrift, expenseDrift, receivableDrift } from '../src/database/reconciliation';
import { auth, type Harness, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;
let manager: Record<string, string>;
let cashier: Record<string, string>;
let acct: Record<'CASH' | 'UPI' | 'BANK', string>;
let transportId: string;
let customerId: string;

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  manager = auth(await h.token('manager'));
  cashier = auth(await h.token('salesperson'));
  const accounts = (await h.http().get('/api/v1/cash-accounts').set(owner)).body as { id: string; kind: 'CASH' | 'UPI' | 'BANK' }[];
  acct = Object.fromEntries(accounts.map((a) => [a.kind, a.id])) as typeof acct;
  transportId = ((await h.http().get('/api/v1/expense-categories').set(owner)).body as { id: string; name: string }[]).find((c) => c.name === 'Transport')!.id;
  customerId = ((await h.http().get('/api/v1/customers').set(owner)).body as { id: string; code: string }[]).find((c) => c.code === 'CUST-001')!.id;
  // Real money at the start of 20 Oct: ₹10,000.50 cash, ₹5,000 on UPI, nothing in the bank.
  for (const [kind, amount] of [['CASH', 10_000.5], ['UPI', 5_000], ['BANK', 0]] as const) {
    await h.http().put(`/api/v1/cash-accounts/${acct[kind]}/opening`).set(owner).send({ openingBalance: amount, openingDate: '2026-10-20' }).expect(200);
  }
});
afterEach(async () => {
  expect(await expenseDrift(h.db)).toEqual([]);
  expect(await receivableDrift(h.db)).toEqual([]);
  expect(await counterCashDrift(h.db)).toEqual([]);
});

interface Book { date: string; accounts: { kind: string; beforeOpening: boolean; openingBalance: number; received: number; paidOut: number; closingBalance: number }[]; totals: { openingBalance: number; received: number; paidOut: number; closingBalance: number }; entries: { type: string; party: string; amount: number }[] }
const book = async (date: string, token = owner) => (await h.http().get(`/api/v1/cash-book?date=${date}`).set(token).expect(200)).body as Book;
const row = (b: Book, kind: string) => b.accounts.find((a) => a.kind === kind)!;
const spend = (date: string, amount: number, kind: 'CASH' | 'UPI', token = cashier) =>
  h.http().post('/api/v1/expenses').set(token).send({ categoryId: transportId, amount, date, paymentMethod: kind === 'UPI' ? 'UPI' : 'CASH', accountId: acct[kind] }).expect(201);
const receive = (amount: number, paymentMethod: string) => h.http().post('/api/v1/payments').set(cashier).send({ customerId, amount, paymentMethod }).expect(201);

describe('opening balance and carry-forward', () => {
  it("each day's closing balance is the next day's opening balance", async () => {
    await spend('2026-10-22', 500, 'CASH');
    await spend('2026-10-23', 300, 'UPI');
    expect(row(await book('2026-10-21'), 'CASH')).toMatchObject({ openingBalance: 10_000.5, paidOut: 0, closingBalance: 10_000.5 });
    expect(row(await book('2026-10-22'), 'CASH')).toMatchObject({ openingBalance: 10_000.5, paidOut: 500, closingBalance: 9_500.5 });
    const day23 = await book('2026-10-23');
    expect(row(day23, 'CASH')).toMatchObject({ openingBalance: 9_500.5, closingBalance: 9_500.5 });
    expect(row(day23, 'UPI')).toMatchObject({ openingBalance: 5_000, paidOut: 300, closingBalance: 4_700 });
    expect(day23.totals).toMatchObject({ openingBalance: 14_500.5, paidOut: 300, closingBalance: 14_200.5 });
  });

  it('an expense entered later for an earlier day readjusts that day and every day after it', async () => {
    await spend('2026-10-22', 500, 'CASH');
    expect(row(await book('2026-10-23'), 'CASH').openingBalance).toBe(9_500.5); // cached read
    await spend('2026-10-21', 200, 'CASH', manager); // forgotten yesterday-ish expense, entered now
    expect(row(await book('2026-10-21'), 'CASH')).toMatchObject({ openingBalance: 10_000.5, closingBalance: 9_800.5 });
    expect(row(await book('2026-10-22'), 'CASH')).toMatchObject({ openingBalance: 9_800.5, closingBalance: 9_300.5 });
    expect(row(await book('2026-10-23'), 'CASH')).toMatchObject({ openingBalance: 9_300.5 });
  });

  it("today's receipts go to the right account and carry on from the earlier days", async () => {
    await spend('2026-10-22', 500, 'CASH');
    const t = today();
    await receive(1_000, 'CASH');
    await receive(2_000.25, 'UPI');
    const b = await book(t);
    expect(row(b, 'CASH')).toMatchObject({ openingBalance: 9_500.5, received: 1_000, closingBalance: 10_500.5 });
    expect(row(b, 'UPI')).toMatchObject({ openingBalance: 5_000, received: 2_000.25, closingBalance: 7_000.25 });
    expect(b.entries.filter((e) => e.type === 'Collection').map((e) => e.amount)).toEqual([1_000, 2_000.25]);
    // The tally: opening + in − out = closing, over all accounts.
    expect(b.totals.openingBalance + b.totals.received - b.totals.paidOut).toBeCloseTo(b.totals.closingBalance, 2);
  });

  it('shows vendor payments and expenses as money out, and a day before the opening date as not yet open', async () => {
    const vendorPay = ((await h.http().get('/api/v1/expense-categories').set(owner)).body as { id: string; name: string }[]).find((c) => c.name === 'Purchase Payments')!.id;
    const vendorId = ((await h.http().get('/api/v1/vendors').set(owner)).body as { id: string }[])[0]!.id;
    await h.http().post('/api/v1/expenses').set(manager).send({ categoryId: vendorPay, vendorId, amount: 4_000, date: '2026-10-24', paymentMethod: 'UPI', accountId: acct.UPI }).expect(201);
    await spend('2026-10-24', 150, 'CASH');
    const b = await book('2026-10-24');
    expect(b.entries.map((e) => e.type).sort()).toEqual(['Expense', 'Vendor payment']);
    expect(row(b, 'UPI')).toMatchObject({ paidOut: 4_000, closingBalance: 1_000 });
    expect(row(await book('2026-10-19'), 'CASH')).toMatchObject({ beforeOpening: true, openingBalance: 0, closingBalance: 0 });
  });
});

describe('who can see what', () => {
  it('only the Owner sees balances; everyone sees what was collected on a day', async () => {
    await h.http().get(`/api/v1/cash-book?date=${today()}`).set(manager).expect(403);
    await h.http().get(`/api/v1/cash-book?date=${today()}`).set(cashier).expect(403);
    await h.http().put(`/api/v1/cash-accounts/${acct.CASH}/opening`).set(manager).send({ openingBalance: 1, openingDate: '2026-10-20' }).expect(403);
    await h.http().get('/api/v1/cash-book?date=nope').set(owner).expect(400);
    await receive(1_000, 'CASH');
    await receive(500, 'UPI');
    for (const token of [cashier, manager, owner]) {
      const daily = (await h.http().get(`/api/v1/collections/daily?date=${today()}`).set(token).expect(200)).body;
      expect(daily).toMatchObject({ date: today(), collected: 1_500 });
      expect(daily.byMethod.map((m: { method: string; amount: number }) => [m.method, m.amount]).sort()).toEqual([['CASH', 1_000], ['UPI', 500]]);
      expect(JSON.stringify(daily)).not.toMatch(/closing|opening/i);
    }
  });

  it('staff can record an expense for a past day; they see their own, the Owner and Manager see all', async () => {
    await spend('2026-10-22', 100, 'CASH', cashier);
    await spend('2026-10-22', 200, 'CASH', manager);
    expect(((await h.http().get('/api/v1/expenses').set(cashier).expect(200)).body as unknown[])).toHaveLength(1);
    expect(((await h.http().get('/api/v1/expenses').set(manager).expect(200)).body as unknown[])).toHaveLength(2);
    expect(((await h.http().get('/api/v1/expenses').set(owner).expect(200)).body as unknown[])).toHaveLength(2);
  });
});

describe('no N+1 and cached reads', () => {
  it('the cash book costs the same number of queries with 1 or 20 entries, and a repeat read is served from the cache', async () => {
    const prisma = h.app.get(PrismaService);
    const t = today();
    const queries = async () => { const before = prisma.queryCount; await book(t); return prisma.queryCount - before; };
    await receive(100, 'CASH');
    const base = await queries();
    const cached = await queries();
    expect(cached).toBeLessThan(base); // only the sign-in check, no book queries
    for (let i = 0; i < 10; i += 1) { await receive(10, i % 2 ? 'UPI' : 'CASH'); await spend(t, 5, 'CASH'); }
    expect(await queries()).toBe(base);
    expect(row(await book(t), 'CASH').closingBalance).toBeCloseTo(10_000.5 + 100 + 50 - 50, 2); // new entries are visible at once: the write cleared the cache
  });
});
