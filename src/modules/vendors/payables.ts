import { toPaise } from '../../common/money';
import type { Db } from '../../database/prisma.service';

export interface VendorBalance {
  purchasedPaise: number;
  paidPaise: number;
}

/**
 * What we owe each vendor, derived and never stored: purchase bills (goods + the bill's purchase expenses)
 * minus payments made (expenses that name the vendor). Pass a vendor id to read just that one.
 */
export async function vendorBalances(db: Db, organizationId: string, vendorId?: string): Promise<Map<string, VendorBalance>> {
  const bills = await db.purchase.groupBy({
    by: ['vendorPartyId'], where: { organizationId, ...(vendorId && { vendorPartyId: vendorId }) }, _sum: { netAmount: true },
  });
  const payments = await db.expense.groupBy({
    by: ['vendorPartyId'], where: { organizationId, vendorPartyId: vendorId ?? { not: null } }, _sum: { amount: true },
  });
  const balances = new Map<string, VendorBalance>();
  const entry = (id: string) => balances.get(id) ?? balances.set(id, { purchasedPaise: 0, paidPaise: 0 }).get(id)!;
  for (const row of bills) entry(row.vendorPartyId).purchasedPaise = toPaise(Number(row._sum.netAmount ?? 0));
  for (const row of payments) if (row.vendorPartyId) entry(row.vendorPartyId).paidPaise = toPaise(Number(row._sum.amount ?? 0));
  return balances;
}
