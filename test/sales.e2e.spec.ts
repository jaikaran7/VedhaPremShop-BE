import { counterCashDrift, receivableDrift, stockDrift } from '../src/database/reconciliation';
import { auth, type Harness, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;
let manager: Record<string, string>;
let cashier: Record<string, string>;
let onionsId: string;
let customers: Record<string, { id: string; outstandingAmount: number }>;

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  manager = auth(await h.token('manager'));
  cashier = auth(await h.token('salesperson'));
  const products = (await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[];
  onionsId = products.find((p) => p.code === 'ONIONS')!.id;
  const list = (await h.http().get('/api/v1/customers').set(owner)).body as { id: string; code: string; outstandingAmount: number }[];
  customers = Object.fromEntries(list.map((c) => [c.code, c]));
});
afterEach(async () => {
  // Every scenario must leave the books balanced.
  expect(await stockDrift(h.db)).toEqual([]);
  expect(await receivableDrift(h.db)).toEqual([]);
  expect(await counterCashDrift(h.db)).toEqual([]);
});

const bags = (...kg: number[]) => kg.map((weightKg, i) => ({ bagNumber: i + 1, weightKg }));
const sale = (over: Record<string, unknown> = {}) => ({
  customerId: customers['CUST-001']!.id,
  productId: onionsId,
  items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.5, 50, 50.5) }],
  tenders: [],
  creditDays: 7,
  ...over,
});
// 151 kg × ₹69 = ₹10,419; 3 bags × (₹20 Amali + ₹10 market fee) = ₹90 → ₹10,509
const TOTAL = 10_509;
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const daysAgo = (n: number) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

const lotMark = async (lot: string, mark: string) => {
  const lots = (await h.http().get('/api/v1/lots').set(owner)).body as { lotNumber: string; marks: { markCode: string; remainingBags: number; remainingWeightKg: number }[] }[];
  return lots.find((l) => l.lotNumber === lot)!.marks.find((m) => m.markCode === mark)!;
};
const customer = async (code: string) =>
  (await h.http().get(`/api/v1/customers/${customers[code]!.id}`).set(owner)).body as { outstandingAmount: number; advanceAmount: number };
const outstanding = async (code: string) => (await customer(code)).outstandingAmount;
const approvals = async () => (await h.http().get('/api/v1/approvals').set(cashier).expect(200)).body as { id: string; status: string; requestType: string; referenceNo: string }[];

describe('cash, credit and counter bills', () => {
  it('cash bill: bill, stock out, receipt and audit together; outstanding unchanged', async () => {
    const res = await h.http().post('/api/v1/sales').set(cashier)
      .send(sale({ tenders: [{ method: 'CASH', amount: TOTAL }], totalAmount: TOTAL, status: 'IGNORED', paidAmount: 1 })).expect(201);
    expect(res.body).toMatchObject({
      billNumber: 'VPN-INV-1085', date: today(), totalBags: 3, totalWeightKg: 151, productSubtotal: 10_419, totalAmount: TOTAL,
      paymentType: 'CASH', paymentStatus: 'PAID', paidAmount: TOTAL, balanceDue: 0, status: 'CONFIRMED',
      tenders: [{ method: 'CASH', amount: TOTAL }], charges: { amaliAmount: 60, marketFeeAmount: 30, finalInvoiceAmount: TOTAL },
    });
    expect(await lotMark('LOT AP', 'AA')).toMatchObject({ remainingBags: 75, remainingWeightKg: 3905 });
    expect(await outstanding('CUST-001')).toBe(150_000);
    const receipts = (await h.http().get('/api/v1/payments').set(owner)).body;
    expect(receipts[0]).toMatchObject({ receiptNumber: 'VPN-REC-510', amount: TOTAL, previousOutstanding: 160_509, newOutstanding: 150_000 });
  });

  it('counter bill must be paid in full; its cash is collected under "Counter sales"', async () => {
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ customerId: '', tenders: [] })).expect(422);
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ customerId: '', tenders: [{ method: 'UPI', amount: TOTAL }] })).expect(201);
    const receipts = (await h.http().get('/api/v1/payments').set(owner)).body;
    expect(receipts[0]).toMatchObject({ customerId: '', customerName: 'Counter sales', amount: TOTAL, paymentMethod: 'UPI' });
  });

  it('credit bill uses the customer default credit days when none are sent', async () => {
    const res = await h.http().post('/api/v1/sales').set(cashier).send(sale({ creditDays: undefined })).expect(201);
    expect(res.body).toMatchObject({ paymentType: 'CREDIT', creditDays: 7, balanceDue: TOTAL });
  });

  it('blocked and over-limit customers can still be billed (the screen warns)', async () => {
    await h.http().patch(`/api/v1/customers/${customers['CUST-002']!.id}`).set(owner).send({ status: 'BLOCKED', creditLimit: 1000 }).expect(200);
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ customerId: customers['CUST-002']!.id })).expect(201);
  });
});

