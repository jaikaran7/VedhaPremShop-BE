import { ConflictException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { toDbDate } from '../../common/dates';
import { isIsoDate } from '../../common/http/is-iso-date';
import { toGrams, toPaise } from '../../common/money';
import { ENV, type Env } from '../../config/env';
import { PrismaService, TX_OPTIONS, type Tx } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { type Confidence, type Field, type MarkSheetOut, type VendorBillOut } from './extraction/extraction.schema';
import { type ExtractionJob, type ExtractionPage, ExtractionError, DocumentExtractor } from './extraction/document.extractor';
import { PROMPT_VERSION } from './extraction/prompts';
import { DOCX, officeText, type ScanFileType, XLSX } from './file-validation';
import { normalizeMark } from './reconciliation.calc';
import { lockScan, recalculate, snapshotVersion } from './scan-store';

const RANK: Record<Confidence, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
/** The weakest confidence of a row's fields; a missing value is LOW. */
const weakest = (...fields: Field<unknown>[]): Confidence => fields.map((f) => (f.value === null ? 'LOW' : f.confidence)).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'HIGH');
const whole = (f: Field<number>) => Math.round(f.value ?? 0);
const isoOrNull = (f: Field<string>) => (f.value && isIsoDate(f.value) ? f.value : null);
const optionalBig = (f: Field<number>, scale: (v: number) => number) => (f.value === null ? null : BigInt(scale(f.value)));

/** Reads the uploaded documents with AI: the bill and the mark sheet as two jobs in parallel, each recorded as a run. */
@Injectable()
export class ConsignmentScanProcessingService {
  private readonly logger = new Logger(ConsignmentScanProcessingService.name);

  constructor(private readonly db: PrismaService, private readonly extractor: DocumentExtractor, @Inject(ENV) private readonly env: Env) {}

  /** A run older than every retry could take is treated as abandoned (the process died), so the scan can be read again. */
  private get staleAfterMs(): number {
    return (this.env.gemini.maxRetries + 1) * (this.env.gemini.timeoutMs + 5_000) + 60_000;
  }

