import { PrismaService } from '../src/database/prisma.service';
import { stockDrift } from '../src/database/reconciliation';
import { auth, type Harness, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;
let manager: Record<string, string>;
let cashier: Record<string, string>;
let onionsId: string;
let customerId: string;

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  manager = auth(await h.token('manager'));
  cashier = auth(await h.token('salesperson'));
  onionsId = ((await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[]).find((p) => p.code === 'ONIONS')!.id;
  customerId = ((await h.http().get('/api/v1/customers').set(owner)).body as { id: string; code: string }[]).find((c) => c.code === 'CUST-001')!.id;
});
afterEach(async () => { expect(await stockDrift(h.db)).toEqual([]); });

const sell = (kg: number[], lot = 'LOT AP', mark = 'AA', rate = 69) => h.http().post('/api/v1/sales').set(cashier).send({
  customerId, productId: onionsId, creditDays: 7, tenders: [], confirmDuplicateSale: true,
  items: [{ lotNumber: lot, markCode: mark, ratePerKg: rate, bagWeights: kg.map((weightKg, i) => ({ bagNumber: i + 1, weightKg })) }],
}).expect(201);
interface Lot { lotNumber: string; soldBags: number; soldKg: number; salesAmount: number; profit: number | null; status: string; base: { cogs: number | null; amali: number; marketFee: number; outgoingLines: unknown[]; realizedProfit: number | null } }
const differential = async (token = manager) => (await h.http().get('/api/v1/reports/differential').set(token).expect(200)).body as { lots: Lot[] };
const lotAp = async () => (await differential()).lots.find((l) => l.lotNumber === 'LOT AP')!;

describe('lot breakdown computed on the server', () => {
  it('is for Owner and Manager and covers every lot', async () => {
    await h.http().get('/api/v1/reports/differential').set(cashier).expect(403);
    const report = await differential(owner);
    expect(report.lots).toHaveLength(9);
    expect(report.lots.find((l) => l.lotNumber === 'LOT AP')).toMatchObject({ soldBags: 0, soldKg: 0, salesAmount: 0 });
  });

  it('shows a new sale at once: sold quantity, sales amount, fees, cost of goods and profit that add up', async () => {
    expect((await lotAp()).soldBags).toBe(0);
    await sell([50.5, 50, 50.5]); // 151 kg × ₹69 = ₹10,419; Amali ₹60 + market fee ₹30
    const lot = await lotAp();
    expect(lot).toMatchObject({ soldBags: 3, soldKg: 151, salesAmount: 10_419 });
    expect(lot.base).toMatchObject({ amali: 60, marketFee: 30 });
    expect(lot.base.outgoingLines).toHaveLength(1);
    expect(lot.base.cogs).toEqual(expect.any(Number));
    // profit = sales − cost of goods sold − Amali − market fee
    expect(lot.profit).toBeCloseTo(10_419 - (lot.base.cogs as number) - 90, 2);
    await sell([50]);
    expect((await lotAp()).soldBags).toBe(4);
  });

  it('a cancelled bill drops out of the report', async () => {
    const sale = (await sell([50.5, 50, 50.5])).body as { id: string };
    expect((await lotAp()).soldBags).toBe(3);
    await h.http().post(`/api/v1/sales/${sale.id}/cancel`).set(owner).send({ reason: 'wrong customer' }).expect(200);
    expect(await lotAp()).toMatchObject({ soldBags: 0, salesAmount: 0 });
  });

  it('is served from the cache until something is written', async () => {
    const prisma = h.app.get(PrismaService);
    const cost = async () => { const before = prisma.queryCount; await differential(); return prisma.queryCount - before; };
    const first = await cost();
    expect(await cost()).toBeLessThan(first);
    await sell([50]);
    expect(await cost()).toBeGreaterThanOrEqual(first);
  });
});

describe('stock movement history is filtered and paged in the database', () => {
  it('filters by lot, mark, type and date, and reports the total in X-Total-Count', async () => {
    await sell([50.5, 50, 50.5]);
    await sell([50], 'LOT TC', 'AA');
    const get = (qs: string) => h.http().get(`/api/v1/stock/movements?${qs}`).set(cashier).expect(200);
    const all = await get('limit=1000');
    expect(Number(all.headers['x-total-count'])).toBe(all.body.length);
    const sales = await get('type=SALE_OUT');
    expect(sales.body).toHaveLength(2);
    expect(sales.headers['x-total-count']).toBe('2');
    const ap = await get('lotNumber=lot ap&type=SALE_OUT');
    expect(ap.body).toEqual([expect.objectContaining({ lotNumber: 'LOT AP', markCode: 'AA', bags: 3, weightKg: 151, type: 'SALE_OUT' })]);
    expect((await get('type=SALE_OUT,PURCHASE_IN')).body.every((m: { type: string }) => ['SALE_OUT', 'PURCHASE_IN'].includes(m.type))).toBe(true);
    expect((await get('markCode=zz')).body).toEqual([]);
    expect((await get('from=2020-01-01&to=2020-12-31')).body).toEqual([]);
    const page = await get('limit=2&offset=0');
    expect(page.body).toHaveLength(2);
    expect(Number(page.headers['x-total-count'])).toBeGreaterThan(2);
    await h.http().get('/api/v1/stock/movements?type=NOT_A_TYPE').set(cashier).expect(400);
  });
});

