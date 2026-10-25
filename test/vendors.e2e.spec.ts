import { PrismaService } from '../src/database/prisma.service';
import { expenseDrift, purchaseDrift, stockDrift } from '../src/database/reconciliation';
import { auth, type Harness, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;
let manager: Record<string, string>;
let cashier: Record<string, string>;
let murade: { id: string };
let onionsId: string;
let vendorPayId: string;
let cashId: string;

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  manager = auth(await h.token('manager'));
  cashier = auth(await h.token('salesperson'));
  murade = (await vendors()).find((v) => v.name === 'Murade Traders')!;
  onionsId = ((await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[]).find((p) => p.code === 'ONIONS')!.id;
  vendorPayId = ((await h.http().get('/api/v1/expense-categories').set(owner)).body as { id: string; name: string }[]).find((c) => c.name === 'Purchase Payments')!.id;
  cashId = ((await h.http().get('/api/v1/cash-accounts').set(owner)).body as { id: string; kind: string }[]).find((a) => a.kind === 'CASH')!.id;
});
afterEach(async () => {
  expect(await expenseDrift(h.db)).toEqual([]);
  expect(await purchaseDrift(h.db)).toEqual([]);
  expect(await stockDrift(h.db)).toEqual([]);
});

interface VendorRow { id: string; name: string; totalPurchases: number; openingBalance: number; previousDue: number; newDue: number; advanceAmount: number; payableAmount: number }
const vendors = async () => (await h.http().get('/api/v1/vendors').set(owner)).body as VendorRow[];
const vendor = async () => (await vendors()).find((v) => v.id === murade.id)!;
const pay = (amount: number) => h.http().post('/api/v1/expenses').set(manager)
  .send({ categoryId: vendorPayId, vendorId: murade.id, amount, date: '2026-10-25', paymentMethod: 'CASH', accountId: cashId }).expect(201);
const setOpening = (openingBalance: number) => h.http().patch(`/api/v1/vendors/${murade.id}`).set(owner).send({ openingBalance }).expect(200);

describe('previous due and new due', () => {
  it('only the Owner can set what was owed before the system; it is audited', async () => {
    await h.http().patch(`/api/v1/vendors/${murade.id}`).set(manager).send({ openingBalance: 100 }).expect(403);
    await h.http().patch(`/api/v1/vendors/${murade.id}`).set(manager).send({ phone: '+91 99999 00000' }).expect(200); // other fields stay with management
    await h.http().post('/api/v1/vendors').set(manager).send({ name: 'Nashik Agro', openingBalance: 5 }).expect(403);
    const created = await h.http().post('/api/v1/vendors').set(owner).send({ name: 'Nashik Agro', mandiCity: 'Nashik', openingBalance: 75_000 }).expect(201);
    expect(created.body).toMatchObject({ openingBalance: 75_000, previousDue: 75_000, newDue: 0, advanceAmount: 0, payableAmount: 75_000, totalPurchases: 0 });
    await setOpening(250_000);
    expect(await h.db.auditLog.count({ where: { action: 'UPDATE_VENDOR_OPENING' } })).toBe(1);
  });

  it('shows the previous due and the new due separately, and payments clear the old dues first', async () => {
    await setOpening(250_000);
    expect(await vendor()).toMatchObject({ openingBalance: 250_000, previousDue: 250_000, newDue: 708_500, advanceAmount: 0, payableAmount: 958_500, totalPurchases: 708_500 });
    await pay(100_000);
    expect(await vendor()).toMatchObject({ previousDue: 150_000, newDue: 708_500, payableAmount: 858_500 });
    await pay(200_000.5); // clears the last 150,000 of old dues, then 50,000.50 of the new bills
    expect(await vendor()).toMatchObject({ previousDue: 0, newDue: 658_499.5, payableAmount: 658_499.5, advanceAmount: 0 });
  });

  it('an advance paid before the system (negative opening) is used by the first bills', async () => {
    await setOpening(-10_000);
    expect(await vendor()).toMatchObject({ previousDue: 0, newDue: 698_500, payableAmount: 698_500, advanceAmount: 0 });
  });

  it('paying beyond everything owed is an advance with the vendor, and a new bill uses it', async () => {
    await pay(708_500 + 25_000);
    expect(await vendor()).toMatchObject({ payableAmount: 0, advanceAmount: 25_000 });
    await h.http().post('/api/v1/purchases').set(cashier).send({
      billNumber: 'ADV-1', vendorId: murade.id, productId: onionsId, date: '2026-10-25', lotNumber: 'LOT ADV',
      items: [{ markCode: 'ZZ', bags: 10, weightKg: 500, ratePerKg: 40 }], // ₹20,000
    }).expect(201);
    expect(await vendor()).toMatchObject({ payableAmount: 0, advanceAmount: 5_000 });
  });
});

