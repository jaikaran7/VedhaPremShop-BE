# API Contracts

Base: `/api/v1`. JSON. Live OpenAPI at `/api/docs` (non-production builds).
Response bodies are the frontend's own types from `src/types/index.ts`, unwrapped (arrays for lists), so screens are
unchanged. Unknown request fields are stripped, never trusted.

## Conventions

| Topic | Rule |
|---|---|
| Auth | `vp_access` httpOnly cookie (browser) or `Authorization: Bearer <accessToken>` (API clients). All routes except `auth/login`, `auth/refresh`, `auth/logout`, `health*` require it. |
| CSRF | Requests carrying `vp_*` cookies with a method other than GET/HEAD/OPTIONS must send `X-Requested-With` (any value). The frontend client always sends `X-Requested-With: fetch`. |
| Roles | O = Owner, M = Manager, S = Salesperson. Enforced by the API (403), not just hidden in the UI. |
| Tenancy | Organization always comes from the token. Another organization's id returns 404. |
| Lists | `?limit` (default 1000, max 5000) & `?offset`. The frontend filters and sorts in the browser today. |
| Idempotency | `Idempotency-Key` header (8–100 chars `[A-Za-z0-9_-]`) on `POST /sales`, `POST /payments`. Same key ⇒ same record, posted once, even under concurrent retries. |
| Money / weight | Numbers in rupees (2 dp) and kg (3 dp). Server recomputes every total. |
| Dates | `YYYY-MM-DD` business date in the organization timezone (Asia/Kolkata); timestamps ISO-8601 UTC. |
| Errors | `{ "statusCode", "error", "message" (string or string[] for validation), "requestId" }`; `X-Request-Id` header on every response. |

Status codes: 200/201/204 success · 400 validation · 401 not signed in / expired · 403 role or CSRF ·
404 not found (or other tenant) · 409 conflict (stock, duplicate, state, changed total) · 422 business rule ·
429 rate limit · 500 unexpected (logged with requestId).

## Endpoints

