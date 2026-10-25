# Owner's Answers and What Is Still Open

Plain language. Part 1 records what you decided and where it now lives in the system. Part 2 is the short list of things I had to
interpret or choose; please confirm or correct them.

---

## Part 1 — Your answers, and what was built

| # | Your answer | What the system does now |
|---|---|---|
| 1 | Paying a vendor more than owed is an **advance with the vendor**; the next bill uses it automatically. | Vendor screens show *Advance with vendor*. Paying more than is owed is accepted; the next bill takes the advance first. Example: owe ₹1,00,000, pay ₹1,20,000 → advance ₹20,000; next bill ₹50,000 → you owe ₹30,000. |
| 2 | **Opening balance per vendor**, and show the **previous due and the new due**. | The Owner enters "owed before the system" on the vendor form (a minus amount means you had already paid ahead). Vendor list and details show **Previous Due**, **New Due**, **Payable** and **Advance**. Payments clear the previous due first, then the oldest bills. |
| 3 | Vendor account is **account based**, but also show each bill's amount. | Vendor → *Account Statement*: every bill with how much of it is paid, balance and status (Paid / Partly paid / Unpaid), and every payment made. |
| 4 | Mistakes in a vendor bill: it must be **editable by staff and the Owner**, with the **previous and current** values visible. | **Correct Bill** button on every vendor bill (Owner, Manager, Salesperson). Before the lot is received anything can change. After it is received, rates, charges, bill number, date and notes can change but not what physically arrived (use a stock adjustment for that). Every correction is kept: who, when, why, and each field as **Previous → Current**. The amount owed follows the correction. |
| 5 | Scale / Term / Loading are **not mandatory**; any charge is optional. | Charges are optional; a charge left at ₹0 is not saved. A bill with no charges is fine. |
| 6 | Past-dated **vendor bills need no approval**. | Any date, no approval, for any staff member. |
| 7 | Only **one weight** (no gross/net). | Unchanged: the weight typed is the weight billed. No sack deduction anywhere. |
| 8 | GST: **optional**, a percentage **or** a typed amount, added to the total. | New Sale has an optional *GST / Tax* box: "% of bill" or "₹ amount". The tax is added to the bill total, shown on the summary and printed bill, and the customer owes it. |
| 9 | Customers rarely return bags; give **edit bill** and **cancel bill**, and put stock and money back. | Already built earlier (cancel / edit bill = cancel and re-bill): stock returns, money received becomes the customer's credit (counter sales are refunded), and the new bill takes the stock again. Nothing new needed. |
| 10 | Accounts must start from **today's real cash**, and each day's closing carries to the next day; **only the Owner sees it**; salespeople see only the **cash collected that day**. | Settings → *Cash & Bank Openings* (Owner). *Daily Cash Book* report: per account opening + money in − money out = closing, and closing is the next day's opening. Salespeople see "Cash collected" for the day on their home screen and the Daily Cash Book shows them only collections. Manager sees no balances either. |
| 11 | Staff can **record expenses, including for past days**, and balances must **readjust** automatically. | Salesperson and Manager can record expenses (a salesperson sees only their own). A past-dated expense moves that day's closing and every later day's opening by itself (nothing is stored per day, so nothing can go out of step). |
| 12 | **Average floor rate:** keep the current method; "give me a clear idea of what it is". | See Part 2, point 5. |
| 13 | Trading day ends in the afternoon; **use IST**; at day end the **closing balance** is what matters. | Days are Indian calendar days. The closing balance of each day is shown in the Daily Cash Book. |
| 14 | Other distributors **never log in**. | Unchanged: they are just names in your customer / vendor lists. |

Also done as you asked: the backend does the lot breakdown (landed cost, cost of goods, profit, differences) using the same formulas the
screens used (the frontend's own tests run unchanged against the server copy); stock movements are filtered and paged in the database;
screens no longer re-fetch everything on every visit; and tests prove that **the number of database queries does not grow as you add
sales, bills, payments, expenses or vendors** (no N+1). No Redis: a small in-memory cache per business, cleared the moment anything is saved.

---

## Part 2 — Please confirm

**1. Past-dated sales bills — decided (session 6): no approval for staff.**
A sales bill dated another day posts at once for anyone (stock, balance and any payment on that date). The Owner's approval is kept only for
**cancel** and **edit bill** requests. Nothing to confirm.

**2. Staff now see vendor bill amounts and the costing rates.**
To enter, correct and receive vendor bills, a salesperson must see the rates on those bills and the costing settings (default margin, extra
margins). They still do **not** see what we owe vendors, vendor accounts, profit, or cash balances. Is that acceptable?

**3. GST is worked out on the whole invoice (onions + Amali + market fee) and rounded to the whole rupee**
when you enter a percentage. Example: 5% of ₹10,509 = ₹525.45 → ₹525. A typed amount is kept exactly. Is that how you want it?

**4. Money recorded for a day before an account's opening date is ignored in the balance.**
Example: you set Cash in Hand = ₹10,000 from 20 Oct. A cash expense dated 19 Oct is saved, but does not change the balance (your ₹10,000 already
reflects it). Is that right?

**5. What is the "Average Floor Rate"?** (you asked for a clear idea)
The *floor rate* is the lowest rate per kg you let the counter sell each quality (mark) for; you set it daily in Settings → Daily Floor Rates.
The *average* is meant to be one number summarising today's rates. Today's seed rates: AA ₹69, J ₹64, K ₹58, OK ₹49, CV ₹71, TC ₹61.
- **Simple average** = add the six rates and divide by 6 = **₹62.00**. Treats a quality you hold 50 kg of the same as one you hold 8,000 kg of.
- **Weighted by stock** = each rate counted in proportion to the kilograms in the yard = **₹63.70**. Closer to what your stock is worth per kg.
- **Weighted by sales** = each rate counted by the kilograms sold today. Shows what you actually sold at.
**What is on the dashboard right now is neither: the text "₹69.00 / KG, Top Mark AA" is typed into the screen and never changes.** Tell me which
of the three you want (I would suggest weighted by stock) and I will make it real. Until then I left it as it was, as you asked.

**6. Wrongly entered vendor bill that should not exist at all.**
A bill can be corrected but not deleted (money history is never deleted). If a bill was entered twice, the usual fix is to correct one to the
right values. Do you also want a "Cancel bill" for an unreceived vendor bill, and a "Return to vendor" for goods sent back after receiving?

**7. The Manager does not see account balances either.** Only the Owner does, as you said. The Manager still sees expenses, collections and vendor accounts.
