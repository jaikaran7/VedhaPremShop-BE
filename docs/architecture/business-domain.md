# Business Domain

Vedhaprem Mandi is an APMC onion commission/wholesale shop. It buys consignments (lots) from vendors
upstream, grades them by **mark** (AA, J, K, OK, CV, TC… or product grades such as garlic BOLD), sells
weighed bags to customers at the yard, and collects cash now or on credit.

```
Producer / upstream trader ──(purchase bill, lot)──► Vedhaprem Mandi ──(sale bill, bags)──► Customer
                                                         │                                     │
                                                     stock by lot+mark                  receipts (cash/UPI/…)
```

## Glossary (from the code)

| Term | Meaning | Source |
|---|---|---|
| Lot | One consignment, e.g. `LOT AP`, from one vendor bill; holds several marks | `types.Lot` |
| Mark | Quality grade inside a lot; master list carries default (floor) selling & purchase rate | `types.Mark`, `LotMarkBreakdown` |
| Bag weight | Each bag is weighed; line kg = Σ bag kg; bags are **not** uniform | `SaleItem.bagWeights`, `trading.pricedFromBags` |
| Line amount | `round(Σkg × ₹/kg)` to the whole rupee | `trading.saleLineAmount` |
| Amali | Porter/handling charge, ₹/bag, on the bill | `sale-charges.ts` |
| Market fee | APMC fee, ₹/bag, on the bill | `sale-charges.ts` |
| Counter sale | Walk-in sale with no customer account; must be fully paid | `NewSaleWorkflow`, `PaymentSettlement.tsx:311` |
| Regular / Wholesale customer | Walk-in (no credit, 0/0 terms) vs business account | `CustomerFormModal` |
| Finalized selling rate | Rate fixed per lot+mark at receiving; default for new bills | `receiving.quotedSaleRate` |
| Floor rate | Mark master `defaultSellingRate`, fallback when not finalized | same |

## Entities kept (validated against screens)

Organization (shop + settings), User + role membership, Party (one business), Customer profile,
Vendor profile, Product, Mark, Lot, Lot-mark stock line, Stock movement, Sale, Sale line,
Payment (receipt), Payment allocation, Customer ledger entry, Audit log, Document sequence.

Deferred until their phase: Purchase, purchase lines/expenses, receiving record, costing masters,
expenses & cash accounts, approvals. Not modelled (no screen needs them): warehouses/yard locations,
reservations, supplier returns, discounts, GST tax lines, multi-level distributor hierarchy beyond one
organization (see `system-architecture.md §Tenancy`).

## Rules the backend enforces

### Sales
1. Server recomputes everything from bag weights and rates; client totals are only compared.
   If the client sends `totalAmount` and it differs from the server's, the request fails (409) so the
   cashier never confirms a price the customer was not shown.
2. Line: `bags = count(bagWeights)`, `kg = Σ bag kg` (each bag > 0, ≤ 3 decimals), `amount = round(kg × rate)`.
3. Charges: `amali = bags × amaliPerBag` (if enabled), `marketFee = bags × marketFeePerBag` (if enabled),
   both from the organization's **current** settings; snapshot saved on the bill and never rewritten.
4. `total = productSubtotal + amali + marketFee`.
5. Settlement: tenders > 0 each, Σ tenders ≤ total; balance > 0 requires `creditDays ≥ 0`;
   `dueDate = saleDate + creditDays`. `paymentStatus` = PAID / PARTIAL / CREDIT, `paymentType` per `paymentTypeFor`.
6. Counter sale (no customer) must be fully paid.
7. A `BLOCKED` or over-limit customer **can** be billed on credit; the frontend shows a red warning only (owner decision D4).
8. Stock: each line references a specific lot + mark of the sale's product. No FIFO — the cashier chooses the lot.
   Σbags and Σkg per lot-mark must be available; deducted atomically (see `database-design.md §Concurrency`).
   Negative stock is never allowed.
9. Sale date defaults to today in the organization timezone (Asia/Kolkata). Any staff member may pick another date (365 days back, 30 ahead);
   the bill posts at once with stock, receivable and receipts on that date, and the audit trail notes the date and the reason typed. No approval. (D1)
   Only cancelling or editing a bill needs the Owner (rule 11). Bills left `PENDING_APPROVAL` by the earlier rule can still be approved or rejected.
10. Bill numbers: `{invoicePrefix}-{n}`, gap-free per organization, allocated inside the sale transaction.
11. Cancel and rebill ("edit bill") replace the old sale-edit request. The Owner's change applies at once; anyone else's becomes an
    approval request. Cancelling restores stock with reversal movements; money already received on the bill is released as the
    customer's credit (counter-sale money is refunded). Rebill = cancel + a new bill on the original date with the released money applied
    first. History is never deleted. (D8)

