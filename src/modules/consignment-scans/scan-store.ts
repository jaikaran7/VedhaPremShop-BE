/** Transaction helpers shared by the scan services: lock a scan, guard its state, recalculate and persist the result. */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor';
import type { Tx } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { Reconciliation } from './reconciliation.calc';
import { calcInput, reconcileScan } from './scan-model';

const ROWS = {
  billLines: { orderBy: { position: 'asc' } },
  marks: { orderBy: { position: 'asc' } },
  expenses: { orderBy: { position: 'asc' } },
} as const satisfies Prisma.ConsignmentScanInclude;

export type LockedScan = Prisma.ConsignmentScanGetPayload<{ include: typeof ROWS }>;

/** Row-locks the scan (this organization's only) so concurrent saves, reads and confirms run one after another. */
export async function lockScan(tx: Tx, actor: Actor, id: string): Promise<LockedScan> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM consignment_scans WHERE id = ${id}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
  if (!rows[0]) throw new NotFoundException('Scan not found');
  return tx.consignmentScan.findUniqueOrThrow({ where: { id }, include: ROWS });
}

export function assertEditable(scan: { status: string }): void {
  if (scan.status === 'CONFIRMED') throw new ConflictException('This scan is already confirmed and posted as a purchase.');
  if (scan.status === 'PROCESSING') throw new ConflictException('The documents are still being read. Wait for it to finish.');
}

/** Reconciles the scan's current rows, replaces its issue rows and sets READY or NEEDS_REVIEW. */
export async function recalculate(tx: Tx, actor: Actor, id: string): Promise<Reconciliation> {
  const scan = await tx.consignmentScan.findUniqueOrThrow({ where: { id }, include: ROWS });
  const result = reconcileScan(scan);
  await tx.consignmentScanIssue.deleteMany({ where: { scanId: id } });
  if (result.issues.length) {
    await tx.consignmentScanIssue.createMany({
      data: result.issues.map((i) => ({ organizationId: actor.organizationId, scanId: id, code: i.code, severity: i.severity, message: i.message, refs: i.refs ?? Prisma.DbNull })),
    });
  }
  await tx.consignmentScan.update({ where: { id }, data: { reconciliation: result as unknown as Prisma.InputJsonValue, status: result.canConfirm ? 'READY' : 'NEEDS_REVIEW' } });
  return result;
}

/** Records the draft as it now stands, so every correction (and every re-read) can be traced. */
export async function snapshotVersion(tx: Tx, actor: Actor, id: string, version: number, reason: string): Promise<void> {
  const scan = await tx.consignmentScan.findUniqueOrThrow({ where: { id }, include: ROWS });
  const input = calcInput(scan);
  await tx.consignmentScanVersion.create({
    data: {
      organizationId: actor.organizationId, scanId: id, version, reason, editedByName: actor.name,
      snapshot: { ...input, header: { ...input.header, lotNumber: scan.lotNumber }, expenses: scan.expenses.map((e) => ({ label: e.label, category: e.category, amountPaise: Number(e.amountPaise), includeInCost: e.includeInCost })) } as unknown as Prisma.InputJsonValue,
    },
  });
}
