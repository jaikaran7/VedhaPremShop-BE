export interface Credit {
  paymentId: string;
  availablePaise: number;
}

export interface Debt {
  /** null = the customer's opening balance. */
  saleId: string | null;
  balancePaise: number;
}

export interface AllocationLine {
  paymentId: string;
  saleId: string | null;
  amountPaise: number;
}

/**
 * Greedy matching of available credit (oldest receipt first) to debts in the given priority order.
 * Whatever is not matched stays as credit (an advance) or as debt (outstanding). Pure, so it is unit-tested.
 */
export function planAllocation(credits: Credit[], debts: Debt[]): AllocationLine[] {
  const lines: AllocationLine[] = [];
  const left = credits.map((c) => ({ ...c }));
  let c = 0;
  for (const debt of debts) {
    let owed = debt.balancePaise;
    while (owed > 0 && c < left.length) {
      const credit = left[c]!;
      const take = Math.min(owed, credit.availablePaise);
      if (take > 0) lines.push({ paymentId: credit.paymentId, saleId: debt.saleId, amountPaise: take });
      owed -= take;
      credit.availablePaise -= take;
      if (credit.availablePaise === 0) c += 1;
    }
  }
  return lines;
}
