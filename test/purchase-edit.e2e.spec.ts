import { purchaseDrift, stockDrift } from '../src/database/reconciliation';
import { auth, type Harness, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;
let manager: Record<string, string>;
let cashier: Record<string, string>;
let vendorId: string;
let onionsId: string;

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  manager = auth(await h.token('manager'));
  cashier = auth(await h.token('salesperson'));
  vendorId = ((await h.http().get('/api/v1/vendors').set(owner)).body as { id: string; name: string }[]).find((v) => v.name === 'Murade Traders')!.id;
  onionsId = ((await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[]).find((p) => p.code === 'ONIONS')!.id;
});
afterEach(async () => {
  expect(await purchaseDrift(h.db)).toEqual([]);
  expect(await stockDrift(h.db)).toEqual([]);
});

interface P { id: string; netAmount: number; grossAmount: number; revisionCount: number; receiptStatus: string; items: { id: string; markCode: string; bags: number; weightKg: number; ratePerKg: number; totalAmount: number }[] }
const body = (over: Record<string, unknown> = {}) => ({
  billNumber: 'ED-1', vendorId, productId: onionsId, date: '2026-10-25', lotNumber: 'lot ed',
  items: [{ markCode: 'zz', bags: 10, weightKg: 500, ratePerKg: 40 }], expenses: [{ expenseTypeId: 'custom', expenseTypeName: 'Scale', amount: 1000 }], ...over,
});
const create = async (over: Record<string, unknown> = {}, token = cashier) => (await h.http().post('/api/v1/purchases').set(token).send(body(over)).expect(201)).body as P;
const edit = (p: P, over: Record<string, unknown> = {}, reason = 'Rate was entered wrongly', token = cashier) =>
  h.http().patch(`/api/v1/purchases/${p.id}`).set(token).send({ ...body(), items: p.items.map(({ id, markCode, bags, weightKg, ratePerKg }) => ({ id, markCode, bags, weightKg, ratePerKg })), reason, ...over });
const payable = async () => ((await h.http().get('/api/v1/vendors').set(owner)).body as { id: string; payableAmount: number }[]).find((v) => v.id === vendorId)!.payableAmount;
const receiveAll = (p: P) => h.http().post(`/api/v1/purchases/${p.id}/receive`).set(manager)
  .send({ expenses: [], groups: [{ id: p.items[0]!.id, markCode: 'ZZ', receivedBags: 10, acceptedBags: 10, defectiveBags: 0, receivedWeightKg: 500 }] }).expect(200);

describe('vendor bills are optional-charge, any-date, and open to staff', () => {
  it('a salesperson can enter a bill with no charges at all, dated yesterday, without approval', async () => {
    const p = await create({ date: '2026-10-24', expenses: [] });
    expect(p).toMatchObject({ grossAmount: 20_000, netAmount: 20_000, receiptStatus: 'PENDING_RECEIPT', revisionCount: 0 });
  });
});

describe('correcting a bill before the lot is received', () => {
  it('changes anything, keeps previous and current, and the amount owed follows', async () => {
    const before = await payable();
    const p = await create();
    expect(await payable()).toBe(before + 21_000);
    const res = await edit(p, { billNumber: 'ED-1B', lotNumber: 'lot ed2', date: '2026-10-24', items: [{ markCode: 'zz', bags: 12, weightKg: 600, ratePerKg: 41 }], expenses: [{ expenseTypeId: 'custom', expenseTypeName: 'Scale', amount: 1000 }, { expenseTypeId: 'custom', expenseTypeName: 'Term', amount: 300 }] }).expect(200);
    // 600 kg × ₹41 = ₹24,600 + 1,300 charges
    expect(res.body).toMatchObject({ billNumber: 'ED-1B', lotNumber: 'LOT ED2', date: '2026-10-24', grossAmount: 24_600, totalExpenses: 1300, netAmount: 25_900, revisionCount: 1 });
    expect(await payable()).toBe(before + 25_900);

    const revisions = (await h.http().get(`/api/v1/purchases/${p.id}/revisions`).set(owner).expect(200)).body;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ revisionNo: 1, editedBy: 'Rajesh Kumar', editedByRole: 'SALESPERSON', reason: 'Rate was entered wrongly' });
    const byField = Object.fromEntries(revisions[0].changes.map((c: { field: string }) => [c.field, c]));
    expect(byField.billNumber).toMatchObject({ from: 'ED-1', to: 'ED-1B' });
    expect(byField.items).toMatchObject({ from: expect.stringContaining('10 bags, 500 kg @ ₹40'), to: expect.stringContaining('12 bags, 600 kg @ ₹41') });
    expect(byField.netAmount).toMatchObject({ from: '₹21,000', to: '₹25,900' });
    expect(revisions[0].before.netAmount).toBe(21_000);
    expect(revisions[0].after.netAmount).toBe(25_900);
  });

  it('records each correction in order, by whoever made it, and skips an edit that changes nothing', async () => {
    const p = await create();
    await edit(p, {}, 'No change at all').expect(200);
    expect((await h.http().get(`/api/v1/purchases/${p.id}`).set(owner)).body.revisionCount).toBe(0);
    await edit(p, { notes: 'Truck 2' }, 'Added a note', manager).expect(200);
    await edit(p, { notes: 'Truck 3' }, 'Wrong truck', owner).expect(200);
    const revisions = (await h.http().get(`/api/v1/purchases/${p.id}/revisions`).set(cashier).expect(200)).body;
    expect(revisions.map((r: { revisionNo: number; editedByRole: string }) => [r.revisionNo, r.editedByRole])).toEqual([[2, 'OWNER'], [1, 'MANAGER']]);
    expect(await h.db.auditLog.count({ where: { action: 'EDIT_PURCHASE' } })).toBe(2);
  });

  it('refuses a missing reason, a duplicate bill number, and another organization', async () => {
    const p = await create();
    await create({ billNumber: 'ED-2', lotNumber: 'LOT ED9' });
    await edit(p, {}, 'x').expect(400);
    await edit(p, { billNumber: 'ED-2' }).expect(409);
    await h.http().patch('/api/v1/purchases/00000000-0000-4000-8000-000000000000').set(owner).send({ ...body(), reason: 'nothing here' }).expect(404);
  });
});

