import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { OrgCache } from '../../common/cache';
import { type Actor, isManagement } from '../../common/auth/actor';
import { businessDate, fromDbDate, toDbDate } from '../../common/dates';
import { toGrams } from '../../common/money';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import type { MovementsQueryDto, OpeningStockDto, StockAdjustmentDto } from './inventory.dto';
import { applyStockChange, findLotMark, orgTimezone } from './stock-ledger';

const num = (value: unknown) => Number(value);
const LOTS_TTL_MS = 15_000;

@Injectable()
export class InventoryService {
  constructor(private readonly db: PrismaService, private readonly cache: OrgCache) {}

  /** Lot totals are derived from their marks, never stored twice. The full list is the most-read endpoint, so it is cached briefly. */
  listLots(actor: Actor, lotId?: string) {
    if (lotId) return this.loadLots(actor, lotId);
    return this.cache.get(actor.organizationId, `lots:${isManagement(actor)}`, LOTS_TTL_MS, () => this.loadLots(actor));
  }

  private async loadLots(actor: Actor, lotId?: string) {
    const lots = await this.db.lot.findMany({
      where: { organizationId: actor.organizationId, ...(lotId && { id: lotId }) },
      include: { vendorParty: { select: { name: true } }, marks: { orderBy: [{ createdAt: 'asc' }, { markCode: 'asc' }] } },
      orderBy: [{ arrivalDate: 'desc' }, { lotNumber: 'asc' }],
    });
    const showCost = isManagement(actor);
    return lots.map((lot) => {
      const sumGrams = (pick: (m: (typeof lot.marks)[number]) => unknown) => lot.marks.reduce((t, m) => t + toGrams(num(pick(m))), 0) / 1000;
      const remainingBags = lot.marks.reduce((t, m) => t + m.remainingBags, 0);
      return {
        id: lot.id,
        lotNumber: lot.lotNumber,
        productId: lot.productId,
        vendorId: lot.vendorPartyId,
        vendorName: lot.vendorParty.name,
        purchaseBillId: lot.purchaseId ?? '',
        purchaseBillNo: lot.purchaseBillNo,
        arrivalDate: fromDbDate(lot.arrivalDate),
        status: remainingBags === 0 ? 'EXHAUSTED' : 'ACTIVE',
        totalBags: lot.marks.reduce((t, m) => t + m.initialBags, 0),
        totalWeightKg: sumGrams((m) => m.initialWeightKg),
        remainingBags,
        remainingWeightKg: sumGrams((m) => m.remainingWeightKg),
        marks: lot.marks.map((mark) => ({
          markCode: mark.markCode,
          initialBags: mark.initialBags,
          initialWeightKg: num(mark.initialWeightKg),
          remainingBags: mark.remainingBags,
          remainingWeightKg: num(mark.remainingWeightKg),
          // Purchase cost is hidden from Salesperson in the response itself.
          ...(showCost && { purchaseRate: num(mark.purchaseRate) }),
          ...(mark.finalizedSellingRate != null && { finalizedSellingRate: num(mark.finalizedSellingRate) }),
          ...(mark.calculatedSellingRate != null && { calculatedSellingRate: num(mark.calculatedSellingRate) }),
          sellingRateOverride: mark.sellingRateOverride == null ? null : num(mark.sellingRateOverride),
          ...(mark.sellingRateOverrideReason && { sellingRateOverrideReason: mark.sellingRateOverrideReason }),
        })),
        ...(lot.notes && { notes: lot.notes }),
      };
    });
  }

  async getLot(actor: Actor, id: string) {
    const [lot] = await this.listLots(actor, id);
    if (!lot) throw new NotFoundException('Lot not found');
    return lot;
  }

