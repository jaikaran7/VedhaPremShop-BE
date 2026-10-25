/**
 * What we owe a vendor, in integer paise. Everything is derived from three numbers and never stored:
 *   opening  – owed before this system was used (negative = we had already paid ahead)
 *   billed   – Σ vendor bills entered here (goods + purchase charges)
 *   paid     – Σ payments made to the vendor
 * Payments clear the old (opening) dues first, then the new bills, oldest first. Paying more than is owed leaves an advance
 * that the next bill uses up automatically.
 */
export interface VendorPosition {
  previousDuePaise: number;
  newDuePaise: number;
  advancePaise: number;
  /** previous + new, never negative. */
  payablePaise: number;
}

export function vendorPosition(openingPaise: number, billedPaise: number, paidPaise: number): VendorPosition {
  const previousDuePaise = Math.max(0, openingPaise - paidPaise);
  const creditPaise = Math.max(0, paidPaise - openingPaise); // payments left after the old dues (or the advance paid before go-live)
  const newDuePaise = Math.max(0, billedPaise - creditPaise);
  const advancePaise = Math.max(0, creditPaise - billedPaise);
  return { previousDuePaise, newDuePaise, advancePaise, payablePaise: previousDuePaise + newDuePaise };
}

export interface LedgerBill {
  id: string;
  netPaise: number;
}

export interface BillSettlement {
  id: string;
  paidPaise: number;
  balancePaise: number;
  status: 'PAID' | 'PARTIAL' | 'UNPAID';
}

/** Which bills the payments have cleared. `bills` must already be oldest first. */
export function settleBills(openingPaise: number, bills: LedgerBill[], paidPaise: number): BillSettlement[] {
  let credit = Math.max(0, paidPaise - openingPaise);
  return bills.map((bill) => {
    const paid = Math.min(bill.netPaise, credit);
    credit -= paid;
    const balancePaise = bill.netPaise - paid;
    return { id: bill.id, paidPaise: paid, balancePaise, status: billStatus(balancePaise, paid) };
  });
}

function billStatus(balancePaise: number, paidPaise: number): BillSettlement['status'] {
  if (balancePaise === 0) return 'PAID';
  return paidPaise === 0 ? 'UNPAID' : 'PARTIAL';
}
