import { counterCashDrift, expenseDrift, purchaseDrift, receivableDrift, stockDrift } from '../src/database/reconciliation';
import { auth, type Harness, startHarness } from './harness';

/**
 * One trading cycle of this business, with every figure worked out by hand:
 * buy from the bigger distributor -> receive -> sell to a retailer (part cash, rest credit) -> collect -> pay the vendor.
 */
let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => { await h.reset(); });

const cents = (n: number) => Math.round(n * 100);

it('buy, receive, sell, collect and pay the vendor: every balance tallies', async () => {
  const manager = auth(await h.token('manager'));
  const cashier = auth(await h.token('salesperson'));
  const get = async <T>(path: string, token = manager) => (await h.http().get(`/api/v1${path}`).set(token).expect(200)).body as T;

  const onions = (await get<{ id: string; code: string }[]>('/settings/products')).find((p) => p.code === 'ONIONS')!;
  const vendor = (await get<{ id: string; name: string }[]>('/vendors')).find((v) => v.name === 'Murade Traders')!;
  const retailer = (await get<{ id: string; code: string; outstandingAmount: number }[]>('/customers')).find((c) => c.code === 'CUST-001')!;
  const accounts = await get<{ id: string; kind: string }[]>('/cash-accounts');
  const cash = accounts.find((a) => a.kind === 'CASH')!.id;
  const upi = accounts.find((a) => a.kind === 'UPI')!.id;
  const categories = await get<{ id: string; name: string }[]>('/expense-categories');
  const vendorBefore = (await get<{ id: string; payableAmount: number }[]>('/vendors')).find((v) => v.id === vendor.id)!.payableAmount;

  // 1. Vendor bill: 100 bags, 5,000 kg at ₹40/kg = ₹2,00,000 + Scale 1,000 + Term 2,000 + Loading 500 = ₹2,03,500 owed.
  const bill = (await h.http().post('/api/v1/purchases').set(manager).send({
    billNumber: 'BIG-001', vendorId: vendor.id, productId: onions.id, date: '2026-10-25', lotNumber: '25 OCT TL',
    items: [{ markCode: 'QA', bags: 100, weightKg: 5000, ratePerKg: 40 }],
    expenses: [{ expenseTypeId: 'custom', expenseTypeName: 'Scale', amount: 1000 }, { expenseTypeId: 'custom', expenseTypeName: 'Term', amount: 2000 }, { expenseTypeId: 'custom', expenseTypeName: 'Loading', amount: 500 }],
  }).expect(201)).body;
  expect(bill).toMatchObject({ grossAmount: 200_000, totalExpenses: 3500, netAmount: 203_500 });
  expect((await get<{ id: string; payableAmount: number }[]>('/vendors')).find((v) => v.id === vendor.id)!.payableAmount).toBe(vendorBefore + 203_500);

  // 2. Receive all 100 bags / 5,000 kg; Transport ₹5,000 over 5,000 kg = ₹1/kg -> landed ₹41 + margin ₹6 = ₹47/kg.
  await h.http().post(`/api/v1/purchases/${bill.id}/receive`).set(manager).send({
    expenses: [{ id: 'rx', expenseTypeId: 'cet', expenseTypeName: 'Transport', amount: 5000, allocation: { method: 'BY_RECEIVED_KG' } }],
    groups: [{ id: bill.items[0].id, markCode: 'QA', receivedBags: 100, acceptedBags: 100, defectiveBags: 0, receivedWeightKg: 5000 }],
  }).expect(200);
  const lot = () => get<{ lotNumber: string; marks: { markCode: string; remainingBags: number; remainingWeightKg: number; finalizedSellingRate: number }[] }[]>('/lots').then((l) => l.find((x) => x.lotNumber === '25 OCT TL')!.marks[0]!);
  expect(await lot()).toMatchObject({ remainingBags: 100, remainingWeightKg: 5000, finalizedSellingRate: 47 });

  // 3. Sell 2 bags (50.5 + 50 = 100.5 kg) at ₹47: round(100.5 × 47 = 4,723.5) = ₹4,724.
  //    Charges: Amali ₹20 × 2 + market fee ₹10 × 2 = ₹60. Bill ₹4,784. Cash ₹2,000 now, ₹2,784 on credit.
  const sale = (await h.http().post('/api/v1/sales').set(cashier).send({
    customerId: retailer.id, productId: onions.id, creditDays: 7, tenders: [{ method: 'CASH', amount: 2000 }],
    items: [{ lotNumber: '25 OCT TL', markCode: 'QA', ratePerKg: 47, bagWeights: [{ bagNumber: 1, weightKg: 50.5 }, { bagNumber: 2, weightKg: 50 }] }],
  }).expect(201)).body;
  expect(sale).toMatchObject({ totalBags: 2, totalWeightKg: 100.5, productSubtotal: 4724, totalAmount: 4784, paidAmount: 2000, balanceDue: 2784, paymentStatus: 'PARTIAL' });
  expect(await lot()).toMatchObject({ remainingBags: 98, remainingWeightKg: 4899.5 });
  expect((await get<{ id: string; outstandingAmount: number }[]>('/customers', cashier)).find((c) => c.id === retailer.id)!.outstandingAmount).toBe(retailer.outstandingAmount + 2784);

  // 4. Retailer pays ₹1,000 by UPI -> still owes ₹1,784 of this bill.
  await h.http().post('/api/v1/payments').set(cashier).send({ customerId: retailer.id, amount: 1000, paymentMethod: 'UPI' }).expect(201);
  const retailerNow = (await get<{ id: string; outstandingAmount: number }[]>('/customers')).find((c) => c.id === retailer.id)!;
  expect(cents(retailerNow.outstandingAmount)).toBe(cents(retailer.outstandingAmount + 2784 - 1000));

  // 5. We pay the bigger distributor ₹1,00,000 by UPI, and ₹500 diesel in cash.
  const category = (name: string) => categories.find((c) => c.name === name)!.id;
  await h.http().post('/api/v1/expenses').set(manager).send({ categoryId: category('Purchase Payments'), vendorId: vendor.id, amount: 100_000, date: '2026-10-25', paymentMethod: 'UPI', accountId: upi }).expect(201);
  await h.http().post('/api/v1/expenses').set(manager).send({ categoryId: category('Transport'), amount: 500, date: '2026-10-25', paymentMethod: 'CASH', accountId: cash }).expect(201);

  // Tally: vendor owes 2,03,500 − 1,00,000; money in = 2,000 + 1,000; money out = 1,00,000 + 500.
  expect((await get<{ id: string; payableAmount: number }[]>('/vendors')).find((v) => v.id === vendor.id)!.payableAmount).toBe(vendorBefore + 103_500);
  const receipts = await get<{ amount: number }[]>('/payments');
  const expenses = await get<{ amount: number }[]>('/expenses');
  expect(receipts.reduce((t, r) => t + cents(r.amount), 0)).toBe(cents(3000));
  expect(expenses.reduce((t, e) => t + cents(e.amount), 0)).toBe(cents(100_500));

  // Every ledger agrees with its own history.
  expect(await stockDrift(h.db)).toEqual([]);
  expect(await receivableDrift(h.db)).toEqual([]);
  expect(await counterCashDrift(h.db)).toEqual([]);
  expect(await purchaseDrift(h.db)).toEqual([]);
  expect(await expenseDrift(h.db)).toEqual([]);
});
