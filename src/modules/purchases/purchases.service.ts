import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { businessDate, fromDbDate, toDbDate } from '../../common/dates';
import { formatRupees, fromPaise, lineAmountPaise, toGrams, toPaise } from '../../common/money';
import { isUniqueViolation } from '../../common/pg-error';
import { PrismaService, TX_OPTIONS, type Tx } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { applyStockChange, orgTimezone } from '../inventory/stock-ledger';
import { loadCostingInputs } from '../settings/costing.service';
import type { CreatePurchaseDto, ReceivePurchaseDto, UpdatePurchaseDto } from './purchases.dto';
import { type BillSnapshotInput, diffBill } from './purchase-diff';
import { composeMarkCode, lotCodeFromNumber } from './lot-mark';
import { appliedSellingRate, type DraftGroup, evaluateReceiving, takenInspectionQuantity } from './receiving.calc';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INCLUDE = {
  vendorParty: { select: { name: true } },
  product: { select: { name: true } },
  items: { orderBy: { position: 'asc' } },
  expenses: { orderBy: { position: 'asc' } },
  _count: { select: { revisions: true } },
} as const;
type PurchaseRow = Prisma.PurchaseGetPayload<{ include: typeof INCLUDE }>;

const num = (value: unknown) => Number(value);

/** Frontend `Purchase` shape. The receiving record is stored exactly as the frontend renders it. */
function purchaseView(row: PurchaseRow) {
  return {
    id: row.id,
    billNumber: row.billNumber,
    vendorId: row.vendorPartyId,
    vendorName: row.vendorParty.name,
    productId: row.productId,
    productName: row.product.name,
    date: fromDbDate(row.purchaseDate),
    lotNumber: row.lotNumber,
    items: row.items.map((i) => ({ id: i.id, markCode: i.markCode, bags: i.bags, weightKg: num(i.weightKg), ratePerKg: num(i.ratePerKg), totalAmount: num(i.totalAmount) })),
    expenses: row.expenses.map((e) => ({
      id: e.id,
      type: e.type,
      ...(e.expenseTypeId && { expenseTypeId: e.expenseTypeId }),
      expenseTypeName: e.expenseTypeName,
      amount: num(e.amount),
      description: e.description,
      ...(e.remarks && { remarks: e.remarks }),
    })),
    grossAmount: num(row.grossAmount),
    totalExpenses: num(row.totalExpenses),
    netAmount: num(row.netAmount),
    ...(row.notes && { notes: row.notes }),
    receiptStatus: row.receiptStatus,
    ...(row.expectedArrivalDate && { expectedArrivalDate: fromDbDate(row.expectedArrivalDate) }),
    ...(row.receivingRecord && { receiving: row.receivingRecord }),
    ...(row.receivingDraft && { receivingDraft: row.receivingDraft }),
    revisionCount: row._count.revisions,
    createdAt: row.createdAt.toISOString(),
  };
}

const snapshotOf = (view: ReturnType<typeof purchaseView>): BillSnapshotInput => ({
  billNumber: view.billNumber, vendorName: view.vendorName, productName: view.productName, date: view.date,
  expectedArrivalDate: view.expectedArrivalDate ?? null, lotNumber: view.lotNumber, notes: view.notes ?? '',
  items: view.items.map(({ markCode, bags, weightKg, ratePerKg, totalAmount }) => ({ markCode, bags, weightKg, ratePerKg, totalAmount })),
  expenses: view.expenses.map((e) => ({ name: e.expenseTypeName, amount: e.amount })),
  grossAmount: view.grossAmount, totalExpenses: view.totalExpenses, netAmount: view.netAmount,
});

/** A validated, priced bill ready to store (shared by create and edit). */
interface PricedBill {
  vendorName: string;
  productName: string;
  billNumber: string;
  lotNumber: string;
  items: { id?: string; position: number; markCode: string; bags: number; weightKg: number; ratePerKg: number; totalPaise: number }[];
  expenses: { position: number; name: string; masterId: string | null; type: 'FREIGHT' | 'HAMALI' | 'MANDI_TAX' | 'COMMISSION' | 'OTHER'; amountPaise: number; description: string; remarks: string | null }[];
  grossPaise: number;
  expensePaise: number;
}

@Injectable()
export class PurchasesService {
  constructor(private readonly db: PrismaService) {}