  /**
   * Waits for both jobs and returns when the draft is ready; the progress (each run's stage and attempt) is in the database
   * all along, so a reload or a second screen sees the same state. Replaces earlier AI rows of the kinds that were read.
   */
  async process(actor: Actor, id: string): Promise<void> {
    const jobs = await this.start(actor, id);
    const results = await Promise.all(jobs.map((job) => this.runJob(actor, id, job)));
    await this.store(actor, id, results).catch(async (error: unknown) => {
      // Never leave the scan stuck in PROCESSING: the runs are recorded, so a person can retry.
      await this.db.consignmentScan.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'FAILED' } });
      throw error;
    });
  }

  private async store(actor: Actor, id: string, results: Awaited<ReturnType<ConsignmentScanProcessingService['runJob']>>[]): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const scan = await lockScan(tx, actor, id);
      for (const r of results) {
        if (r.kind === 'VENDOR_BILL' && r.bill) await this.storeBill(tx, actor, id, r.bill);
        if (r.kind === 'MARK_SHEET' && r.sheet) await this.storeSheet(tx, actor, id, r.sheet);
      }
      await this.prefill(tx, actor, id);
      const version = scan.version + 1;
      await tx.consignmentScan.update({ where: { id }, data: { version } });
      await snapshotVersion(tx, actor, id, version, 'Documents read by AI');
      const result = await recalculate(tx, actor, id);
      const failed = results.filter((r) => r.error);
      if (failed.length === results.length) await tx.consignmentScan.update({ where: { id }, data: { status: 'FAILED' } });
      await audit(tx, actor, {
        action: 'READ_CONSIGNMENT_DOCUMENTS', entity: 'CONSIGNMENT_SCAN', entityId: id,
        details: `AI read ${results.length - failed.length} of ${results.length} document set(s); ${result.issues.filter((i) => i.severity === 'CRITICAL').length} blocking issue(s) to review.`,
      });
    }, TX_OPTIONS);
  }

  /** Claims the scan (one reader at a time) and creates one run per document kind present. */
  private async start(actor: Actor, id: string): Promise<{ kind: ExtractionJob; runId: string; pages: ExtractionPage[] }[]> {
    return this.db.$transaction(async (tx) => {
      const scan = await lockScan(tx, actor, id);
      if (scan.status === 'CONFIRMED') throw new ConflictException('This scan is already confirmed.');
      if (scan.status === 'PROCESSING' && Date.now() - scan.updatedAt.getTime() < this.staleAfterMs) throw new ConflictException('The documents are already being read.');
      const docs = await tx.consignmentScanDocument.findMany({ where: { scanId: id }, orderBy: [{ kind: 'asc' }, { pageNo: 'asc' }], include: { file: true } });
      if (docs.length === 0) throw new UnprocessableEntityException('Upload the vendor bill and the mark sheet first.');
      await tx.consignmentScan.update({ where: { id }, data: { status: 'PROCESSING' } });
      const jobs: { kind: ExtractionJob; runId: string; pages: ExtractionPage[] }[] = [];
      for (const kind of new Set(docs.map((d) => d.kind))) {
        const pages = docs.filter((d) => d.kind === kind).map((d, i): ExtractionPage => {
          const content = Buffer.from(d.file?.content ?? new Uint8Array());
          const office = d.mimeType === DOCX || d.mimeType === XLSX;
          return { pageNo: i + 1, fileName: d.fileName, mimeType: d.mimeType, ...(office ? { text: officeText(content, d.mimeType as ScanFileType) } : { data: content }) };
        });
        const model = kind === 'VENDOR_BILL' ? this.env.gemini.printedBillModel : this.env.gemini.handwritingModel;
        const run = await tx.consignmentScanRun.create({ data: { organizationId: actor.organizationId, scanId: id, job: kind, model, promptVersion: PROMPT_VERSION, stage: 'READING' } });
        jobs.push({ kind, runId: run.id, pages });
      }
      return jobs;
    }, TX_OPTIONS).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') throw new NotFoundException('Scan not found');
      throw error;
    });
  }

  private async runJob(actor: Actor, scanId: string, job: { kind: ExtractionJob; runId: string; pages: ExtractionPage[] }) {
    const finish = (data: Prisma.ConsignmentScanRunUpdateInput) => this.db.consignmentScanRun.update({ where: { id: job.runId }, data: { ...data, finishedAt: new Date() } });
    try {
      const result = job.kind === 'VENDOR_BILL' ? await this.extractor.extract('VENDOR_BILL', job.pages) : await this.extractor.extract('MARK_SHEET', job.pages);
      await finish({
        status: 'SUCCEEDED', stage: 'DONE', model: result.model, attempts: result.attempts, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        latencyMs: result.latencyMs, rawResponse: result.raw as Prisma.InputJsonValue,
      });
      return job.kind === 'VENDOR_BILL' ? { kind: job.kind, bill: result.parsed as VendorBillOut } : { kind: job.kind, sheet: result.parsed as MarkSheetOut };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Extraction failed';
      const failure = error instanceof ExtractionError ? error : new ExtractionError(message, '', 0);
      this.logger.error(JSON.stringify({ event: 'ai_extraction_failed', scanId, organizationId: actor.organizationId, job: job.kind, attempts: failure.attempts, reason: failure.message.slice(0, 300) }));
      await finish({ status: 'FAILED', stage: 'FAILED', error: failure.message, attempts: failure.attempts, ...(failure.model && { model: failure.model }), rawResponse: failure.raw === null ? Prisma.DbNull : (failure.raw as Prisma.InputJsonValue) });
      return { kind: job.kind, error: failure.message };
    }
  }

  private async storeBill(tx: Tx, actor: Actor, scanId: string, bill: VendorBillOut): Promise<void> {
    await tx.consignmentScanBillLine.deleteMany({ where: { scanId } });
    await tx.consignmentScanExpense.deleteMany({ where: { scanId } });
    const org = actor.organizationId;
    await tx.consignmentScanBillLine.createMany({
      data: bill.lines.map((l, i) => ({
        organizationId: org, scanId, position: i + 1, itemName: l.itemName.value ?? '', bags: whole(l.bags), grams: BigInt(toGrams(l.weightKg.value ?? 0)),
        ratePaise: BigInt(toPaise(l.rate.value ?? 0)), amountPaise: BigInt(toPaise(l.amount.value ?? 0)), sourcePage: l.page, sourceRow: l.row,
        confidence: Number.isInteger(l.bags.value) ? weakest(l.bags, l.weightKg, l.rate, l.amount) : 'LOW',
        rawText: { bags: l.bags.raw, weight: l.weightKg.raw, rate: l.rate.raw, amount: l.amount.raw },
      })),
    });
    await tx.consignmentScanExpense.createMany({
      data: bill.expenses.map((e, i) => ({
        organizationId: org, scanId, position: i + 1, label: e.label, category: e.category, amountPaise: BigInt(toPaise(e.amount.value ?? 0)),
        includeInCost: e.category !== 'DRIVER_ADVANCE', confidence: weakest(e.amount), rawText: e.amount.raw,
      })),
    });
    const t = bill.totals;
    await tx.consignmentScan.update({
      where: { id: scanId },
      data: {
        billNumber: bill.billNumber.value, billDate: isoOrNull(bill.billDate) && toDbDate(isoOrNull(bill.billDate) as string), vendorNameText: bill.vendorName.value, buyerNameText: bill.buyerName.value,
        printedBillBags: t.bags.value === null ? null : whole(t.bags), printedBillGrams: optionalBig(t.weightKg, toGrams), printedGrossPaise: optionalBig(t.goodsTotal, toPaise),
        printedExpensesPaise: optionalBig(t.totalExpenses, toPaise), printedNetPaise: optionalBig(t.totalAmount, toPaise),
        headerEvidence: await this.mergeEvidence(tx, scanId, { vendorName: bill.vendorName, buyerName: bill.buyerName, billNumber: bill.billNumber, billDate: bill.billDate, totals: t }),
      },
    });
  }

  private async storeSheet(tx: Tx, actor: Actor, scanId: string, sheet: MarkSheetOut): Promise<void> {
    await tx.consignmentScanMark.deleteMany({ where: { scanId } });
    // A line assigned to a mark that was just replaced would point nowhere.
    await tx.consignmentScanBillLine.updateMany({ where: { scanId }, data: { assignedMarkId: null } });
    await tx.consignmentScanMark.createMany({
      data: sheet.marks.map((m, i) => {
        const min = m.rateMin.value ?? m.rateMax.value ?? 0;
        const max = Math.max(min, m.rateMax.value ?? min);
        return {
          organizationId: actor.organizationId, scanId, position: i + 1, markCode: normalizeMark(m.mark.value ?? '').slice(0, 12), bags: whole(m.bags),
          rateMinPaise: BigInt(toPaise(min)), rateMaxPaise: BigInt(toPaise(max)), sourcePage: m.page, sourceRow: m.row,
          confidence: weakest(m.bags, m.rateMin, m.mark), rawText: { side: m.side, bags: m.bags.raw, rate: m.rateMax.raw || m.rateMin.raw, mark: m.mark.raw },
        };
      }),
    });
    await tx.consignmentScan.update({
      where: { id: scanId },
      data: {
        sheetDate: isoOrNull(sheet.date) && toDbDate(isoOrNull(sheet.date) as string), lotRefText: sheet.lotRef.value,
        printedSheetBags: sheet.totalBags.value === null ? null : whole(sheet.totalBags),
        headerEvidence: await this.mergeEvidence(tx, scanId, { sheetDate: sheet.date, lotRef: sheet.lotRef, sheetTotalBags: sheet.totalBags }),
      },
    });
  }

  private async mergeEvidence(tx: Tx, scanId: string, fields: Record<string, unknown>): Promise<Prisma.InputJsonValue> {
    const current = (await tx.consignmentScan.findUniqueOrThrow({ where: { id: scanId }, select: { headerEvidence: true } })).headerEvidence;
    return { ...(current && typeof current === 'object' ? (current as Record<string, unknown>) : {}), ...fields } as Prisma.InputJsonValue;
  }

  /**
   * Fills empty header choices from what was read, only when unambiguous: the one vendor whose name matches, the
   * organization's only active product, the vendor's known rate convention, and a lot number from the bill date and lot reference.
   */
  private async prefill(tx: Tx, actor: Actor, scanId: string): Promise<void> {
    const scan = await tx.consignmentScan.findUniqueOrThrow({ where: { id: scanId } });
    const letters = (s: string) => s.toUpperCase().replace(/^(M\/?S\.?|MS\.?|MESSRS\.?)\s+/, '').replace(/[^A-Z]/g, '');
    const data: Prisma.ConsignmentScanUncheckedUpdateInput = {};
    if (!scan.vendorPartyId && scan.vendorNameText) {
      const wanted = letters(scan.vendorNameText);
      const vendors = await tx.vendor.findMany({ where: { organizationId: actor.organizationId, status: 'ACTIVE' }, select: { partyId: true, billRateUnit: true, party: { select: { name: true } } } });
      const hits = vendors.filter((v) => wanted.length > 3 && letters(v.party.name) === wanted);
      if (hits.length === 1) {
        data.vendorPartyId = hits[0]?.partyId;
        if (!scan.rateUnit && hits[0]?.billRateUnit) data.rateUnit = hits[0].billRateUnit;
      }
    }
    if (!scan.productId) {
      const products = await tx.product.findMany({ where: { organizationId: actor.organizationId, status: 'ACTIVE' }, select: { id: true }, take: 2 });
      if (products.length === 1) data.productId = products[0]?.id;
    }
    const lotCode = (scan.lotRefText ?? '').toUpperCase().match(/[A-Z]{2}\s*\d{1,2}/)?.[0]?.replace(/\s/g, '');
    const day = scan.billDate ?? scan.sheetDate;
    if (!scan.lotNumber && lotCode && day) {
      const iso = day.toISOString().slice(0, 10);
      data.lotNumber = `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)} ${lotCode}`;
    }
    if (Object.keys(data).length) await tx.consignmentScan.update({ where: { id: scanId }, data });
  }
}
