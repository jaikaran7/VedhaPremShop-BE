/** A vendor bill reduced to what a person reads when comparing a correction: "previous → current". */
export interface BillSnapshotInput {
  billNumber: string;
  vendorName: string;
  productName: string;
  date: string;
  expectedArrivalDate: string | null;
  lotNumber: string;
  notes: string;
  items: { markCode: string; bags: number; weightKg: number; ratePerKg: number; totalAmount: number }[];
  expenses: { name: string; amount: number }[];
  grossAmount: number;
  totalExpenses: number;
  netAmount: number;
}

export interface BillChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const itemLine = (i: BillSnapshotInput['items'][number]) =>
  `${i.markCode}: ${i.bags} bags, ${i.weightKg.toLocaleString('en-IN')} kg @ ${inr(i.ratePerKg)} = ${inr(i.totalAmount)}`;

const SCALARS: { field: keyof BillSnapshotInput; label: string }[] = [
  { field: 'billNumber', label: 'Vendor bill number' },
  { field: 'vendorName', label: 'Vendor' },
  { field: 'productName', label: 'Product' },
  { field: 'date', label: 'Bill date' },
  { field: 'expectedArrivalDate', label: 'Expected arrival' },
  { field: 'lotNumber', label: 'Lot number' },
  { field: 'notes', label: 'Notes' },
];

/** Every difference between two versions of a bill, in reading order. Empty when nothing changed. */
export function diffBill(before: BillSnapshotInput, after: BillSnapshotInput): BillChange[] {
  const changes: BillChange[] = [];
  for (const { field, label } of SCALARS) {
    const from = String(before[field] ?? '');
    const to = String(after[field] ?? '');
    if (from !== to) changes.push({ field, label, from: from || '—', to: to || '—' });
  }
  const lines = (s: BillSnapshotInput) => s.items.map(itemLine).join('\n') || '—';
  if (lines(before) !== lines(after)) changes.push({ field: 'items', label: 'Quality lines', from: lines(before), to: lines(after) });
  const charges = (s: BillSnapshotInput) => s.expenses.map((e) => `${e.name}: ${inr(e.amount)}`).join('\n') || '—';
  if (charges(before) !== charges(after)) changes.push({ field: 'expenses', label: 'Purchase charges', from: charges(before), to: charges(after) });
  if (before.netAmount !== after.netAmount) changes.push({ field: 'netAmount', label: 'Amount owed to vendor', from: inr(before.netAmount), to: inr(after.netAmount) });
  return changes;
}
