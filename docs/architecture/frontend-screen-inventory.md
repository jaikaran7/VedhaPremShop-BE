# Frontend Screen Inventory

Source: `jaikaran7/vedhapremshop` @ `9b27bf1` (branch `badri-fe`), inspected file by file, plus the four
deployed-app screenshots (owner dashboard, sales list, customers, README).

## How the frontend talks to data today

| Concern | Where | Evidence |
|---|---|---|
| Stack | Next.js 15.5 App Router, React 18.3, TS 5.7 strict, Tailwind 3.4, Radix/shadcn, TanStack Query 5.83, react-hook-form 7.62, recharts 2.15 | `package.json` |
| Routes | `src/app/**/page.page.tsx` (custom `pageExtensions`), each renders one screen from `src/pages/**` | `next.config.ts` |
| API switch | `NEXT_PUBLIC_API_BASE_URL` empty ⇒ every `src/api/*.api.ts` function calls `mockRepository` (localStorage) | `src/config/env.ts`, `src/api/*.ts` |
| HTTP client | `apiClient(path)` = `fetch(base + path)`, JSON, throws `ApiError(status)` | `src/api/client.ts` |
| Cache | One key per collection (`queryKeys`), **every mutation invalidates every query** | `src/hooks/queries/keys.ts`, `src/hooks/mutations/invalidate.ts` |
| Session | Persona picker; user stored in localStorage; no password check | `src/store/session/session-provider.tsx`, `Login.tsx` |
| Permissions | `can(role, permission)` — UI only | `src/auth/permissions.ts` |
| Business rules | Pure functions in `src/utils/*` (sale charges, settlement, costing, receiving, collections, reports) — 9 unit-test files | `src/utils/*.test.ts` |
| Business date | Hard-coded `TRADING_SESSION_DATE = '2026-10-01'` used for new bills and dashboards | `src/constants/session.ts` |

Contract style: **unpaginated arrays of the exact TS types in `src/types/index.ts`**. The backend keeps
that shape so screens do not change.

## Screens

Roles: O = Owner, M = Manager, S = Salesperson. Sidebar: O/M get the management nav; S gets
Home, New Sale, Today's Sales, Customers, Bills, Payment Receipts (`Sidebar.tsx`).

### Auth

| Route | Screen | Purpose / fields | Data | Mutations | Endpoints |
|---|---|---|---|---|---|
| `/login` | `Auth/Login` | username, password, persona chips (demo) | `useUsersQuery` (persona list) | none (sets local user) | `POST /auth/login`, `GET /auth/me` |
| `/change-password` | `Auth/ChangePassword` | current, new, confirm | — | none wired | `POST /auth/change-password` |
| `/forgot-password`, `/reset-password` | `Auth/*` | email / new password | — | none wired | **Unresolved** — no email provider; admin reset instead |
| `/profile` | `Auth/UserProfile` | shows session user + company | `useCompanyQuery` | — | `GET /auth/me`, `GET /settings/company` |

### Dashboards

| Route | Screen | Displays | Source hooks | Endpoints |
|---|---|---|---|---|
| `/dashboard/owner` (O) | `OwnerDashboard` | Today's revenue (₹ + bags + kg, Δ vs yesterday), today's collections (+ receipt count), total receivables (+ customer count, high-balance count), stock in mandi (bags, MT, active lots), credit sales today (% of volume), lots completed / in progress, average floor rate (top mark), weekly sales vs collections chart, stock by mark | customers, lots, marks, payments, sales | list endpoints (Phase 3–6); `GET /dashboard/owner` (Phase 8) |
| `/dashboard/manager` (M) | `ManagerDashboard` | lots, pending receipts | lots, purchases | `/lots`, `/purchases` |
| `/salesperson-home` (S) | `SalespersonHome` | today's own bills, marks/rates, customers | customers, marks, sales | `/customers`, `/settings/marks`, `/sales` |

All dashboard metrics are computed in the browser from full lists today. Metric definitions: `business-domain.md §Metrics`.

### Sales

