/** Shared by the scan services: what is loaded for a scan, how it feeds the reconciliation, and the API view. */
import { fromDbDate } from '../../common/dates';
import { fromGrams, fromPaise } from '../../common/money';
import type { Prisma } from '../../generated/prisma/client';
import { lotCodeFromNumber } from '../purchases/lot-mark';
import { type LineMatch, reconcile, type Reconciliation, type ReconcileInput } from './reconciliation.calc';
import { signedFilePath } from './scan-file-links';

export const SCAN_INCLUDE = {
  vendorParty: { select: { name: true } },
  product: { select: { name: true } },
  documents: { orderBy: [{ kind: 'asc' }, { pageNo: 'asc' }], select: { id: true, kind: true, pageNo: true, fileName: true, mimeType: true, sizeBytes: true, createdAt: true } },
  runs: {
    orderBy: { startedAt: 'desc' }, take: 10,
    select: { id: true, job: true, status: true, stage: true, model: true, promptVersion: true, attempts: true, inputTokens: true, outputTokens: true, latencyMs: true, error: true, startedAt: true, finishedAt: true },
  },
  billLines: { orderBy: { position: 'asc' } },
  marks: { orderBy: { position: 'asc' } },
  expenses: { orderBy: { position: 'asc' } },
} as const satisfies Prisma.ConsignmentScanInclude;

export type ScanRow = Prisma.ConsignmentScanGetPayload<{ include: typeof SCAN_INCLUDE }>;
type ScanFields = Pick<ScanRow, 'vendorPartyId' | 'productId' | 'lotNumber' | 'billNumber' | 'billDate' | 'sheetDate' | 'rateUnit' | 'printedBillBags' | 'printedBillGrams' | 'printedGrossPaise' | 'printedExpensesPaise' | 'printedNetPaise' | 'printedSheetBags'>;
type Rows = Pick<ScanRow, 'billLines' | 'marks' | 'expenses'>;

const n = (value: bigint | number | null): number | null => (value === null ? null : Number(value));
const date = (value: Date | null): string | null => (value ? fromDbDate(value) : null);

export function calcInput(scan: ScanFields & Rows): ReconcileInput {
  return {
    header: {
      vendorPartyId: scan.vendorPartyId, productId: scan.productId, lotNumber: scan.lotNumber, billNumber: scan.billNumber,
      billDate: date(scan.billDate), sheetDate: date(scan.sheetDate),
      printedBillBags: scan.printedBillBags, printedBillGrams: n(scan.printedBillGrams), printedGrossPaise: n(scan.printedGrossPaise),
      printedExpensesPaise: n(scan.printedExpensesPaise), printedNetPaise: n(scan.printedNetPaise), printedSheetBags: scan.printedSheetBags,
    },
    rateUnit: scan.rateUnit,
    lines: scan.billLines.map((l) => ({
      id: l.id, position: l.position, bags: l.bags, grams: Number(l.grams), ratePaise: Number(l.ratePaise), amountPaise: Number(l.amountPaise),
      assignedMarkId: l.assignedMarkId, needsReview: l.confidence === 'LOW' && !l.corrected,
    })),
    marks: scan.marks.map((m) => ({
      id: m.id, position: m.position, markCode: m.markCode, bags: m.bags, rateMinPaise: Number(m.rateMinPaise), rateMaxPaise: Number(m.rateMaxPaise),
      needsReview: m.confidence === 'LOW' && !m.corrected,
    })),
    expenses: scan.expenses.map((e) => ({ id: e.id, label: e.label, category: e.category, amountPaise: Number(e.amountPaise), includeInCost: e.includeInCost })),
  };
}

export function reconcileScan(scan: ScanFields & Rows): Reconciliation {
  return reconcile(calcInput(scan), lotCodeFromNumber(scan.lotNumber ?? '').length);
}

/** Where a line's mark came from: a person, an automatic rule, or nothing yet. */
function provenance(match: LineMatch | undefined): string {
  if (match?.method === 'MANUAL') return 'CORRECTED';
  if (match?.method) return 'MATCHED';
  return 'UNRESOLVED';
}

