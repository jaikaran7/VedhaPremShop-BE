import { Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { nextSequence, partyCode } from '../../common/sequences';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import type { CreateVendorDto, UpdateVendorDto } from './vendors.dto';

@Injectable()
export class VendorsService {
  constructor(private readonly db: PrismaService) {}

  async list(actor: Actor, partyId?: string) {
    const rows = await this.db.vendor.findMany({
      where: { organizationId: actor.organizationId, ...(partyId && { partyId }) },
      include: { party: true },
      orderBy: { code: 'asc' },
    });
    // Owed to a vendor = sum of its purchase bills (goods + purchase expenses). There is no vendor payment flow yet, so nothing reduces it.
    const owed = new Map((await this.db.purchase.groupBy({ by: ['vendorPartyId'], where: { organizationId: actor.organizationId }, _sum: { netAmount: true } }))
      .map((g) => [g.vendorPartyId, Number(g._sum.netAmount ?? 0)]));
    return rows.map(({ party, ...vendor }) => ({
      id: party.id,
      code: vendor.code,
      name: party.name,
      phone: party.phone,
      ...(party.email && { email: party.email }),
      address: party.address,
      mandiCity: party.location,
      totalPurchases: owed.get(party.id) ?? 0,
      payableAmount: owed.get(party.id) ?? 0,
      status: vendor.status,
      createdAt: vendor.createdAt.toISOString(),
    }));
  }

  async get(actor: Actor, id: string) {
    const [vendor] = await this.list(actor, id);
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor;
  }

  async create(actor: Actor, dto: CreateVendorDto) {
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
      await tx.vendor.create({ data: { partyId: party.id, organizationId: actor.organizationId, code, status: dto.status ?? 'ACTIVE' } });
      await audit(tx, actor, { action: 'CREATE_VENDOR', entity: 'VENDOR', entityId: party.id, details: `Created vendor ${party.name} (${code})` });
      return party.id;
    }, TX_OPTIONS);
    return this.get(actor, id);
  }

  async update(actor: Actor, id: string, dto: UpdateVendorDto) {
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
      if (dto.status) await tx.vendor.update({ where: { partyId: id }, data: { status: dto.status } });
      await audit(tx, actor, { action: 'UPDATE_VENDOR', entity: 'VENDOR', entityId: id, details: `Updated vendor details for ${before.name}` });
    }, TX_OPTIONS);
    return this.get(actor, id);
  }
}
