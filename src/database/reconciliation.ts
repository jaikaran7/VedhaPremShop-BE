import type { Db } from './prisma.service';

/**
 * Integrity checks. Each returns the rows that disagree; an empty array means the books reconcile.
 * Run after deploys/migrations (and after every e2e test). The SQL can be pasted into psql as is.
 */
export function stockDrift(db: Db) {
  return db.$queryRaw<unknown[]>`
    SELECT lm.id, lm.remaining_bags, lm.remaining_weight_kg, coalesce(m.bags, 0) AS ledger_bags, coalesce(m.kg, 0) AS ledger_kg
    FROM lot_marks lm
    LEFT JOIN (SELECT lot_mark_id, sum(bags_delta) AS bags, sum(weight_delta_kg) AS kg FROM stock_movements GROUP BY lot_mark_id) m
      ON m.lot_mark_id = lm.id
    WHERE lm.remaining_bags <> coalesce(m.bags, 0) OR lm.remaining_weight_kg <> coalesce(m.kg, 0)`;
}

/**
 * Per customer: ledger balance = unpaid opening + unpaid confirmed bills − unused receipts (advance).
 * Also every cancelled bill must have no net allocation left on it.
 */
export function receivableDrift(db: Db) {
  return db.$queryRaw<unknown[]>`
    WITH ledger AS (
      SELECT customer_party_id AS c, sum(debit - credit) AS balance FROM customer_ledger_entries GROUP BY 1
    ), opening AS (
      SELECT customer_party_id AS c, sum(debit) AS amount FROM customer_ledger_entries WHERE type = 'OPENING' GROUP BY 1
    ), opening_paid AS (
      SELECT p.customer_party_id AS c, sum(a.amount) AS amount
      FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.sale_id IS NULL GROUP BY 1
    ), bills AS (
      SELECT s.customer_party_id AS c,
             sum(s.total_amount - coalesce((SELECT sum(amount) FROM payment_allocations WHERE sale_id = s.id), 0)) AS unpaid
      FROM sales s WHERE s.status = 'CONFIRMED' AND s.customer_party_id IS NOT NULL GROUP BY 1
    ), unused AS (
      SELECT p.customer_party_id AS c, sum(p.amount - coalesce((SELECT sum(amount) FROM payment_allocations WHERE payment_id = p.id), 0)) AS amount
      FROM payments p WHERE p.customer_party_id IS NOT NULL GROUP BY 1
    )
    SELECT ledger.c AS customer_party_id, ledger.balance,
           coalesce(opening.amount, 0) - coalesce(opening_paid.amount, 0) + coalesce(bills.unpaid, 0) - coalesce(unused.amount, 0) AS expected
    FROM ledger
    LEFT JOIN opening ON opening.c = ledger.c
    LEFT JOIN opening_paid ON opening_paid.c = ledger.c
    LEFT JOIN bills ON bills.c = ledger.c
    LEFT JOIN unused ON unused.c = ledger.c
    WHERE ledger.balance <> coalesce(opening.amount, 0) - coalesce(opening_paid.amount, 0) + coalesce(bills.unpaid, 0) - coalesce(unused.amount, 0)
    UNION ALL
    SELECT s.id, NULL, NULL FROM sales s
    WHERE s.status <> 'CONFIRMED' AND coalesce((SELECT sum(amount) FROM payment_allocations WHERE sale_id = s.id), 0) <> 0`;
}

/** Counter-sale money: every rupee received is either on a bill or refunded. */
export function counterCashDrift(db: Db) {
  return db.$queryRaw<unknown[]>`
    SELECT sum(p.amount) AS received_net, (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a
      JOIN payments p2 ON p2.id = a.payment_id WHERE p2.customer_party_id IS NULL) AS allocated
    FROM payments p WHERE p.customer_party_id IS NULL
    HAVING coalesce(sum(p.amount), 0) <> (SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a
      JOIN payments p2 ON p2.id = a.payment_id WHERE p2.customer_party_id IS NULL)`;
}

/**
 * Purchases vs the stock ledger: a received purchase's PURCHASE_IN bags equal the accepted + defective bags it recorded;
 * a pending one has posted nothing. (Opening-stock purchases carry no groups and are skipped.)
 */
export function purchaseDrift(db: Db) {
  return db.$queryRaw<unknown[]>`
    SELECT p.id, p.receipt_status, coalesce(m.bags, 0) AS ledger_bags, g.bags AS recorded_bags
    FROM purchases p
    LEFT JOIN (SELECT reference_id, sum(bags_delta) AS bags FROM stock_movements WHERE type = 'PURCHASE_IN' GROUP BY 1) m ON m.reference_id = p.id
    CROSS JOIN LATERAL (
      SELECT coalesce(sum((x->>'acceptedBags')::int + (x->>'defectiveBags')::int), 0) AS bags, count(*) AS n
      FROM jsonb_array_elements(coalesce(p.receiving_record->'groups', '[]'::jsonb)) x
    ) g
    WHERE (p.receipt_status = 'PENDING_RECEIPT' AND coalesce(m.bags, 0) <> 0)
       OR (p.receipt_status = 'RECEIVED' AND g.n > 0 AND coalesce(m.bags, 0) <> g.bags)`;
}
