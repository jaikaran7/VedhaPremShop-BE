# Questions for the Owner (plain language)

Business in one line: we buy onions from a bigger distributor, keep them in lots, sell to retailers (cash or credit), collect money, and pay
the distributor. For each question below: **what it means**, **an example**, **what the system does today**, and **what I suggest**.
Answer with just the number and your choice, e.g. "1: yes, advance allowed".

Everything marked *today* is already built and working, so no question blocks you from using the system. Your answers only change small rules.

---

## A. Paying the bigger distributor (vendor)

**1. Can you pay a vendor more than you owe them (advance payment)?** *(was Q10)*
- Example: you owe Murade ₹1,00,000 but you pay ₹1,20,000 because next week's lot is coming.
- *Today:* the system refuses (it says "more than the ₹1,00,000 owed"), so the books never show a wrong "negative" amount.
- *Suggest:* if you really do this, say yes and I will show the extra ₹20,000 as "advance with vendor" and use it on the next bill, exactly like a retailer's advance.

**2. When you start using the system, do you already owe vendors money from old bills?** *(new)*
- Example: before today you owe Murade ₹2,50,000 from lots bought last month. Those bills are not in the system.
- *Today:* the system only counts bills entered here, so "amount we owe" starts at zero and cannot include old dues.
- *Suggest:* enter an "opening balance owed" for each vendor once (the same way retailers have an opening balance). Tell me the amounts, or tell me you will enter the old bills instead.

**3. Do you pay a vendor against a particular bill, or just "some money on account"?** *(new)*
- *Today:* just on account. We track "total bought" minus "total paid" per vendor. No bill-by-bill "paid / unpaid" tick.
- *Suggest:* keep it simple (on account) unless the vendor sends you statements bill by bill.

**4. If a vendor bill was entered wrongly (wrong rate or bags) or goods are sent back, how should it be corrected?** *(new, important)*
- *Today:* a saved purchase cannot be edited or deleted (like a printed bill). There is no "vendor return" yet.
- *Suggest:* "cancel and re-enter" for mistakes before the lot is received, and a "return to vendor" entry (reduces stock and the amount owed) after. Tell me if you want exactly this.

## B. Buying (purchases and receiving)

**5. Must every vendor bill have Scale, Term and Loading charges?** *(was Q11)*
- *Today:* the screen makes you fill all three (each above zero); the server does not insist.
- *Suggest:* keep it on the screen only, but allow ₹0 if a vendor really charges nothing. Say if it must be strict.

**6. Can a vendor bill be dated on a past day without approval?** *(was Q12)*
- Retailer bills dated on another day need your approval. Vendor bills have no such rule today.
- *Suggest:* same rule as sales (past-dated vendor bills wait for you) if staff other than you enter them.

**7. Are the weights you type per bag already net (after taking off the sack), or should the system subtract the sack weight?** *(new)*
- *Today:* the weight typed is the weight billed. No sack deduction anywhere.
- *Suggest:* keep as is if your weighing machine shows net onion weight.

## C. Selling and money

**8. When you (the Owner) post a bill dated another day, should it still wait for approval?** *(was Q13)*
- *Today:* your own back-dated bill goes through immediately (you are the approver). Staff bills wait for you.
- *Suggest:* keep it.

**9. Do you charge GST or any other tax on bills?** *(new)*
- *Today:* no tax is added. Bill = onion value + Amali + market fee. Fresh onions are normally GST-exempt, but please confirm for your trade.
- *Suggest:* leave as is if no tax is charged.

**10. Do customers ever return some bags after delivery?** *(was Q9)*
- *Today:* only whole-bill "cancel" or "edit bill" (cancel + rebill). No "return 3 of 20 bags" entry.
- *Suggest:* use edit bill for now; I can add a proper partial return if it happens often.

**11. Where should opening cash, bank and UPI balances come from?** *(new)*
- *Today:* all three accounts start at ₹0, so "account balance" = money received − money paid out since you began.
- *Suggest:* tell me today's real cash-in-hand, bank and UPI balances once, and I will set them as opening balances.

**12. Expenses: can staff record them, and can an expense be dated in the past?** *(was Q14)*
- *Today:* only Owner and Manager can record expenses; any date is accepted; an expense cannot be edited or deleted afterwards (a wrong one needs a correcting entry).
- *Suggest:* keep, and tell me if past-dated expenses should also wait for your approval.

## D. Reports and the wider business

**13. "Average floor rate" on the dashboard: simple average of all marks, or weighted by the kilograms you actually sold today?** *(was Q6)*
- Example: mark AA ₹55 (100 kg sold) and mark J ₹45 (900 kg sold): simple average ₹50, weighted ₹46.
- *Today:* simple average. *Suggest:* weighted, because it reflects what you really sold.

**14. Does your trading day end at midnight?** *(new)*
- *Today:* "today" means the Indian calendar day (12:00 am to 11:59 pm). A late-night mandi sale still counts for that date.
- *Suggest:* keep, unless your auction runs past midnight and you want it counted in the previous day.

**15. Will other distributors ever log in to their own books in this system?** *(was D9)*
- *Today:* other distributors are just names in your customer / vendor lists (one business can be both). They cannot log in.
- *Suggest:* keep it that way now. Shared books need a separate, careful design (who can see whose stock and money).

---

### Already decided by you (for reference)
Bills default to today but the date can change, and other days need Owner approval · staff can see the approval list but only the Owner decides ·
extra payment stays as customer advance · blocked or over-limit customers can still be billed, with a red warning · counter-sale cash is
collected under "Counter sales" · the cashier may sell below the floor rate · "edit bill" means cancel and re-bill with stock put back and re-taken.
