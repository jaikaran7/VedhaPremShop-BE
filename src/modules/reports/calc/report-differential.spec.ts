/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- the frontend's own test file, run unchanged; it is not written for the backend's stricter index checks.
import assert from './assert-shim';
import { buildDifferentialReport, rateKey } from './report-differential';
import { calculateSaleCharges, DEFAULT_SALE_CHARGE_SETTINGS } from './sale-charges';
import type { Lot, Product, Purchase, Sale, StockMovement } from './frontend-types';

const products: Product[] = [
  { id: 'prod-onions', code: 'ONIONS', name: 'Onions', status: 'ACTIVE' },
  { id: 'prod-garlic', code: 'GARLIC', name: 'Garlic', status: 'ACTIVE' },
];

function lot(partial: Partial<Lot> & Pick<Lot, 'id' | 'lotNumber'>): Lot {
  return {
    vendorId: 'v-1',
    vendorName: 'Murade Traders',
    purchaseBillId: 'pur-1',
    purchaseBillNo: 'PUR-1',
    arrivalDate: '2026-09-28',
    status: 'ACTIVE',
    totalBags: 10,
    totalWeightKg: 500,
    remainingBags: 10,
    remainingWeightKg: 500,
    marks: [],
    ...partial,
  };
}

function purchase(partial: Partial<Purchase> & Pick<Purchase, 'id' | 'lotNumber'>): Purchase {
  return {
    billNumber: partial.id,
    vendorId: 'v-1',
    vendorName: 'Murade Traders',
    date: '2026-09-28',
    items: [],
    expenses: [],
    grossAmount: 0,
    totalExpenses: 0,
    netAmount: 0,
    createdAt: '2026-09-28T00:00:00Z',
    ...partial,
  };
}