describe('receipts and advances', () => {
  it('a receipt settles the named bill first, then the oldest dues (opening balance first)', async () => {
    const credit = await h.http().post('/api/v1/sales').set(cashier).send(sale()).expect(201);
    const named = await h.http().post('/api/v1/payments').set(cashier)
      .send({ customerId: customers['CUST-001']!.id, amount: 4000, paymentMethod: 'UPI', referenceNumber: credit.body.billNumber }).expect(201);
    expect(named.body).toMatchObject({ previousOutstanding: 160_509, newOutstanding: 156_509, billAllocations: [{ billNumber: credit.body.billNumber, amount: 4000 }] });
    expect((await h.http().get(`/api/v1/sales/${credit.body.id}`).set(owner)).body).toMatchObject({ paidAmount: 4000, balanceDue: 6509, paymentStatus: 'PARTIAL' });

    const general = await h.http().post('/api/v1/payments').set(owner).send({ customerId: customers['CUST-001']!.id, amount: 10_000, paymentMethod: 'CASH' }).expect(201);
    expect(general.body.billAllocations).toEqual([{ saleId: null, billNumber: null, amount: 10_000 }]);
    expect(await outstanding('CUST-001')).toBe(146_509);
  });

  it('paying more than owed is accepted and kept as an advance that the next bill uses', async () => {
    const paid = await h.http().post('/api/v1/payments').set(cashier)
      .send({ customerId: customers['CUST-004']!.id, amount: 50_000, paymentMethod: 'CASH' }).expect(201);
    expect(paid.body).toMatchObject({ previousOutstanding: 45_000, newOutstanding: -5000, unallocatedAmount: 5000 });
    expect(await customer('CUST-004')).toMatchObject({ outstandingAmount: 0, advanceAmount: 5000 });

    const bill = await h.http().post('/api/v1/sales').set(cashier).send(sale({ customerId: customers['CUST-004']!.id })).expect(201);
    expect(bill.body).toMatchObject({ paidAmount: 5000, balanceDue: TOTAL - 5000, paymentStatus: 'PARTIAL' });
    expect(await customer('CUST-004')).toMatchObject({ outstandingAmount: TOTAL - 5000, advanceAmount: 0 });
  });
});

describe('stock and price guards', () => {
  it('rejects overselling and rolls back everything, including the bill number', async () => {
    const tc = await lotMark('LOT NS', 'TC');
    await h.http().post('/api/v1/sales').set(cashier)
      .send(sale({ items: [{ lotNumber: 'LOT NS', markCode: 'TC', ratePerKg: 50, bagWeights: bags(...Array.from({ length: tc.remainingBags + 1 }, () => 1)) }] })).expect(409);
    expect(await lotMark('LOT NS', 'TC')).toEqual(tc);
    expect((await h.http().post('/api/v1/sales').set(cashier).send(sale()).expect(201)).body.billNumber).toBe('VPN-INV-1085');
  });

  it('never sells the same last bags twice under concurrent requests', async () => {
    const tc = await lotMark('LOT NS', 'TC'); // 20 bags
    const perBag = Math.floor((tc.remainingWeightKg / tc.remainingBags) * 1000) / 1000;
    const attempt = () => h.http().post('/api/v1/sales').set(cashier)
      .send(sale({ items: [{ lotNumber: 'lot ns', markCode: 'tc', ratePerKg: 40, bagWeights: bags(...Array.from({ length: 6 }, () => perBag)) }] }));
    const results = await Promise.all(Array.from({ length: 5 }, attempt));
    const created = results.filter((r) => r.status === 201);
    expect(created).toHaveLength(Math.floor(tc.remainingBags / 6));
    expect(results.filter((r) => r.status === 409)).toHaveLength(5 - created.length);
    expect((await lotMark('LOT NS', 'TC')).remainingBags).toBe(tc.remainingBags - 6 * created.length);
  });

  it('refuses a bill whose total differs from what the cashier saw; allows selling below the floor rate', async () => {
    await h.http().put('/api/v1/settings/sale-charges').set(owner).send({ amaliPerBag: 25, marketFeePerBag: 10, amaliEnabled: true, marketFeeEnabled: true }).expect(200);
    expect((await h.http().post('/api/v1/sales').set(cashier).send(sale({ totalAmount: TOTAL })).expect(409)).body.message).toMatch(/₹10524/);
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 30, bagWeights: bags(50) }] })).expect(201);
  });

  it('rejects other-product lots and bad weighments', async () => {
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ items: [{ lotNumber: 'LOT GL', markCode: 'BOLD', ratePerKg: 90, bagWeights: bags(50) }] })).expect(422);
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(-5) }] })).expect(400);
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.1234) }] })).expect(400);
  });

  it('the same Idempotency-Key returns the first bill / receipt, even concurrently', async () => {
    const first = await h.http().post('/api/v1/sales').set(cashier).set('Idempotency-Key', 'sale-retry-0001').send(sale()).expect(201);
    const again = await h.http().post('/api/v1/sales').set(cashier).set('Idempotency-Key', 'sale-retry-0001').send(sale()).expect(201);
    expect(again.body.id).toBe(first.body.id);
    const body = { customerId: customers['CUST-001']!.id, amount: 500, paymentMethod: 'CASH' };
    const both = await Promise.all([1, 2].map(() => h.http().post('/api/v1/payments').set(owner).set('Idempotency-Key', 'pay-retry-0001').send(body)));
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    expect(both[0]!.body.id).toBe(both[1]!.body.id);
  });
});

