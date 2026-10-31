import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { toDbDate } from '../../common/dates';
import { toGrams, toPaise } from '../../common/money';
import { isUniqueViolation } from '../../common/pg-error';
import { ENV, type Env } from '../../config/env';
import { PrismaService, TX_OPTIONS, type Tx } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { DocumentKind, SaveScanDraftDto, ScanExpenseDto, ScanLineDto, ScanMarkDto } from './consignment-scans.dto';
import { checkUpload, MAX_FILES_PER_SCAN } from './file-validation';
import { verifyFileLink } from './scan-file-links';
import { SCAN_INCLUDE, scanView } from './scan-model';
import { assertEditable, type LockedScan, lockScan, recalculate, snapshotVersion } from './scan-store';

/** The parts of a multer file this service reads (memory storage). */
export interface UploadedScanFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const big = (value: number) => BigInt(value);
const optionalBig = (value: number | null | undefined, scale: (v: number) => number) => (value == null ? value : BigInt(scale(value)));
/** Keeps a file name displayable and harmless: no path, no control characters, bounded length. */
const safeFileName = (name: string) => (name.split(/[\\/]/).pop() ?? 'file').replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(-120) || 'file';
const json = (value: Prisma.JsonValue | null | undefined) => (value == null ? Prisma.DbNull : (value as Prisma.InputJsonValue));

/**
 * Consignment scan sessions: create, upload documents, review and correct the draft. Reading the documents with AI is
 * ConsignmentScanProcessingService; posting the purchase is ConsignmentScanConfirmService.
 */
@Injectable()
export class ConsignmentScansService {
  constructor(private readonly db: PrismaService, @Inject(ENV) private readonly env: Env) {}

  async create(actor: Actor) {
    const scan = await this.db.$transaction(async (tx) => {
      const created = await tx.consignmentScan.create({ data: { organizationId: actor.organizationId, createdByUserId: actor.userId, createdByName: actor.name } });
      await audit(tx, actor, { action: 'CREATE_CONSIGNMENT_SCAN', entity: 'CONSIGNMENT_SCAN', entityId: created.id, details: 'Consignment scan started.' });
      return created;
    }, TX_OPTIONS);
    return this.get(actor, scan.id);
  }

  async list(actor: Actor, limit: number, offset: number) {
    const rows = await this.db.consignmentScan.findMany({
      where: { organizationId: actor.organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true, status: true, billNumber: true, lotNumber: true, vendorNameText: true, purchaseId: true, createdByName: true, createdAt: true,
        vendorParty: { select: { name: true } }, _count: { select: { documents: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id, status: r.status, billNumber: r.billNumber, lotNumber: r.lotNumber, vendorName: r.vendorParty?.name ?? r.vendorNameText,
      purchaseId: r.purchaseId, documentCount: r._count.documents, createdBy: r.createdByName, createdAt: r.createdAt.toISOString(),
    }));
  }

  async get(actor: Actor, id: string) {
    const scan = await this.db.consignmentScan.findFirst({ where: { id, organizationId: actor.organizationId }, include: SCAN_INCLUDE });
    if (!scan) throw new NotFoundException('Scan not found');
    return scanView(scan, this.env.jwtAccessSecret, nowSeconds());
  }

  /** Stores validated files privately in the database. The whole upload is rejected if any file fails a check. */
  async upload(actor: Actor, id: string, kind: DocumentKind, files: UploadedScanFile[]) {
    if (!files?.length) throw new BadRequestException('Attach at least one file.');
    const checked = files.map((f) => {
      const result = checkUpload(f.buffer, f.mimetype);
      if (!result.ok) throw new UnprocessableEntityException(`${safeFileName(f.originalname)}: ${result.reason}`);
      return { fileName: safeFileName(f.originalname), mimeType: result.type, content: f.buffer, sha256: createHash('sha256').update(f.buffer).digest('hex') };
    });
    await this.db.$transaction(async (tx) => {
      const scan = await lockScan(tx, actor, id);
      assertEditable(scan);
      const existing = await tx.consignmentScanDocument.findMany({ where: { scanId: id }, select: { kind: true, pageNo: true } });
      if (existing.length + checked.length > MAX_FILES_PER_SCAN) throw new UnprocessableEntityException(`A scan can hold at most ${MAX_FILES_PER_SCAN} files.`);
      let pageNo = Math.max(0, ...existing.filter((d) => d.kind === kind).map((d) => d.pageNo));
      for (const file of checked) {
        pageNo += 1;
        await tx.consignmentScanDocument.create({
          data: {
            organizationId: actor.organizationId, scanId: id, kind, pageNo, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.content.length,
            sha256: file.sha256, uploadedByName: actor.name, file: { create: { content: new Uint8Array(file.content) } },
          },
        });
      }
      await audit(tx, actor, { action: 'UPLOAD_SCAN_DOCUMENTS', entity: 'CONSIGNMENT_SCAN', entityId: id, details: `${checked.length} ${kind === 'VENDOR_BILL' ? 'vendor bill' : 'mark sheet'} file(s) uploaded.` });
    }, TX_OPTIONS).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictException('That file is already uploaded to this scan.');
      throw error;
    });
    return this.get(actor, id);
  }

