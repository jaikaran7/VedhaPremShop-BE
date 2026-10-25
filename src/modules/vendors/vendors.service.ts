import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { type Actor, isManagement } from '../../common/auth/actor';
import { fromDbDate } from '../../common/dates';
import { formatRupees, fromPaise, toPaise } from '../../common/money';
import { nextSequence, partyCode } from '../../common/sequences';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import { vendorTotals } from './payables';
import { settleBills, vendorPosition } from './vendor-ledger.calc';
import type { CreateVendorDto, UpdateVendorDto } from './vendors.dto';

/** The money fields of a vendor, all derived (see vendor-ledger.calc.ts). */
export function vendorMoney(openingPaise: number, billedPaise: number, paidPaise: number) {
  const position = vendorPosition(openingPaise, billedPaise, paidPaise);
  return {
    totalPurchases: fromPaise(billedPaise),
    openingBalance: fromPaise(openingPaise),
    previousDue: fromPaise(position.previousDuePaise),
    newDue: fromPaise(position.newDuePaise),
    advanceAmount: fromPaise(position.advancePaise),
    payableAmount: fromPaise(position.payablePaise),
  };
}

/** Audit text for a vendor update; a change of the opening balance names the old and the new amount. */
function updateDetails(before: { name: string; openingBalance?: number }, openingBalance?: number): string {
  if (openingBalance === undefined) return `Updated vendor details for ${before.name}`;
  return `Opening balance for ${before.name} set to ${formatRupees(openingBalance)} (was ${formatRupees(before.openingBalance ?? 0)})`;
}

@Injectable()
export class VendorsService {
  constructor(private readonly db: PrismaService) {}

  /** Everyone can list vendors (bill forms need the names); what we owe them is Owner and Manager only. */
  async list(actor: Actor, partyId?: string) {
    const [rows, totals] = await Promise.all([
      this.db.vendor.findMany({
        where: { organizationId: actor.organizationId, ...(partyId && { partyId }) },
        include: { party: true },
        orderBy: { code: 'asc' },
      }),
      isManagement(actor) ? vendorTotals(this.db, actor.organizationId, partyId) : undefined,
    ]);
    return rows.map(({ party, ...vendor }) => {
      const t = totals?.get(party.id);
      return {
        id: party.id,
        code: vendor.code,
        name: party.name,
        phone: party.phone,
        ...(party.email && { email: party.email }),
        address: party.address,
        mandiCity: party.location,
        ...(totals && vendorMoney(t?.openingPaise ?? 0, t?.billedPaise ?? 0, t?.paidPaise ?? 0)),
        status: vendor.status,
        createdAt: vendor.createdAt.toISOString(),
      };
    });
  }

