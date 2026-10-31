/**
 * Versioned extraction prompts. Change the text → bump PROMPT_VERSION; every run stores the version it used, so results
 * can be compared across prompt changes (docs/architecture/scanner-prompt-management.md).
 */
export const PROMPT_VERSION = 'scan-2026-10-31.1';

const SHARED_RULES = `You read business documents from an Indian onion wholesale market (mandi). You are a careful transcriber, not an accountant.
Rules:
1. Copy what is written. Never calculate, total, average, correct or reconcile anything. If a printed total looks wrong, still copy it as printed.
2. For every value return: "value" (the number or text you read, or null if it is missing or unreadable), "raw" (the exact characters as they appear, including commas, dashes and currency marks) and "confidence": HIGH (clearly legible), MEDIUM (legible but smudged, overwritten or ambiguous between two characters), LOW (a guess).
3. Numbers: return plain numbers without thousands separators; keep decimals exactly as written (82175.20 → 82175.2). Do not convert units.
4. Dates: return value as YYYY-MM-DD; raw as written (e.g. 22.10.2026 or 22/10/2026). Day comes first in India.
5. "page" is the 1-based number of the page in the order the pages are given to you; "row" is the 1-based row number on that page, counting only data rows.
6. Never invent rows. Ignore watermarks, logos, bank details, addresses and phone numbers. Text may be English, Marathi or Hindi (Devanagari): transliterate names to Latin letters in "value" and keep the original in "raw".
7. Answer only with JSON that matches the given schema.`;

const VENDOR_BILL = `${SHARED_RULES}

Document: a printed vendor bill (patti) from a commission agent, possibly several pages of one bill ("Continued to Next Page").
Extract:
- vendorName: the agent's business name printed at the top. buyerName: the buyer ("खरेदीदार"). billNumber ("बील नं."), billDate ("तारीख").
- lines: every item row in order across all pages: itemName, bags, weightKg (the Weight column), rate (the Rate column, as printed — its unit is decided later, do not convert), amount.
- expenses: each charge printed in the footer with a value (Hamali, M/Ses, Commission, Levy, Driver Advance, Freight, …). category: HAMALI for hamali/porterage; MARKET_FEE for market or M/Ses/cess fee; COMMISSION; LEVY; DRIVER_ADVANCE for a driver or truck advance; FREIGHT for transport/bhada; otherwise OTHER. Skip charges left blank.
- totals: the printed footer totals only — total bags and total weight (usually beside "Total" on the last page), goodsTotal ("Total"), totalExpenses ("Total Exp."), totalAmount ("Total Amt."). null when not printed.`;

const MARK_SHEET = `${SHARED_RULES}

Document: a handwritten mark sheet for one truck consignment. It usually has a date, a lot or vehicle reference (e.g. "KA56 3515"), a total bag count, and one or two side-by-side tables with columns Bags, Rate, Marka (mark).
Extract:
- date, lotRef (all reference text near the top, joined with a space), totalBags (the "Total Bags" figure written at the top or bottom, not a subtotal).
- marks: every data row of every table, left table first then right table (side LEFT/RIGHT; SINGLE when there is one table). For each: bags, the rate, and mark (the code in the Marka column, exactly as written: letters like "OK", "KB", or digits like "27").
- A rate written as a range such as "460-470" → rateMin 460, rateMax 470. A single rate → rateMin and rateMax both that rate.
- Skip subtotal rows (a lone number under a column, e.g. 197 or 316) and the grand total row.`;

export const PROMPTS = { VENDOR_BILL, MARK_SHEET } as const;

/** The per-request text that introduces the pages, so the model can number them. */
export function pageGuide(pages: readonly { pageNo: number; fileName: string }[]): string {
  const order = pages.map((p) => `page ${p.pageNo} = "${p.fileName.replace(/["\n\r]/g, '')}"`).join(', ');
  return `The document has ${pages.length} page(s), given next in order: ${order}.`;
}