  async list(actor: Actor, limit: number, offset: number) {
    const rows = await this.db.purchase.findMany({
      where: { organizationId: actor.organizationId },
      include: INCLUDE,
      orderBy: [{ purchaseDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      skip: offset,
    });
    return rows.map(purchaseView);
  }

  async get(actor: Actor, id: string) {
    const row = await this.db.purchase.findFirst({ where: { id, organizationId: actor.organizationId }, include: INCLUDE });
    if (!row) throw new NotFoundException('Purchase not found');
    return purchaseView(row);
  }

  /** Every correction made to a bill, newest first: who, why, and previous → current. */
  async revisions(actor: Actor, id: string) {
    await this.get(actor, id);
    const rows = await this.db.purchaseRevision.findMany({ where: { purchaseId: id, organizationId: actor.organizationId }, orderBy: { revisionNo: 'desc' } });
    return rows.map((r) => ({
      id: r.id, revisionNo: r.revisionNo, editedBy: r.editedByName, editedByRole: r.editedByRole, reason: r.reason,
      changes: r.changes, before: r.before, after: r.after, createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Records what is owed to the vendor. No stock moves until the consignment is received. Any bill date is accepted. */
  async create(actor: Actor, dto: CreatePurchaseDto) {
    if (dto.receiptStatus === 'RECEIVED') throw new BadRequestException('A new vendor bill cannot be created as received. Save it, then receive the lot.');
    const id = await this.db.$transaction(async (tx) => {
      const { vendorId, productId, bill } = await this.priceBill(tx, actor, dto);
      const purchase = await tx.purchase.create({ data: {
        organizationId: actor.organizationId,
        billNumber: bill.billNumber,
        vendorPartyId: vendorId,
        productId,
        purchaseDate: toDbDate(dto.date),
        lotNumber: bill.lotNumber,
        expectedArrivalDate: dto.expectedArrivalDate ? toDbDate(dto.expectedArrivalDate) : null,
        grossAmount: fromPaise(bill.grossPaise),
        totalExpenses: fromPaise(bill.expensePaise),
        netAmount: fromPaise(bill.grossPaise + bill.expensePaise),
        notes: dto.notes?.trim() || null,
        createdByUserId: actor.userId,
        createdByName: actor.name,
        items: { create: bill.items.map((i) => itemRow(actor, i)) },
        expenses: { create: bill.expenses.map((e) => expenseRow(actor, e)) },
      } });
      await audit(tx, actor, {
        action: 'CREATE_PURCHASE', entity: 'PURCHASE', entityId: purchase.id,
        details: `Vendor bill ${bill.billNumber} saved for ${purchase.lotNumber}: ${formatRupees(fromPaise(bill.grossPaise + bill.expensePaise))}. Awaiting physical receipt.`,
      });
      return purchase.id;
    }, TX_OPTIONS).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictException(`Bill ${dto.billNumber.trim()} is already recorded for this vendor.`);
      throw error;
    });
    return this.get(actor, id);
  }

  /**
   * Corrects a vendor bill and keeps the previous version. Before the lot is received anything can change. After it is
   * received, what physically arrived (vendor, product, lot, qualities, bags, weight) is fixed — fix that with a stock
   * adjustment — but rates and purchase charges can still be corrected, which changes what is owed and the lot's recorded cost.
   * The selling rates frozen at receiving never change. A correction that changes nothing is not recorded.
   */
  async update(actor: Actor, id: string, dto: UpdatePurchaseDto) {
    await this.db.$transaction(async (tx) => {
      // Lifts the database guard on the bill rows for this transaction only; the trigger still protects the receipt itself.
      await tx.$executeRaw`SELECT set_config('vedhaprem.purchase_edit', 'on', true)`;
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchases WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
      if (!locked[0]) throw new NotFoundException('Purchase not found');
      const current = await tx.purchase.findUniqueOrThrow({ where: { id }, include: INCLUDE });
      const received = current.receiptStatus === 'RECEIVED';
      const { vendorId, productId, bill } = await this.priceBill(tx, actor, dto, id);

      if (received) this.assertReceiptUnchanged(current, vendorId, productId, bill);
      const before = snapshotOf(purchaseView(current));
      const after: BillSnapshotInput = {
        billNumber: bill.billNumber, vendorName: bill.vendorName, productName: bill.productName, date: dto.date,
        expectedArrivalDate: dto.expectedArrivalDate ?? null, lotNumber: bill.lotNumber, notes: dto.notes?.trim() ?? '',
        items: bill.items.map((i) => ({ markCode: i.markCode, bags: i.bags, weightKg: i.weightKg, ratePerKg: i.ratePerKg, totalAmount: fromPaise(i.totalPaise) })),
        expenses: bill.expenses.map((e) => ({ name: e.name, amount: fromPaise(e.amountPaise) })),
        grossAmount: fromPaise(bill.grossPaise), totalExpenses: fromPaise(bill.expensePaise), netAmount: fromPaise(bill.grossPaise + bill.expensePaise),
      };
      const changes = diffBill(before, after);
      if (changes.length === 0) return; // nothing to record

      await tx.purchase.update({ where: { id }, data: {
        billNumber: bill.billNumber, vendorPartyId: vendorId, productId, purchaseDate: toDbDate(dto.date), lotNumber: bill.lotNumber,
        expectedArrivalDate: dto.expectedArrivalDate ? toDbDate(dto.expectedArrivalDate) : null,
        grossAmount: fromPaise(bill.grossPaise), totalExpenses: fromPaise(bill.expensePaise), netAmount: fromPaise(bill.grossPaise + bill.expensePaise),
        notes: dto.notes?.trim() || null,
      } });
      if (received) {
        // Same lines, new rates: the bill's amounts and the cost recorded on the lot marks this bill created.
        for (const line of bill.items) {
          const old = current.items.find((i) => i.id === line.id)!;
          if (num(old.ratePerKg) === line.ratePerKg) continue;
          await tx.purchaseItem.update({ where: { id: old.id }, data: { ratePerKg: line.ratePerKg, totalAmount: fromPaise(line.totalPaise) } });
          await tx.lotMark.updateMany({ where: { lot: { purchaseId: id }, markCode: line.markCode }, data: { purchaseRate: line.ratePerKg } });
        }
      } else {
        await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
        await tx.purchaseItem.createMany({ data: bill.items.map((i) => ({ ...itemRow(actor, i), purchaseId: id })) });
      }
      await tx.purchaseExpense.deleteMany({ where: { purchaseId: id } });
      await tx.purchaseExpense.createMany({ data: bill.expenses.map((e) => ({ ...expenseRow(actor, e), purchaseId: id })) });

      const last = await tx.purchaseRevision.aggregate({ where: { purchaseId: id }, _max: { revisionNo: true } });
      await tx.purchaseRevision.create({ data: {
        organizationId: actor.organizationId, purchaseId: id, revisionNo: (last._max.revisionNo ?? 0) + 1,
        editedByUserId: actor.userId, editedByName: actor.name, editedByRole: actor.role, reason: dto.reason.trim(),
        changes: changes as unknown as Prisma.InputJsonValue, before: before as unknown as Prisma.InputJsonValue, after: after as unknown as Prisma.InputJsonValue,
      } });
      await audit(tx, actor, {
        action: 'EDIT_PURCHASE', entity: 'PURCHASE', entityId: id,
        details: `Vendor bill ${bill.billNumber} corrected (${changes.map((c) => c.label).join(', ')}): ${dto.reason.trim()}`,
      });
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  /** Stores the in-progress count, expenses and lot commission. Stock is unchanged until receive. */
  async saveReceivingDraft(actor: Actor, id: string, dto: ReceivePurchaseDto) {
    const purchase = await this.db.purchase.findFirst({ where: { id, organizationId: actor.organizationId }, select: { receiptStatus: true } });
    if (!purchase) throw new NotFoundException('Purchase not found');
    if (purchase.receiptStatus !== 'PENDING_RECEIPT') throw new UnprocessableEntityException('This lot is already received.');
    await this.db.purchase.update({ where: { id }, data: { receivingDraft: dto as unknown as Prisma.InputJsonValue } });
    return this.get(actor, id);
  }

  /**
   * Physical receipt: evaluates the draft with the server's costing rules, then posts stock once. The purchase row is
   * locked first, so a double click or a retry waits and then gets the already-received bill instead of posting twice.
   */
  async receive(actor: Actor, id: string, dto: ReceivePurchaseDto) {
    await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM purchases WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
      if (!locked[0]) throw new NotFoundException('Purchase not found');
      const purchase = await tx.purchase.findUniqueOrThrow({ where: { id }, include: { items: true, vendorParty: { select: { name: true } } } });
      if (purchase.receiptStatus === 'RECEIVED') return;

      const evaluation = this.evaluate(purchase, dto, await loadCostingInputs(tx, actor.organizationId));
      const accepted = evaluation.groups.flatMap((group) => {
        const taken = takenInspectionQuantity(group);
        return taken.bags > 0 && taken.weightKg > 0 ? [{ group, taken }] : [];
      });
      const today = businessDate(await orgTimezone(tx, actor.organizationId));
      const lotId = accepted.length ? await this.lotFor(tx, actor, purchase, today) : null;
      // One query for the marks already in the lot, instead of one lookup per quality.
      const existingMarks = lotId
        ? new Map((await tx.lotMark.findMany({ where: { lotId, markCode: { in: accepted.map((a) => a.group.markCode) } } })).map((m) => [m.markCode, m]))
        : new Map();

      for (const { group, taken } of accepted) {
        const applied = appliedSellingRate(group);
        const rates = {
          finalizedSellingRate: applied,
          calculatedSellingRate: group.calculatedFinalRate,
          sellingRateOverride: group.revisedSellingRate,
          sellingRateOverrideReason: group.revisedSellingRate != null ? group.overrideReason.trim() || null : null,
        };
        const existing = existingMarks.get(group.markCode);
        // A mark already in the lot keeps its recorded purchase rate; a new mark takes this bill's rate.
        const lotMark = existing
          ? await tx.lotMark.update({ where: { id: existing.id }, data: rates })
          : await tx.lotMark.create({ data: {
            organizationId: actor.organizationId, lotId: lotId as string, markCode: group.markCode,
            initialBags: 0, initialWeightKg: 0, remainingBags: 0, remainingWeightKg: 0, purchaseRate: group.originalPurchaseRate, ...rates,
          } });
        await applyStockChange(tx, actor, {
          lotMarkId: lotMark.id, type: 'PURCHASE_IN', bagsDelta: taken.bags, gramsDelta: toGrams(taken.weightKg),
          referenceType: 'PURCHASE', referenceId: purchase.id, reason: `Received ${purchase.lotNumber} from ${purchase.vendorParty.name}`,
          movementDate: today, raisesInitial: true,
        });
      }

      const receivedAt = new Date();
      const totalBags = accepted.reduce((t, a) => t + a.taken.bags, 0);
      await tx.purchase.update({ where: { id }, data: {
        receiptStatus: 'RECEIVED',
        receivedAt,
        receivingDraft: Prisma.DbNull,
        receivingRecord: { receivedAt: receivedAt.toISOString(), stockPosted: true, calculationVersion: 2, expenses: dto.expenses, groups: evaluation.groups, issues: evaluation.issues } as unknown as Prisma.InputJsonValue,
      } });
      await audit(tx, actor, {
        action: 'RECEIVE_LOT', entity: 'PURCHASE', entityId: id,
        details: `Received ${purchase.lotNumber}: ${totalBags} bags posted once, including accepted and defective`,
      });
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  /**
   * Validates and prices a bill for create or edit: vendor and product exist and are active, qualities are not repeated, the
   * bill number is unused for this vendor, charges resolve to their master (one query for all) or a custom name.
   */
  private async priceBill(tx: Tx, actor: Actor, dto: CreatePurchaseDto, editingId?: string): Promise<{ vendorId: string; productId: string; bill: PricedBill }> {
    const lotCode = lotCodeFromNumber(dto.lotNumber);
    const markCodes = dto.items.map((i) => composeMarkCode(lotCode, i.markCode));
    if (markCodes.some((code) => !code)) throw new UnprocessableEntityException('Every line needs a quality (mark).');
    if (markCodes.some((code) => code.length > 16)) throw new UnprocessableEntityException('A quality name with the lot code is longer than 16 characters.');
    if (new Set(markCodes).size !== markCodes.length) throw new UnprocessableEntityException('Each quality can appear once per vendor bill.');
    const billNumber = dto.billNumber.trim();
    if (!billNumber) throw new UnprocessableEntityException('Bill number is required.');

    const vendor = await tx.vendor.findFirst({ where: { partyId: dto.vendorId, organizationId: actor.organizationId }, include: { party: true } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    const product = await tx.product.findFirst({ where: { id: dto.productId, organizationId: actor.organizationId } });
    if (!product) throw new NotFoundException('Product not found');
    const duplicate = await tx.purchase.findUnique({ where: { organizationId_vendorPartyId_billNumber: { organizationId: actor.organizationId, vendorPartyId: dto.vendorId, billNumber } }, select: { id: true } });
    if (duplicate && duplicate.id !== editingId) throw new ConflictException(`Bill ${billNumber} is already recorded for ${vendor.party.name}.`);
    // An edit may keep an inactive vendor or product the bill already uses; it cannot move a bill onto one.
    const current = editingId ? await tx.purchase.findUnique({ where: { id: editingId }, select: { vendorPartyId: true, productId: true } }) : null;
    if (vendor.status !== 'ACTIVE' && current?.vendorPartyId !== dto.vendorId) throw new UnprocessableEntityException(`${vendor.party.name} is inactive.`);
    if (product.status !== 'ACTIVE' && current?.productId !== dto.productId) throw new UnprocessableEntityException(`${product.name} is inactive.`);

    const masterIds = [...new Set((dto.expenses ?? []).map((e) => e.expenseTypeId).filter((v): v is string => !!v && UUID.test(v)))];
    const masters = new Map((masterIds.length
      ? await tx.costingExpenseType.findMany({ where: { id: { in: masterIds }, organizationId: actor.organizationId, kind: 'PURCHASE' } })
      : []).map((m) => [m.id, m]));
    const items = dto.items.map((item, position) => ({
      ...(item.id && { id: item.id }), position, markCode: markCodes[position] as string, bags: item.bags, weightKg: item.weightKg, ratePerKg: item.ratePerKg,
      totalPaise: lineAmountPaise(toGrams(item.weightKg), toPaise(item.ratePerKg)),
    }));
    const expenses = (dto.expenses ?? []).map((e, position) => {
      const isMaster = !!e.expenseTypeId && UUID.test(e.expenseTypeId);
      const master = isMaster ? masters.get(e.expenseTypeId as string) : undefined;
      if (isMaster && !master) throw new UnprocessableEntityException('Unknown purchase expense type.');
      if (master && master.status !== 'ACTIVE' && !editingId) throw new UnprocessableEntityException(`${master.name} is inactive and cannot be added to a new bill.`);
      const name = master?.name ?? e.expenseTypeName?.trim();
      if (!name) throw new UnprocessableEntityException('Give each custom purchase expense a name.');
      return { position, name, masterId: master?.id ?? null, type: e.type ?? ('OTHER' as const), amountPaise: toPaise(e.amount), description: e.description?.trim() ?? '', remarks: e.remarks?.trim() || null };
    });
    return {
      vendorId: dto.vendorId, productId: dto.productId,
      bill: {
        vendorName: vendor.party.name, productName: product.name, billNumber, lotNumber: dto.lotNumber.trim().toUpperCase(), items, expenses,
        grossPaise: items.reduce((t, i) => t + i.totalPaise, 0), expensePaise: expenses.reduce((t, e) => t + e.amountPaise, 0),
      },
    };
  }

  /** After receipt only rates and charges may change: the same vendor, product, lot and lines, in the same quantities. */
  private assertReceiptUnchanged(current: PurchaseRow, vendorId: string, productId: string, bill: PricedBill): void {
    const fixed = 'This lot is already received, so what arrived cannot change here. Fix quantities with a stock adjustment; rates and charges can still be corrected.';
    if (vendorId !== current.vendorPartyId || productId !== current.productId || bill.lotNumber !== current.lotNumber) throw new UnprocessableEntityException(fixed);
    if (bill.items.length !== current.items.length) throw new UnprocessableEntityException(fixed);
    for (const line of bill.items) {
      const old = current.items.find((i) => i.id === line.id);
      if (!old || old.markCode !== line.markCode || old.bags !== line.bags || num(old.weightKg) !== line.weightKg) throw new UnprocessableEntityException(fixed);
    }
  }

  /** Server-authoritative draft: a vendor-bill line takes mark, expected quantity and rate from the bill, never from the client. */
  private evaluate(purchase: { lotNumber: string; items: { id: string; markCode: string; bags: number; weightKg: Prisma.Decimal; ratePerKg: Prisma.Decimal }[] }, dto: ReceivePurchaseDto, costing: Awaited<ReturnType<typeof loadCostingInputs>>) {
    const items = new Map(purchase.items.map((i) => [i.id, i]));
    const groupIds = new Set(dto.groups.map((g) => g.id));
    const missing = purchase.items.find((i) => !groupIds.has(i.id));
    if (missing) throw new UnprocessableEntityException(`${missing.markCode} is on the vendor bill. Enter what arrived for it (0 if nothing).`);
    for (const e of dto.expenses) {
      if (e.allocation.method === 'ASSIGN_TO_GROUP' && !groupIds.has(e.allocation.groupId ?? '')) {
        throw new UnprocessableEntityException(`${e.expenseTypeName} is assigned to a quality that is not being received.`);
      }
    }
    const groups: DraftGroup[] = dto.groups.map((g) => {
      const item = items.get(g.id);
      return {
        id: g.id,
        markCode: item?.markCode ?? composeMarkCode(lotCodeFromNumber(purchase.lotNumber), g.markCode),
        fromVendorBill: item !== undefined,
        expectedBags: item?.bags ?? 0,
        expectedWeightKg: item ? num(item.weightKg) : 0,
        receivedBags: g.receivedBags,
        acceptedBags: g.acceptedBags,
        defectiveBags: g.defectiveBags,
        receivedWeightKg: g.receivedWeightKg,
        originalPurchaseRate: item ? num(item.ratePerKg) : (g.originalPurchaseRate ?? Number.NaN),
        revisedSellingRate: g.revisedSellingRate ?? null,
        marginPerKg: g.marginPerKg ?? null,
        overrideReason: g.overrideReason ?? '',
        remarks: g.remarks ?? '',
        bagWeights: g.bagWeights ?? [],
      };
    });
    const evaluation = evaluateReceiving({
      draft: {
        groups,
        expenses: dto.expenses.map((e) => ({
          id: e.id, expenseTypeId: e.expenseTypeId, expenseTypeName: e.expenseTypeName, description: e.description ?? '', amount: e.amount,
          ...(e.amountBasis && { amountBasis: e.amountBasis }),
          remarks: e.remarks ?? '',
          allocation: e.allocation.method === 'ASSIGN_TO_GROUP' ? { method: 'ASSIGN_TO_GROUP' as const, groupId: e.allocation.groupId ?? '' } : { method: e.allocation.method },
        })),
        lotMarginPerKg: dto.lotMarginPerKg ?? null,
      },
      ...costing,
    });
    const blocking = evaluation.issues.find((issue) => issue.blocking);
    if (blocking) throw new UnprocessableEntityException(blocking.message);
    return evaluation;
  }

  /** The lot for this consignment: extended when the lot number exists (same product only), otherwise created. */
  private async lotFor(tx: Tx, actor: Actor, purchase: { id: string; lotNumber: string; billNumber: string; vendorPartyId: string; productId: string; notes: string | null }, arrivalDate: string): Promise<string> {
    const existing = await tx.lot.findUnique({ where: { organizationId_lotNumber: { organizationId: actor.organizationId, lotNumber: purchase.lotNumber } } });
    if (existing) {
      if (existing.productId !== purchase.productId) throw new ConflictException(`${purchase.lotNumber} already holds a different product.`);
      return existing.id;
    }
    const lot = await tx.lot.create({ data: {
      organizationId: actor.organizationId, lotNumber: purchase.lotNumber, productId: purchase.productId, vendorPartyId: purchase.vendorPartyId,
      purchaseId: purchase.id, purchaseBillNo: purchase.billNumber, arrivalDate: toDbDate(arrivalDate), notes: purchase.notes,
    } });
    return lot.id;
  }
}

const itemRow = (actor: Actor, i: PricedBill['items'][number]) => ({
  organizationId: actor.organizationId, position: i.position, markCode: i.markCode, bags: i.bags, weightKg: i.weightKg, ratePerKg: i.ratePerKg, totalAmount: fromPaise(i.totalPaise),
});

const expenseRow = (actor: Actor, e: PricedBill['expenses'][number]) => ({
  organizationId: actor.organizationId, position: e.position, type: e.type, expenseTypeId: e.masterId, expenseTypeName: e.name,
  amount: fromPaise(e.amountPaise), description: e.description, remarks: e.remarks,
});