  async get(actor: Actor, id: string) {
    const [vendor] = await this.list(actor, id);
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  /**
   * Account statement: previous due, each bill with how much of it is paid (payments clear old dues, then the oldest bills),
   * every payment made, and any advance held with the vendor. Three queries however many bills or payments exist.
   */
  async ledger(actor: Actor, id: string) {
    const [vendorRow, bills, payments] = await Promise.all([
      this.db.vendor.findFirst({ where: { partyId: id, organizationId: actor.organizationId }, select: { openingBalance: true } }),
      this.db.purchase.findMany({
        where: { organizationId: actor.organizationId, vendorPartyId: id },
        select: { id: true, billNumber: true, purchaseDate: true, lotNumber: true, receiptStatus: true, netAmount: true, createdAt: true },
        orderBy: [{ purchaseDate: 'asc' }, { createdAt: 'asc' }],
      }),
      this.db.expense.findMany({
        where: { organizationId: actor.organizationId, vendorPartyId: id },
        select: { id: true, expenseDate: true, amount: true, paymentMethod: true, reference: true, receiptNumber: true, nextPaymentDate: true, recordedByName: true, createdAt: true, account: { select: { name: true } } },
        orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    if (!vendorRow) throw new NotFoundException('Vendor not found');
    const openingPaise = toPaise(Number(vendorRow.openingBalance));
    const billedPaise = bills.reduce((t, b) => t + toPaise(Number(b.netAmount)), 0);
    const paidPaise = payments.reduce((t, p) => t + toPaise(Number(p.amount)), 0);
    const settled = new Map(settleBills(openingPaise, bills.map((b) => ({ id: b.id, netPaise: toPaise(Number(b.netAmount)) })), paidPaise).map((s) => [s.id, s]));
    return {
      vendor: await this.get(actor, id),
      ...vendorMoney(openingPaise, billedPaise, paidPaise),
      bills: bills.map((b) => {
        const s = settled.get(b.id)!;
        return {
          id: b.id, billNumber: b.billNumber, date: fromDbDate(b.purchaseDate), lotNumber: b.lotNumber, receiptStatus: b.receiptStatus,
          netAmount: Number(b.netAmount), paidAmount: fromPaise(s.paidPaise), balanceAmount: fromPaise(s.balancePaise), status: s.status,
        };
      }),
      payments: payments.map((p) => ({
        id: p.id, date: fromDbDate(p.expenseDate), amount: Number(p.amount), paymentMethod: p.paymentMethod, accountName: p.account.name,
        ...(p.reference && { reference: p.reference }),
        ...(p.receiptNumber && { receiptNumber: p.receiptNumber }),
        ...(p.nextPaymentDate && { nextPaymentDate: fromDbDate(p.nextPaymentDate) }),
        recordedBy: p.recordedByName, createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  async create(actor: Actor, dto: CreateVendorDto) {
    if (dto.openingBalance !== undefined) this.requireOwner(actor);
    const id = await this.db.$transaction(async (tx) => {
      const code = partyCode('VEN', await nextSequence(tx, actor.organizationId, 'VENDOR'));
      const party = await tx.party.create({ data: {
        organizationId: actor.organizationId,
        name: dto.name.trim(),
        phone: dto.phone?.trim() ?? '',
        email: dto.email?.trim() ?? '',
        address: dto.address?.trim() ?? '',
        location: dto.mandiCity?.trim() ?? '',
      } });
      await tx.vendor.create({ data: { partyId: party.id, organizationId: actor.organizationId, code, status: dto.status ?? 'ACTIVE', openingBalance: dto.openingBalance ?? 0 } });
      await audit(tx, actor, {
        action: 'CREATE_VENDOR', entity: 'VENDOR', entityId: party.id,
        details: `Created vendor ${party.name} (${code})` + (dto.openingBalance ? ` with an opening balance of ${formatRupees(dto.openingBalance)}` : ''),
      });
      return party.id;
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  async update(actor: Actor, id: string, dto: UpdateVendorDto) {
    if (dto.openingBalance !== undefined) this.requireOwner(actor);
    const before = await this.get(actor, id);
    await this.db.$transaction(async (tx) => {
      const partyPatch = {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.phone !== undefined && { phone: dto.phone.trim() }),
        ...(dto.email !== undefined && { email: dto.email.trim() }),
        ...(dto.address !== undefined && { address: dto.address.trim() }),
        ...(dto.mandiCity !== undefined && { location: dto.mandiCity.trim() }),
      };
      if (Object.keys(partyPatch).length) await tx.party.update({ where: { id }, data: partyPatch });
      const vendorPatch = { ...(dto.status && { status: dto.status }), ...(dto.openingBalance !== undefined && { openingBalance: dto.openingBalance }) };
      if (Object.keys(vendorPatch).length) await tx.vendor.update({ where: { partyId: id }, data: vendorPatch });
      await audit(tx, actor, {
        action: dto.openingBalance === undefined ? 'UPDATE_VENDOR' : 'UPDATE_VENDOR_OPENING', entity: 'VENDOR', entityId: id,
        details: updateDetails(before, dto.openingBalance),
      });
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  private requireOwner(actor: Actor): void {
    if (actor.role !== 'OWNER') throw new ForbiddenException('Only the Owner can set what was owed to a vendor before the system was used.');
  }
}
