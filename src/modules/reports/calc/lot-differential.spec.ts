/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- the frontend's own test file, run unchanged; it is not written for the backend's stricter index checks.
import assert from './assert-shim';
import { buildLotDifferential } from './lot-differential';
import { calculateSaleCharges, DEFAULT_SALE_CHARGE_SETTINGS } from './sale-charges';
import type { Lot, Purchase, Sale, StockMovement } from './frontend-types';

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

describe('lot differential', () => {
  it('keeps a partly sold lot in progress and costs only the sold weight', () => {
    const purchases = [
      purchase({
        id: 'pur-1',
        lotNumber: 'LOT AP',
        items: [{ id: 'pi', markCode: 'AA', bags: 10, weightKg: 500, ratePerKg: 40, totalAmount: 20000 }],
        expenses: [{ id: 'pe', type: 'FREIGHT', amount: 1000, description: 'Freight' }],
        grossAmount: 20000,
        totalExpenses: 1000,
        netAmount: 21000,
      }),
    ];
    const lots = [
      lot({
        id: 'lot-1',
        lotNumber: 'LOT AP',
        totalBags: 10,
        totalWeightKg: 500,
        remainingBags: 7,
        remainingWeightKg: 350,
        marks: [{ markCode: 'AA', initialBags: 10, initialWeightKg: 500, remainingBags: 7, remainingWeightKg: 350, purchaseRate: 40 }],
      }),
    ];
    const charges = calculateSaleCharges({
      totalBags: 3,
      productSubtotal: 10419,
      settings: DEFAULT_SALE_CHARGE_SETTINGS,
    });
    const sales = [
      sale({
        id: 'sale-1',
        items: [{ id: 'si', markCode: 'AA', lotNumber: 'LOT AP', bags: 3, weightKg: 150, ratePerKg: 69.46, amount: 10419, bagWeights: [] }],
        totalBags: 3,
        totalWeightKg: 150,
        productSubtotal: 10419,
        charges,
        totalAmount: charges.finalInvoiceAmount,
        paidAmount: 5000,
        balanceDue: 5509,
        paymentStatus: 'PARTIAL',
        paymentType: 'PARTIAL',
      }),
    ];

    const report = buildLotDifferential({ lots, purchases, sales, stockMovements: [] });
    const row = report.lots[0];

    assert.equal(row.status, 'IN_PROGRESS');
    assert.equal(row.outgoingBags, 3);
    assert.equal(row.outgoingWeightKg, 150);
    assert.equal(row.remainingBags, 7);
    assert.equal(row.remainingWeightKg, 350);
    assert.equal(row.salesRealization, 10419);
    assert.equal(row.amali, 60);
    assert.equal(row.marketFee, 30);
    assert.equal(row.purchaseCost, 21000);
    assert.equal(row.realizedProfit, 10419 - 6300 - 90);
    assert.equal(row.estimatedProfit, null);
    assert.ok(row.remainingInventoryCost != null && row.remainingInventoryCost > 0);
    assert.notEqual(row.realizedProfit, 10419 - 21000);
  });

  it('marks a fully depleted lot completed and realizes the full landed cost', () => {
    const charges = calculateSaleCharges({
      totalBags: 10,
      productSubtotal: 30000,
      settings: DEFAULT_SALE_CHARGE_SETTINGS,
    });
    const report = buildLotDifferential({
      lots: [
        lot({
          id: 'lot-4',
          lotNumber: 'LOT DN',
          status: 'EXHAUSTED',
          totalBags: 10,
          totalWeightKg: 500,
          remainingBags: 0,
          remainingWeightKg: 0,
        }),
      ],
      purchases: [
        purchase({
          id: 'pur-4',
          lotNumber: 'LOT DN',
          items: [{ id: 'pi', markCode: 'OK', bags: 10, weightKg: 500, ratePerKg: 40, totalAmount: 20000 }],
          expenses: [{ id: 'pe', type: 'OTHER', amount: 1000, description: 'Unloading' }],
          grossAmount: 20000,
          totalExpenses: 1000,
          netAmount: 21000,
        }),
      ],
      sales: [
        sale({
          id: 'sale-4',
          items: [{ id: 'si', markCode: 'OK', lotNumber: 'LOT DN', bags: 10, weightKg: 500, ratePerKg: 60, amount: 30000, bagWeights: [] }],
          totalBags: 10,
          totalWeightKg: 500,
          productSubtotal: 30000,
          charges,
          totalAmount: 30300,
          paidAmount: 30300,
          balanceDue: 0,
          paymentStatus: 'PAID',
        }),
      ],
      stockMovements: [],
    });

    const row = report.lots[0];
    assert.equal(row.status, 'COMPLETED');
    assert.equal(row.closureStatus, 'CLOSED');
    assert.equal(row.remainingWeightKg, 0);
    assert.equal(row.realizedProfit, 30000 - 21000 - 300);
    assert.equal(row.estimatedProfit, row.realizedProfit);
  });

  it('includes stock-receiving expenses in landed cost and sold COGS', () => {
    const charges = calculateSaleCharges({
      totalBags: 10,
      productSubtotal: 30000,
      settings: DEFAULT_SALE_CHARGE_SETTINGS,
    });
    const report = buildLotDifferential({
      lots: [
        lot({
          id: 'lot-recv',
          lotNumber: 'LOT RX',
          status: 'EXHAUSTED',
          totalBags: 10,
          totalWeightKg: 500,
          remainingBags: 0,
          remainingWeightKg: 0,
        }),
      ],
      purchases: [
        purchase({
          id: 'pur-rx',
          lotNumber: 'LOT RX',
          items: [{ id: 'pi', markCode: 'OK', bags: 10, weightKg: 500, ratePerKg: 40, totalAmount: 20000 }],
          expenses: [{ id: 'pe', type: 'OTHER', amount: 1000, description: 'Unloading' }],
          grossAmount: 20000,
          totalExpenses: 1000,
          netAmount: 21000,
          receiving: {
            receivedAt: '2026-09-25T09:00:00Z',
            stockPosted: true,
            expenses: [{
              id: 're-1',
              expenseTypeId: 'cet-transport',
              expenseTypeName: 'Transport',
              description: 'Yard transport',
              amount: 500,
              remarks: '',
              allocation: { method: 'BY_RECEIVED_KG' },
            }],
            groups: [],
            issues: [],
          },
        }),
      ],
      sales: [
        sale({
          id: 'sale-rx',
          items: [{ id: 'si', markCode: 'OK', lotNumber: 'LOT RX', bags: 10, weightKg: 500, ratePerKg: 60, amount: 30000, bagWeights: [] }],
          totalBags: 10,
          totalWeightKg: 500,
          productSubtotal: 30000,
          charges,
          totalAmount: 30300,
          paidAmount: 30300,
          balanceDue: 0,
          paymentStatus: 'PAID',
        }),
      ],
      stockMovements: [],
    });
    const row = report.lots[0];
    assert.equal(row.purchaseCost, 21500);
    assert.equal(row.realizedProfit, 30000 - 21500 - 300);
    assert.notEqual(row.realizedProfit, 30000 - 21000 - 300);
  });

  it('values unsold stock from receipts minus sales, not a short recorded remaining', () => {
    const report = buildLotDifferential({
      lots: [
        lot({
          id: 'lot-short',
          lotNumber: 'LOT SH',
          totalBags: 10,
          totalWeightKg: 500,
          remainingBags: 8,
          remainingWeightKg: 400,
          marks: [{ markCode: 'TC', initialBags: 10, initialWeightKg: 500, remainingBags: 8, remainingWeightKg: 400, purchaseRate: 40 }],
        }),
      ],
      purchases: [
        purchase({
          id: 'pur-sh',
          lotNumber: 'LOT SH',
          items: [{ id: 'pi', markCode: 'TC', bags: 10, weightKg: 500, ratePerKg: 40, totalAmount: 20000 }],
          expenses: [{ id: 'pe', type: 'FREIGHT', amount: 1000, description: 'Freight' }],
          grossAmount: 20000,
          totalExpenses: 1000,
          netAmount: 21000,
        }),
      ],
      sales: [],
      stockMovements: [],
    });
    const row = report.lots[0];
    assert.equal(row.realizedProfit, null);
    assert.equal(row.remainingInventoryCost, 21000);
    assert.notEqual(row.remainingInventoryCost, 16800);
  });

  it('does not complete a lot that still has stock, even when the lot record is closed', () => {
    const report = buildLotDifferential({
      lots: [
        lot({
          id: 'lot-x',
          lotNumber: 'LOT HOLD',
          status: 'EXHAUSTED',
          remainingBags: 2,
          remainingWeightKg: 100,
        }),
      ],
      purchases: [],
      sales: [],
      stockMovements: [],
    });
    assert.equal(report.lots[0].status, 'IN_PROGRESS');
    assert.equal(report.lots[0].closureStatus, 'CLOSED');
    assert.equal(report.lots[0].purchaseCost, null);
    assert.equal(report.lots[0].realizedProfit, null);
  });

  it('attributes a multi-lot invoice by line, not by the invoice total', () => {
    const charges = calculateSaleCharges({
      totalBags: 4,
      productSubtotal: 4000,
      settings: DEFAULT_SALE_CHARGE_SETTINGS,
    });
    const report = buildLotDifferential({
      lots: [
        lot({ id: 'a', lotNumber: 'LOT A', totalBags: 2, totalWeightKg: 100, remainingBags: 0, remainingWeightKg: 0, status: 'EXHAUSTED' }),
        lot({ id: 'b', lotNumber: 'LOT B', totalBags: 2, totalWeightKg: 100, remainingBags: 0, remainingWeightKg: 0, status: 'EXHAUSTED' }),
      ],
      purchases: [
        purchase({
          id: 'pa',
          lotNumber: 'LOT A',
          items: [{ id: '1', markCode: 'AA', bags: 2, weightKg: 100, ratePerKg: 10, totalAmount: 1000 }],
          grossAmount: 1000,
          netAmount: 1000,
        }),
        purchase({
          id: 'pb',
          lotNumber: 'LOT B',
          items: [{ id: '2', markCode: 'K', bags: 2, weightKg: 100, ratePerKg: 10, totalAmount: 1000 }],
          grossAmount: 1000,
          netAmount: 1000,
        }),
      ],
      sales: [
        sale({
          id: 'sale-mix',
          items: [
            { id: 's1', markCode: 'AA', lotNumber: 'LOT A', bags: 2, weightKg: 100, ratePerKg: 30, amount: 3000, bagWeights: [] },
            { id: 's2', markCode: 'K', lotNumber: 'LOT B', bags: 2, weightKg: 100, ratePerKg: 10, amount: 1000, bagWeights: [] },
          ],
          totalBags: 4,
          totalWeightKg: 200,
          productSubtotal: 4000,
          charges,
          totalAmount: charges.finalInvoiceAmount,
          paidAmount: charges.finalInvoiceAmount,
          balanceDue: 0,
        }),
      ],
      stockMovements: [] as StockMovement[],
    });

    const lotA = report.lots.find((row) => row.lotNumber === 'LOT A');
    const lotB = report.lots.find((row) => row.lotNumber === 'LOT B');
    assert.equal(lotA?.outgoingWeightKg, 100);
    assert.equal(lotB?.outgoingWeightKg, 100);
    assert.equal(lotA?.salesRealization, 3000);
    assert.equal(lotB?.salesRealization, 1000);
    assert.equal((lotA?.amali ?? 0) + (lotB?.amali ?? 0), charges.amaliAmount);
    assert.equal((lotA?.marketFee ?? 0) + (lotB?.marketFee ?? 0), charges.marketFeeAmount);
    assert.equal((lotA?.salesRealization ?? 0) + (lotB?.salesRealization ?? 0), 4000);
  });
});
