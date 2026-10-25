import { toPaise } from '../../common/money';
import type { Db } from '../../database/prisma.service';

export interface VendorTotals {
  openingPaise: number;
  billedPaise: number;
  paidPaise: number;
}

/**
 * The three numbers every vendor figure is derived from (see vendor-ledger.calc.ts), for all vendors, or one when an id is
 * given, in a fixed three queries. Payments are expenses that name the vendor.
 */
export async function vendorTotals(db: Db, organizationId: string, vendorId?: string): Promise<Map<string, VendorTotals>> {
  const [vendors, bills, payments] = await Promise.all([
    db.vendor.findMany({ where: { organizationId, ...(vendorId && { partyId: vendorId }) }, select: { partyId: true, openingBalance: true } }),
    db.purchase.groupBy({ by: ['vendorPartyId'], where: { organizationId, ...(vendorId && { vendorPartyId: vendorId }) }, _sum: { netAmount: true } }),
    db.expense.groupBy({ by: ['vendorPartyId'], where: { organizationId, vendorPartyId: vendorId ?? { not: null } }, _sum: { amount: true } }),
  ]);
  const billed = new Map(bills.map((row) => [row.vendorPartyId, toPaise(Number(row._sum.netAmount ?? 0))]));
  const paid = new Map(payments.map((row) => [row.vendorPartyId, toPaise(Number(row._sum.amount ?? 0))]));
  return new Map(vendors.map((v) => [v.partyId, {
    openingPaise: toPaise(Number(v.openingBalance)),
    billedPaise: billed.get(v.partyId) ?? 0,
    paidPaise: paid.get(v.partyId) ?? 0,
  }]));
}
