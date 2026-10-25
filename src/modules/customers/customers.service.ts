import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { type Actor, isManagement } from '../../common/auth/actor';
import { fromDbDate } from '../../common/dates';
import { nextSequence, partyCode } from '../../common/sequences';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import { customerBalances } from '../payments/receivables';
import { CREDIT_FIELDS, type CreateCustomerDto, type UpdateCustomerDto } from './customers.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly db: PrismaService) {}

  /**
   * outstandingAmount is what the customer owes (never negative); advanceAmount is money we hold for them
   * (paid more than owed) and is used automatically on their next bills.
   */
  async list(actor: Actor, partyId?: string) {
    const [rows, balances] = await Promise.all([
      this.db.customer.findMany({
        where: { organizationId: actor.organizationId, ...(partyId && { partyId }) },
        include: { party: true },
        orderBy: { code: 'asc' },
      }),
      customerBalances(this.db, actor.organizationId),
    ]);
    return rows.map(({ party, ...customer }) => {
      const balance = balances.get(party.id) ?? 0;
      return {
        id: party.id,
        code: customer.code,
        name: party.name,
        phone: party.phone,
        ...(party.email && { email: party.email }),
        address: party.address,
        marketLocation: party.location,
        creditLimit: Number(customer.creditLimit),
        creditDays: customer.creditDays,
        outstandingAmount: Math.max(0, balance),
        advanceAmount: Math.max(0, -balance),
        status: customer.status,
        kind: customer.kind,
        createdAt: customer.createdAt.toISOString(),
      };
    });
  }

  async get(actor: Actor, id: string) {
    const [customer] = await this.list(actor, id);
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /** Statement rows with a signed running balance per customer, oldest first (frontend CustomerLedgerEntry). */
  async ledger(actor: Actor) {
    const rows = await this.db.$queryRaw<{ id: string; date: Date; customer_id: string; type: string; reference_no: string; description: string; debit: unknown; credit: unknown; balance: unknown }[]>`
      SELECT id, entry_date AS date, customer_party_id AS customer_id, type::text AS type, reference_no, description, debit, credit,
             sum(debit - credit) OVER (PARTITION BY customer_party_id ORDER BY entry_date, created_at, id) AS balance
      FROM customer_ledger_entries WHERE organization_id = ${actor.organizationId}::uuid
      ORDER BY entry_date, created_at, id`;
    return rows.map((row) => ({
      id: row.id,
      date: fromDbDate(row.date),
      customerId: row.customer_id,
      type: row.type,
      referenceNo: row.reference_no,
      description: row.description,
      debit: Number(row.debit),
      credit: Number(row.credit),
      balance: Number(row.balance),
    }));
  }

  async create(actor: Actor, dto: CreateCustomerDto) {
    if (!isManagement(actor) && ((dto.creditLimit ?? 0) > 0 || (dto.creditDays ?? 0) > 0 || (dto.status && dto.status !== 'ACTIVE'))) {
      throw new ForbiddenException('Only the owner or manager can set credit terms');
    }
    const id = await this.db.$transaction(async (tx) => {
      const code = partyCode('CUST', await nextSequence(tx, actor.organizationId, 'CUSTOMER'));
      const party = await tx.party.create({ data: {
        organizationId: actor.organizationId,
        name: dto.name.trim(),
        phone: dto.phone?.trim() ?? '',
        email: dto.email?.trim() ?? '',
        address: dto.address?.trim() ?? '',
        location: dto.marketLocation?.trim() ?? '',
      } });
      await tx.customer.create({ data: {
        partyId: party.id,
        organizationId: actor.organizationId,
        code,
        creditLimit: dto.creditLimit ?? 0,
        creditDays: dto.creditDays ?? 0,
        status: dto.status ?? 'ACTIVE',
        kind: dto.kind ?? 'WHOLESALE',
      } });
      await audit(tx, actor, { action: 'CREATE_CUSTOMER', entity: 'CUSTOMER', entityId: party.id, details: `Created customer ${party.name} (${code})` });
      return party.id;
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  async update(actor: Actor, id: string, dto: UpdateCustomerDto) {
    if (CREDIT_FIELDS.some((field) => dto[field] !== undefined) && !isManagement(actor)) {
      throw new ForbiddenException('Only the owner or manager can change credit terms');
    }
    const before = await this.get(actor, id);
    await this.db.$transaction(async (tx) => {
      const partyPatch = {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.phone !== undefined && { phone: dto.phone.trim() }),
        ...(dto.email !== undefined && { email: dto.email.trim() }),
        ...(dto.address !== undefined && { address: dto.address.trim() }),
        ...(dto.marketLocation !== undefined && { location: dto.marketLocation.trim() }),
      };
      if (Object.keys(partyPatch).length) await tx.party.update({ where: { id }, data: partyPatch });
      const creditPatch = Object.fromEntries(CREDIT_FIELDS.filter((f) => dto[f] !== undefined).map((f) => [f, dto[f]]));
      if (Object.keys(creditPatch).length) await tx.customer.update({ where: { partyId: id }, data: creditPatch });
      const creditChange = CREDIT_FIELDS.filter((f) => dto[f] !== undefined && dto[f] !== before[f]).map((f) => `${f} ${before[f]} → ${dto[f]}`);
      await audit(tx, actor, {
        action: creditChange.length ? 'UPDATE_CUSTOMER_CREDIT' : 'UPDATE_CUSTOMER',
        entity: 'CUSTOMER',
        entityId: id,
        details: creditChange.length ? `Updated ${before.name}: ${creditChange.join(', ')}` : `Updated customer profile ${before.name}`,
      });
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  /** Only customers with no history can be removed; otherwise block them so their statement survives. */
  async remove(actor: Actor, id: string): Promise<void> {
    const customer = await this.get(actor, id);
    await this.db.$transaction(async (tx) => {
      const [ledger, sales, payments] = await Promise.all([
        tx.customerLedgerEntry.count({ where: { customerPartyId: id } }),
        tx.sale.count({ where: { customerPartyId: id } }),
        tx.payment.count({ where: { customerPartyId: id } }),
      ]);
      if (ledger + sales + payments > 0) throw new ConflictException('This customer has transactions. Set the status to BLOCKED instead.');
      await tx.customer.delete({ where: { partyId: id } });
      await tx.party.delete({ where: { id } });
      await audit(tx, actor, { action: 'DELETE_CUSTOMER', entity: 'CUSTOMER', entityId: id, details: `Removed customer ${customer.name} (${customer.code})` });
    }, TX_OPTIONS);
  }
}