describe('correcting a bill after the lot is received', () => {
  it('a corrected rate changes what is owed and the lot cost, but never the selling rate frozen at receiving', async () => {
    const p = await create();
    await receiveAll(p);
    const lotBefore = ((await h.http().get('/api/v1/lots').set(owner)).body as { lotNumber: string; marks: { purchaseRate: number; finalizedSellingRate: number }[] }[]).find((l) => l.lotNumber === 'LOT ED')!.marks[0]!;
    expect(lotBefore).toMatchObject({ purchaseRate: 40, finalizedSellingRate: 46 });
    const owedBefore = await payable();

    const res = await edit(p, { items: [{ id: p.items[0]!.id, markCode: 'ZZ', bags: 10, weightKg: 500, ratePerKg: 42 }], expenses: [{ expenseTypeId: 'custom', expenseTypeName: 'Scale', amount: 1500 }] }, 'Vendor corrected the rate').expect(200);
    expect(res.body).toMatchObject({ grossAmount: 21_000, netAmount: 22_500, receiptStatus: 'RECEIVED', revisionCount: 1 });
    expect(await payable()).toBe(owedBefore + (22_500 - 21_000));
    const lotAfter = ((await h.http().get('/api/v1/lots').set(owner)).body as { lotNumber: string; marks: { purchaseRate: number; finalizedSellingRate: number; remainingBags: number }[] }[]).find((l) => l.lotNumber === 'LOT ED')!.marks[0]!;
    expect(lotAfter).toMatchObject({ purchaseRate: 42, finalizedSellingRate: 46, remainingBags: 10 });
    expect(res.body.receiving.groups[0].calculatedFinalRate).toBe(46); // frozen record untouched
  });

  it("accepts the frontend's own correction payload (it echoes the receipt status and client totals)", async () => {
    const p = await create();
    await receiveAll(p);
    await edit(p, { receiptStatus: 'RECEIVED', vendorName: 'ignored', productName: 'ignored', grossAmount: 1, totalExpenses: 1, netAmount: 1, expenses: [] }, 'Charges were not billed').expect(200);
    await h.http().post('/api/v1/purchases').set(cashier).send(body({ billNumber: 'ED-RCV', receiptStatus: 'RECEIVED' })).expect(400);
  });

  it('what arrived cannot be changed here: quantities, qualities, vendor, lot and product are fixed', async () => {
    const p = await create();
    await receiveAll(p);
    const line = p.items[0]!;
    await edit(p, { items: [{ id: line.id, markCode: 'ZZ', bags: 11, weightKg: 500, ratePerKg: 40 }] }).expect(422);
    await edit(p, { items: [{ id: line.id, markCode: 'ZZ', bags: 10, weightKg: 510, ratePerKg: 40 }] }).expect(422);
    await edit(p, { items: [{ id: line.id, markCode: 'QQ', bags: 10, weightKg: 500, ratePerKg: 40 }] }).expect(422);
    await edit(p, { items: [{ markCode: 'ZZ', bags: 10, weightKg: 500, ratePerKg: 40 }] }).expect(422); // not the existing line
    await edit(p, { lotNumber: 'LOT OTHER' }).expect(422);
    expect((await h.http().get(`/api/v1/purchases/${p.id}/revisions`).set(owner)).body).toEqual([]);
  });

  it('the database still refuses a direct change, and the receipt itself can never be changed even during an edit', async () => {
    const p = await create();
    await receiveAll(p);
    await expect(h.db.purchase.update({ where: { id: p.id }, data: { notes: 'sneaky' } })).rejects.toThrow(/append-only/);
    await expect(h.db.purchaseItem.update({ where: { id: p.items[0]!.id }, data: { ratePerKg: 1 } })).rejects.toThrow(/append-only/);
    await expect(h.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('vedhaprem.purchase_edit', 'on', true)`;
      await tx.$executeRaw`UPDATE purchases SET receiving_record = '{}'::jsonb WHERE id = ${p.id}::uuid`;
    })).rejects.toThrow(/receipt of a purchase cannot be changed/);
    await expect(h.db.purchaseRevision.deleteMany({ where: { purchaseId: p.id } })).resolves.toBeDefined(); // none yet: nothing to delete
    await edit(p, { notes: 'ok' }).expect(200);
    await expect(h.db.purchaseRevision.updateMany({ where: { purchaseId: p.id }, data: { reason: 'rewritten' } })).rejects.toThrow(/append-only/);
  });
});
