/** A sales bill reduced to what a person reads when comparing a correction. */
export interface SaleSnapshot {
  productName: string;
  totalBags: number;
  totalWeightKg: number;
  totalAmount: number;
  items: { lotNumber: string; markCode: string; bags: number; weightKg: number; ratePerKg: number; amount: number }[];
}

export interface SaleChange {
  field: string;
  label: string;
  from: string;
  to: string;
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const itemLine = (item: SaleSnapshot['items'][number]) =>
  `${item.lotNumber} ${item.markCode}: ${item.bags} bags, ${item.weightKg} kg @ ${inr(item.ratePerKg)} = ${inr(item.amount)}`;

const SCALARS: { field: keyof SaleSnapshot; label: string; format: (value: SaleSnapshot[keyof SaleSnapshot]) => string }[] = [
  { field: 'productName', label: 'Product', format: (value) => String(value) },
  { field: 'totalBags', label: 'Bags', format: (value) => String(value) },
  { field: 'totalWeightKg', label: 'Weight (kg)', format: (value) => String(value) },
  { field: 'totalAmount', label: 'Bill amount', format: (value) => inr(Number(value)) },
];

/** Every difference between two versions of a bill. Empty when nothing the bill shows has changed. */
export function diffSale(before: SaleSnapshot, after: SaleSnapshot): SaleChange[] {
  const changes: SaleChange[] = [];
  for (const { field, label, format } of SCALARS) {
    if (before[field] !== after[field]) changes.push({ field, label, from: format(before[field]), to: format(after[field]) });
  }
  const lines = (snapshot: SaleSnapshot) => snapshot.items.map(itemLine).join('\n') || '—';
  if (lines(before) !== lines(after)) changes.push({ field: 'items', label: 'Bags and rates', from: lines(before), to: lines(after) });
  return changes;
}