function sale(partial: Partial<Sale> & Pick<Sale, 'id'>): Sale {
  return {
    billNumber: partial.id,
    customerId: 'c-1',
    customerName: 'ABC Traders',
    customerPhone: '',
    customerAddress: '',
    date: '2026-10-01',
    time: '10:00 AM',
    items: [],
    totalBags: 0,
    totalWeightKg: 0,
    totalAmount: 0,
    paymentType: 'CASH',
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

describe('differential report', () => {
  it('keeps unsold stock out of profit and reconciles a matching balance', () => {
    const report = buildDifferentialReport({
      products,
      stockMovements: [] as StockMovement[],
      purchases: [
        purchase({
          id: 'pur-ns',
          lotNumber: 'LOT NS',
          items: [{ id: 'pi', markCode: 'TC', bags: 20, weightKg: 1000, ratePerKg: 42, totalAmount: 42000 }],
          grossAmount: 42000,
          netAmount: 42000,
        }),
      ],
      lots: [
        lot({
          id: 'lot-ns',
          lotNumber: 'LOT NS',
          totalBags: 20,
          totalWeightKg: 1000,
          remainingBags: 20,
          remainingWeightKg: 1000,
          marks: [{ markCode: 'TC', initialBags: 20, initialWeightKg: 1000, remainingBags: 20, remainingWeightKg: 1000, purchaseRate: 42 }],
        }),
      ],
      sales: [],
    });
    const row = report.lots[0];
    assert.equal(row.profit, null);
    assert.equal(row.bagDifference, 0);
    assert.equal(row.weightDifferenceKg, 0);
    assert.equal(row.status, 'NORMAL');
    assert.equal(row.marks[0].profit, null);
    assert.ok((row.remainingInventoryCost ?? 0) > 0);
  });

  it('uses landed cost once and does not turn a shortage into the profit figure', () => {
    const charges = calculateSaleCharges({
      totalBags: 4,
      productSubtotal: 8000,
      settings: DEFAULT_SALE_CHARGE_SETTINGS,
    });
    const report = buildDifferentialReport({
      products,
      stockMovements: [],
      purchases: [
        purchase({
          id: 'pur-1',
          lotNumber: 'LOT AP',
          items: [
            { id: 'h', markCode: 'H', bags: 5, weightKg: 250, ratePerKg: 48, totalAmount: 12000 },
            { id: 'm', markCode: 'M', bags: 5, weightKg: 250, ratePerKg: 48, totalAmount: 12000 },
          ],
          expenses: [{ id: 'pe', type: 'FREIGHT', amount: 1000, description: 'Freight' }],
          grossAmount: 24000,
          totalExpenses: 1000,
          netAmount: 25000,
        }),
      ],
      lots: [
        lot({
          id: 'lot-1',
          lotNumber: 'LOT AP',
          totalBags: 10,
          totalWeightKg: 500,
          remainingBags: 4,
          remainingWeightKg: 200,
          marks: [
            { markCode: 'H', initialBags: 5, initialWeightKg: 250, remainingBags: 2, remainingWeightKg: 100, purchaseRate: 48 },
            { markCode: 'M', initialBags: 5, initialWeightKg: 250, remainingBags: 2, remainingWeightKg: 100, purchaseRate: 48 },
          ],
        }),
      ],
      sales: [
        sale({
          id: 'sale-1',
          items: [
            { id: 's1', markCode: 'H', lotNumber: 'LOT AP', bags: 2, weightKg: 80, ratePerKg: 20, amount: 1600, bagWeights: [{ bagNumber: 1, weightKg: 40 }, { bagNumber: 2, weightKg: 40 }] },
            { id: 's2', markCode: 'M', lotNumber: 'LOT AP', bags: 2, weightKg: 100, ratePerKg: 64, amount: 6400, bagWeights: [] },
          ],
          totalBags: 4,
          totalWeightKg: 180,
          productSubtotal: 8000,
          charges,
          totalAmount: charges.finalInvoiceAmount,
          paidAmount: charges.finalInvoiceAmount,
          balanceDue: 0,
        }),
      ],
    });
    const row = report.lots[0];
    const costPerKg = 25000 / 500;
    const soldKg = 180;
    const fees = charges.amaliAmount + charges.marketFeeAmount;
    assert.equal(row.profit, Math.round((8000 - soldKg * costPerKg - fees) * 100) / 100);
    assert.notEqual(row.profit, row.profit! - (row.remainingInventoryCost ?? 0));
    assert.equal(row.expenses, 1000);
    assert.equal(row.bagDifference, 4 - (10 - 4));
    assert.equal(rateKey(48), rateKey(row.costs[0].rate));
    assert.equal(row.costs.length, 1);
    assert.deepEqual(row.costs[0].marks.sort(), ['H', 'M']);
    assert.equal(row.costs[0].purchaseBags, 10);
    assert.equal(row.alerts.some((alert) => alert.reason.includes('Average bag weight')), false);
    assert.equal(row.alerts.some((alert) => alert.reason.includes('40')), false);
  });

  it('costs each mark at its own landed rate instead of the lot average', () => {
    const charges = calculateSaleCharges({
      totalBags: 5,
      productSubtotal: 15000,
      settings: DEFAULT_SALE_CHARGE_SETTINGS,
    });
    const report = buildDifferentialReport({
      products,
      stockMovements: [],
      purchases: [
        purchase({
          id: 'pur-1',
          lotNumber: 'LOT MIX',
          items: [
            { id: 'h', markCode: 'H', bags: 5, weightKg: 250, ratePerKg: 48, totalAmount: 12000 },
            { id: 'm', markCode: 'M', bags: 5, weightKg: 250, ratePerKg: 40, totalAmount: 10000 },
          ],
          expenses: [{ id: 'pe', type: 'FREIGHT', amount: 1000, description: 'Freight' }],
          grossAmount: 22000,
          totalExpenses: 1000,
          netAmount: 23000,
        }),
      ],
      lots: [
        lot({
          id: 'lot-mix',
          lotNumber: 'LOT MIX',
          totalBags: 10,
          totalWeightKg: 500,
          remainingBags: 5,
          remainingWeightKg: 250,
          marks: [
            { markCode: 'H', initialBags: 5, initialWeightKg: 250, remainingBags: 5, remainingWeightKg: 250, purchaseRate: 48 },
            { markCode: 'M', initialBags: 5, initialWeightKg: 250, remainingBags: 0, remainingWeightKg: 0, purchaseRate: 40 },
          ],
        }),
      ],
      sales: [
        sale({
          id: 'sale-cheap',
          items: [{ id: 's', markCode: 'M', lotNumber: 'LOT MIX', bags: 5, weightKg: 250, ratePerKg: 60, amount: 15000, bagWeights: [] }],
          totalBags: 5,
          totalWeightKg: 250,
          productSubtotal: 15000,
          charges,
          totalAmount: charges.finalInvoiceAmount,
          paidAmount: charges.finalInvoiceAmount,
          balanceDue: 0,
        }),
      ],
    });
    const row = report.lots[0];
    const fees = charges.amaliAmount + charges.marketFeeAmount;
    const cheapLanded = 10000 + 500;
    const averageCogs = 250 * (23000 / 500);
    assert.equal(row.profit, Math.round((15000 - cheapLanded - fees) * 100) / 100);
    assert.notEqual(row.profit, Math.round((15000 - averageCogs - fees) * 100) / 100);
    const soldMark = row.marks.find((mark) => mark.markCode === 'M');
    assert.equal(soldMark?.profit, row.profit);
    const unsoldMark = row.marks.find((mark) => mark.markCode === 'H');
    assert.equal(unsoldMark?.profit, null);
    assert.equal(row.remainingInventoryCost, 12000 + 500);
  });

  it('does not merge different normalized rates', () => {
    const report = buildDifferentialReport({
      products,
      stockMovements: [],
      purchases: [
        purchase({
          id: 'pur-1',
          lotNumber: 'LOT MIX',
          items: [
            { id: 'a', markCode: 'H', bags: 2, weightKg: 100, ratePerKg: 48, totalAmount: 4800 },
            { id: 'b', markCode: 'M', bags: 2, weightKg: 100, ratePerKg: 48.5, totalAmount: 4850 },
          ],
          grossAmount: 9650,
          netAmount: 9650,
        }),
      ],
      lots: [
        lot({
          id: 'lot-mix',
          lotNumber: 'LOT MIX',
          totalBags: 4,
          totalWeightKg: 200,
          remainingBags: 4,
          remainingWeightKg: 200,
          marks: [
            { markCode: 'H', initialBags: 2, initialWeightKg: 100, remainingBags: 2, remainingWeightKg: 100, purchaseRate: 48 },
            { markCode: 'M', initialBags: 2, initialWeightKg: 100, remainingBags: 2, remainingWeightKg: 100, purchaseRate: 48.5 },
          ],
        }),
      ],
      sales: [],
    });
    assert.deepEqual(report.lots[0].costs.map((group) => group.rate), [48, 48.5]);
  });

  it('leaves sales unallocated when one mark has two exact costs', () => {
    const report = buildDifferentialReport({
      products,
      stockMovements: [],
      purchases: [
        purchase({
          id: 'pur-1',
          lotNumber: 'LOT TWO',
          items: [
            { id: 'a', markCode: 'H', bags: 2, weightKg: 80, ratePerKg: 40, totalAmount: 3200 },
            { id: 'b', markCode: 'H', bags: 2, weightKg: 80, ratePerKg: 55, totalAmount: 4400 },
          ],
          grossAmount: 7600,
          netAmount: 7600,
        }),
      ],
      lots: [
        lot({
          id: 'lot-two',
          lotNumber: 'LOT TWO',
          totalBags: 4,
          totalWeightKg: 160,
          remainingBags: 2,
          remainingWeightKg: 80,
          marks: [{ markCode: 'H', initialBags: 4, initialWeightKg: 160, remainingBags: 2, remainingWeightKg: 80, purchaseRate: 40 }],
        }),
      ],
      sales: [
        sale({
          id: 'sale-1',
          items: [{ id: 's', markCode: 'H', lotNumber: 'LOT TWO', bags: 2, weightKg: 80, ratePerKg: 70, amount: 5600, bagWeights: [] }],
          totalBags: 2,
          totalWeightKg: 80,
          totalAmount: 5600,
          paidAmount: 5600,
        }),
      ],
    });
    assert.equal(report.lots[0].costs.length, 2);
    assert.equal(report.lots[0].costs.every((group) => group.salesUnallocated && group.soldKg == null), true);
    assert.equal(report.lots[0].marks[0].purchaseRate, null);
  });

  it('flags a selling rate under the stored floor and a bag-weight mismatch', () => {
    const report = buildDifferentialReport({
      products,
      stockMovements: [],
      purchases: [
        purchase({
          id: 'pur-1',
          lotNumber: 'LOT AP',
          items: [{ id: 'pi', markCode: 'AA', bags: 4, weightKg: 200, ratePerKg: 40, totalAmount: 8000 }],
          grossAmount: 8000,
          netAmount: 8000,
        }),
      ],
      lots: [
        lot({
          id: 'lot-1',
          lotNumber: 'LOT AP',
          totalBags: 4,
          totalWeightKg: 200,
          remainingBags: 2,
          remainingWeightKg: 100,
          marks: [{
            markCode: 'AA',
            initialBags: 4,
            initialWeightKg: 200,
            remainingBags: 2,
            remainingWeightKg: 100,
            purchaseRate: 40,
            finalizedSellingRate: 70,
          }],
        }),
      ],
      sales: [
        sale({
          id: 'sale-low',
          items: [{
            id: 's',
            markCode: 'AA',
            lotNumber: 'LOT AP',
            bags: 2,
            weightKg: 80,
            ratePerKg: 60,
            amount: 4800,
            bagWeights: [{ bagNumber: 1, weightKg: 30 }, { bagNumber: 2, weightKg: 30 }],
          }],
          totalBags: 2,
          totalWeightKg: 80,
          totalAmount: 4800,
          paidAmount: 4800,
        }),
      ],
    });
    const reasons = report.lots[0].alerts.map((alert) => alert.reason);
    assert.ok(reasons.some((reason) => reason === 'Selling rate below finalized floor rate'));
    assert.ok(reasons.some((reason) => reason === 'Recorded bag weights do not add up to the line weight'));
    assert.equal(report.lots[0].status, 'NEEDS_REVIEW');
  });
});
