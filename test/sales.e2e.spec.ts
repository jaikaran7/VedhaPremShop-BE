import { PrismaService } from '../src/database/prisma.service';
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
  confirmDuplicateSale: true,
  ...over,
});
// 151 kg × ₹69 = ₹10,419; Amali ₹60; market fee 1% = ₹104.19, rounded up → ₹10,584
const TOTAL = 10_584;
// 100.5 kg × ₹69 = ₹6,935; Amali ₹40; market fee ₹69.35, rounded up → ₹7,045
const TWO_BAGS = 7_045;
// 200 kg × ₹69 = ₹13,800; Amali ₹80; market fee ₹138 → ₹14,018
const FOUR_BAGS = 14_018;
// 80 kg × ₹100 = ₹8,000; Amali ₹40; market fee ₹80 → ₹8,120
const GARLIC = 8_120;
const paise = (rupees: number) => Math.round(rupees * 100);
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
      tenders: [{ method: 'CASH', amount: TOTAL }], charges: { amaliAmount: 60, marketFeeAmount: 105, marketFeeBasis: 'BILL_PERCENT', finalInvoiceAmount: TOTAL },
    });
    expect(await lotMark('LOT AP', 'AA')).toMatchObject({ remainingBags: 75, remainingWeightKg: 3905 });
    expect(await outstanding('CUST-001')).toBe(150_000);
    const receipts = (await h.http().get('/api/v1/payments').set(owner)).body;
    expect(receipts[0]).toMatchObject({ receiptNumber: 'VPN-REC-510', amount: TOTAL, previousOutstanding: 160_584, newOutstanding: 150_000 });
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
    expect(named.body).toMatchObject({ previousOutstanding: 160_584, newOutstanding: 156_584, billAllocations: [{ billNumber: credit.body.billNumber, amount: 4000 }] });
    expect((await h.http().get(`/api/v1/sales/${credit.body.id}`).set(owner)).body).toMatchObject({ paidAmount: 4000, balanceDue: 6_584, paymentStatus: 'PARTIAL' });

    const general = await h.http().post('/api/v1/payments').set(owner).send({ customerId: customers['CUST-001']!.id, amount: 10_000, paymentMethod: 'CASH' }).expect(201);
    expect(general.body.billAllocations).toEqual([{ saleId: null, billNumber: null, amount: 10_000 }]);
    expect(paise(await outstanding('CUST-001'))).toBe(14_658_319);
  });

  it('paying more than owed is accepted and kept as an advance that the next bill uses', async () => {
    const paid = await h.http().post('/api/v1/payments').set(cashier)
      .send({ customerId: customers['CUST-004']!.id, amount: 50_000, paymentMethod: 'CASH' }).expect(201);
    expect(paid.body).toMatchObject({ previousOutstanding: 45_000, newOutstanding: -5000, unallocatedAmount: 5000 });
    expect(await customer('CUST-004')).toMatchObject({ outstandingAmount: 0, advanceAmount: 5000 });

    const bill = await h.http().post('/api/v1/sales').set(cashier).send(sale({ customerId: customers['CUST-004']!.id })).expect(201);
    expect(bill.body).toMatchObject({ paidAmount: 5000, balanceDue: 5_584, paymentStatus: 'PARTIAL' });
    expect(await customer('CUST-004')).toMatchObject({ outstandingAmount: 5_584, advanceAmount: 0 });
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
    await h.http().put('/api/v1/settings/sale-charges').set(owner).send({
      amaliPerBag: 25, marketFeePerBag: 10, marketFeeBasis: 'PER_BAG', marketFeePercent: 1, amaliEnabled: true, marketFeeEnabled: true,
    }).expect(200);
    expect((await h.http().post('/api/v1/sales').set(cashier).send(sale({ totalAmount: TOTAL })).expect(409)).body.message).toMatch(/₹10524/);
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 30, bagWeights: bags(50) }] })).expect(201);
  });

  it('rejects other-product lots and bad weighments', async () => {
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ items: [{ lotNumber: 'LOT GL', markCode: 'BOLD', ratePerKg: 90, bagWeights: bags(50) }] })).expect(422);
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(-5) }] })).expect(400);
    await h.http().post('/api/v1/sales').set(cashier).send(sale({ items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.1234) }] })).expect(400);
  });

  it('asks before posting the same customer, items and total again on the same day', async () => {
    const first = await h.http().post('/api/v1/sales').set(cashier).send(sale({ confirmDuplicateSale: false })).expect(201);
    const again = await h.http().post('/api/v1/sales').set(cashier).send(sale({ confirmDuplicateSale: false })).expect(409);
    expect(again.body.code).toBe('POSSIBLE_DUPLICATE_SALE');
    expect(again.body.existingSale).toMatchObject({
      id: first.body.id,
      billNumber: first.body.billNumber,
      customerName: first.body.customerName,
      totalAmount: TOTAL,
    });
    const second = await h.http().post('/api/v1/sales').set(cashier).send(sale({ confirmDuplicateSale: true })).expect(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.billNumber).not.toBe(first.body.billNumber);
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
    expect(res.body).toMatchObject({ status: 'CONFIRMED', date: daysAgo(2), paidAmount: 1000, balanceDue: 9_584 });
    expect((await lotMark('LOT AP', 'AA')).remainingBags).toBe(before.remainingBags - 3);
    expect(paise(await outstanding('CUST-001'))).toBe(15_000_000 + 1_058_400 - 100_000);
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
    // The receipt now settles part of the opening balance.
    expect(paise(await outstanding('CUST-001'))).toBe(15_000_000 - 1_058_400);
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

  it('an edit keeps the same bill, returns the spare bags and moves the balance by the difference', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const bills = await h.db.sale.count();
    const paid = await h.http().post('/api/v1/sales').set(cashier).send(sale({ tenders: [{ method: 'UPI', amount: 5000 }] })).expect(201);
    const edited = { ...sale({ tenders: [] }), items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.5, 50) }], reason: 'Third bag was not loaded' };
    const res = await h.http().post(`/api/v1/sales/${paid.body.id}/rebill`).set(owner).send(edited).expect(200);
    // 100.5 kg × ₹69 = ₹6,935; Amali ₹40; market fee 1% = ₹69.35, rounded up → ₹7,045. ₹5,000 already paid.
    expect(res.body).toMatchObject({
      status: 'APPLIED',
      sale: { id: paid.body.id, billNumber: paid.body.billNumber, status: 'CONFIRMED', totalAmount: TWO_BAGS, paidAmount: 5000, balanceDue: 2_045, date: paid.body.date },
    });
    expect(res.body.sale.replacesBillNumber).toBeUndefined();
    expect(res.body.sale.revisions[0]).toMatchObject({ reason: 'Third bag was not loaded', editedByRole: 'OWNER' });
    expect(res.body.sale.revisions[0].changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'items' }),
      expect.objectContaining({ field: 'totalAmount' }),
    ]));
    expect((await h.http().get(`/api/v1/sales/${paid.body.id}`).set(owner)).body.status).toBe('CONFIRMED');
    expect(await h.db.sale.count()).toBe(bills + 1);
    expect((await lotMark('LOT AP', 'AA')).remainingBags).toBe(before.remainingBags - 2);
    expect(paise(await outstanding('CUST-001'))).toBe(15_000_000 + 704_500 - 500_000);
  });

  it('lists edited bills newest first, with a fixed number of queries', async () => {
    const first = await h.http().post('/api/v1/sales').set(owner).send(sale()).expect(201);
    const second = await h.http().post('/api/v1/sales').set(owner).send(sale()).expect(201);
    const lighter = { ...sale({ tenders: [] }), items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.5, 50) }], reason: 'Third bag was not loaded' };
    await h.http().post(`/api/v1/sales/${first.body.id}/rebill`).set(owner).send(lighter).expect(200);
    await h.http().post(`/api/v1/sales/${second.body.id}/rebill`).set(owner).send({ ...lighter, reason: 'Short by one bag' }).expect(200);
    const prisma = h.app.get(PrismaService);
    const before = prisma.queryCount;
    const listed = await h.http().get('/api/v1/sales/edits').set(cashier).expect(200);
    // Grouping, the sale page, and its revision rows. The count stays fixed as the page grows.
    expect(prisma.queryCount - before).toBe(3);
    expect(listed.body.map((bill: { id: string }) => bill.id)).toEqual([second.body.id, first.body.id]);
    expect(listed.body[0]).toMatchObject({
      billNumber: second.body.billNumber,
      customerName: second.body.customerName,
      revisionCount: 1,
      revisions: [expect.objectContaining({ reason: 'Short by one bag', editedByRole: 'OWNER' })],
    });
    expect(listed.body[0].revisions[0].changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'totalAmount', from: expect.any(String), to: expect.any(String) }),
    ]));
    expect(await h.http().get('/api/v1/sales/edits').set(cashier).query({ limit: 1 }).expect(200)).toMatchObject({ body: [{ id: second.body.id }] });
  });

  it('staff edit waits for approval and keeps the same counter bill; the difference is refunded only after approval', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const counter = await h.http().post('/api/v1/sales').set(cashier).send(sale({ customerId: '', tenders: [{ method: 'CASH', amount: TOTAL }] })).expect(201);
    const edited = { ...sale({ customerId: '', tenders: [] }), items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.5, 50) }], reason: 'One bag returned' };
    const res = await h.http().post(`/api/v1/sales/${counter.body.id}/rebill`).set(cashier).send(edited).expect(200);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    expect((await h.http().get(`/api/v1/sales/${counter.body.id}`).set(owner)).body).toMatchObject({ status: 'CONFIRMED', totalAmount: TOTAL });
    expect(await lotMark('LOT AP', 'AA')).toMatchObject({ remainingBags: before.remainingBags - 3 });
    await h.http().post(`/api/v1/approvals/${res.body.approvalId}`).set(owner).send({ action: 'APPROVE' }).expect(204);
    expect((await h.http().get(`/api/v1/sales/${counter.body.id}`).set(owner)).body).toMatchObject({
      id: counter.body.id, billNumber: counter.body.billNumber, status: 'CONFIRMED', totalAmount: TWO_BAGS,
    });
    const receipts = (await h.http().get('/api/v1/payments').set(owner)).body as { kind: string; amount: number }[];
    expect(receipts.find((r) => r.kind === 'REFUND')).toMatchObject({ amount: -3_539 });
  });

  it('a larger edit of the same bill takes the extra bags and weight and adds the extra amount', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const bill = await h.http().post('/api/v1/sales').set(cashier).send(sale()).expect(201);
    // 200 kg × ₹69 = ₹13,800; Amali ₹80; market fee 1% = ₹138 → ₹14,018
    const edited = { ...sale({ tenders: [] }), items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50, 50, 50, 50) }], reason: 'A fourth bag was loaded' };
    const res = await h.http().post(`/api/v1/sales/${bill.body.id}/rebill`).set(owner).send(edited).expect(200);
    expect(res.body).toMatchObject({ status: 'APPLIED', sale: { id: bill.body.id, billNumber: bill.body.billNumber, totalAmount: FOUR_BAGS, balanceDue: FOUR_BAGS } });
    expect(await lotMark('LOT AP', 'AA')).toMatchObject({ remainingBags: before.remainingBags - 4, remainingWeightKg: before.remainingWeightKg - 200 });
    expect(await outstanding('CUST-001')).toBe(150_000 + FOUR_BAGS);
  });

  it('editing a fully paid bill down keeps the same bill, the extra collection as credit, and returns the spare bags', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const paid = await h.http().post('/api/v1/sales').set(cashier).send(sale({ tenders: [{ method: 'CASH', amount: TOTAL }] })).expect(201);
    const edited = { ...sale({ tenders: [] }), items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: bags(50.5, 50) }], reason: 'One bag came back' };
    const res = await h.http().post(`/api/v1/sales/${paid.body.id}/rebill`).set(owner).send(edited).expect(200);
    expect(res.body).toMatchObject({ status: 'APPLIED', sale: { id: paid.body.id, totalAmount: TWO_BAGS, paidAmount: TWO_BAGS, balanceDue: 0 } });
    expect(await lotMark('LOT AP', 'AA')).toMatchObject({ remainingBags: before.remainingBags - 2, remainingWeightKg: before.remainingWeightKg - 100.5 });
    // The amount collected above the edited bill pays down the opening balance.
    expect(paise(await outstanding('CUST-001'))).toBe(15_000_000 - (1_058_400 - 704_500));
    expect(await customer('CUST-001')).toMatchObject({ advanceAmount: 0 });
  });

  it('changing the product updates the same bill: the old lot is restored and the new lot is drawn', async () => {
    const onions = await lotMark('LOT AP', 'AA');
    const garlic = await lotMark('LOT GL', 'BOLD');
    const products = (await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[];
    const garlicId = products.find((p) => p.code === 'GARLIC')!.id;
    const bill = await h.http().post('/api/v1/sales').set(cashier).send(sale()).expect(201);
    // 80 kg × ₹100 = ₹8,000; Amali ₹40; market fee 1% = ₹80 → ₹8,120
    const edited = {
      ...sale({ tenders: [], productId: garlicId }),
      items: [{ lotNumber: 'LOT GL', markCode: 'BOLD', ratePerKg: 100, bagWeights: bags(40, 40) }],
      reason: 'Customer took garlic instead',
    };
    const res = await h.http().post(`/api/v1/sales/${bill.body.id}/rebill`).set(owner).send(edited).expect(200);
    expect(res.body).toMatchObject({
      status: 'APPLIED',
      sale: { id: bill.body.id, billNumber: bill.body.billNumber, customerId: customers['CUST-001']!.id, productName: 'Garlic', totalBags: 2, totalWeightKg: 80, totalAmount: GARLIC },
    });
    expect(await lotMark('LOT AP', 'AA')).toEqual(onions);
    expect(await lotMark('LOT GL', 'BOLD')).toMatchObject({ remainingBags: garlic.remainingBags - 2, remainingWeightKg: garlic.remainingWeightKg - 80 });
    expect(await outstanding('CUST-001')).toBe(150_000 + GARLIC);
    expect(res.body.sale.revisions[0].changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'productName', from: 'Onions', to: 'Garlic' }),
    ]));
    await expect(h.db.saleRevision.updateMany({ data: { reason: 'rewritten' } })).rejects.toThrow(/append-only/);
  });

  it('an edit cannot move the bill to another customer', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const bill = await h.http().post('/api/v1/sales').set(cashier).send(sale()).expect(201);
    const edited = { ...sale({ customerId: customers['CUST-002']!.id, tenders: [] }), reason: 'Wrong customer on the slip' };
    await h.http().post(`/api/v1/sales/${bill.body.id}/rebill`).set(owner).send(edited).expect(422);
    expect((await h.http().get(`/api/v1/sales/${bill.body.id}`).set(owner)).body).toMatchObject({ customerId: customers['CUST-001']!.id, totalAmount: TOTAL });
    expect(await lotMark('LOT AP', 'AA')).toMatchObject({ remainingBags: before.remainingBags - 3 });
    expect(paise(await outstanding('CUST-001'))).toBe(15_000_000 + 1_058_400);
  });

  it('a staff cancel changes nothing until approved, and a second approval does not apply it again', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const bill = await h.http().post('/api/v1/sales').set(cashier).send(sale()).expect(201);
    const res = await h.http().post(`/api/v1/sales/${bill.body.id}/cancel`).set(cashier).send({ reason: 'Wrong customer' }).expect(200);
    expect(res.body.status).toBe('PENDING_APPROVAL');
    expect(await lotMark('LOT AP', 'AA')).toMatchObject({ remainingBags: before.remainingBags - 3, remainingWeightKg: before.remainingWeightKg - 151 });
    expect(paise(await outstanding('CUST-001'))).toBe(15_000_000 + 1_058_400);

    const both = await Promise.all([
      h.http().post(`/api/v1/approvals/${res.body.approvalId}`).set(owner).send({ action: 'APPROVE' }),
      h.http().post(`/api/v1/approvals/${res.body.approvalId}`).set(owner).send({ action: 'APPROVE' }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([204, 409]);
    expect((await h.http().get(`/api/v1/sales/${bill.body.id}`).set(owner)).body.status).toBe('CANCELLED');
    expect(await lotMark('LOT AP', 'AA')).toEqual(before);
    expect(await outstanding('CUST-001')).toBe(150_000);
    await h.http().post(`/api/v1/approvals/${res.body.approvalId}`).set(owner).send({ action: 'APPROVE' }).expect(409);
    expect(await lotMark('LOT AP', 'AA')).toEqual(before);
    expect(await outstanding('CUST-001')).toBe(150_000);
  });

  it('cancelling a paid counter bill refunds the cash and returns every bag and its weight', async () => {
    const before = await lotMark('LOT AP', 'AA');
    const paid = await h.http().post('/api/v1/sales').set(cashier).send(sale({ customerId: '', tenders: [{ method: 'CASH', amount: TOTAL }] })).expect(201);
    const res = await h.http().post(`/api/v1/sales/${paid.body.id}/cancel`).set(owner).send({ reason: 'Walk-in returned the lot' }).expect(200);
    expect(res.body).toMatchObject({ status: 'APPLIED', sale: { status: 'CANCELLED' } });
    expect(await lotMark('LOT AP', 'AA')).toEqual(before);
    const receipts = (await h.http().get('/api/v1/payments').set(owner)).body as { kind: string; amount: number }[];
    expect(receipts.find((r) => r.kind === 'REFUND')).toMatchObject({ amount: -TOTAL });
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