describe('cached masters never show stale values to the person who just saved', () => {
  it('company, sale charges, marks and costing read back what was just written', async () => {
    const company = (await h.http().get('/api/v1/settings/company').set(owner)).body;
    expect(company).toMatchObject({ inactivePurchaseDays: 45, paymentAlertDays: 2 });
    const saved = await h.http().put('/api/v1/settings/company').set(owner).send({ ...company, shopName: 'Vedhaprem Test Mandi', inactivePurchaseDays: 30, paymentAlertDays: 3 }).expect(200);
    expect(saved.body).toMatchObject({ shopName: 'Vedhaprem Test Mandi', inactivePurchaseDays: 30, paymentAlertDays: 3 });
    expect((await h.http().get('/api/v1/settings/company').set(cashier)).body.shopName).toBe('Vedhaprem Test Mandi');
    await h.http().put('/api/v1/settings/sale-charges').set(owner).send({ amaliPerBag: 25, marketFeePerBag: 5, amaliEnabled: true, marketFeeEnabled: true }).expect(200);
    expect((await h.http().get('/api/v1/settings/sale-charges').set(cashier)).body).toMatchObject({ amaliPerBag: 25, marketFeePerBag: 5 });
    const marks = (await h.http().get('/api/v1/settings/marks').set(owner)).body as { id: string; code: string }[];
    await h.http().patch(`/api/v1/settings/marks/${marks[0]!.id}`).set(owner).send({ defaultSellingRate: 88 }).expect(200);
    expect(((await h.http().get('/api/v1/settings/marks').set(cashier)).body as { id: string; defaultSellingRate: number }[]).find((m) => m.id === marks[0]!.id)!.defaultSellingRate).toBe(88);
    const costing = await h.http().put('/api/v1/settings/costing').set(owner).send({ defaultSellingMarginPerKg: 9, roundingRule: 'CEIL_WHOLE_RUPEE' }).expect(200);
    expect(costing.body.defaultSellingMarginPerKg).toBe(9);
    expect((await h.http().get('/api/v1/settings/costing').set(cashier)).body.defaultSellingMarginPerKg).toBe(9);
  });

  it('a sale is reflected in the cached lot list immediately', async () => {
    const remaining = async () => ((await h.http().get('/api/v1/lots').set(cashier)).body as { lotNumber: string; remainingBags: number }[]).find((l) => l.lotNumber === 'LOT AP')!.remainingBags;
    const before = await remaining();
    await sell([50.5, 50, 50.5]);
    expect(await remaining()).toBe(before - 3);
  });
});

describe('no N+1: query counts do not grow with the data', () => {
  it('lots, movements, sales, purchases, customers, payments, expenses, vendors and reports', async () => {
    const prisma = h.app.get(PrismaService);
    const paths = ['/api/v1/lots', '/api/v1/stock/movements', '/api/v1/sales', '/api/v1/purchases', '/api/v1/customers', '/api/v1/payments', '/api/v1/expenses', '/api/v1/vendors', '/api/v1/reports', '/api/v1/reports/differential', '/api/v1/customers/ledger'];
    const measure = async () => {
      const counts: Record<string, number> = {};
      for (const path of paths) {
        await h.http().post('/api/v1/auth/change-password').set(owner).send({}).expect(400); // any write: empties the cache so every read is a real read
        const before = prisma.queryCount;
        await h.http().get(path).set(owner).expect(200);
        counts[path] = prisma.queryCount - before;
      }
      return counts;
    };
    await sell([50]); // lists short-circuit when empty, so start from one row each to compare like with like
    await h.http().post('/api/v1/payments').set(cashier).send({ customerId, amount: 10, paymentMethod: 'CASH' }).expect(201);
    const small = await measure();
    // grow every collection: more sales across lots, payments, vendor bills and expenses
    const vendorId = ((await h.http().get('/api/v1/vendors').set(owner)).body as { id: string }[])[0]!.id;
    const transport = ((await h.http().get('/api/v1/expense-categories').set(owner)).body as { id: string; name: string }[]).find((c) => c.name === 'Transport')!.id;
    const cash = ((await h.http().get('/api/v1/cash-accounts').set(owner)).body as { id: string; kind: string }[]).find((a) => a.kind === 'CASH')!.id;
    for (let i = 0; i < 4; i += 1) {
      await sell([50], i % 2 ? 'LOT AP' : 'LOT TC', 'AA');
      await h.http().post('/api/v1/payments').set(cashier).send({ customerId, amount: 10, paymentMethod: 'CASH' }).expect(201);
      await h.http().post('/api/v1/expenses').set(cashier).send({ categoryId: transport, amount: 5, date: '2026-10-25', paymentMethod: 'CASH', accountId: cash }).expect(201);
      await h.http().post('/api/v1/purchases').set(cashier).send({ billNumber: `GROW-${i}`, vendorId, productId: onionsId, date: '2026-10-25', lotNumber: `LOT G${i}`, items: [{ markCode: 'ZZ', bags: 1, weightKg: 50, ratePerKg: 40 }] }).expect(201);
    }
    expect(await measure()).toEqual(small);
  });
});
