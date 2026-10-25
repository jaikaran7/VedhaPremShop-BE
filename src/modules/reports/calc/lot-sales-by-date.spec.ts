/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- the frontend's own test file, run unchanged; it is not written for the backend's stricter index checks.
import assert from './assert-shim';
import type { Sale } from './frontend-types';
import type { LotOutgoingLine } from './lot-differential';
import {
  filterLotSaleLines,
  lotSalesForDate,
  saleCreditDebit,
  summarizeLotSalesByDate,
} from './lot-sales-by-date';

function line(partial: Partial<LotOutgoingLine> & Pick<LotOutgoingLine, 'saleId' | 'date'>): LotOutgoingLine {
  return {
    billNumber: partial.billNumber ?? partial.saleId,
    customerName: partial.customerName ?? 'ABC Traders',
    markCode: partial.markCode ?? 'TC',
    bags: partial.bags ?? 10,
    weightKg: partial.weightKg ?? 500,
    ratePerKg: partial.ratePerKg ?? 42,
    productAmount: partial.productAmount ?? 21000,
    amali: 0,
    marketFee: 0,
    lineInvoiceAmount: partial.productAmount ?? 21000,
    ...partial,
  };
}

function sale(partial: Partial<Sale> & Pick<Sale, 'id'>): Sale {
  return {
    billNumber: partial.billNumber ?? partial.id,
    customerId: 'c-1',
    customerName: partial.customerName ?? 'ABC Traders',
    customerPhone: '',
    customerAddress: '',
    date: '2026-10-01',
    time: partial.time ?? '10:00 AM',
    items: [],
    totalBags: 0,
    totalWeightKg: 0,
    totalAmount: 0,
    paymentType: partial.paymentType ?? 'CASH',
    paymentStatus: partial.paymentStatus,
    paidAmount: 0,
    balanceDue: 0,
    status: 'CONFIRMED',
    createdByUserId: 'u-1',
    createdByName: 'Owner',
    createdByRole: 'OWNER',
    createdAt: '2026-10-01T00:00:00Z',
    ...partial,
  };
}

describe('lot sales by date', () => {
  it('groups lines into daily bill counts and saved-record totals', () => {
    const lines = [
      line({ saleId: 's-1', date: '2026-10-02', bags: 8, weightKg: 400, productAmount: 16800 }),
      line({ saleId: 's-2', date: '2026-10-01', bags: 12, weightKg: 600, productAmount: 25200 }),
      line({ saleId: 's-3', date: '2026-10-02', bags: 5, weightKg: 250, productAmount: 10500 }),
      line({ saleId: 's-1', date: '2026-10-02', markCode: 'NS', bags: 2, weightKg: 100, productAmount: 4200 }),
    ];

    const report = summarizeLotSalesByDate(lines);

    assert.deepEqual(report.days.map((day) => day.date), ['2026-10-02', '2026-10-01']);
    assert.equal(report.days[0].billCount, 2);
    assert.equal(report.days[0].bags, 15);
    assert.equal(report.days[0].weightKg, 750);
    assert.equal(report.days[0].amount, 31500);
    assert.equal(report.totals.bills, 3);
    assert.equal(report.totals.bags, 27);
    assert.equal(report.totals.weightKg, 1350);
    assert.equal(report.totals.amount, 56700);
  });

  it('filters by date range and customer or bill search before grouping', () => {
    const lines = [
      line({ saleId: 's-1', billNumber: 'VPN-100', customerName: 'Ravi Traders', date: '2026-10-01' }),
      line({ saleId: 's-2', billNumber: 'VPN-200', customerName: 'Meena Stores', date: '2026-10-02' }),
      line({ saleId: 's-3', billNumber: 'VPN-300', customerName: 'Ravi Mart', date: '2026-10-03' }),
    ];

    const ranged = filterLotSaleLines(lines, { from: '2026-10-02', to: '2026-10-03', search: '' });
    assert.deepEqual(ranged.map((item) => item.saleId), ['s-2', 's-3']);

    const byCustomer = filterLotSaleLines(lines, { from: '', to: '', search: 'ravi' });
    assert.deepEqual(byCustomer.map((item) => item.saleId), ['s-1', 's-3']);

    const byBill = filterLotSaleLines(lines, { from: '', to: '', search: 'vpn-200' });
    assert.deepEqual(byBill.map((item) => item.saleId), ['s-2']);
  });

  it('loads bill details for one date from saved sale records', () => {
    const lines = [
      line({ saleId: 's-1', date: '2026-10-02', markCode: 'TC', bags: 8, weightKg: 400, ratePerKg: 42, productAmount: 16800 }),
      line({ saleId: 's-1', date: '2026-10-02', markCode: 'NS', bags: 2, weightKg: 100, ratePerKg: 40, productAmount: 4000 }),
      line({ saleId: 's-2', date: '2026-10-01', bags: 12, weightKg: 600, productAmount: 25200 }),
    ];
    const sales = [
      sale({ id: 's-1', time: '11:20 AM', paymentType: 'CREDIT', paymentStatus: 'CREDIT' }),
      sale({ id: 's-2', time: '09:05 AM', paymentType: 'CASH', paymentStatus: 'PAID' }),
    ];

    const rows = lotSalesForDate(lines, '2026-10-02', sales);

    assert.equal(rows.length, 2);
    assert.equal(rows[0].billNumber, 's-1');
    assert.equal(rows[0].time, '11:20 AM');
    assert.equal(rows[0].markCode, 'TC');
    assert.equal(rows[0].creditDebit, 'CREDIT');
    assert.equal(rows[1].markCode, 'NS');
    assert.equal(rows[1].amount, 4000);
  });

  it('uses saved payment status for credit and paid labels and does not invent debit', () => {
    assert.equal(saleCreditDebit(sale({ id: 'c', paymentStatus: 'CREDIT', paymentType: 'CREDIT' })), 'CREDIT');
    assert.equal(saleCreditDebit(sale({ id: 'p', paymentStatus: 'PAID', paymentType: 'CASH' })), 'PAID');
    assert.equal(saleCreditDebit(sale({ id: 'h', paymentStatus: 'PARTIAL', paymentType: 'PARTIAL' })), 'PARTIAL');
    assert.equal(saleCreditDebit(sale({ id: 'legacy', paymentType: 'CREDIT' })), 'CREDIT');
    assert.equal(saleCreditDebit(sale({ id: 'cash', paymentType: 'CASH' })), 'PAID');
    assert.notEqual(saleCreditDebit(sale({ id: 'cash', paymentType: 'CASH' })), 'DEBIT');
  });
});