describe('bills dated another day', () => {
  it('a staff bill dated another day posts at once: stock, receivable and receipt are all on that date, no approval', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const res = await h.http().post('/api/v1/sales').set(cashier).send(sale({ date: daysAgo(2), dateReason: "Yesterday's slip entered late", tenders: [{ method: 'CASH', amount: 1000 }] })).expect(201);
    expect(res.body).toMatchObject({ status: 'CONFIRMED', date: daysAgo(2), paidAmount: 1000, balanceDue: TOTAL - 1000 });
    expect((await lotMark('LOT AP', 'AA')).remainingBags).toBe(before.remainingBags - 3);
    expect(await outstanding('CUST-001')).toBe(150_000 + TOTAL - 1000);
    expect((await h.http().get('/api/v1/payments').set(owner)).body[0]).toMatchObject({ date: daysAgo(2), amount: 1000 });
    expect(await approvals()).toEqual([]); // nothing waits for the owner
    expect(await h.db.auditLog.count({ where: { action: 'CREATE_SALE', details: { contains: `dated ${daysAgo(2)}` } } })).toBe(1);
  });

  it('the manager and the owner can back-date too; dates far away are still refused', async () => {
    expect((await h.http().post('/api/v1/sales').set(manager).send(sale({ date: daysAgo(1) })).expect(201)).body).toMatchObject({ status: 'CONFIRMED', date: daysAgo(1) });
    expect((await h.http().post('/api/v1/sales').set(owner).send(sale({ date: daysAgo(3) })).expect(201)).body).toMatchObject({ status: 'CONFIRMED', date: daysAgo(3) });
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ date: daysAgo(400) })).expect(400);
    expect(await approvals()).toEqual([]);
  });

  it('cancelling or editing such a bill still goes to the owner', async () => {
    const bill = (await h.http().post('/api/v1/sales').set(cashier).send(sale({ date: daysAgo(1) })).expect(201)).body as { id: string };
    const res = await h.http().post(`/api/v1/sales/${bill.id}/cancel`).set(cashier).send({ reason: 'Duplicate slip' }).expect(200);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    expect((await approvals())[0]).toMatchObject({ requestType: 'SALE_CANCEL', status: 'PENDING' });
  });
});

