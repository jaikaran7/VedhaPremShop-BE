import { purchaseDrift, stockDrift } from '../src/database/reconciliation';
import { hashPassword } from '../src/modules/auth/passwords';
import { auth, type Harness, PASSWORD, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;
let manager: Record<string, string>;
let cashier: Record<string, string>;
let vendorId: string;
let onionsId: string;
let garlicId: string;
let scaleTypeId: string;
let transportTypeId: string;

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  manager = auth(await h.token('manager'));
  cashier = auth(await h.token('salesperson'));
  const products = (await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[];
  onionsId = products.find((p) => p.code === 'ONIONS')!.id;
  garlicId = products.find((p) => p.code === 'GARLIC')!.id;
  vendorId = (await vendors()).find((v) => v.name === 'Murade Traders')!.id;
  const types = (await h.http().get('/api/v1/settings/costing/expense-types').set(owner)).body as { id: string; name: string; kind: string }[];
  scaleTypeId = types.find((t) => t.name === 'Scale' && t.kind === 'PURCHASE')!.id;
  transportTypeId = types.find((t) => t.name === 'Transport' && t.kind === 'STOCK_RECEIVING')!.id;
});
afterEach(async () => {
  expect(await stockDrift(h.db)).toEqual([]);
  expect(await purchaseDrift(h.db)).toEqual([]);
});

interface PurchaseBody { id: string; items: { id: string; markCode: string }[]; receiptStatus: string; receiving?: { groups: { calculatedFinalRate: number }[]; issues: { blocking: boolean }[] } }
const vendors = async () => (await h.http().get('/api/v1/vendors').set(owner)).body as { id: string; name: string; totalPurchases: number; payableAmount: number }[];
const lots = async (token = owner) => (await h.http().get('/api/v1/lots').set(token)).body as {
  lotNumber: string; purchaseBillId: string; marks: { markCode: string; remainingBags: number; remainingWeightKg: number; initialBags: number; purchaseRate?: number; finalizedSellingRate?: number }[];
}[];
const bill = (over: Record<string, unknown> = {}) => ({
  billNumber: 'V-1001', vendorId, productId: onionsId, date: '2026-10-25', lotNumber: 'lot zz',
  items: [{ markCode: 'zz', bags: 10, weightKg: 500.5, ratePerKg: 40.25 }],
  expenses: [{ expenseTypeId: scaleTypeId, amount: 1200 }, { expenseTypeId: 'custom', expenseTypeName: 'Tarpaulin', amount: 300 }],
  ...over,
});
const create = async (over: Record<string, unknown> = {}) => (await h.http().post('/api/v1/purchases').set(manager).send(bill(over)).expect(201)).body as PurchaseBody;
const draft = (p: PurchaseBody, group: Record<string, unknown> = {}, expenses: unknown[] = []) => ({
  expenses,
  groups: [{ id: p.items[0]!.id, markCode: 'ZZ', receivedBags: 10, acceptedBags: 10, defectiveBags: 0, receivedWeightKg: 500.5, ...group }],
});
const receive = (p: PurchaseBody, body: unknown, token = manager) => h.http().post(`/api/v1/purchases/${p.id}/receive`).set(token).send(body as object);
const movementsFor = (purchaseId: string) => h.db.stockMovement.findMany({ where: { referenceId: purchaseId, type: 'PURCHASE_IN' } });
const transport = (amount: number) => ({ id: 'rx1', expenseTypeId: transportTypeId, expenseTypeName: 'Transport', amount, allocation: { method: 'BY_RECEIVED_KG' } });