const rupeeView = (s: Reconciliation) => ({
  canConfirm: s.canConfirm,
  issues: s.issues,
  rateUnitEvidence: s.rateUnitEvidence,
  roundingDifference: fromPaise(s.roundingDifferencePaise),
  totals: {
    lineBags: s.totals.lineBags, markBags: s.totals.markBags, lineWeightKg: fromGrams(s.totals.lineGrams), linesAmount: fromPaise(s.totals.linesAmountPaise),
    expenses: fromPaise(s.totals.expensesPaise), net: fromPaise(s.totals.netPaise), costExpenses: fromPaise(s.totals.costExpensesPaise),
  },
  marks: s.marks.map((m) => ({ markId: m.markId, markCode: m.markCode, expectedBags: m.expectedBags, matchedBags: m.matchedBags, weightKg: fromGrams(m.grams), amount: fromPaise(m.amountPaise), rates: m.ratesPaise.map(fromPaise), status: m.status })),
  purchaseLines: s.purchaseLines.map((l) => ({ markCode: l.markCode, bags: l.bags, weightKg: fromGrams(l.grams), printedRate: fromPaise(l.printedRatePaise), ratePerKg: fromPaise(l.ratePerKgPaise), vendorAmount: fromPaise(l.vendorAmountPaise), lineIds: l.lineIds })),
});

/** The API shape: rupees and kg (as the frontend uses everywhere), with each value's source and the reconciliation. */
export function scanView(scan: ScanRow, secret: string, nowSeconds: number) {
  const result = reconcileScan(scan);
  const matches = new Map(result.matches.map((m) => [m.lineId, m]));
  return {
    id: scan.id, status: scan.status, version: scan.version,
    vendorId: scan.vendorPartyId, vendorName: scan.vendorParty?.name ?? null, productId: scan.productId, productName: scan.product?.name ?? null,
    lotNumber: scan.lotNumber, rateUnit: scan.rateUnit, billNumber: scan.billNumber, billDate: date(scan.billDate), sheetDate: date(scan.sheetDate),
    vendorNameText: scan.vendorNameText, buyerNameText: scan.buyerNameText, lotRefText: scan.lotRefText,
    printed: {
      billBags: scan.printedBillBags, billWeightKg: scan.printedBillGrams === null ? null : fromGrams(Number(scan.printedBillGrams)),
      grossAmount: scan.printedGrossPaise === null ? null : fromPaise(Number(scan.printedGrossPaise)),
      expensesAmount: scan.printedExpensesPaise === null ? null : fromPaise(Number(scan.printedExpensesPaise)),
      netAmount: scan.printedNetPaise === null ? null : fromPaise(Number(scan.printedNetPaise)), sheetBags: scan.printedSheetBags,
    },
    headerEvidence: scan.headerEvidence,
    purchaseId: scan.purchaseId, confirmedBy: scan.confirmedByName, confirmedAt: scan.confirmedAt?.toISOString() ?? null,
    createdBy: scan.createdByName, createdAt: scan.createdAt.toISOString(), updatedAt: scan.updatedAt.toISOString(),
    documents: scan.documents.map((d) => ({ ...d, createdAt: d.createdAt.toISOString(), url: signedFilePath(secret, d.id, nowSeconds) })),
    runs: scan.runs.map((r) => ({ ...r, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null })),
    lines: scan.billLines.map((l) => {
      const match = matches.get(l.id);
      return {
        id: l.id, position: l.position, itemName: l.itemName, bags: l.bags, weightKg: fromGrams(Number(l.grams)), rate: fromPaise(Number(l.ratePaise)),
        amount: fromPaise(Number(l.amountPaise)), sourcePage: l.sourcePage, sourceRow: l.sourceRow, confidence: l.confidence, rawText: l.rawText,
        origin: l.origin, corrected: l.corrected, assignedMarkId: l.assignedMarkId,
        markId: match?.markId ?? null, matchMethod: match?.method ?? null, suggestedMarkId: match?.suggestedMarkId ?? null, provenance: provenance(match),
      };
    }),
    marks: scan.marks.map((m) => ({
      id: m.id, position: m.position, markCode: m.markCode, bags: m.bags, rateMin: fromPaise(Number(m.rateMinPaise)), rateMax: fromPaise(Number(m.rateMaxPaise)),
      sourcePage: m.sourcePage, sourceRow: m.sourceRow, confidence: m.confidence, rawText: m.rawText, origin: m.origin, corrected: m.corrected,
    })),
    expenses: scan.expenses.map((e) => ({
      id: e.id, label: e.label, category: e.category, amount: fromPaise(Number(e.amountPaise)), includeInCost: e.includeInCost,
      confidence: e.confidence, rawText: e.rawText, origin: e.origin, corrected: e.corrected,
    })),
    reconciliation: rupeeView(result),
  };
}

export type ScanView = ReturnType<typeof scanView>;
