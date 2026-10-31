/**
 * Ground truth for the reference consignment: Ms. Pradip Shantaram Murade bill 00045 of
 * 22.10.2026 (two pages) and the handwritten mark sheet for KA56 3515. Transcribed by a person from the photos; used as
 * the mocked AI answer in tests and as the expected values when measuring real extraction accuracy (npm run scanner:eval).
 * The photos themselves (mark-sheet.webp, vendor-bill-p1.webp, vendor-bill-p2.webp) are git-ignored: they show the
 * vendor's bank details and the repository is public. Copy them into this folder to run the evaluation.
 */
import type { Field, MarkSheetOut, VendorBillOut } from '../../../src/modules/consignment-scans/extraction/extraction.schema';

const f = <T>(value: T, raw = String(value)): Field<T> => ({ value, raw, confidence: 'HIGH' });

/** [bags, weight kg, rate per 10 kg, amount ₹] exactly as printed, page 1 rows 1–30 then page 2 rows 1–23. */
export const BILL_ROWS: [number, number, number, number][] = [
  [8, 416, 420, 17472], [1, 53, 460, 2438], [1, 49, 460, 2254], [3, 156, 440, 6864], [3, 159, 470, 7473],
  [1, 48, 470, 2256], [1, 53, 460, 2438], [1, 48, 460, 2208], [3, 164, 460, 7544], [3, 151, 460, 6946],
  [1, 41, 450, 1845], [1, 49, 460, 2254], [42, 1986, 465, 92349], [34, 1741, 472, 82175.2], [26, 1271, 430, 54653],
  [26, 1279, 410, 52439], [11, 549, 420, 23058], [23, 1189, 450, 53505], [27, 1292, 435, 56202], [72, 3502, 435, 152337],
  [45, 2202, 450, 99090], [18, 879, 445, 39115.5], [60, 2923, 445, 130073.5], [2, 94, 280, 2632], [1, 48, 280, 1344],
  [3, 139, 280, 3892], [3, 156, 280, 4368], [1, 47, 280, 1316], [2, 102, 290, 2958], [3, 155, 270, 4185],
  [2, 99, 290, 2871], [3, 159, 305, 4849.5], [2, 100, 320, 3200], [6, 284, 310, 8804], [3, 140, 310, 4340],
  [1, 53, 280, 1484], [5, 242, 300, 7260], [1, 50, 300, 1500], [3, 140, 330, 4620], [1, 47, 380, 1786],
  [3, 150, 300, 4500], [1, 48, 280, 1344], [1, 53, 330, 1749], [8, 424, 300, 12720], [2, 96, 300, 2880],
  [2, 94, 300, 2820], [2, 96, 300, 2880], [5, 229, 300, 6870], [20, 955, 330, 31515], [3, 149, 310, 4619],
  [2, 100, 300, 3000], [3, 155, 380, 5890], [8, 393, 470, 18471],
];
export const PAGE_ONE_ROWS = 30;

/** [bags, rate min, rate max, mark, side] as written on the sheet. */
export const SHEET_ROWS: [number, number, number, string, 'LEFT' | 'RIGHT'][] = [
  [35, 460, 470, 'OK', 'LEFT'], [34, 472, 472, 'K', 'LEFT'], [26, 410, 410, 'N', 'LEFT'], [11, 420, 420, 'KK', 'LEFT'],
  [27, 435, 435, '27', 'LEFT'], [45, 450, 450, 'H', 'LEFT'], [6, 310, 310, 'AB', 'LEFT'], [8, 300, 300, 'PB', 'LEFT'],
  [5, 300, 300, 'HB', 'LEFT'], [42, 465, 465, 'A', 'RIGHT'], [26, 430, 430, '26', 'RIGHT'], [72, 435, 435, 'P', 'RIGHT'],
  [23, 450, 450, 'S', 'RIGHT'], [60, 445, 445, 'M', 'RIGHT'], [18, 445, 445, '18', 'RIGHT'], [20, 330, 330, 'KB', 'RIGHT'],
  [5, 300, 300, 'EG', 'RIGHT'], [50, 280, 310, 'BK', 'RIGHT'],
];

export const BILL_EXPENSES: [string, VendorBillOut['expenses'][number]['category'], number][] = [
  ['Hamali', 'HAMALI', 4104], ['M/Ses', 'MARKET_FEE', 11105.4], ['Commission', 'COMMISSION', 63459.5], ['Levy', 'LEVY', 923.4], ['Driver Advance', 'DRIVER_ADVANCE', 5000],
];

export const REFERENCE_BILL: VendorBillOut = {
  vendorName: f('Ms. Pradip Shantaram Murade'),
  buyerName: f('SHRI VEDAMATHA ENTERPRISES'),
  billNumber: f('00045'),
  billDate: f('2026-10-22', '22.10.2026'),
  lines: BILL_ROWS.map(([bags, kg, rate, amount], i) => ({
    page: i < PAGE_ONE_ROWS ? 1 : 2, row: i < PAGE_ONE_ROWS ? i + 1 : i - PAGE_ONE_ROWS + 1,
    itemName: f('ONION'), bags: f(bags), weightKg: f(kg), rate: f(rate), amount: f(amount, amount.toFixed(2)),
  })),
  expenses: BILL_EXPENSES.map(([label, category, amount]) => ({ label, category, amount: f(amount, amount.toFixed(2)) })),
  totals: { bags: f(513), weightKg: f(25197), goodsTotal: f(1057656.7, '1057656.70'), totalExpenses: f(84592.3, '84592.30'), totalAmount: f(1142249, '1142249.00') },
};

export const REFERENCE_SHEET: MarkSheetOut = {
  date: f('2026-10-22', '22/10/2026'),
  lotRef: f('KA56 3515'),
  totalBags: f(513),
  marks: SHEET_ROWS.map(([bags, min, max, mark, side], i) => ({
    page: 1, row: side === 'LEFT' ? i + 1 : i - 8, side, bags: f(bags), rateMin: f(min), rateMax: f(max, min === max ? String(max) : `${min}-${max}`), mark: f(mark),
  })),
};
