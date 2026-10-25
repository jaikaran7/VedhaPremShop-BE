import { type BillSnapshotInput, diffBill } from './purchase-diff';

const bill = (over: Partial<BillSnapshotInput> = {}): BillSnapshotInput => ({
  billNumber: 'PUR-1', vendorName: 'Murade Traders', productName: 'Onions', date: '2026-10-25', expectedArrivalDate: null, lotNumber: 'LOT A', notes: '',
  items: [{ markCode: 'AA', bags: 100, weightKg: 5200, ratePerKg: 47, totalAmount: 244_400 }],
  expenses: [{ name: 'Scale', amount: 1200 }], grossAmount: 244_400, totalExpenses: 1200, netAmount: 245_600, ...over,
});

describe('diffBill', () => {
  it('reports nothing for an identical bill', () => expect(diffBill(bill(), bill())).toEqual([]));

  it('shows previous and current for a corrected rate, with the new amount owed', () => {
    const after = bill({ items: [{ markCode: 'AA', bags: 100, weightKg: 5200, ratePerKg: 46, totalAmount: 239_200 }], grossAmount: 239_200, netAmount: 240_400 });
    expect(diffBill(bill(), after)).toEqual([
      { field: 'items', label: 'Quality lines', from: 'AA: 100 bags, 5,200 kg @ ₹47 = ₹2,44,400', to: 'AA: 100 bags, 5,200 kg @ ₹46 = ₹2,39,200' },
      { field: 'netAmount', label: 'Amount owed to vendor', from: '₹2,45,600', to: '₹2,40,400' },
    ]);
  });

  it('shows scalar edits, an added charge and a cleared date', () => {
    const changes = diffBill(bill({ expectedArrivalDate: '2026-10-27' }), bill({ billNumber: 'PUR-2', expectedArrivalDate: null, expenses: [{ name: 'Scale', amount: 1200 }, { name: 'Term', amount: 300 }], totalExpenses: 1500, netAmount: 245_900 }));
    expect(changes.map((c) => c.field)).toEqual(['billNumber', 'expectedArrivalDate', 'expenses', 'netAmount']);
    expect(changes[1]).toMatchObject({ from: '2026-10-27', to: '—' });
    expect(changes[2]).toMatchObject({ to: 'Scale: ₹1,200\nTerm: ₹300' });
  });
});
