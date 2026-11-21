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

// 151 kg × ₹69 = ₹10,419; Amali ₹60; market fee 1% = ₹104.19, rounded up → ₹10,584 before tax
const sale = (over: Record<string, unknown> = {}) => ({
  customerId: customer.id, productId: onionsId, creditDays: 7, tenders: [], confirmDuplicateSale: true,
  items: [{ lotNumber: 'LOT AP', markCode: 'AA', ratePerKg: 69, bagWeights: [50.5, 50, 50.5].map((weightKg, i) => ({ bagNumber: i + 1, weightKg })) }], ...over,
});
const post = (over: Record<string, unknown> = {}) => h.http().post('/api/v1/sales').set(cashier).send(sale(over));
const paise = (rupees: number) => Math.round(rupees * 100);

describe('optional GST on a bill', () => {
  it('without tax nothing changes', async () => {
    const res = await post().expect(201);
    expect(res.body.charges).toMatchObject({ taxPercent: null, taxAmount: 0, finalInvoiceAmount: 10_584, totalAdditionalCharges: 165 });
    expect(paise(res.body.totalAmount)).toBe(1_058_400);
  });

  it('a percentage is added to the invoice before the bill is rounded up: 5% of ₹10,583.19 = ₹529.16 → ₹529, then the bill is ₹11,113', async () => {
    const res = await post({ taxPercent: 5, totalAmount: 11_113 }).expect(201);
    expect(res.body).toMatchObject({ productSubtotal: 10_419, totalAmount: 11_113, balanceDue: 11_113 });
    expect(res.body.charges).toMatchObject({ taxPercent: 5, taxAmount: 529, totalAdditionalCharges: 694, finalInvoiceAmount: 11_113 });
    const after = ((await h.http().get(`/api/v1/customers/${customer.id}`).set(owner)).body as { outstandingAmount: number }).outstandingAmount;
    expect(paise(after)).toBe(paise(customer.outstandingAmount) + 1_111_300); // the customer owes the tax too
  });

  it('a typed tax amount is added, then the bill is rounded up, and can be paid at the counter', async () => {
    const res = await post({ taxAmount: 250.5, tenders: [{ method: 'CASH', amount: 10_834 }] }).expect(201);
    expect(res.body).toMatchObject({ totalAmount: 10_834, paidAmount: 10_834, balanceDue: 0, paymentStatus: 'PAID' });
    expect(res.body.charges).toMatchObject({ taxPercent: null, taxAmount: 250.5 });
  });

  it('refuses both a percentage and an amount, a percentage over 100, and a stale total that ignores the tax', async () => {
    await post({ taxPercent: 5, taxAmount: 100 }).expect(422);
    await post({ taxPercent: 101 }).expect(400);
    await post({ taxAmount: -1 }).expect(400);
    await post({ taxPercent: 5, totalAmount: 10_584 }).expect(409); // the cashier saw the pre-tax total, but the bill includes ₹529 of tax
  });

  it('editing the bill (rebill) can add, change or remove the tax, and the books still balance', async () => {
    const first = (await post({ taxPercent: 5 }).expect(201)).body as { id: string; totalAmount: number };
    expect(paise(first.totalAmount)).toBe(1_111_300);
    const rebilled = await h.http().post(`/api/v1/sales/${first.id}/rebill`).set(owner).send({ ...sale({ taxPercent: 18 }), reason: 'Tax rate was wrong' }).expect(200);
    expect(rebilled.body.status).toBe('APPLIED');
    expect(rebilled.body.sale.charges).toMatchObject({ taxPercent: 18, taxAmount: 1_905, finalInvoiceAmount: 12_489 }); // 18% of the pre-round invoice → ₹1,905, then rounded up
    const after = ((await h.http().get(`/api/v1/customers/${customer.id}`).set(owner)).body as { outstandingAmount: number }).outstandingAmount;
    expect(paise(after)).toBe(paise(customer.outstandingAmount) + 1_248_900); // the old bill's ₹11,113 is gone
  });

  it('the database refuses a total that does not include the tax', async () => {
    const res = await post({ taxPercent: 5 }).expect(201);
    await expect(h.db.$executeRaw`UPDATE sales SET tax_amount = 0 WHERE id = ${res.body.id}::uuid`).rejects.toThrow(/sales_totals/);
  });
});