describe('vendor bill', () => {
  it('computes amounts on the server, records the payable and posts no stock', async () => {
    const before = (await vendors()).find((v) => v.id === vendorId)!;
    const res = await h.http().post('/api/v1/purchases').set(manager)
      .send(bill({ grossAmount: 1, netAmount: 1, totalExpenses: 1, vendorName: 'ignored', receiptStatus: 'PENDING_RECEIPT' })).expect(201);
    expect(res.body).toMatchObject({
      billNumber: 'V-1001', lotNumber: 'LOT ZZ', receiptStatus: 'PENDING_RECEIPT', grossAmount: 20_145, totalExpenses: 1500, netAmount: 21_645,
      items: [{ markCode: 'ZZ', bags: 10, weightKg: 500.5, ratePerKg: 40.25, totalAmount: 20_145 }],
      expenses: [{ expenseTypeId: scaleTypeId, expenseTypeName: 'Scale', amount: 1200 }, { expenseTypeName: 'Tarpaulin', amount: 300 }],
    });
    expect((await lots()).some((l) => l.lotNumber === 'LOT ZZ')).toBe(false);
    expect(await h.db.stockMovement.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
    const after = (await vendors()).find((v) => v.id === vendorId)!;
    expect(after.totalPurchases - before.totalPurchases).toBe(21_645);
    expect(after.payableAmount - before.payableAmount).toBe(21_645);
  });

  it('seeded vendors show their derived purchase totals', async () => {
    expect(await vendors()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Murade Traders', totalPurchases: 708_500 }),
      expect.objectContaining({ name: 'Kaveri Traders', totalPurchases: 1_006_800 }),
    ]));
  });

  it('is Owner/Manager only, refuses a duplicate bill, bad input, repeated marks and stock-posting statuses', async () => {
    await h.http().get('/api/v1/purchases').set(cashier).expect(403);
    await h.http().post('/api/v1/purchases').set(cashier).send(bill()).expect(403);
    await create();
    await h.http().post('/api/v1/purchases').set(manager).send(bill({ lotNumber: 'LOT YY' })).expect(409);
    await h.http().post('/api/v1/purchases').set(manager).send(bill({ billNumber: 'V-2', items: [{ markCode: 'A', bags: 0, weightKg: 10, ratePerKg: 5 }] })).expect(400);
    await h.http().post('/api/v1/purchases').set(manager).send(bill({ billNumber: 'V-3', date: '25/10/2026' })).expect(400);
    await h.http().post('/api/v1/purchases').set(manager).send(bill({ billNumber: 'V-4', receiptStatus: 'RECEIVED' })).expect(400);
    await h.http().post('/api/v1/purchases').set(manager).send(bill({ billNumber: 'V-5', items: [{ markCode: 'a', bags: 1, weightKg: 10, ratePerKg: 5 }, { markCode: 'A', bags: 1, weightKg: 10, ratePerKg: 5 }] })).expect(422);
    await h.http().post('/api/v1/purchases').set(manager).send(bill({ billNumber: 'V-6', vendorId: '00000000-0000-4000-8000-000000000000' })).expect(404);
    expect(await h.db.purchase.count({ where: { billNumber: { startsWith: 'V-' } } })).toBe(1);
  });

  it('refuses an inactive expense type on a new bill but keeps old bills as they were', async () => {
    await h.http().patch(`/api/v1/settings/costing/expense-types/${scaleTypeId}`).set(owner).send({ status: 'INACTIVE' }).expect(200);
    await h.http().post('/api/v1/purchases').set(manager).send(bill()).expect(422);
  });
});

