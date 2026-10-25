import type { Actor } from '../../common/auth/actor';
import { fromPaise, toPaise } from '../../common/money';
import type { Db, Tx } from '../../database/prisma.service';
import { planAllocation } from './allocation.calc';

/**
 * Signed customer balance = Σ ledger debit − Σ credit. Positive = the customer owes; negative = advance we hold.
 * The single definition used by customer lists, receipts, bills and reports.
 */
export async function customerBalancePaise(db: Db, organizationId: string, partyId: string): Promise<number> {
  const rows = await db.$queryRaw<{ balance: unknown }[]>`
    SELECT coalesce(sum(debit - credit), 0) AS balance FROM customer_ledger_entries
    WHERE organization_id = ${organizationId}::uuid AND customer_party_id = ${partyId}::uuid`;
  return toPaise(Number(rows[0]?.balance ?? 0));
}

/** Balances for every customer of the organization (one grouped query). */
export async function customerBalances(db: Db, organizationId: string): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ party_id: string; balance: unknown }[]>`
    SELECT customer_party_id AS party_id, sum(debit - credit) AS balance FROM customer_ledger_entries
    WHERE organization_id = ${organizationId}::uuid GROUP BY customer_party_id`;
  return new Map(rows.map((row) => [row.party_id, Number(row.balance)]));
}

/** Locks the customer row for the rest of the transaction (serializes balance-changing work per customer). */
export async function lockCustomer(tx: Tx, organizationId: string, partyId: string) {
  const rows = await tx.$queryRaw<{ party_id: string; status: string; credit_days: number }[]>`
    SELECT party_id, status::text AS status, credit_days FROM customers
    WHERE party_id = ${partyId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  return rows[0];
}

/**
 * Applies the customer's unused credit (advances, receipts released by cancelled bills) to what they owe:
 * the preferred bill first, then FIFO — opening balance, then confirmed bills oldest first.
 * Leftover credit stays as an advance for future bills. Call inside the transaction after any change.
 */
export async function settleCustomer(tx: Tx, actor: Actor, partyId: string, preferSaleId?: string | null): Promise<void> {
  const org = actor.organizationId;
  const credits = await tx.$queryRaw<{ payment_id: string; available: unknown }[]>`
    SELECT p.id AS payment_id, p.amount - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.payment_id = p.id), 0) AS available
    FROM payments p
    WHERE p.organization_id = ${org}::uuid AND p.customer_party_id = ${partyId}::uuid AND p.kind = 'RECEIPT'
    ORDER BY p.received_on, p.created_at`;
  const open = credits.map((c) => ({ paymentId: c.payment_id, availablePaise: toPaise(Number(c.available)) })).filter((c) => c.availablePaise > 0);
  if (open.length === 0) return;

  const opening = await tx.$queryRaw<{ remaining: unknown }[]>`
    SELECT coalesce((SELECT sum(debit) FROM customer_ledger_entries
                     WHERE organization_id = ${org}::uuid AND customer_party_id = ${partyId}::uuid AND type = 'OPENING'), 0)
         - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
                     WHERE p.customer_party_id = ${partyId}::uuid AND a.sale_id IS NULL), 0) AS remaining`;
  const bills = await tx.$queryRaw<{ id: string; bill_number: string; balance: unknown }[]>`
    SELECT s.id, s.bill_number, s.total_amount - coalesce((SELECT sum(a.amount) FROM payment_allocations a WHERE a.sale_id = s.id), 0) AS balance
    FROM sales s
    WHERE s.organization_id = ${org}::uuid AND s.customer_party_id = ${partyId}::uuid AND s.status = 'CONFIRMED'
    ORDER BY s.sale_date, s.created_at`;
  const debts = [
    { saleId: null as string | null, balancePaise: toPaise(Number(opening[0]?.remaining ?? 0)) },
    ...bills.map((b) => ({ saleId: b.id as string | null, balancePaise: toPaise(Number(b.balance)) })),
  ].filter((d) => d.balancePaise > 0);
  const preferred = debts.find((d) => d.saleId === preferSaleId);
  const ordered = preferred ? [preferred, ...debts.filter((d) => d !== preferred)] : debts;

  const lines = planAllocation(open, ordered);
  if (lines.length === 0) return;
  await tx.paymentAllocation.createMany({
    data: lines.map((line) => ({ organizationId: org, paymentId: line.paymentId, saleId: line.saleId, amount: fromPaise(line.amountPaise) })),
  });
}

/**
 * Releases every receipt allocated to a bill (negative allocation rows), so the money becomes credit again.
 * Returns what was released per receipt.
 */
export async function releaseSaleAllocations(tx: Tx, actor: Actor, saleId: string): Promise<{ paymentId: string; amountPaise: number }[]> {
  const rows = await tx.$queryRaw<{ payment_id: string; net: unknown }[]>`
    SELECT payment_id, sum(amount) AS net FROM payment_allocations WHERE sale_id = ${saleId}::uuid
    GROUP BY payment_id HAVING sum(amount) <> 0 ORDER BY min(created_at)`;
  const released = rows.map((row) => ({ paymentId: row.payment_id, amountPaise: toPaise(Number(row.net)) }));
  if (released.length) {
    await tx.paymentAllocation.createMany({
      data: released.map((r) => ({ organizationId: actor.organizationId, paymentId: r.paymentId, saleId, amount: fromPaise(-r.amountPaise) })),
    });
  }
  return released;
}
