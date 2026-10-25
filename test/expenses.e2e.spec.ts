import { expenseDrift, purchaseDrift, stockDrift } from '../src/database/reconciliation';
import { hashPassword } from '../src/modules/auth/passwords';
import { auth, type Harness, PASSWORD, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;
let manager: Record<string, string>;
let cashier: Record<string, string>;
let cashId: string;
let upiId: string;
let transportId: string;
let vendorPayId: string;
let murade: { id: string; totalPurchases: number; payableAmount: number };

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  manager = auth(await h.token('manager'));
  cashier = auth(await h.token('salesperson'));
  const accounts = (await h.http().get('/api/v1/cash-accounts').set(manager)).body as { id: string; kind: string }[];
  cashId = accounts.find((a) => a.kind === 'CASH')!.id;
  upiId = accounts.find((a) => a.kind === 'UPI')!.id;
  const categories = (await h.http().get('/api/v1/expense-categories').set(manager)).body as { id: string; name: string }[];
  transportId = categories.find((c) => c.name === 'Transport')!.id;
  vendorPayId = categories.find((c) => c.name === 'Purchase Payments')!.id;
  murade = await vendor('Murade Traders');
});
afterEach(async () => {
  expect(await expenseDrift(h.db)).toEqual([]);
  expect(await purchaseDrift(h.db)).toEqual([]);
  expect(await stockDrift(h.db)).toEqual([]);
});

const vendor = async (name: string) =>
  ((await h.http().get('/api/v1/vendors').set(owner)).body as { id: string; name: string; totalPurchases: number; payableAmount: number }[]).find((v) => v.name === name)!;
const expense = (over: Record<string, unknown> = {}) => ({ categoryId: transportId, amount: 1500.5, date: '2026-10-25', paymentMethod: 'CASH', accountId: cashId, reference: 'Truck 1', ...over });
const pay = (over: Record<string, unknown> = {}) => h.http().post('/api/v1/expenses').set(manager).send(expense({ categoryId: vendorPayId, vendorId: murade.id, ...over }));

describe('cash accounts and categories', () => {
  it('lists the seeded accounts and categories, Owner and Manager only', async () => {
    const accounts = (await h.http().get('/api/v1/cash-accounts').set(owner).expect(200)).body;
    expect(accounts.map((a: { kind: string }) => a.kind).sort()).toEqual(['BANK', 'CASH', 'UPI']);
    expect((await h.http().get('/api/v1/expense-categories').set(manager).expect(200)).body).toHaveLength(7);
    for (const path of ['cash-accounts', 'expense-categories', 'expenses']) await h.http().get(`/api/v1/${path}`).set(cashier).expect(403);
  });

  it('adds a category once, whatever the letter case, and tracks it against a collection bucket', async () => {
    const created = await h.http().post('/api/v1/expense-categories').set(manager).send({ name: ' Cold Storage ', trackingCategory: 'OTHER' }).expect(201);
    expect(created.body).toMatchObject({ name: 'Cold Storage', trackingCategory: 'OTHER' });
    const again = await h.http().post('/api/v1/expense-categories').set(manager).send({ name: 'cold storage' }).expect(201);
    expect(again.body.id).toBe(created.body.id);
    expect((await h.http().get('/api/v1/expense-categories').set(manager)).body).toHaveLength(8);
    await h.http().post('/api/v1/expense-categories').set(manager).send({ name: ' ' }).expect(422);
    await h.http().post('/api/v1/expense-categories').set(cashier).send({ name: 'x' }).expect(403);
  });
});

describe('recording an expense', () => {
  it('records, names the category and account, and uses the category default tracking', async () => {
    const res = await h.http().post('/api/v1/expenses').set(manager).send(expense({ totalAmount: 1, categoryName: 'ignored' })).expect(201);
    expect(res.body).toMatchObject({ categoryName: 'Transport', accountName: 'Cash in Hand', amount: 1500.5, date: '2026-10-25', paymentMethod: 'CASH', reference: 'Truck 1', trackingCategory: null, recordedBy: 'Suresh Patil' });
    const marketFee = ((await h.http().get('/api/v1/expense-categories').set(manager)).body as { id: string; name: string }[]).find((c) => c.name === 'Market Fee Expense')!;
    expect((await h.http().post('/api/v1/expenses').set(owner).send(expense({ categoryId: marketFee.id })).expect(201)).body.trackingCategory).toBe('MARKET_FEE');
    expect((await h.http().post('/api/v1/expenses').set(owner).send(expense({ categoryId: marketFee.id, trackingCategory: null })).expect(201)).body.trackingCategory).toBeNull();
    expect((await h.http().get('/api/v1/expenses').set(manager)).body).toHaveLength(3);
  });

  it('refuses bad input, unknown records, another organization and the salesperson; rows cannot be changed in SQL', async () => {
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ amount: 0 })).expect(400);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ amount: -5 })).expect(400);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ amount: 10.123 })).expect(400);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ date: '25-10-2026' })).expect(400);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ paymentMethod: 'BITCOIN' })).expect(400);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ categoryId: '00000000-0000-4000-8000-000000000000' })).expect(404);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ accountId: '00000000-0000-4000-8000-000000000000' })).expect(404);
    await h.http().post('/api/v1/expenses').set(cashier).send(expense()).expect(403);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ vendorId: murade.id })).expect(422); // vendor on a non-vendor category

    const org = await h.db.organization.create({ data: { slug: 'other-mandi', shopName: 'Other Mandi' } });
    const user = await h.db.user.create({ data: { username: 'other-owner', name: 'Other', passwordHash: await hashPassword(PASSWORD) } });
    await h.db.membership.create({ data: { userId: user.id, organizationId: org.id, role: 'OWNER' } });
    const other = auth((await h.http().post('/api/v1/auth/login').send({ username: 'other-owner', password: PASSWORD }).expect(200)).body.accessToken);
    await h.http().post('/api/v1/expenses').set(other).send(expense()).expect(404);
    expect((await h.http().get('/api/v1/expenses').set(other).expect(200)).body).toEqual([]);
    expect(await h.db.expense.count()).toBe(0);

    const ok = await h.http().post('/api/v1/expenses').set(manager).send(expense()).expect(201);
    await expect(h.db.expense.update({ where: { id: ok.body.id }, data: { amount: 1 } })).rejects.toThrow(/append-only/);
    await expect(h.db.expense.delete({ where: { id: ok.body.id } })).rejects.toThrow(/append-only/);
  });
});

