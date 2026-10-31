import { BadRequestException, ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { fromDbDate } from '../../common/dates';
import { fromGrams, fromPaise } from '../../common/money';
import { isUniqueViolation } from '../../common/pg-error';
import { PrismaService, type Tx } from '../../database/prisma.service';
import type { CreatePurchaseDto, ReceivePurchaseDto } from '../purchases/purchases.dto';
import { PurchasesService } from '../purchases/purchases.service';
import type { Reconciliation } from './reconciliation.calc';
import { reconcileScan } from './scan-model';
import { type LockedScan, lockScan } from './scan-store';

/** Confirm writes a whole purchase and its stock; Neon round trips need more room than an ordinary request. */
const CONFIRM_TX = { maxWait: 10_000, timeout: 60_000 } as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

const PURCHASE_EXPENSE_TYPE = { HAMALI: 'HAMALI', MARKET_FEE: 'MANDI_TAX', LEVY: 'MANDI_TAX', COMMISSION: 'COMMISSION', FREIGHT: 'FREIGHT', DRIVER_ADVANCE: 'OTHER', OTHER: 'OTHER' } as const;

/**
 * Owner confirmation: re-checks the draft on the server, then — in one transaction — creates the vendor bill and receives
 * the lot through PurchasesService (the same code the Purchases screens use), and marks the scan CONFIRMED. A repeated
 * confirm returns the purchase already created, whatever key it carries.
 */
@Injectable()
export class ConsignmentScanConfirmService {
  constructor(private readonly db: PrismaService, private readonly purchases: PurchasesService) {}

  async confirm(actor: Actor, id: string, version: number, idempotencyKey: string | undefined): Promise<{ purchaseId: string; replayed: boolean }> {
    if (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)) throw new BadRequestException('An Idempotency-Key header (8–100 letters, digits, - or _) is required.');
    return this.db.$transaction(async (tx) => {
      const scan = await lockScan(tx, actor, id);
      if (scan.status === 'CONFIRMED' && scan.purchaseId) return { purchaseId: scan.purchaseId, replayed: true };
      if (scan.status === 'PROCESSING') throw new ConflictException('The documents are still being read.');
      if (scan.version !== version) throw new ConflictException('The scan changed after you reviewed it. Review the latest version and confirm again.');
      const result = reconcileScan(scan);
      const blocking = result.issues.filter((i) => i.severity === 'CRITICAL');
      if (blocking.length) throw new UnprocessableEntityException(`Resolve ${blocking.length} blocking issue(s) first: ${blocking.slice(0, 3).map((i) => i.message).join(' ')}`);

      const purchaseId = await this.purchases.createInTx(tx, actor, this.purchaseDto(scan, result));
      await this.purchases.receiveInTx(tx, actor, purchaseId, await this.receiveDto(tx, purchaseId, scan));
      if (scan.rateUnit) await tx.vendor.updateMany({ where: { partyId: scan.vendorPartyId as string, organizationId: actor.organizationId, billRateUnit: null }, data: { billRateUnit: scan.rateUnit } });
      await tx.consignmentScan.update({ where: { id }, data: { status: 'CONFIRMED', purchaseId, confirmKey: idempotencyKey, confirmedAt: new Date(), confirmedByName: actor.name } });
      await audit(tx, actor, {
        action: 'CONFIRM_CONSIGNMENT_SCAN', entity: 'CONSIGNMENT_SCAN', entityId: id,
        details: `Scanned bill ${scan.billNumber} confirmed as purchase ${purchaseId}: ${result.totals.lineBags} bags received.`,
        metadata: { purchaseId, version, roundingDifferencePaise: result.roundingDifferencePaise },
      });
      return { purchaseId, replayed: false };
    }, CONFIRM_TX).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw new ConflictException('This bill number is already recorded for the vendor, or this confirmation was already used.');
      throw error;
    });
  }

  /** The vendor bill from the reconciled draft: one line per mark (per printed rate for a range mark); every bill charge as payable. */
  private purchaseDto(scan: LockedScan, result: Reconciliation): CreatePurchaseDto {
    return {
      billNumber: scan.billNumber as string,
      vendorId: scan.vendorPartyId as string,
      productId: scan.productId as string,
      date: fromDbDate(scan.billDate as Date),
      lotNumber: scan.lotNumber as string,
      items: result.purchaseLines.map((l) => ({ markCode: l.markCode, bags: l.bags, weightKg: fromGrams(l.grams), ratePerKg: fromPaise(l.ratePerKgPaise) })),
      expenses: scan.expenses.map((e) => ({ expenseTypeName: e.label, type: PURCHASE_EXPENSE_TYPE[e.category], amount: fromPaise(Number(e.amountPaise)), description: 'From scanned vendor bill' })),
      notes: `Created from consignment scan ${scan.id}.`,
    };
  }

  /** Everything on the bill arrived as billed; charges marked "add to cost" are spread over the lot by weight. */
  private async receiveDto(tx: Tx, purchaseId: string, scan: LockedScan): Promise<ReceivePurchaseDto> {
    const items = await tx.purchaseItem.findMany({ where: { purchaseId }, orderBy: { position: 'asc' } });
    return {
      groups: items.map((i) => ({
        id: i.id, markCode: i.markCode, fromVendorBill: true, receivedBags: i.bags, acceptedBags: i.bags, defectiveBags: 0, receivedWeightKg: Number(i.weightKg),
      })),
      expenses: scan.expenses.filter((e) => e.includeInCost && e.amountPaise > 0n).map((e) => ({
        id: e.id, expenseTypeId: `scan-${e.category.toLowerCase()}`, expenseTypeName: e.label, amount: fromPaise(Number(e.amountPaise)),
        amountBasis: 'FIXED_TOTAL' as const, allocation: { method: 'BY_RECEIVED_KG' as const }, remarks: 'From scanned vendor bill',
      })),
      lotMarginPerKg: null,
    };
  }
}
