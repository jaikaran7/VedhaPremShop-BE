import { counterCashDrift, receivableDrift, stockDrift } from '../src/database/reconciliation';
import { auth, type Harness, startHarness } from './harness';

let h: Harness;
let owner: Record<string, string>;
let cashier: Record<string, string>;
let onionsId: string;
let customer: { id: string; outstandingAmount: number };

beforeAll(async () => { h = await startHarness(); });
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  owner = auth(await h.token('owner'));
  cashier = auth(await h.token('salesperson'));
  onionsId = ((await h.http().get('/api/v1/settings/products').set(owner)).body as { id: string; code: string }[]).find((p) => p.code === 'ONIONS')!.id;
  customer = ((await h.http().get('/api/v1/customers').set(owner)).body as { id: string; code: string; outstandingAmount: number }[]).find((c) => c.code === 'CUST-001')!;
});
afterEach(async () => {
  expect(await stockDrift(h.db)).toEqual([]);
  expect(await receivableDrift(h.db)).toEqual([]);
  expect(await counterCashDrift(h.db)).toEqual([]);
});

// 151 kg × ₹69 = ₹10,419; 3 bags × (₹20 Amali + ₹10 market fee) = ₹90 → ₹10,509 before tax
const sale = (over: Record<string, unknown> = {}) => ({
  customerId: customer.id, productId: onionsId, creditDays: 7, tenders: [],
  items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: [50.5, 50, 50.5].map((weightKg, i) => ({ bagNumber: i + 1, weightKg })) }], ...over,
});
const post = (over: Record<string, unknown> = {}) => h.http().post('/api/v1/sales').set(cashier).send(sale(over));

describe('optional GST on a bill', () => {
  it('without tax nothing changes', async () => {
    const res = await post().expect(201);
    expect(res.body.charges).toMatchObject({ taxPercent: null, taxAmount: 0, finalInvoiceAmount: 10_509, totalAdditionalCharges: 90 });
    expect(res.body.totalAmount).toBe(10_509);
  });

  it('a percentage is added to the whole invoice and rounded to the rupee: 5% of ₹10,509 = ₹525.45 → ₹525', async () => {
    const res = await post({ taxPercent: 5, totalAmount: 11_034 }).expect(201);
    expect(res.body).toMatchObject({ productSubtotal: 10_419, totalAmount: 11_034, balanceDue: 11_034 });
    expect(res.body.charges).toMatchObject({ taxPercent: 5, taxAmount: 525, totalAdditionalCharges: 615, finalInvoiceAmount: 11_034 });
    const after = ((await h.http().get(`/api/v1/customers/${customer.id}`).set(owner)).body as { outstandingAmount: number }).outstandingAmount;
    expect(after).toBe(customer.outstandingAmount + 11_034); // the customer owes the tax too
  });

  it('a typed tax amount is added exactly, and can be paid at the counter with the rest', async () => {
    const res = await post({ taxAmount: 250.5, tenders: [{ method: 'CASH', amount: 10_759.5 }] }).expect(201);
    expect(res.body).toMatchObject({ totalAmount: 10_759.5, paidAmount: 10_759.5, balanceDue: 0, paymentStatus: 'PAID' });
    expect(res.body.charges).toMatchObject({ taxPercent: null, taxAmount: 250.5 });
  });

  it('refuses both a percentage and an amount, a percentage over 100, and a stale total that ignores the tax', async () => {
    await post({ taxPercent: 5, taxAmount: 100 }).expect(422);
    await post({ taxPercent: 101 }).expect(400);
    await post({ taxAmount: -1 }).expect(400);
    await post({ taxPercent: 5, totalAmount: 10_509 }).expect(409); // the cashier saw ₹10,509 but the bill is ₹11,034
  });

  it('editing the bill (rebill) can add, change or remove the tax, and the books still balance', async () => {
    const first = (await post({ taxPercent: 5 }).expect(201)).body as { id: string; totalAmount: number };
    expect(first.totalAmount).toBe(11_034);
    const rebilled = await h.http().post(`/api/v1/sales/${first.id}/rebill`).set(owner).send({ ...sale({ taxPercent: 18 }), reason: 'Tax rate was wrong' }).expect(200);
    expect(rebilled.body.status).toBe('APPLIED');
    expect(rebilled.body.sale.charges).toMatchObject({ taxPercent: 18, taxAmount: 1_892, finalInvoiceAmount: 12_401 }); // 18% of 10,509 = 1,891.62 → 1,892
    const after = ((await h.http().get(`/api/v1/customers/${customer.id}`).set(owner)).body as { outstandingAmount: number }).outstandingAmount;
    expect(after).toBe(customer.outstandingAmount + 12_401); // the old bill's ₹11,034 is gone
  });

  it('the database refuses a total that does not include the tax', async () => {
    const res = await post({ taxPercent: 5 }).expect(201);
    await expect(h.db.$executeRaw`UPDATE sales SET tax_amount = 0 WHERE id = ${res.body.id}::uuid`).rejects.toThrow(/sales_totals/);
  });
});