| Route | Screen | Fields / table | Actions | Statuses | Endpoints |
|---|---|---|---|---|---|
| `/sales/new` (all) | `NewSaleWorkflow` (+ `CustomerSearch`, `PaymentSettlement`, `InvoiceChargeSummary`) | customer *or* counter sale; product; per line: lot, mark, rate ₹/kg (editable, prefilled from finalized lot rate → mark floor rate), bag weights (one entry per bag); notes. Steps entry → review → settlement. Settlement: Paid in full / Partial / Credit, single or split tenders (CASH, UPI, QR, BANK_TRANSFER, CARD, OTHER), credit days (0/7/15/30/customer default) | add customer inline, add line, edit/delete bag, confirm sale → `/sales/:id/bill` | sale `CONFIRMED` | `POST /sales` |
| `/sales` | `SalesList` | bill no, date/time, payment type chip, status chip, customer, bags, kg, marks summary, billed by, revenue, due; search by bill/customer; payment-type filter | open bill, print | CONFIRMED, PENDING_APPROVAL, CANCELLED | `GET /sales` |
| `/sales/todays` | `TodaysSales` | today's bills, totals, dispatch | — | — | `GET /sales` |
| `/sales/:id` | `SaleDetails` | header, lines with bag weights, charges, tenders, balance | note correction, request edit (S) | — | `GET /sales/:id`, `POST /sales/:id/corrections`, `POST /sales/:id/edit-requests` |
| `/sales/:id/bill` | `DigitalBill` | printable invoice + 80 mm receipt | print | — | `GET /sales/:id`, `GET /settings/company` |

Visible validation (`NewSaleWorkflow.tsx:470-503`, `settlement.ts:resolveSettlement`): product required;
≥1 bag; every line has lot + mark + rate > 0; per lot/mark Σbags ≤ remaining bags and Σkg ≤ remaining kg + 0.0001;
lot awaiting receipt cannot be sold; partial amount > 0, < bill, ≤ bill; method required for any amount;
split total ≤ bill; credit terms required when balance > 0; counter sale has no credit account.
Over-credit-limit is shown as a warning only (`isOverCreditLimit`).

### Customers and receivables

| Route | Screen | Fields / table | Actions | Endpoints |
|---|---|---|---|---|
| `/customers` | `CustomerList` | code, name, status chip, location, phone, terms, outstanding bar vs limit, % used; search; status filter; sort (highest outstanding…) | Add, Pay, Sale, Ledger, Edit, Delete | `GET/POST /customers`, `PATCH/DELETE /customers/:id` |
| modal | `CustomerFormModal` | kind REGULAR (walk-in) / WHOLESALE; name (required); phone; email; address; market location; credit limit, credit days (edit only; new customers start at 0/0) | save | same |
| `/customers/:id`, `/customers/:id/ledger` | `CustomerDetails` | profile, KPIs, statement (date, type, ref, debit, credit, running balance), invoices, receipts | Pay, Sale | `GET /customers`, `GET /customers/ledger`, `GET /sales`, `GET /payments` |
| `/payments/outstanding` | `CustomerOutstandingList` | outstanding by customer | Pay | `GET /customers` |

Customer statuses: `ACTIVE`, `BLOCKED`, `PENDING`.

### Payments, collections, expenses

| Route | Screen | Fields | Endpoints |
|---|---|---|---|
| `/payments` | `PaymentHistory` | receipts table, category totals, cash/bank accounts | `GET /payments`, `GET /expenses`, `GET /cash-accounts`, `GET /expense-categories` |
| `/payments/new` | `PaymentEntry` | customer (with due), amount > 0, method, reference, notes; shows new balance `max(0, due - amount)` | `POST /payments` |
| `/payments/receipt`, `/payments/receipt/:id` | `PaymentReceipt` | printable receipt incl. previous/new outstanding | `GET /payments` |
| `/payments/collections/:category` | `CollectionCategory` | collections per category (Onion, Amali, Other product, Market fee, Other) — computed in browser by `resolveAllocations` | `GET /payments`, `GET /sales` |
| `/payments/expense` | `RecordExpense` | category, amount, date, method, account, reference | `POST /expenses`, `POST /expense-categories` |

### Purchases, lots, stock, vendors

| Route | Screen | Fields / actions | Endpoints |
|---|---|---|---|
| `/purchases` | `PurchaseList` | bills, vendor, lot, gross/expenses/net, receipt status | `GET /purchases` |
| `/purchases/new` | `NewPurchase` | vendor, product, bill no, date, lot number, items (mark, bags, kg, ₹/kg), expenses (typed master), notes, attachment | `POST /purchases` |
| `/purchases/:id` | `PurchaseDetails` | bill detail, linked lot | `GET /purchases/:id` |
| `/purchases/:id/receive` | `ReceiveLot` | per-mark groups: received/accepted/defective bags & kg, bag weights, receiving expenses with allocation (by kg/bags/group), landed cost, calculated & revised selling rate + reason | `POST /purchases/:id/receive` |
| `/lots`, `/lots/:id` | `LotList`, `LotDetails` | lot, product, vendor, arrival, status, per-mark initial/remaining bags & kg, purchase rate (O/M), finalized selling rate; movement history | `GET /lots`, `GET /lots/:id`, `GET /stock/movements` |
| `/stock` | `StockOverview` | stock by mark/lot, movement ledger (type, ref, lot, mark, ±bags, ±kg, reason, by); adjustment form (lot, mark, ADD/REDUCE, bags, kg, reason); opening stock form | `GET /stock/movements`, `POST /stock/adjustments`, `POST /stock/opening` |
| `/vendors`, `/vendors/:id` | `VendorList`, `VendorDetails`, `VendorFormModal` | code, name, city, phone, total purchases, payable; add/edit | `GET/POST /vendors`, `PATCH /vendors/:id` |