  /**
   * Movement history, newest first, filtered in the database (lot, mark, type, date range) and paged; `total` is the number
   * of rows matching the filters. Two queries however many movements exist.
   */
  async listMovements(actor: Actor, q: Partial<Pick<MovementsQueryDto, 'lotNumber' | 'markCode' | 'type' | 'from' | 'to'>> & { limit: number; offset: number }) {
    const where = {
      organizationId: actor.organizationId,
      ...(q.type?.length && { type: { in: q.type } }),
      ...((q.from || q.to) && { movementDate: { ...(q.from && { gte: toDbDate(q.from) }), ...(q.to && { lte: toDbDate(q.to) }) } }),
      ...((q.lotNumber || q.markCode) && { lotMark: {
        ...(q.markCode && { markCode: q.markCode.trim().toUpperCase() }),
        ...(q.lotNumber && { lot: { lotNumber: q.lotNumber.trim().toUpperCase() } }),
      } }),
    };
    const [rows, total] = await Promise.all([
      this.db.stockMovement.findMany({
        where,
        include: { lotMark: { select: { markCode: true, lot: { select: { lotNumber: true } } } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit,
        skip: q.offset,
      }),
      this.db.stockMovement.count({ where }),
    ]);
    return { total, rows: rows.map((m) => ({
      id: m.id,
      date: fromDbDate(m.movementDate),
      type: m.type,
      referenceId: m.referenceId ?? '',
      referenceType: m.referenceType,
      lotNumber: m.lotMark.lot.lotNumber,
      markCode: m.lotMark.markCode,
      bags: Math.abs(m.bagsDelta),
      weightKg: Math.abs(num(m.weightDeltaKg)),
      balanceBagsAfter: m.balanceBagsAfter,
      balanceWeightKgAfter: num(m.balanceWeightKgAfter),
      reason: m.reason,
      performedBy: m.performedByName,
    })) };
  }

  /** Owner/Manager correction. Cannot push stock below zero; recorded as an immutable movement. */
  async adjust(actor: Actor, dto: StockAdjustmentDto) {
    if (dto.bags === 0 && dto.weightKg === 0) throw new BadRequestException('Enter bags or weight to adjust');
    return this.db.$transaction(async (tx) => {
      const found = await findLotMark(tx, actor.organizationId, dto.lotNumber, dto.markCode);
      if (!found) throw new NotFoundException(`${dto.lotNumber} has no mark ${dto.markCode}`);
      const sign = dto.type === 'ADD' ? 1 : -1;
      const date = businessDate(await orgTimezone(tx, actor.organizationId));
      const reason = dto.reason.trim();
      const { movementId } = await applyStockChange(tx, actor, {
        lotMarkId: found.lotMark.id,
        type: dto.type === 'ADD' ? 'ADJUSTMENT_ADD' : 'ADJUSTMENT_SUB',
        bagsDelta: sign * dto.bags,
        gramsDelta: sign * toGrams(dto.weightKg),
        referenceType: 'ADJUSTMENT',
        referenceId: null,
        reason,
        movementDate: date,
      });
      await audit(tx, actor, {
        action: 'STOCK_ADJUSTMENT', entity: 'STOCK', entityId: found.lotMark.id,
        details: `Stock ${dto.type}: ${dto.bags} bags (${dto.weightKg} KG) on ${found.lot.lotNumber} [${found.lotMark.markCode}] — ${reason}`,
      });
      return adjustmentView(movementId, actor, date, found.lot.lotNumber, found.lotMark.markCode, dto.type, dto.bags, dto.weightKg, reason);
    }, TX_OPTIONS);
  }

  /** Physical opening count for a lot already in the yard. Adds the mark to the lot if it is new. */
  async addOpening(actor: Actor, dto: OpeningStockDto) {
    if (dto.bags === 0 && dto.weightKg === 0) throw new BadRequestException('Enter bags or weight');
    return this.db.$transaction(async (tx) => {
      let found = await findLotMark(tx, actor.organizationId, dto.lotNumber, dto.markCode);
      if (!found) {
        const lot = await tx.lot.findUnique({ where: { organizationId_lotNumber: { organizationId: actor.organizationId, lotNumber: dto.lotNumber.trim().toUpperCase() } } });
        if (!lot) throw new NotFoundException(`Lot ${dto.lotNumber} not found`);
        const lotMark = await tx.lotMark.create({ data: {
          organizationId: actor.organizationId, lotId: lot.id, markCode: dto.markCode.trim().toUpperCase(),
          initialBags: 0, initialWeightKg: 0, remainingBags: 0, remainingWeightKg: 0,
        } });
        found = { lot, lotMark };
      }
      const date = businessDate(await orgTimezone(tx, actor.organizationId));
      const reason = 'Physical opening stock reconciliation';
      const { movementId } = await applyStockChange(tx, actor, {
        lotMarkId: found.lotMark.id, type: 'OPENING_STOCK', bagsDelta: dto.bags, gramsDelta: toGrams(dto.weightKg),
        referenceType: 'OPENING', referenceId: null, reason, movementDate: date, raisesInitial: true,
      });
      await audit(tx, actor, {
        action: 'OPENING_STOCK', entity: 'STOCK', entityId: found.lotMark.id,
        details: `Opening stock: ${dto.bags} bags (${dto.weightKg} KG) on ${found.lot.lotNumber} [${found.lotMark.markCode}]`,
      });
      return adjustmentView(movementId, actor, date, found.lot.lotNumber, found.lotMark.markCode, 'ADD', dto.bags, dto.weightKg, reason);
    }, TX_OPTIONS);
  }
}

/** Frontend StockAdjustment shape; the adjustment is its movement row, so the id is the movement id. */
function adjustmentView(id: string, actor: Actor, date: string, lotNumber: string, markCode: string, type: 'ADD' | 'REDUCE', bags: number, weightKg: number, reason: string) {
  return { id, date, lotNumber, markCode, type, bags, weightKg, reason, approvedBy: actor.name, status: 'APPROVED' as const, createdAt: new Date().toISOString() };
}