describe('vendor account statement', () => {
  it('lists each bill with how much of it is paid, and every payment', async () => {
    await setOpening(50_000);
    await pay(70_000.25);
    const ledger = (await h.http().get(`/api/v1/vendors/${murade.id}/ledger`).set(manager).expect(200)).body;
    // 70,000.25 − 50,000 old dues = 20,000.25 goes to the oldest bill (PUR-2026-081, ₹5,44,600)
    expect(ledger).toMatchObject({ openingBalance: 50_000, previousDue: 0, newDue: 708_500 - 20_000.25, advanceAmount: 0 });
    expect(ledger.bills.map((b: { billNumber: string }) => b.billNumber)).toEqual(['PUR-2026-081', 'PUR-2026-109']);
    expect(ledger.bills[0]).toMatchObject({ netAmount: 544_600, paidAmount: 20_000.25, balanceAmount: 524_599.75, status: 'PARTIAL' });
    expect(ledger.bills[1]).toMatchObject({ netAmount: 163_900, paidAmount: 0, status: 'UNPAID' });
    expect(ledger.payments).toEqual([expect.objectContaining({ amount: 70_000.25, paymentMethod: 'CASH', accountName: 'Cash in Hand', recordedBy: 'Suresh Patil' })]);
    expect(ledger.bills.reduce((t: number, b: { balanceAmount: number }) => t + b.balanceAmount, 0)).toBeCloseTo(ledger.newDue, 2);
  });

  it('is for Owner and Manager; a salesperson sees vendor names but no amounts owed', async () => {
    await h.http().get(`/api/v1/vendors/${murade.id}/ledger`).set(cashier).expect(403);
    const list = (await h.http().get('/api/v1/vendors').set(cashier).expect(200)).body as Record<string, unknown>[];
    expect(list).toHaveLength(3);
    for (const v of list) expect(Object.keys(v).filter((k) => /due|payable|advance|opening|totalPurchases/i.test(k))).toEqual([]);
    await h.http().get(`/api/v1/vendors/00000000-0000-4000-8000-000000000000/ledger`).set(owner).expect(404);
  });
});

describe('no N+1 on vendor reads', () => {
  it('the number of queries does not grow with the number of vendors, bills or payments', async () => {
    const prisma = h.app.get(PrismaService);
    const count = async (path: string) => { const before = prisma.queryCount; await h.http().get(path).set(owner).expect(200); return prisma.queryCount - before; };
    const baseList = await count('/api/v1/vendors');
    const baseLedger = await count(`/api/v1/vendors/${murade.id}/ledger`);
    for (let i = 0; i < 6; i += 1) {
      await h.http().post('/api/v1/vendors').set(owner).send({ name: `Extra vendor ${i}` }).expect(201);
      await h.http().post('/api/v1/purchases').set(manager).send({
        billNumber: `N1-${i}`, vendorId: murade.id, productId: onionsId, date: '2026-10-25', lotNumber: `LOT N${i}`, items: [{ markCode: 'ZZ', bags: 1, weightKg: 50, ratePerKg: 40 }],
      }).expect(201);
      await pay(10);
    }
    expect(await count('/api/v1/vendors')).toBe(baseList);
    expect(await count(`/api/v1/vendors/${murade.id}/ledger`)).toBe(baseLedger);
  });
});
