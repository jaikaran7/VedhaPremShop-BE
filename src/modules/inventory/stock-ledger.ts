import { ConflictException } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor';
import { toDbDate } from '../../common/dates';
import { fromGrams } from '../../common/money';
import type { Db, Tx } from '../../database/prisma.service';
import type { StockMovementType, StockReferenceType } from '../../generated/prisma/client';

export interface StockChange {
  lotMarkId: string;
  type: StockMovementType;
  bagsDelta: number;
  /** Signed grams, so no float error reaches the numeric column. */
  gramsDelta: number;
  referenceType: StockReferenceType;
  referenceId: string | null;
  reason: string;
  movementDate: string;
  /** Opening stock also raises the initial quantity; sales and adjustments do not. */
  raisesInitial?: boolean;
}

/**
 * The only way stock changes. One conditional UPDATE checks availability and writes the new balance atomically,
 * so two concurrent sales can never both take the last bags (the second sees 0 rows and fails); then the
 * immutable movement row records the delta and the balance after it. Call inside the business transaction.
 */
export async function applyStockChange(tx: Tx, actor: Actor, change: StockChange): Promise<{ movementId: string; bags: number; weightKg: number }> {
  const kg = String(fromGrams(change.gramsDelta));
  const initialBags = change.raisesInitial ? change.bagsDelta : 0;
  const initialKg = change.raisesInitial ? kg : '0';
  const rows = await tx.$queryRaw<{ bags: number; kg: unknown }[]>`
    UPDATE lot_marks
       SET remaining_bags = remaining_bags + ${change.bagsDelta},
           remaining_weight_kg = remaining_weight_kg + ${kg}::numeric,
           initial_bags = initial_bags + ${initialBags},
           initial_weight_kg = initial_weight_kg + ${initialKg}::numeric
     WHERE id = ${change.lotMarkId}::uuid AND organization_id = ${actor.organizationId}::uuid
       AND remaining_bags + ${change.bagsDelta} >= 0
       AND remaining_weight_kg + ${kg}::numeric >= 0
    RETURNING remaining_bags AS bags, remaining_weight_kg AS kg`;
  const after = rows[0];
  if (!after) throw new ConflictException('Not enough stock for this lot and mark. Refresh and try again.');

  const movement = await tx.stockMovement.create({ data: {
    organizationId: actor.organizationId,
    lotMarkId: change.lotMarkId,
    type: change.type,
    bagsDelta: change.bagsDelta,
    weightDeltaKg: kg,
    balanceBagsAfter: after.bags,
    balanceWeightKgAfter: String(after.kg),
    referenceType: change.referenceType,
    referenceId: change.referenceId,
    reason: change.reason,
    movementDate: toDbDate(change.movementDate),
    performedByUserId: actor.userId,
    performedByName: actor.name,
  } });
  return { movementId: movement.id, bags: Number(after.bags), weightKg: Number(after.kg) };
}

/** Lot and mark codes are stored uppercase, so lookups normalise the input. */
export async function findLotMark(db: Db, organizationId: string, lotNumber: string, markCode: string) {
  const lot = await db.lot.findUnique({ where: { organizationId_lotNumber: { organizationId, lotNumber: lotNumber.trim().toUpperCase() } } });
  if (!lot) return null;
  const lotMark = await db.lotMark.findUnique({ where: { lotId_markCode: { lotId: lot.id, markCode: markCode.trim().toUpperCase() } } });
  return lotMark ? { lot, lotMark } : null;
}

export async function orgTimezone(db: Db, organizationId: string): Promise<string> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { timezone: true } });
  return org.timezone;
}