| Method & path | Roles | Body → Response | Notes |
|---|---|---|---|
| POST `/auth/login` | public (10/min/IP) | `{username, password}` → `{user, accessToken, expiresIn}` + cookies | Same 401 message for unknown user, wrong password, deactivated |
| POST `/auth/refresh` | public, cookie (30/min) | — → same as login | Rotates; replaying an old token revokes the family |
| POST `/auth/logout` | public, cookie | — → 204 | Revokes the refresh family, clears cookies |
| GET `/auth/me` | all | → `User` | |
| POST `/auth/change-password` | all (5/min) | `{currentPassword, newPassword≥8}` → 204 | Signs out other sessions |
| GET `/users` | O, M | → `User[]` | |
| POST `/users` | O | `{username, name, role, password≥8, email?, phone?}` → `User` | |
| PATCH `/users/:id` | O | `{name?, role?, active?, password?, email?, phone?}` → `User` | Cannot deactivate/demote self or the last active owner; revokes sessions on deactivate/reset/role change |
| GET `/settings/company` · PUT | all · O | `CompanySettings` | |
| GET `/settings/sale-charges` · PUT | all · O | `SaleChargeSettings` | Applies to new bills only |
| GET `/settings/marks` · POST · PATCH `/:id` | all · O · O | `Mark` | `defaultPurchaseRate` omitted for S |
| GET `/settings/products` · POST · PATCH `/:id` | all · O · O | `Product` | Code derived from name |
| GET `/customers` | all | → `Customer[]` | `outstandingAmount` from the ledger |
| GET `/customers/ledger` | all | → `CustomerLedgerEntry[]` | Running balance per customer |
| GET `/customers/:id` | all | → `Customer` | |
| POST `/customers` | all | `{name, phone?, email?, address?, marketLocation?, kind?, creditLimit?, creditDays?, status?}` → `Customer` | S may not set credit terms/status (403) |
| PATCH `/customers/:id` | all | partial of the above → `Customer` | Credit fields O/M only; credit changes audited as `UPDATE_CUSTOMER_CREDIT` |
| DELETE `/customers/:id` | O, M | → 204 | 409 if the customer has any history — block instead |
| GET `/vendors` · GET `/:id` | all | `Vendor` | Everyone gets identity; **O, M** also get `totalPurchases`, `openingBalance`, `previousDue`, `newDue`, `advanceAmount`, `payableAmount` (derived: payments clear opening first, then oldest bills; excess = advance) |
| POST `/vendors` · PATCH `/:id` | O, M | `Vendor` | `openingBalance` (owed before the system, may be negative) is **Owner only**, audited |
| GET `/vendors/:id/ledger` | O, M | → `{vendor, previousDue, newDue, advanceAmount, payableAmount, bills[], payments[]}` | Each bill with paid / balance / status; three queries |
| GET `/lots`, GET `/lots/:id` | all | → `Lot` | Totals derived from marks; `purchaseRate` omitted for S |
| GET `/stock/movements` | all | `?lotNumber&markCode&type=A,B&from&to&limit&offset` → `StockMovement[]` newest first | bags/kg absolute; type gives direction; matching count in `X-Total-Count` |
| POST `/stock/adjustments` | O, M | `{lotNumber, markCode, type ADD/REDUCE, bags, weightKg, reason}` → `StockAdjustment` | 409 if it would go negative |
| POST `/stock/opening` | O, M | `{lotNumber, markCode, bags, weightKg}` → `StockAdjustment` | Adds the mark to an existing lot if new |
| GET `/sales` | all | `?from&to&limit&offset` → `Sale[]` | `paidAmount`, `balanceDue`, `paymentStatus` live from allocations |
| GET `/sales/:id` | all | → `Sale` | |
| POST `/sales` | all | see below → `Sale` (201) | Idempotency-Key supported |
| POST `/sales/:id/cancel` | all | `{reason}` → `{status:'APPLIED', sale}` or `{status:'PENDING_APPROVAL', approvalId}` | Owner applies now; others file a request. Stock returns; receipts become customer credit (counter money refunded) |
| POST `/sales/:id/rebill` | all | new-bill body + `{reason}` → same union | Cancel + new bill on the original date; Owner now, others via approval |
| GET `/approvals` | all | → `ApprovalRequest[]` newest first | Staff can see the queue |
| POST `/approvals/:id` | O | `{action: APPROVE/REJECT, notes?}` → 204 | Runs the change in one transaction; 409 if already decided or no longer applicable |
| POST `/sales/:id/corrections` | all | `{note}` → 204 | Audit note, as in the mock |
| GET `/payments`, GET `/payments/:id` | all | → `Payment[]` + `billAllocations[]` | `allocation` categories are derived by the frontend |
| POST `/payments` | all | `{customerId, amount, paymentMethod, referenceNumber?, notes?}` → `Payment` | Excess over what is owed is kept as an advance; Idempotency-Key supported |
| GET `/settings/costing` · PUT | all · O | `{defaultSellingMarginPerKg, roundingRule}` | Applies to receivings done afterwards |
| GET `/settings/costing/expense-types` · POST · PATCH `/:id` | all · O · O | `{name, kind PURCHASE/STOCK_RECEIVING}` → `CostingExpenseType` | Case-insensitive unique per kind (409) |
| GET `/settings/costing/margins` · POST · PATCH `/:id` | all · O · O | `{name, perKg}` → `SellingMarginComponent` | Only per-kg margins are defined |
| GET `/purchases` · GET `/:id` | all | → `Purchase[]` / `Purchase` (+ `revisionCount`) | Bounded by `limit`/`offset` |
| POST `/purchases` | all | see below → `Purchase` (201) | No stock; totals computed by the server; 409 duplicate bill per vendor; 422 inactive vendor/product/expense type, repeated mark |
| POST `/purchases/:id/receive` | all | `{expenses[], groups[]}` → `Purchase` (200) | Posts stock once; repeats return the received purchase; 422 on any blocking issue; 409 lot holds another product |
| GET `/cash-accounts` | all | → `CashAccount[]` `{id, name, kind}`; **Owner** also gets `openingBalance`, `openingDate` | Seeded |
| PUT `/cash-accounts/:id/opening` | O | `{openingBalance, openingDate}` → `CashAccount` | Real money at the start of that day; audited |
| GET `/cash-book?date=` | O | → `{date, accounts[{opening, received, paidOut, closing}], totals, entries[]}` | Closing of a day = next day's opening; past-dated entries readjust later days; cached 30 s, cleared on any write |
| GET `/collections/daily?date=` | all | → `{date, collected, byMethod[]}` | Receipts net of refunds; no balances |
| GET `/expense-categories` · POST | all | `{name, trackingCategory?}` → `ExpenseCategory` | POST of an existing name (any case) returns the existing row |
| GET `/expenses` · POST | all | `{categoryId, amount>0, date, paymentMethod, accountId, reference?, trackingCategory?, vendorId?}` → `Expense` | Staff may record any date. Owner/Manager list all; a salesperson lists their own. Category **Purchase Payments** = vendor payment: `vendorId` required; paying more than owed is an advance; `vendorId` on any other category is 422. Rows are immutable |
| PATCH `/purchases/:id` | all | bill fields + `reason` → `Purchase` | Correction. Before receipt anything; after receipt only rates and charges (422 for bags, weight, quality, vendor, product, lot). Previous version kept; a change-less edit records nothing |
| GET `/purchases/:id/revisions` | all | → `[{revisionNo, editedBy, editedByRole, reason, changes[{label, from, to}], before, after, createdAt}]` | Newest first |
| GET `/reports/differential` | O, M | → `DifferentialReport` (the lot breakdown) | Built on the server by the ported frontend functions; cached 60 s |
| GET `/reports` | O, M | → `{sales, payments, customers, vendors, lots, purchases}` | Snapshot the Reports screen computes from; sales/payments/purchases capped at the newest 5000 |
| GET `/audit` | O, M | → `AuditLog[]` newest first | |
| GET `/health`, `/health/ready` | public | → `{status}` | ready checks the database |

