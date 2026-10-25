-- Rules Prisma's schema language cannot express. Prisma does not manage CHECK constraints or triggers,
-- so later `migrate diff` runs leave them alone.

ALTER TABLE organizations ADD CONSTRAINT org_charges_non_negative CHECK (amali_per_bag >= 0 AND market_fee_per_bag >= 0);
ALTER TABLE customers ADD CONSTRAINT customers_credit_valid CHECK (credit_limit >= 0 AND credit_days BETWEEN 0 AND 365);
ALTER TABLE marks ADD CONSTRAINT marks_rates_non_negative CHECK (default_selling_rate >= 0 AND default_purchase_rate >= 0);
ALTER TABLE marks ADD CONSTRAINT marks_code_upper CHECK (code = upper(code));
ALTER TABLE lots ADD CONSTRAINT lots_number_upper CHECK (lot_number = upper(lot_number));
ALTER TABLE users ADD CONSTRAINT users_username_lower CHECK (username = lower(username));

ALTER TABLE lot_marks ADD CONSTRAINT lot_marks_non_negative
  CHECK (remaining_bags >= 0 AND remaining_weight_kg >= 0 AND initial_bags >= 0 AND initial_weight_kg >= 0);
ALTER TABLE lot_marks ADD CONSTRAINT lot_marks_code_upper CHECK (mark_code = upper(mark_code));

ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_sign CHECK (
  ((type IN ('PURCHASE_IN','OPENING_STOCK','SALE_REVERSAL','ADJUSTMENT_ADD') AND bags_delta >= 0 AND weight_delta_kg >= 0)
   OR (type IN ('SALE_OUT','ADJUSTMENT_SUB') AND bags_delta <= 0 AND weight_delta_kg <= 0))
  AND (bags_delta <> 0 OR weight_delta_kg <> 0));

ALTER TABLE sales ADD CONSTRAINT sales_totals
  CHECK (total_amount > 0 AND total_amount = product_subtotal + amali_amount + market_fee_amount + other_charges);
ALTER TABLE sale_items ADD CONSTRAINT sale_items_positive CHECK (bags > 0 AND weight_kg > 0 AND rate_per_kg > 0 AND amount >= 0);

ALTER TABLE payments ADD CONSTRAINT payments_sign CHECK ((kind = 'RECEIPT' AND amount > 0) OR (kind = 'REFUND' AND amount < 0));
ALTER TABLE payment_allocations ADD CONSTRAINT payment_allocations_non_zero CHECK (amount <> 0);
ALTER TABLE customer_ledger_entries ADD CONSTRAINT ledger_one_side
  CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0) <> (credit > 0)));

-- Posted history is corrected by new rows (reversals, releases, adjustments), never rewritten.
CREATE OR REPLACE FUNCTION forbid_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
CREATE TRIGGER customer_ledger_append_only BEFORE UPDATE OR DELETE ON customer_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_history_change();
