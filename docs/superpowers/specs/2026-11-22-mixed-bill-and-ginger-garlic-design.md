# Mixed bills, ginger and garlic stock, and customer balance printing

Date: 2026-11-22. Status: draft for owner approval.
Applies to both repos: backend `VedhaPremShop-BE` and frontend `vedhapremshop`.

## Intent

PKS (Punnari Kirana Store) sells onion, ginger and garlic. The owner wants:

1. A printed bill to show the customer's **total balance**, not only the balance of that one sale.
2. A recorded customer payment to print a receipt in the same style as the bill.
3. The customer ledger to print with dates, bills, payments and a running balance.
4. A customer who buys onion, ginger and garlic in one visit to get **one bill, one sale, one ledger entry**.
5. Ginger and garlic to carry **no hamali and no market fee**.
6. Ginger and garlic purchases to work like onion: several varieties, each with bags, weight and rate, kept as stock. **No fixed purchase expense types** (transport and so on). Expenses on these purchases are custom only.

## Goals

- One bill can hold lines from any product. Stock, ledger, payments and receipts treat it as a single sale.
- Hamali and market fee are charged only on onion lines. Existing rounding rules do not change.
- Ginger and garlic stock is counted in bags and weight per variety, like onion marks.
- All new printouts use the thermal 80mm style already built in `DigitalBill.tsx`.

## Non-goals

- No change to bills already stored. Old single-product bills keep working and keep their numbers.
- No costing, margin or selling-rate finalisation for ginger and garlic. The rate is typed on the bill.
- No settings screen for which products carry fees. A flag on the product is enough.
- No new accounting model. The ledger stays as it is.

## Anti-goals

- Do not split a mixed visit into several sales that are grouped later. The ledger must show one sale.
- Do not break onion billing, receiving, or reports to make room for the new products.

## Approaches considered

1. **Reuse the onion flow for all three products (chosen).** Ginger and garlic go through the same purchase, lot and per-bag weight flow, with the variety standing in for the onion mark. A sale line already points to a lot, and a lot already has a product, so a bill can mix products once the sale itself stops being tied to one. Smallest change, one stock system, one ledger.
2. A separate ginger/garlic module with its own tables. Leaves onion alone but needs two systems joined for a mixed bill, and reports would drift.
3. One sale per product, grouped under a printed bill. Easy on stock, but the ledger would hold several sales for one visit, which the owner ruled out.

## Design

### Part 1: Balance and ledger printing (frontend only, no data change)

- **Bill:** The Balance Due line shows the customer's balance after this bill, taken from the customer ledger (running balance after the last ledger entry for this sale). Add two lines: "Previous Balance" (balance before this bill) and "Total Balance Due". Paid-in-full text shows only when the total balance is zero. Reprinting an old bill shows the balance as it stood after that bill, not today's balance. This is my call: it keeps a reprint truthful.
- **Payment receipt:** A new thermal template printed after a customer payment is recorded, and reprintable from payment history. Shows customer name, ID, number, date, time, method(s) and amount, the bills it was applied to, and the balance after the payment.
- **Customer ledger print:** A new thermal template from the customer details page. Columns: date, reference, debit (bill), credit (paid), balance. Opening and closing balance at the ends. Optional date range, default all.
- All three reuse the iframe print path, the 66mm width, the PKS header and the Jai Shree Krishna footer. Common pieces move into shared components.

### Part 2: Mixed bills

- A sale line carries its own product (id and name snapshot). The sale header's single `productId` stays for old rows and becomes optional for new ones; `productName` becomes a summary such as "Onion, Ginger".
- Billing validates each line: the lot must belong to the line's product. Weight and bag checks are unchanged.
- Product gets a flag, "sale charges apply", default true. Ginger and garlic are created with it false. Hamali bag count and the market fee percent are computed only from lines whose product has the flag on. Rounding and "lift" rules are unchanged and run on the same totals as today.
- The new-sale screen lets the salesperson add lines from any product; the receipt lists lines as Onion 1, Onion 2, Ginger 1, Garlic 1 and so on, with no internal marks.
- Edit, rebill, cancel, approval and revision paths must handle multiple products. Reports that group by sale product move to the line's product.

### Part 3: Ginger and garlic purchases and stock

- A purchase stays one product with several varieties. Each variety becomes a lot mark: variety name, bags, total weight, purchase rate.
- Stock is posted when the purchase is saved. There is no receiving or evaluation step for these products. This is my call, because the owner asked only for variety, rate, weight and stock.
- Variety is free text and becomes the mark code. My call; it avoids pre-creating a master list.
- The purchase screen hides master expense types for these products and offers custom expense lines only (label and amount). The bill's net amount is goods plus those custom lines, as today.
- Per-bag weights are recorded at sale time, as for onion.

## Constraints

- Backend is NestJS with Prisma on Neon Postgres, deployed to production. Migrations must be additive and safe on existing rows.
- Existing bills, ledger entries and idempotency keys keep working.
- Frontend uses the existing query hooks and the `chargesForSale` snapshot; the snapshot must stay consistent with the backend.

## Order of work

1. Part 1 (printing). Independent and low risk.
2. Part 2 (mixed bills and no fees), with tests for charges on mixed bills.
3. Part 3 (ginger and garlic purchases).

Each part is built, tested and pushed on its own.

## Built (calls made while building)

- The sale header keeps a required `productId`: the first line's product. `productName` lists every product ("Onions, Garlic"). Each sale line also stores its own product, name and whether fees applied. This is smaller than making the header optional.
- One product flag, `appliesSaleCharges`, marks ginger and garlic as general goods. It switches off Amali and market fee on sales and also the receiving evaluation and fixed expense types on purchases.
- A general-goods purchase is saved as received: stock goes in at save, in the same transaction. A lot number that already holds another product returns 409 at save.
- Previous Balance on a bill is read from the customer ledger row just before that bill; Total Due is that plus the bill's own unpaid amount.
- The migration is additive and creates GINGER and GARLIC for every shop that lacks them. It must be applied (`npm run db:migrate`) before this backend is deployed.

## Left to the builder

- Exact migration for the product flag and the new line columns, including backfilling `productId` on existing sale items from their lots.
- Seeding ginger and garlic products for the existing organisation.
- Updating every report and query that reads the sale-level product.
- Payment receipt reprint entry points and screen placement.
