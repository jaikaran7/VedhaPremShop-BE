# Business Rules and Decisions

Source tags: **U** = stated by the owner (prompt 2) · **F** = read from the frontend code · **P** = provisional, chosen by an AI session
as the safest option · **?** = open. Full rule detail lives in `docs/architecture/business-domain.md`; this file is the decision log.

## Decided by the owner

| # | Decision | Implemented as |
|---|---|---|
| D1 | Bills default to today's date but the date can be changed. A bill on any other day waits for the super admin (Owner). | `POST /sales {date, dateReason}`: non-today → status `PENDING_APPROVAL`, stock held, no receivable/receipt until approved. **An Owner's own backdated bill posts directly** (P: the Owner is the approver). |
| D2 | Employees can see the approval list but not approve. | `GET /approvals` for all roles; `POST /approvals/:id` Owner-only (route guard). |
| D3 | Overpayment is accepted; the excess is shown as a positive balance and consumed on the customer's next bill. | Receipt keeps unused amount as an **advance**; `advanceAmount` on `Customer`; `settleCustomer` applies it oldest-debt-first. |
| D4 | A BLOCKED or over-limit customer can still be billed; show a red warning. | No server refusal. FE red warning on New Sale. |
| D5 | Counter-sale cash is recorded in collections as "Counter sales". | Counter bills require full payment; cash becomes a `payments` row with no customer; `counterCashDrift` reconciles it. |
| D6 | If sale charges changed after the cashier loaded the screen, refuse the bill. | `totalAmount` mismatch → 409. |
| D7 | The cashier may sell below the floor rate. | Only `rate > 0` is checked; below-floor is allowed. |
| D8 | "Edit request" becomes **cancel / rebill**; stock is returned on cancel and re-taken on rebill. | `POST /sales/:id/cancel`, `/rebill`: Owner applies at once, anyone else files an approval. |
| D9 | Other distributors appear as customers/suppliers (best-way implementation left to the AI). | One `parties` row can be customer and vendor; `Party.linkedOrganizationId` reserved. **No endpoint uses the link yet.** |
| D11 | Paying a vendor reduces what we owe them. *(provisional, session 4)* | Record Expense with category **Purchase Payments** + vendor. Payable = Σ bills − Σ payments. A payment above what is owed is refused (see `questions-for-owner.md` #1). |
| D12 | Vendor advance: paying more than owed is allowed and is used by the next bill. | Derived in `vendor-ledger.calc.ts`. |
| D13 | Vendor opening balance (Owner); previous due is paid before new bills. | `vendors.opening_balance`. |
| D14 | Vendor bills are corrected, not deleted; staff may correct; every correction keeps previous and current. | `purchase_revisions`. After receipt only rates/charges change. |
| D15 | Scale / Term / Loading are optional; vendor bills can be dated any day with no approval. | Screen + server. |
| D16 | GST optional on sale bills: % of invoice (whole rupee) or typed amount, added to the total. | `sales.calc.ts taxFor`. |
| D17 | Account balances: Owner sets real opening; closing carries to next day; Owner alone sees them; staff see collections of the day. | `cash-book.service.ts`. |
| D18 | Staff may record expenses, any date; late entries readjust later days. | Derived, nothing stored per day. |
| D10 | Prisma, not Drizzle; Neon Postgres 18; `ep-odd-flower` = dev, `ep-round-bar` = production. | Done. Production has never been touched. |

## Phase 7 rules (frontend-derived, F)

- A **vendor bill** records what is owed; **stock arrives only on receiving**. Amounts are recomputed on the server; client totals are ignored.
  Item line = `round(kg × ₹/kg)` to the whole rupee.
- Receiving posts `accepted + defective` bags once (defective bags are still stock); weight = received kg × taken/received bags. Per-bag
  weights override the typed total (mismatch > 0.05 kg blocks).
- Receiving expenses spread by received kg, by received bags, or onto one group. Landed cost = vendor rate + allocated receiving cost.
  Selling rate = landed + default margin (+ active per-kg margins), **rounded up to the next whole rupee**. A manual rate needs a reason.
- A lot number that exists is extended; an existing mark keeps its recorded purchase rate, a new mark takes the bill's rate.
- A finalized rate is frozen on the lot mark and in the receiving record; later settings changes never rewrite it.
- Vendor payable = Σ purchase `netAmount` (goods + purchase expenses). Receiving-time expenses are not owed to the vendor.

## Provisional (P) — safe defaults, please confirm

| # | Provisional rule | Why |
|---|---|---|
| P1 | An inactive vendor/product/expense type cannot be used on a **new** bill. | Mirrors the frontend's refusal of inactive expense types. |
| P2 | A lot number cannot hold two different products (409). | Prevents mixed-product stock under one lot. |
| P3 | Every vendor-bill line must be accounted for on receipt (enter 0 if it did not arrive). | Silent omission would drop owed stock. |
| P4 | A bill's lines may not repeat a mark; a bill number is unique per vendor. | `lot_marks` is unique on (lot, mark). |
| P5 | Rate and expected quantity on receipt come from the bill, not the client. | Authority belongs to the recorded bill. |
| P6 | Costing reads: Owner+Manager; costing writes: Owner. Purchases, reports: Owner+Manager. | Frontend `viewPurchaseCost`, `manageSettings`, `accessPurchases`, `viewProfit`. |
| P7 | Seed purchases for lots already in the yard are `RECEIVED` with an empty receiving record (their stock enters as opening stock). | Frontend treats bills without `receiptStatus` as already in stock. |

## Open questions for the owner

The plain-language version, with examples and suggestions, is `questions-for-owner.md`. Short table:


| # | Question | Today's behaviour |
|---|---|---|
| Q6 | "Average floor rate": mean of mark masters, or weighted by kg sold? | Unchanged from the mock. |
| Q9 | Partial bag returns from customers? | Not supported; cancel/rebill only. |
| Q10 | Vendor payments (advance, opening balance, per-bill). | **Partly resolved:** the frontend's "Vendor Payments" tab is Purchase Payments expenses; now each names a vendor and reduces the payable. Advance and opening balance still open (`questions-for-owner.md` #1–#3). |
| Q11 | Must every consignment carry Scale, Term and Loading (the New Purchase screen enforces it)? | Enforced by the UI only; the server accepts a bill without them. |
| Q12 | Do purchases need a date rule like sales (backdating approval)? | No rule; any date accepted. |
| Q13 | Should the Owner's own backdated bill really skip approval? | Posts directly. |
| Q14 | Expenses: who may record, date rules, opening account balances. | Implemented: Owner/Manager, any date, immutable rows, accounts open at ₹0. See `questions-for-owner.md` #11–#12. |