describe('vendor payments reduce what we owe', () => {
  it('Purchase Payments needs a vendor, and the payable falls by exactly what was paid', async () => {
    expect(murade.totalPurchases).toBe(708_500);
    expect(murade.payableAmount).toBe(708_500);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ categoryId: vendorPayId })).expect(422); // no vendor
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ categoryId: vendorPayId, vendorId: '00000000-0000-4000-8000-000000000000' })).expect(404);

    const first = await pay({ amount: 200_000.25 }).expect(201);
    expect(first.body).toMatchObject({ categoryName: 'Purchase Payments', vendorId: murade.id, vendorName: 'Murade Traders', amount: 200_000.25 });
    await pay({ amount: 99_999.75, paymentMethod: 'UPI', accountId: upiId }).expect(201);
    const after = await vendor('Murade Traders');
    expect(after.totalPurchases).toBe(708_500);
    expect(after.payableAmount).toBe(408_500); // 708,500 − 200,000.25 − 99,999.75
    expect((await vendor('Kaveri Traders')).payableAmount).toBe(1_006_800); // other vendors untouched
  });

  it('a new vendor bill adds to the payable, and paying more than is owed is refused', async () => {
    const products = (await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[];
    await h.http().post('/api/v1/purchases').set(manager).send({
      billNumber: 'V-9', vendorId: murade.id, productId: products.find((p) => p.code === 'ONIONS')!.id, date: '2026-10-25', lotNumber: 'LOT NEW',
      items: [{ markCode: 'ZZ', bags: 10, weightKg: 500, ratePerKg: 40 }], expenses: [{ expenseTypeId: 'custom', expenseTypeName: 'Tarp', amount: 500 }],
    }).expect(201);
    expect((await vendor('Murade Traders')).payableAmount).toBe(708_500 + 20_500);
    await pay({ amount: 729_000.01 }).expect(409);
    await pay({ amount: 729_000 }).expect(201); // exactly what is owed
    expect((await vendor('Murade Traders')).payableAmount).toBe(0);
    await pay({ amount: 0.01 }).expect(409);
  });

  it('ten simultaneous payments cannot overspend the balance', async () => {
    await pay({ amount: 708_500 - 100 }).expect(201); // ₹100 left
    const results = await Promise.all(Array.from({ length: 10 }, () => pay({ amount: 60 })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1); // 100 / 60 = one payment fits
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect((await vendor('Murade Traders')).payableAmount).toBe(40);
  });
});

describe('the books tally', () => {
  it('receipts, expenses and account balances add up exactly (cash flow identity)', async () => {
    const customers = (await h.http().get('/api/v1/customers').set(owner)).body as { id: string; outstandingAmount: number }[];
    const c = customers.find((x) => x.outstandingAmount > 0)!;
    await h.http().post('/api/v1/payments').set(owner).send({ customerId: c.id, amount: 12_345.67, paymentMethod: 'UPI' }).expect(201);
    await h.http().post('/api/v1/payments').set(owner).send({ customerId: c.id, amount: 5_000, paymentMethod: 'CASH' }).expect(201);
    await pay({ amount: 7_000.5 }).expect(201);
    await h.http().post('/api/v1/expenses').set(manager).send(expense({ amount: 800.25, accountId: upiId, paymentMethod: 'UPI' })).expect(201);

    const receipts = (await h.http().get('/api/v1/payments').set(owner)).body as { amount: number }[];
    const expenses = (await h.http().get('/api/v1/expenses').set(owner)).body as { amount: number }[];
    const cents = (n: number) => Math.round(n * 100);
    const collected = receipts.reduce((t, r) => t + cents(r.amount), 0);
    const paidOut = expenses.reduce((t, e) => t + cents(e.amount), 0);
    expect(collected).toBe(cents(17_345.67));
    expect(paidOut).toBe(cents(7_800.75));
    // The frontend maps UPI/QR → UPI account, cheque/card/bank → bank, anything else → cash.
    const byAccount = { CASH: 5_000 - 7_000.5, UPI: 12_345.67 - 800.25 };
    expect(cents(byAccount.CASH + byAccount.UPI)).toBe(collected - paidOut);
    // Customer side: what they owed fell by what they paid.
    expect(((await h.http().get(`/api/v1/customers/${c.id}`).set(owner)).body as { outstandingAmount: number }).outstandingAmount).toBe((cents(c.outstandingAmount) - cents(17_345.67)) / 100);
  });
});