### Management

| Route | Screen | Endpoints |
|---|---|---|
| `/approvals`, `/approvals/:id` | `ApprovalsHub` — pending/approved/rejected requests (sale edits, stock adjustment, credit), approve/reject with notes; sidebar badge | `GET /approvals`, `POST /approvals/:id` |
| `/audit` | `AuditHistory` — timestamp, user, role, action, entity, details | `GET /audit` |
| `/reports`, `/reports/:type`, `/reports/lot/:id` | `ReportsHub` (total sales, outstanding, stock, cash book, differential, opening balances, customer statement), `LotDifferentialDetail` — all computed in browser from one snapshot | `GET /reports` |
| `/settings` (O) | `SettingsHub` + `CostingSettingsPanel` — company profile, sale charges (Amali ₹/bag, market fee ₹/bag, toggles), marks (code, name, default selling/purchase rate, grade), products, costing (default margin ₹/kg, expense types, margin components), users list, reset demo | `/settings/*`, `GET /users` |

## API-to-UI mapping

| Endpoint | Consumed by (hook → screens) | Phase |
|---|---|---|
| `POST /auth/login`, `POST /auth/logout`, `POST /auth/refresh`, `GET /auth/me`, `POST /auth/change-password` | `Login`, `Header` (logout), `SessionProvider`, `ChangePassword` | 2 ✅ |
| `GET /users`, `POST /users`, `PATCH /users/:id` | `useUsersQuery` → `SettingsHub` | 2 ✅ |
| `GET/PUT /settings/company` | `useCompanyQuery` → `Header`, `DigitalBill`, `PaymentReceipt`, `UserProfile`, `SettingsHub` | 3 ✅ |
| `GET/PUT /settings/sale-charges` | `useSaleChargeSettingsQuery` → `NewSaleWorkflow`, `SettingsHub` | 3 ✅ |
| `GET/POST /settings/marks`, `PATCH /settings/marks/:id` | `useMarksQuery` → New Sale, dashboards, Stock, Settings | 3 ✅ |
| `GET/POST /settings/products`, `PATCH /settings/products/:id` | `useProductsQuery` → New Sale, Lots, Purchases | 3 ✅ |
| `GET/POST /customers`, `GET/PATCH/DELETE /customers/:id` | `useCustomersQuery`, `useCustomerQuery`, customer mutations | 3 ✅ |
| `GET /customers/ledger` | `useLedgerQuery` → `CustomerDetails` | 3 ✅ |
| `GET/POST /vendors`, `GET/PATCH /vendors/:id` | vendor hooks → Vendors, New Purchase | 3 ✅ |
| `GET /lots`, `GET /lots/:id` | `useLotsQuery` → New Sale, Lots, Stock, dashboards | 4 ✅ |
| `GET /stock/movements`, `POST /stock/adjustments`, `POST /stock/opening` | `useStockQuery`, stock mutations → Stock, Lot details | 4 ✅ |
| `GET/POST /sales`, `GET /sales/:id`, `POST /sales/:id/cancel`, `POST /sales/:id/corrections` | sales hooks → New Sale, Sales list, Bill, Today's | 5 ✅ |
| `GET/POST /payments`, `GET /payments/:id` | payment hooks → Payments, receipts, customer details | 6 ✅ |
| `GET /audit` | `useAuditQuery` → Audit | 2 ✅ |
| `POST /sales/:id/edit-requests`, `GET /approvals`, `POST /approvals/:id` | approvals | later |
| `GET /expenses`, `POST /expenses`, `GET /cash-accounts`, `GET/POST /expense-categories` | collections & expenses | later |
| `GET/POST /purchases`, `GET /purchases/:id`, `POST /purchases/:id/receive`, `/settings/costing*` | purchases & receiving | 7 |
| `GET /reports`, `GET /dashboard/*` | reports, dashboards | 8 |
| `POST /auth/role`, `POST /settings/reset` | persona switch, demo reset | **not implemented** — demo-only behaviour |

## Unresolved / not inferable from code

1. Forgot/reset password: no email/SMS channel exists. Proposed: owner resets a user's password.
2. Approval workflow for sale edits: the mock rewrites `totalAmount` without touching stock or bag lines.
   That cannot be made consistent; needs a business decision (see `business-domain.md` Q5).
3. Report screens need a server snapshot or server aggregates; the mock returns every table.
</content>
</invoke>