describe('receiving', () => {
  it('posts the lot once with the server-computed selling rate, and the stock can be sold', async () => {
    const p = await create();
    // ₹500.5 Transport over 500.5 kg = ₹1/kg → landed 41.25 + default margin 6 = 47.25 → rounded up to ₹48.
    const res = await receive(p, draft(p, { acceptedBags: 9, defectiveBags: 1 }, [transport(500.5)])).expect(200);
    expect(res.body).toMatchObject({ receiptStatus: 'RECEIVED', receiving: { stockPosted: true, groups: [{ markCode: 'ZZ', landedCostPerKg: 41.25, calculatedFinalRate: 48 }] } });
    const lot = (await lots()).find((l) => l.lotNumber === 'LOT ZZ')!;
    expect(lot.purchaseBillId).toBe(p.id);
    expect(lot.marks).toEqual([expect.objectContaining({ markCode: 'ZZ', initialBags: 10, remainingBags: 10, remainingWeightKg: 500.5, purchaseRate: 40.25, finalizedSellingRate: 48 })]);
    // A salesperson sees the selling rate but not what the lot cost.
    expect((await lots(cashier)).find((l) => l.lotNumber === 'LOT ZZ')!.marks[0]).toMatchObject({ finalizedSellingRate: 48 });
    expect((await lots(cashier)).find((l) => l.lotNumber === 'LOT ZZ')!.marks[0]).not.toHaveProperty('purchaseRate');
    expect(await movementsFor(p.id)).toHaveLength(1);

    const customerId = ((await h.http().get('/api/v1/customers').set(owner)).body as { id: string }[])[0]!.id;
    await h.http().post('/api/v1/sales').set(cashier)
      .send({ customerId, productId: onionsId, tenders: [], creditDays: 7, items: [{ lotNumber: 'LOT ZZ', markCode: 'ZZ', ratePerKg: 48, bagWeights: [{ bagNumber: 1, weightKg: 50 }] }] }).expect(201);
    expect((await lots()).find((l) => l.lotNumber === 'LOT ZZ')!.marks[0]).toMatchObject({ remainingBags: 9, remainingWeightKg: 450.5 });
  });

  it('receiving again, or ten times at once, posts stock exactly once', async () => {
    const p = await create();
    const body = draft(p);
    await receive(p, body).expect(200);
    const again = await receive(p, body).expect(200);
    expect(again.body.receiptStatus).toBe('RECEIVED');

    const q = await create({ billNumber: 'V-1002', lotNumber: 'LOT QQ', items: [{ markCode: 'q', bags: 10, weightKg: 500.5, ratePerKg: 40.25 }] });
    const results = await Promise.all(Array.from({ length: 10 }, () => receive(q, draft(q, { markCode: 'Q' }))));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(await movementsFor(q.id)).toHaveLength(1);
    expect((await lots()).find((l) => l.lotNumber === 'LOT QQ')!.marks[0]).toMatchObject({ remainingBags: 10, remainingWeightKg: 500.5 });
  });

  it('posts only the bags taken; shortfalls are recorded as non-blocking issues', async () => {
    const p = await create();
    const res = await receive(p, draft(p, { receivedBags: 10, acceptedBags: 6, defectiveBags: 0 })).expect(200);
    expect(res.body.receiving.issues.some((i: { blocking: boolean }) => !i.blocking)).toBe(true);
    // 6 of 10 received bags => 60% of 500.5 kg
    expect((await lots()).find((l) => l.lotNumber === 'LOT ZZ')!.marks[0]).toMatchObject({ remainingBags: 6, remainingWeightKg: 300.3 });
  });

  it('refuses a draft with blocking issues and leaves nothing behind', async () => {
    const p = await create();
    await receive(p, draft(p, { revisedSellingRate: 60 })).expect(422); // manual rate without a reason
    await receive(p, draft(p, { bagWeights: [{ bagNumber: 1, weightKg: 50 }], receivedWeightKg: 500.5 })).expect(422); // bag weights do not add up
    await receive(p, { expenses: [], groups: [{ id: 'not-on-the-bill', markCode: 'ZZ', receivedBags: 1, acceptedBags: 1, defectiveBags: 0, receivedWeightKg: 50, originalPurchaseRate: 40 }] }).expect(422); // bill line missing
    await receive(p, draft(p, {}, [{ ...transport(100), allocation: { method: 'ASSIGN_TO_GROUP', groupId: 'nope' } }])).expect(422);
    expect((await h.http().get(`/api/v1/purchases/${p.id}`).set(manager)).body.receiptStatus).toBe('PENDING_RECEIPT');
    expect((await lots()).some((l) => l.lotNumber === 'LOT ZZ')).toBe(false);
  });

  it('takes rate and expected quantity from the bill, not from the client', async () => {
    const p = await create();
    const res = await receive(p, draft(p, { originalPurchaseRate: 1, expectedBags: 999 })).expect(200);
    expect(res.body.receiving.groups[0]).toMatchObject({ originalPurchaseRate: 40.25, expectedBags: 10, calculatedFinalRate: 47 });
  });

  it('extends an existing lot, keeping its purchase rate; a different product is refused atomically', async () => {
    const before = (await lots()).find((l) => l.lotNumber === 'LOT AP')!.marks.find((m) => m.markCode === 'AA')!;
    const p = await create({ billNumber: 'V-1003', lotNumber: 'lot ap', items: [{ markCode: 'aa', bags: 10, weightKg: 500, ratePerKg: 60 }] });
    await receive(p, draft(p, { markCode: 'AA', receivedWeightKg: 500 })).expect(200);
    const after = (await lots()).find((l) => l.lotNumber === 'LOT AP')!.marks.find((m) => m.markCode === 'AA')!;
    expect(after.remainingBags).toBe(before.remainingBags + 10);
    expect(after.initialBags).toBe(before.initialBags + 10);
    expect(after.purchaseRate).toBe(before.purchaseRate);
    expect(after.finalizedSellingRate).toBe(66); // 60 + 6

    const garlic = await create({ billNumber: 'V-1004', lotNumber: 'LOT AP', productId: garlicId });
    await receive(garlic, draft(garlic)).expect(409);
    expect((await h.http().get(`/api/v1/purchases/${garlic.id}`).set(manager)).body.receiptStatus).toBe('PENDING_RECEIPT');
  });

  it('uses the costing settings in force: default margin and extra per-kg margins', async () => {
    await h.http().put('/api/v1/settings/costing').set(manager).send({ defaultSellingMarginPerKg: 10, roundingRule: 'CEIL_WHOLE_RUPEE' }).expect(403);
    await h.http().put('/api/v1/settings/costing').set(owner).send({ defaultSellingMarginPerKg: 10, roundingRule: 'CEIL_WHOLE_RUPEE' }).expect(200);
    await h.http().post('/api/v1/settings/costing/margins').set(owner).send({ name: 'Quality', perKg: 2.5 }).expect(201);
    await h.http().post('/api/v1/settings/costing/margins').set(owner).send({ name: 'quality', perKg: 1 }).expect(409);
    const p = await create();
    const res = await receive(p, draft(p)).expect(200);
    expect(res.body.receiving.groups[0].calculatedFinalRate).toBe(53); // 40.25 + 10 + 2.5 = 52.75 → 53
    expect(res.body.receiving.groups[0].rateSnapshot).toMatchObject({ defaultSellingMarginPerKg: 10, additionalMargins: [{ name: 'Quality', perKg: 2.5 }] });
    // A later settings change does not rewrite the finalized lot.
    await h.http().put('/api/v1/settings/costing').set(owner).send({ defaultSellingMarginPerKg: 20, roundingRule: 'CEIL_WHOLE_RUPEE' }).expect(200);
    expect((await lots()).find((l) => l.lotNumber === 'LOT ZZ')!.marks[0]).toMatchObject({ finalizedSellingRate: 53 });
  });

  it('a posted purchase cannot be edited or deleted in the database', async () => {
    const p = await create();
    await receive(p, draft(p)).expect(200);
    await expect(h.db.purchase.update({ where: { id: p.id }, data: { notes: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(h.db.purchase.delete({ where: { id: p.id } })).rejects.toThrow(/cannot be deleted/);
    await expect(h.db.purchaseItem.deleteMany({ where: { purchaseId: p.id } })).rejects.toThrow(/append-only/);
  });
});

describe('organization isolation', () => {
  it('another organization cannot read, receive or list purchases', async () => {
    const p = await create();
    const org = await h.db.organization.create({ data: { slug: 'other-mandi', shopName: 'Other Mandi' } });
    const user = await h.db.user.create({ data: { username: 'other-owner', name: 'Other', passwordHash: await hashPassword(PASSWORD) } });
    await h.db.membership.create({ data: { userId: user.id, organizationId: org.id, role: 'OWNER' } });
    const other = auth((await h.http().post('/api/v1/auth/login').send({ username: 'other-owner', password: PASSWORD }).expect(200)).body.accessToken);
    expect((await h.http().get('/api/v1/purchases').set(other).expect(200)).body).toEqual([]);
    await h.http().get(`/api/v1/purchases/${p.id}`).set(other).expect(404);
    await receive(p, draft(p), other).expect(404);
    await h.http().post('/api/v1/purchases').set(other).send(bill({ billNumber: 'X-1' })).expect(404); // vendor belongs to the other org
    expect(await h.db.stockMovement.count({ where: { type: 'PURCHASE_IN' } })).toBe(0);
  });
});

describe('reports snapshot', () => {
  it('returns the six collections the Reports screen needs, to Owner and Manager only', async () => {
    const res = await h.http().get('/api/v1/reports').set(manager).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['customers', 'lots', 'payments', 'purchases', 'sales', 'vendors']);
    expect(res.body.purchases).toHaveLength(9);
    expect(res.body.vendors).toHaveLength(3);
    await h.http().get('/api/v1/reports').set(cashier).expect(403);
  });
});