### Receivables and payments
1. Customer outstanding = Σ ledger debits − Σ ledger credits. The ledger is the single source; no stored balance.
2. Ledger entries: OPENING (debit), SALE (debit, full bill total), PAYMENT (credit), ADJUSTMENT (sale reversal credit).
3. A payment is allocated: the bill named in `referenceNumber` first, then open bills oldest first, then any
   remaining opening balance. Allocation is stored (`payment_allocations`); a bill's `paidAmount` is
   Σ its allocations and `balanceDue = total − paidAmount`.
4. A payment larger than the outstanding is accepted: the excess stays as the customer's **advance** (`advanceAmount`, shown as a positive
   number) and is applied to their next bill, oldest debt first. (D3)
5. Tenders taken at sale time become receipts allocated to that bill (counter sales included — cash is cash).
6. Receipt numbers: `{receiptPrefix}-{n}`, gap-free per organization.
7. Retries are safe: `Idempotency-Key` on `POST /sales` and `POST /payments` returns the original record.

### Stock
1. Movements are immutable: PURCHASE_IN, OPENING_STOCK, SALE_OUT, SALE_REVERSAL, ADJUSTMENT_ADD, ADJUSTMENT_SUB.
2. Each movement stores signed bag/kg deltas and the balance after; the stored lot-mark balance must always equal
   Σ deltas (reconciliation query in `database-design.md`).
3. Adjustments and opening stock: Owner/Manager only, reason required, cannot drive stock below zero.

### Visibility
Purchase rates and vendor costs are hidden from Salesperson **in API responses**, not only in the UI.

## Metrics (single definitions, Phase 8 server aggregation)

| Metric | Formula | Scope / time | Cancelled | Source |
|---|---|---|---|---|
| Today's revenue | Σ sale.total for sale_date = today | org, IST day | excluded | sales |
| Today's collections | Σ payment.amount for received_on = today | org, IST day | reversed receipts excluded | payments |
| Total receivables | Σ ledger (debit − credit) over all customers | org, all time | reversal entries net it out | customer_ledger_entries |
| Stock in mandi | Σ remaining bags / kg over lot marks | org, now | n/a | lot_marks |
| Credit sales today | Σ balance due at posting for today's bills | org, IST day | excluded | sales |
| Lots completed / in progress | lots with remaining bags = 0 / > 0 | org, now | n/a | lot_marks |
| Average floor rate | mean of mark `defaultSellingRate` (as today's FE) — **Q6** | org | n/a | marks |
| Weekly sales vs collections | daily Σ sales total vs Σ receipts, last 7 IST days | org | excluded | sales, payments |

Revenue ≠ collections ≠ receivables: a ₹10,000 credit bill adds ₹10,000 revenue and ₹10,000 receivable and
₹0 collection; a later ₹4,000 receipt adds ₹4,000 collection and leaves ₹6,000 outstanding.

## Unresolved questions (need the owner)

| # | Question | Provisional behaviour |
|---|---|---|
| Q1 | Bills dated by the real calendar day? | **Resolved (D1):** today by default, changeable; other days need Owner approval. |
| Q2 | Does BLOCKED forbid credit / does exceeding the limit need approval? | **Resolved (D4):** neither; red warning only. |
| Q3 | May the cashier sell below the finalized/floor rate? | **Resolved (D7):** yes. |
| Q4 | Advance payments? | **Resolved (D3):** accepted, kept as an advance. |
| Q5 | Sale edit requests? | **Resolved (D8):** cancel + rebill, with approval unless the Owner does it. |
| Q6 | "Average floor rate" — mean of mark masters, or weighted by today's kg sold? | Open. Unchanged until Phase 8. |
| Q7 | Are customers also vendors (same business on both sides)? | Supported by one `parties` row with both profiles. |
| Q8 | Other distributors: own books or just parties? | **Resolved (D9):** parties; `linkedOrganizationId` reserved, no flow yet. |
| Q9 | Partial bag returns from customers? | Open. Not supported; cancel/rebill only. |

Later questions (Q10 vendor payments, Q11 mandatory consignment charges, Q12–Q14) are tracked in
`docs/handover/business-rules-and-decisions.md`.

## Purchases and receiving (Phase 7)

1. A vendor bill (`POST /purchases`) records the consignment and what is owed (goods + purchase expenses); **no stock** moves.
   Server recomputes: line = `round(kg × rate)` to the rupee; `net = gross + expenses`.
2. Receiving (`POST /purchases/:id/receive`) happens once per purchase (row lock; repeats return the same purchase). It posts
   `accepted + defective` bags per mark as PURCHASE_IN, creating the lot or extending it (same product only).
3. Selling rate per mark = (vendor rate + allocated receiving cost) + default margin + active per-kg margins, rounded **up** to the
   next whole rupee; a manual rate needs a reason. The result is frozen on the lot mark and in the purchase's receiving record.
4. Vendor payable = Σ purchase net amounts; receiving-time expenses are not owed to the vendor. No vendor payment flow exists (Q10).
5. Stock receiving expenses spread by received kg, received bags, or onto one quality. Rules live in
   `modules/purchases/receiving.calc.ts` (a port of the frontend's `utils/receiving.ts` + `utils/costing.ts`).