  async removeDocument(actor: Actor, id: string, documentId: string) {
    await this.db.$transaction(async (tx) => {
      assertEditable(await lockScan(tx, actor, id));
      const removed = await tx.consignmentScanDocument.deleteMany({ where: { id: documentId, scanId: id } });
      if (removed.count === 0) throw new NotFoundException('Document not found');
      await audit(tx, actor, { action: 'REMOVE_SCAN_DOCUMENT', entity: 'CONSIGNMENT_SCAN', entityId: id, details: 'A document was removed before confirmation.' });
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  /** Serves a private document through a short-lived signed link (no session needed, so an <img> can load it). */
  async file(documentId: string, exp: number, sig: string) {
    if (!verifyFileLink(this.env.jwtAccessSecret, documentId, exp, sig, nowSeconds())) throw new ForbiddenException('This link has expired. Reload the scan.');
    const doc = await this.db.consignmentScanDocument.findUnique({ where: { id: documentId }, select: { mimeType: true, fileName: true, file: { select: { content: true } } } });
    if (!doc?.file) throw new NotFoundException('Document not found');
    return { mimeType: doc.mimeType, fileName: doc.fileName, content: Buffer.from(doc.file.content) };
  }

  /** Saves corrections (optimistic version check), keeps a version snapshot, and recalculates. */
  async saveDraft(actor: Actor, id: string, dto: SaveScanDraftDto) {
    await this.db.$transaction(async (tx) => {
      const scan = await lockScan(tx, actor, id);
      assertEditable(scan);
      if (scan.version !== dto.version) throw new ConflictException('Someone saved this scan after you opened it. Reload to see their changes.');
      await this.assertMasters(tx, actor, dto);
      if (dto.marks) await this.replaceMarks(tx, actor, scan, dto.marks);
      const markIds = new Set((await tx.consignmentScanMark.findMany({ where: { scanId: id }, select: { id: true } })).map((m) => m.id));
      if (dto.lines) await this.replaceLines(tx, actor, scan, dto.lines, markIds);
      if (dto.expenses) await this.replaceExpenses(tx, actor, scan, dto.expenses);
      const version = scan.version + 1;
      await tx.consignmentScan.update({ where: { id }, data: { ...headerChanges(dto), version } });
      const reason = dto.reason?.trim() || 'Draft saved';
      await snapshotVersion(tx, actor, id, version, reason);
      const result = await recalculate(tx, actor, id);
      await audit(tx, actor, {
        action: 'EDIT_CONSIGNMENT_SCAN', entity: 'CONSIGNMENT_SCAN', entityId: id,
        details: `Scan draft v${version} saved (${reason}); ${result.issues.filter((i) => i.severity === 'CRITICAL').length} blocking issue(s).`,
      });
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  async versions(actor: Actor, id: string) {
    await this.get(actor, id);
    const rows = await this.db.consignmentScanVersion.findMany({ where: { scanId: id, organizationId: actor.organizationId }, orderBy: { version: 'desc' }, take: 100 });
    return rows.map((r) => ({ version: r.version, reason: r.reason, editedBy: r.editedByName, createdAt: r.createdAt.toISOString(), snapshot: r.snapshot }));
  }

  private async assertMasters(tx: Tx, actor: Actor, dto: SaveScanDraftDto): Promise<void> {
    if (dto.vendorId && !(await tx.vendor.findFirst({ where: { partyId: dto.vendorId, organizationId: actor.organizationId }, select: { partyId: true } }))) throw new NotFoundException('Vendor not found');
    if (dto.productId && !(await tx.product.findFirst({ where: { id: dto.productId, organizationId: actor.organizationId }, select: { id: true } }))) throw new NotFoundException('Product not found');
  }

  private async replaceMarks(tx: Tx, actor: Actor, scan: LockedScan, marks: ScanMarkDto[]): Promise<void> {
    const old = new Map(scan.marks.map((m) => [m.id, m]));
    const data = marks.map((m, index) => {
      const prev = m.id ? old.get(m.id) : undefined;
      if (m.id && !prev) throw new UnprocessableEntityException('A mark row does not belong to this scan.');
      if (m.rateMax < m.rateMin) throw new UnprocessableEntityException(`${m.markCode}: the highest rate is below the lowest.`);
      const values = { markCode: m.markCode.trim().toUpperCase(), bags: m.bags, rateMinPaise: big(toPaise(m.rateMin)), rateMaxPaise: big(toPaise(m.rateMax)) };
      const changed = !!prev && (prev.markCode !== values.markCode || prev.bags !== values.bags || prev.rateMinPaise !== values.rateMinPaise || prev.rateMaxPaise !== values.rateMaxPaise);
      return {
        ...(prev && { id: prev.id }), organizationId: actor.organizationId, scanId: scan.id, position: index + 1, ...values,
        sourcePage: prev?.sourcePage ?? null, sourceRow: prev?.sourceRow ?? null, confidence: prev?.confidence ?? 'HIGH', rawText: json(prev?.rawText),
        origin: prev?.origin ?? 'MANUAL', corrected: (prev?.corrected ?? false) || changed,
      };
    });
    await tx.consignmentScanMark.deleteMany({ where: { scanId: scan.id } });
    if (data.length) await tx.consignmentScanMark.createMany({ data });
  }

  private async replaceLines(tx: Tx, actor: Actor, scan: LockedScan, lines: ScanLineDto[], markIds: Set<string>): Promise<void> {
    const old = new Map(scan.billLines.map((l) => [l.id, l]));
    const data = lines.map((l, index) => {
      const prev = l.id ? old.get(l.id) : undefined;
      if (l.id && !prev) throw new UnprocessableEntityException('A bill line does not belong to this scan.');
      if (l.assignedMarkId && !markIds.has(l.assignedMarkId)) throw new UnprocessableEntityException(`Bill line ${index + 1} is assigned to a mark that is not on this scan.`);
      const values = { bags: l.bags, grams: big(toGrams(l.weightKg)), ratePaise: big(toPaise(l.rate)), amountPaise: big(toPaise(l.amount)) };
      const changed = !!prev && (prev.bags !== values.bags || prev.grams !== values.grams || prev.ratePaise !== values.ratePaise || prev.amountPaise !== values.amountPaise);
      return {
        ...(prev && { id: prev.id }), organizationId: actor.organizationId, scanId: scan.id, position: index + 1, itemName: l.itemName?.trim() ?? prev?.itemName ?? '', ...values,
        sourcePage: prev?.sourcePage ?? null, sourceRow: prev?.sourceRow ?? null, confidence: prev?.confidence ?? 'HIGH', rawText: json(prev?.rawText),
        origin: prev?.origin ?? 'MANUAL', corrected: (prev?.corrected ?? false) || changed, assignedMarkId: l.assignedMarkId ?? null,
      };
    });
    await tx.consignmentScanBillLine.deleteMany({ where: { scanId: scan.id } });
    if (data.length) await tx.consignmentScanBillLine.createMany({ data });
  }

  private async replaceExpenses(tx: Tx, actor: Actor, scan: LockedScan, expenses: ScanExpenseDto[]): Promise<void> {
    const old = new Map(scan.expenses.map((e) => [e.id, e]));
    const data = expenses.map((e, index) => {
      const prev = e.id ? old.get(e.id) : undefined;
      if (e.id && !prev) throw new UnprocessableEntityException('An expense row does not belong to this scan.');
      const amountPaise = big(toPaise(e.amount));
      const changed = !!prev && (prev.amountPaise !== amountPaise || prev.category !== e.category || prev.label !== e.label.trim());
      return {
        ...(prev && { id: prev.id }), organizationId: actor.organizationId, scanId: scan.id, position: index + 1, label: e.label.trim(), category: e.category, amountPaise,
        includeInCost: e.includeInCost, confidence: prev?.confidence ?? 'HIGH', rawText: prev?.rawText ?? null, origin: prev?.origin ?? 'MANUAL', corrected: (prev?.corrected ?? false) || changed,
      };
    });
    await tx.consignmentScanExpense.deleteMany({ where: { scanId: scan.id } });
    if (data.length) await tx.consignmentScanExpense.createMany({ data });
  }
}

/** Header fields present in the request; null clears, undefined leaves unchanged. */
function headerChanges(dto: SaveScanDraftDto): Prisma.ConsignmentScanUncheckedUpdateInput {
  const dateOrNull = (v: string | null | undefined) => (v === undefined ? undefined : v && toDbDate(v));
  return {
    vendorPartyId: dto.vendorId,
    productId: dto.productId,
    lotNumber: dto.lotNumber === undefined ? undefined : dto.lotNumber?.trim().toUpperCase() || null,
    rateUnit: dto.rateUnit,
    billNumber: dto.billNumber === undefined ? undefined : dto.billNumber?.trim() || null,
    billDate: dateOrNull(dto.billDate),
    sheetDate: dateOrNull(dto.sheetDate),
    printedBillBags: dto.printedBillBags,
    printedBillGrams: optionalBig(dto.printedBillWeightKg, toGrams),
    printedGrossPaise: optionalBig(dto.printedGrossAmount, toPaise),
    printedExpensesPaise: optionalBig(dto.printedExpensesAmount, toPaise),
    printedNetPaise: optionalBig(dto.printedNetAmount, toPaise),
    printedSheetBags: dto.printedSheetBags,
  };
}