### POST /sales

The frontend already sends this (extra `Sale` fields are ignored):

```json
{
  "customerId": "uuid | '' for counter sale",
  "productId": "uuid",
  "items": [{ "lotNumber": "LOT AP", "markCode": "AA", "ratePerKg": 69,
              "bagWeights": [{ "bagNumber": 1, "weightKg": 50.5 }, { "bagNumber": 2, "weightKg": 50 }] }],
  "tenders": [{ "method": "CASH", "amount": 4000 }],
  "creditDays": 7,
  "notes": "",
  "totalAmount": 6999
}
```

Validation: 1–50 lines; 1–1000 bags per line; bag weight > 0, ≤ 500 kg, ≤ 3 decimals; rate > 0, ≤ ₹10,000/kg,
≤ 2 decimals; ≤ 10 tenders, amounts ≥ 0, ≤ 2 decimals. Business errors: 409 not enough stock / total changed;
422 counter sale with balance, missing credit terms, lot of another product. A `date` other than today returns the bill as
`PENDING_APPROVAL` (optional `dateReason`). Blocked or over-limit customers are not refused.

### POST /purchases and POST /purchases/:id/receive

```json
{ "billNumber": "PUR-2026-120", "vendorId": "uuid", "productId": "uuid", "date": "2026-10-25", "lotNumber": "25 OCT QP",
  "expectedArrivalDate": "2026-10-27", "receiptStatus": "PENDING_RECEIPT",
  "items": [{ "markCode": "AA", "bags": 100, "weightKg": 5200, "ratePerKg": 47 }],
  "expenses": [{ "expenseTypeId": "uuid | 'custom'", "expenseTypeName": "Scale", "amount": 1200 }] }
```

```json
{ "expenses": [{ "id": "rx1", "expenseTypeId": "uuid", "expenseTypeName": "Transport", "amount": 3200,
                 "allocation": { "method": "BY_RECEIVED_KG | BY_RECEIVED_BAGS | ASSIGN_TO_GROUP", "groupId": "…" } }],
  "groups": [{ "id": "<bill line id>", "markCode": "AA", "receivedBags": 99, "acceptedBags": 97, "defectiveBags": 2,
               "receivedWeightKg": 5150.5, "revisedSellingRate": null, "overrideReason": "", "bagWeights": [] }] }
```

A group whose `id` is a bill line takes mark, expected quantity and purchase rate from the bill; every bill line must appear (use 0
received if it did not arrive). A group with a new id is a quality not on the bill and must carry `originalPurchaseRate`.
Client totals, `vendorName` and similar fields are stripped. Errors: 400 shape, 404 vendor/product/purchase, 409 duplicate bill or product clash,
422 blocking receiving issue (message is the first issue).

## Not yet implemented (frontend calls return 404)

`/sales/:id/edit-requests` is superseded by `/sales/:id/rebill`. `POST /auth/role` and `POST /settings/reset` are demo-only and will not exist.

### GST on a bill (POST `/sales`, `/sales/:id/rebill`)

Optional `taxPercent` (0–100, 3 decimals) **or** `taxAmount` (₹, 2 decimals); both → 422. A percentage applies to product + Amali + market fee and is
rounded to the whole rupee, half up; an amount is kept as typed. `charges.taxPercent` / `charges.taxAmount` come back on the bill; the tax is part of
`totalAmount`, so the customer owes it (database check: `total = product + Amali + market fee + other + tax`).
