import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { businessDate, fromDbDate, toDbDate } from '../../common/dates';
import { fromPaise, lineAmountPaise, toGrams, toPaise } from '../../common/money';
import { PrismaService, TX_OPTIONS, type Tx } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { applyStockChange, orgTimezone } from '../inventory/stock-ledger';
import { loadCostingInputs } from '../settings/costing.service';
import type { CreatePurchaseDto, ReceivePurchaseDto } from './purchases.dto';
import { appliedSellingRate, type DraftGroup, evaluateReceiving, takenInspectionQuantity } from './receiving.calc';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INCLUDE = { vendorParty: { select: { name: true } }, product: { select: { name: true } }, items: { orderBy: { position: 'asc' } }, expenses: { orderBy: { position: 'asc' } } } as const;
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
    createdAt: row.createdAt.toISOString(),
  };
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

  /** Records what is owed to the vendor. No stock moves until the consignment is received. */
  async create(actor: Actor, dto: CreatePurchaseDto) {
    const markCodes = dto.items.map((i) => i.markCode.trim().toUpperCase());
    if (markCodes.some((code) => !code)) throw new UnprocessableEntityException('Every line needs a quality (mark).');
    if (new Set(markCodes).size !== markCodes.length) throw new UnprocessableEntityException('Each quality can appear once per vendor bill.');
    const billNumber = dto.billNumber.trim();
    if (!billNumber) throw new UnprocessableEntityException('Bill number is required.');

    const id = await this.db.$transaction(async (tx) => {
      const vendor = await tx.vendor.findFirst({ where: { partyId: dto.vendorId, organizationId: actor.organizationId }, include: { party: true } });
      if (!vendor) throw new NotFoundException('Vendor not found');
      if (vendor.status !== 'ACTIVE') throw new UnprocessableEntityException(`${vendor.party.name} is inactive.`);
      const product = await tx.product.findFirst({ where: { id: dto.productId, organizationId: actor.organizationId } });
      if (!product) throw new NotFoundException('Product not found');
      if (product.status !== 'ACTIVE') throw new UnprocessableEntityException(`${product.name} is inactive.`);
      if (await tx.purchase.findUnique({ where: { organizationId_vendorPartyId_billNumber: { organizationId: actor.organizationId, vendorPartyId: dto.vendorId, billNumber } } })) {
        throw new ConflictException(`Bill ${billNumber} is already recorded for ${vendor.party.name}.`);
      }

      const items = dto.items.map((item, position) => ({
        position,
        markCode: markCodes[position] as string,
        bags: item.bags,
        weightKg: item.weightKg,
        ratePerKg: item.ratePerKg,
        totalPaise: lineAmountPaise(toGrams(item.weightKg), toPaise(item.ratePerKg)),
      }));
      const expenses = await Promise.all((dto.expenses ?? []).map(async (e, position) => {
        const master = e.expenseTypeId && UUID.test(e.expenseTypeId)
          ? await tx.costingExpenseType.findFirst({ where: { id: e.expenseTypeId, organizationId: actor.organizationId, kind: 'PURCHASE' } })
          : null;
        if (e.expenseTypeId && UUID.test(e.expenseTypeId) && !master) throw new UnprocessableEntityException('Unknown purchase expense type.');
        if (master && master.status !== 'ACTIVE') throw new UnprocessableEntityException(`${master.name} is inactive and cannot be added to a new bill.`);
        const name = master?.name ?? e.expenseTypeName?.trim();
        if (!name) throw new UnprocessableEntityException('Give each custom purchase expense a name.');
        return { position, name, masterId: master?.id ?? null, type: e.type ?? 'OTHER', amountPaise: toPaise(e.amount), description: e.description?.trim() ?? '', remarks: e.remarks?.trim() || null };
      }));

      const grossPaise = items.reduce((t, i) => t + i.totalPaise, 0);
      const expensePaise = expenses.reduce((t, e) => t + e.amountPaise, 0);
      const purchase = await tx.purchase.create({ data: {
        organizationId: actor.organizationId,
        billNumber,
        vendorPartyId: dto.vendorId,
        productId: dto.productId,
        purchaseDate: toDbDate(dto.date),
        lotNumber: dto.lotNumber.trim().toUpperCase(),
        expectedArrivalDate: dto.expectedArrivalDate ? toDbDate(dto.expectedArrivalDate) : null,
        grossAmount: fromPaise(grossPaise),
        totalExpenses: fromPaise(expensePaise),
        netAmount: fromPaise(grossPaise + expensePaise),
        notes: dto.notes?.trim() || null,
        createdByUserId: actor.userId,
        createdByName: actor.name,
        items: { create: items.map((i) => ({ organizationId: actor.organizationId, position: i.position, markCode: i.markCode, bags: i.bags, weightKg: i.weightKg, ratePerKg: i.ratePerKg, totalAmount: fromPaise(i.totalPaise) })) },
        expenses: { create: expenses.map((e) => ({
          organizationId: actor.organizationId, position: e.position, type: e.type, expenseTypeId: e.masterId, expenseTypeName: e.name,
          amount: fromPaise(e.amountPaise), description: e.description, remarks: e.remarks,
        })) },
      } });
      await audit(tx, actor, {
        action: 'CREATE_PURCHASE', entity: 'PURCHASE', entityId: purchase.id,
        details: `Vendor bill ${billNumber} saved for ${purchase.lotNumber}: ₹${fromPaise(grossPaise + expensePaise).toLocaleString('en-IN')}. Awaiting physical receipt.`,
      });
      return purchase.id;
    }, TX_OPTIONS);
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

      for (const { group, taken } of accepted) {
        const applied = appliedSellingRate(group);
        const rates = {
          finalizedSellingRate: applied,
          calculatedSellingRate: group.calculatedFinalRate,
          sellingRateOverride: group.revisedSellingRate,
          sellingRateOverrideReason: group.revisedSellingRate != null ? group.overrideReason.trim() || null : null,
        };
        const existing = await tx.lotMark.findUnique({ where: { lotId_markCode: { lotId: lotId as string, markCode: group.markCode } } });
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
        receivingRecord: { receivedAt: receivedAt.toISOString(), stockPosted: true, expenses: dto.expenses, groups: evaluation.groups, issues: evaluation.issues } as unknown as Prisma.InputJsonValue,
      } });
      await audit(tx, actor, {
        action: 'RECEIVE_LOT', entity: 'PURCHASE', entityId: id,
        details: `Received ${purchase.lotNumber}: ${totalBags} bags posted once, including accepted and defective`,
      });
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  /** Server-authoritative draft: a vendor-bill line takes mark, expected quantity and rate from the bill, never from the client. */
  private evaluate(purchase: { items: { id: string; markCode: string; bags: number; weightKg: Prisma.Decimal; ratePerKg: Prisma.Decimal }[] }, dto: ReceivePurchaseDto, costing: Awaited<ReturnType<typeof loadCostingInputs>>) {
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
        markCode: item?.markCode ?? g.markCode,
        fromVendorBill: item !== undefined,
        expectedBags: item?.bags ?? 0,
        expectedWeightKg: item ? num(item.weightKg) : 0,
        receivedBags: g.receivedBags,
        acceptedBags: g.acceptedBags,
        defectiveBags: g.defectiveBags,
        receivedWeightKg: g.receivedWeightKg,
        originalPurchaseRate: item ? num(item.ratePerKg) : (g.originalPurchaseRate ?? Number.NaN),
        revisedSellingRate: g.revisedSellingRate ?? null,
        overrideReason: g.overrideReason ?? '',
        remarks: g.remarks ?? '',
        bagWeights: g.bagWeights ?? [],
      };
    });
    const evaluation = evaluateReceiving({
      draft: {
        groups,
        expenses: dto.expenses.map((e) => ({
          id: e.id, expenseTypeId: e.expenseTypeId, expenseTypeName: e.expenseTypeName, description: e.description ?? '', amount: e.amount, remarks: e.remarks ?? '',
          allocation: e.allocation.method === 'ASSIGN_TO_GROUP' ? { method: 'ASSIGN_TO_GROUP' as const, groupId: e.allocation.groupId ?? '' } : { method: e.allocation.method },
        })),
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
