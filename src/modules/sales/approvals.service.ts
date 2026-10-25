import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { businessDate, fromDbDate } from '../../common/dates';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import { toPaise } from '../../common/money';
import { type Approval, Prisma } from '../../generated/prisma/client';
import { lockSale, loadCustomer, postBillFinancials, reverseBillStock, type Tender } from './billing';
import { CreateSaleDto } from './sales.dto';
import { describe, SalesService } from './sales.service';

const TYPE_LABEL: Record<Approval['type'], string> = {
  BACKDATED_SALE: 'Bill dated another day',
  SALE_CANCEL: 'Cancel bill',
  SALE_REBILL: 'Edit bill (cancel & rebill)',
};

/**
 * The Owner's queue. Everyone can read it (staff see what is waiting); only the Owner decides (route guard).
 * Approving runs the change in one transaction; if it can no longer be applied (e.g. stock sold meanwhile),
 * nothing changes and the request stays pending.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly db: PrismaService,
    private readonly sales: SalesService,
  ) {}

  async list(actor: Actor) {
    const rows = await this.db.approval.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map((row) => ({
      id: row.id,
      entityType: 'SALE' as const,
      requestType: row.type,
      requestLabel: TYPE_LABEL[row.type],
      entityId: row.saleId,
      referenceNo: row.referenceNo,
      requestedBy: row.requestedByName,
      requestedByRole: row.requestedByRole,
      requestedAt: row.createdAt.toISOString(),
      reason: row.reason,
      status: row.status,
      originalData: row.originalData,
      requestedData: row.requestedData,
      ...(row.reviewedByName && { reviewedBy: row.reviewedByName }),
      ...(row.reviewedAt && { reviewedAt: row.reviewedAt.toISOString() }),
      ...(row.reviewNotes && { reviewNotes: row.reviewNotes }),
    }));
  }

  async process(actor: Actor, id: string, action: 'APPROVE' | 'REJECT', notes?: string): Promise<void> {
    const pending = await this.db.approval.findFirst({ where: { id, organizationId: actor.organizationId } });
    if (!pending) throw new NotFoundException('Approval not found');
    const rebillInput = pending.type === 'SALE_REBILL' && action === 'APPROVE' ? await validRebillInput(pending.requestedData) : undefined;

    await this.db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM approvals WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked[0]?.status !== 'PENDING') throw new ConflictException('This request was already decided');
      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
      const today = businessDate(org.timezone);

      if (pending.type === 'BACKDATED_SALE') {
        const sale = await lockSale(tx, actor, pending.saleId);
        if (sale.status !== 'PENDING_APPROVAL') throw new ConflictException(`${sale.billNumber} is no longer waiting`);
        if (action === 'APPROVE') {
          const customer = await loadCustomer(tx, actor, sale.customerPartyId);
          const tenders = (sale.pendingTenders ?? []) as unknown as Tender[];
          await tx.sale.update({ where: { id: sale.id }, data: { status: 'CONFIRMED', pendingTenders: Prisma.DbNull } });
          await postBillFinancials(tx, actor, org, {
            saleId: sale.id, billNumber: sale.billNumber, totalPaise: toPaise(Number(sale.totalAmount)), tenders,
            saleDate: fromDbDate(sale.saleDate), customer, description: await describe(tx, sale.id),
          });
        } else {
          await reverseBillStock(tx, actor, sale.id, sale.billNumber, today, 'rejected by owner');
          await tx.sale.update({ where: { id: sale.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledByName: actor.name, cancelReason: `Rejected: ${notes || 'date not approved'}` } });
        }
      } else if (action === 'APPROVE' && pending.type === 'SALE_CANCEL') {
        await this.sales.executeCancel(tx, actor, pending.saleId, pending.reason, actor.name);
      } else if (action === 'APPROVE' && rebillInput) {
        await this.sales.executeRebill(tx, actor, pending.saleId, rebillInput, pending.reason, actor.name);
      }

      await tx.approval.update({ where: { id }, data: {
        status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', reviewedByName: actor.name, reviewedAt: new Date(), reviewNotes: notes?.trim() || null,
      } });
      await audit(tx, actor, {
        action: action === 'APPROVE' ? 'APPROVAL_ACCEPTED' : 'APPROVAL_REJECTED', entity: 'SALE', entityId: pending.saleId,
        details: `${action === 'APPROVE' ? 'Approved' : 'Rejected'} ${TYPE_LABEL[pending.type].toLowerCase()} for ${pending.referenceNo}${notes ? `: ${notes}` : ''}`,
        approver: actor.name,
      });
    }, TX_OPTIONS);
  }
}

/** Stored rebill input is re-validated before it is executed, exactly like a fresh request. */
async function validRebillInput(data: unknown): Promise<CreateSaleDto> {
  const dto = plainToInstance(CreateSaleDto, data);
  const errors = await validate(dto, { whitelist: true });
  if (errors.length) throw new ConflictException('The stored rebill request is no longer valid');
  return dto;
}