describe('cancel and rebill', () => {
  it('owner cancels a paid bill: stock returns, the receipt becomes credit for other dues', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const paid = await h.http().post('/api/v1/sales').set(cashier).send(sale({ tenders: [{ method: 'CASH', amount: TOTAL }] })).expect(201);
    const res = await h.http().post(`/api/v1/sales/${paid.body.id}/cancel`).set(owner).send({ reason: 'Customer returned bags' }).expect(200);
    expect(res.body).toMatchObject({ status: 'APPLIED', sale: { status: 'CANCELLED', paidAmount: 0 } });
    expect(await lotMark('LOT AP', 'AA')).toEqual(before);
    // The ₹10,509 receipt now settles part of the opening balance.
    expect(await outstanding('CUST-001')).toBe(150_000 - TOTAL);
  });

  it('staff cancel goes to the owner; staff can see it but not decide', async () => {
    const bill = await h.http().post('/api/v1/sales').set(cashier).send(sale()).expect(201);
    const res = await h.http().post(`/api/v1/sales/${bill.body.id}/cancel`).set(cashier).send({ reason: 'Duplicate bill' }).expect(200);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    await h.http().post(`/api/v1/sales/${bill.body.id}/cancel`).set(manager).send({ reason: 'again' }).expect(409);
    expect((await h.http().get(`/api/v1/sales/${bill.body.id}`).set(owner)).body.status).toBe('CONFIRMED');
    await h.http().post(`/api/v1/approvals/${res.body.approvalId}`).set(owner).send({ action: 'APPROVE' }).expect(204);
    expect((await h.http().get(`/api/v1/sales/${bill.body.id}`).set(owner)).body.status).toBe('CANCELLED');
    expect(await outstanding('CUST-001')).toBe(150_000);
  });

  it('rebill replaces the bill: stock readjusted, money moved to the new bill', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const paid = await h.http().post('/api/v1/sales').set(cashier).send(sale({ tenders: [{ method: 'UPI', amount: 5000 }] })).expect(201);
    const edited = { ...sale({ tenders: [] }), items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.5, 50) }], reason: 'Third bag was not loaded' };
    const res = await h.http().post(`/api/v1/sales/${paid.body.id}/rebill`).set(owner).send(edited).expect(200);
    // 100.5 kg × ₹69 = ₹6,935 (6934.5 rounds up) + 2 bags × ₹30 = ₹6,995
    expect(res.body).toMatchObject({ status: 'APPLIED', sale: { totalAmount: 6995, paidAmount: 5000, balanceDue: 1995, replacesBillNumber: paid.body.billNumber, date: paid.body.date } });
    expect((await h.http().get(`/api/v1/sales/${paid.body.id}`).set(owner)).body).toMatchObject({ status: 'CANCELLED', replacedByBillNumber: res.body.sale.billNumber });
    expect((await lotMark('LOT AP', 'AA')).remainingBags).toBe(before.remainingBags - 2);
    expect(await outstanding('CUST-001')).toBe(150_000 + 1995);
  });

  it('staff rebill waits for approval; a counter rebill to a smaller bill refunds the difference', async () => {
    const counter = await h.http().post('/api/v1/sales').set(cashier).send(sale({ customerId: '', tenders: [{ method: 'CASH', amount: TOTAL }] })).expect(201);
    const edited = { ...sale({ customerId: '', tenders: [] }), items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.5, 50) }], reason: 'One bag returned' };
    const res = await h.http().post(`/api/v1/sales/${counter.body.id}/rebill`).set(cashier).send(edited).expect(200);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    await h.http().post(`/api/v1/approvals/${res.body.approvalId}`).set(owner).send({ action: 'APPROVE' }).expect(204);
    const receipts = (await h.http().get('/api/v1/payments').set(owner)).body as { kind: string; amount: number }[];
    expect(receipts.find((r) => r.kind === 'REFUND')).toMatchObject({ amount: -(TOTAL - 6995) });
  });
});

describe('history', () => {
  it('posted history cannot be edited in place', async () => {
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ tenders: [{ method: 'CASH', amount: TOTAL }] })).expect(201);
    await expect(h.db.stockMovement.updateMany({ data: { reason: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(h.db.customerLedgerEntry.deleteMany()).rejects.toThrow(/append-only/);
    await expect(h.db.paymentAllocation.deleteMany()).rejects.toThrow(/append-only/);
    await expect(h.db.payment.updateMany({ data: { notes: 'x' } })).rejects.toThrow(/append-only/);
  });

  it('a customer with history cannot be deleted; a new one can', async () => {
    await h.http().delete(`/api/v1/customers/${customers['CUST-001']!.id}`).set(owner).expect(409);
    const fresh = await h.http().post('/api/v1/customers').set(cashier).send({ name: 'Ravi (walk-in)', kind: 'REGULAR' }).expect(201);
    expect(fresh.body).toMatchObject({ code: 'CUST-005', outstandingAmount: 0, advanceAmount: 0 });
    await h.http().delete(`/api/v1/customers/${fresh.body.id}`).set(cashier).expect(403);
    await h.http().delete(`/api/v1/customers/${fresh.body.id}`).set(owner).expect(204);
  });

  it('stock adjustments cannot go below zero and are recorded as movements', async () => {
    await h.http().post('/api/v1/stock/adjustments').set(owner).send({ lotNumber: 'LOT DN', markCode: 'OK', type: 'REDUCE', bags: 1, weightKg: 50, reason: 'Count' }).expect(409);
    await h.http().post('/api/v1/stock/opening').set(owner).send({ lotNumber: 'lot dn', markCode: 'ok', bags: 4, weightKg: 200 }).expect(201);
    expect((await h.http().get('/api/v1/stock/movements').set(owner)).body[0]).toMatchObject({ type: 'OPENING_STOCK', bags: 4, weightKg: 200 });
  });
});
