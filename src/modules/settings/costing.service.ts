import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { OrgCache } from '../../common/cache';
import type { Actor } from '../../common/auth/actor';
import { type Db, PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import type { CostingExpenseType, SellingMarginComponent } from '../../generated/prisma/client';
import type { CostingSettings, MarginComponent } from '../purchases/receiving.calc';
import type { CostingSettingsDto, CreateExpenseTypeDto, CreateMarginDto, UpdateExpenseTypeDto, UpdateMarginDto } from './costing.dto';

const expenseTypeView = (row: CostingExpenseType) => ({
  id: row.id, name: row.name, kind: row.kind, status: row.status, amountBasis: row.amountBasis, defaultAllocation: row.defaultAllocation,
});

type AmountBasis = 'FIXED_TOTAL' | 'PER_BAG' | 'PER_KG';

/** A per-bag rate defaults to bags. A per-kg rate defaults to kilograms. A fixed total may use either. */
function allowedAllocations(basis: AmountBasis): Array<'BY_RECEIVED_KG' | 'BY_RECEIVED_BAGS'> {
  if (basis === 'PER_BAG') return ['BY_RECEIVED_BAGS'];
  if (basis === 'PER_KG') return ['BY_RECEIVED_KG'];
  return ['BY_RECEIVED_KG', 'BY_RECEIVED_BAGS'];
}

function allocationForBasis(basis: AmountBasis, requested?: string): 'BY_RECEIVED_KG' | 'BY_RECEIVED_BAGS' {
  const allowed = allowedAllocations(basis);
  const fallback = allowed[0] ?? 'BY_RECEIVED_KG';
  if (requested === 'BY_RECEIVED_KG' || requested === 'BY_RECEIVED_BAGS') {
    return allowed.includes(requested) ? requested : fallback;
  }
  return fallback;
}
const marginView = (row: SellingMarginComponent) => ({ id: row.id, name: row.name, calculationType: 'PER_KG' as const, perKg: Number(row.perKg), status: row.status });

/** The costing inputs a receiving needs, read inside the receiving transaction so a mid-flight settings edit cannot split it. */
export async function loadCostingInputs(db: Db, organizationId: string): Promise<{ settings: CostingSettings; margins: MarginComponent[] }> {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { defaultSellingMarginPerKg: true } });
  const rows = await db.sellingMarginComponent.findMany({ where: { organizationId, status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
  return {
    settings: { defaultSellingMarginPerKg: Number(org.defaultSellingMarginPerKg), roundingRule: 'CEIL_WHOLE_RUPEE' },
    margins: rows.map((m) => ({ id: m.id, name: m.name, perKg: Number(m.perKg) })),
  };
}

const MASTER_TTL_MS = 60_000;

@Injectable()
export class CostingService {
  constructor(private readonly db: PrismaService, private readonly cache: OrgCache) {}

  settings(actor: Actor) {
    return this.cache.get(actor.organizationId, 'costing:settings', MASTER_TTL_MS, async () => (await loadCostingInputs(this.db, actor.organizationId)).settings);
  }

  /** Applies to receivings done afterwards; a received lot keeps the rate snapshot it was finalized with. */
  async updateSettings(actor: Actor, dto: CostingSettingsDto) {
    await this.db.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: actor.organizationId }, data: { defaultSellingMarginPerKg: dto.defaultSellingMarginPerKg } });
      await audit(tx, actor, {
        action: 'UPDATE_SETTINGS', entity: 'COSTING', entityId: 'CONFIG',
        details: `Default selling margin set to ₹${dto.defaultSellingMarginPerKg}/kg for new receivings`, metadata: { ...dto },
      });
    }, TX_OPTIONS);
    this.cache.invalidate(actor.organizationId);
    return this.settings(actor);
  }

  listExpenseTypes(actor: Actor) {
    return this.cache.get(actor.organizationId, 'costing:expense-types', MASTER_TTL_MS, async () => {
      const rows = await this.db.costingExpenseType.findMany({ where: { organizationId: actor.organizationId }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
      return rows.map(expenseTypeView);
    });
  }

  async createExpenseType(actor: Actor, dto: CreateExpenseTypeDto) {
    const name = dto.name.trim();
    if (!name) throw new ConflictException('Name is required');
    const amountBasis = dto.kind === 'STOCK_RECEIVING' ? (dto.amountBasis ?? 'FIXED_TOTAL') : 'FIXED_TOTAL';
    const defaultAllocation = allocationForBasis(amountBasis, dto.defaultAllocation);
    const view = await this.db.$transaction(async (tx) => {
      const dupe = await tx.costingExpenseType.findFirst({ where: { organizationId: actor.organizationId, kind: dto.kind, name: { equals: name, mode: 'insensitive' } } });
      if (dupe) throw new ConflictException(`${name} already exists`);
      const row = await tx.costingExpenseType.create({ data: { organizationId: actor.organizationId, name, kind: dto.kind, amountBasis, defaultAllocation } });
      await audit(tx, actor, { action: 'CREATE_EXPENSE_TYPE', entity: 'COSTING', entityId: row.id, details: `Added ${dto.kind === 'PURCHASE' ? 'purchase' : 'stock-receiving'} expense type ${name}` });
      return expenseTypeView(row);
    }, TX_OPTIONS);
    this.cache.invalidate(actor.organizationId);
    return view;
  }

  async updateExpenseType(actor: Actor, id: string, dto: UpdateExpenseTypeDto) {
    return this.db.$transaction(async (tx) => {
      const found = await tx.costingExpenseType.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!found) throw new NotFoundException('Expense type not found');
      const name = dto.name?.trim() ?? found.name;
      if (!name) throw new ConflictException('Name is required');
      const clash = await tx.costingExpenseType.findFirst({ where: { organizationId: actor.organizationId, kind: found.kind, id: { not: id }, name: { equals: name, mode: 'insensitive' } } });
      if (clash) throw new ConflictException(`${name} already exists`);
      const amountBasis = found.kind === 'STOCK_RECEIVING' ? (dto.amountBasis ?? found.amountBasis) : found.amountBasis;
      const defaultAllocation = allocationForBasis(amountBasis, dto.defaultAllocation ?? found.defaultAllocation);
      const row = await tx.costingExpenseType.update({ where: { id }, data: { name, amountBasis, defaultAllocation, ...(dto.status && { status: dto.status }) } });
      await audit(tx, actor, { action: 'UPDATE_EXPENSE_TYPE', entity: 'COSTING', entityId: id, details: 'Updated expense type without rewriting saved bills' });
      return expenseTypeView(row);
    }, TX_OPTIONS).then((view) => {
      this.cache.invalidate(actor.organizationId);
      return view;
    });
  }

  listMargins(actor: Actor) {
    return this.cache.get(actor.organizationId, 'costing:margins', MASTER_TTL_MS, async () => {
      const rows = await this.db.sellingMarginComponent.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } });
      return rows.map(marginView);
    });
  }

  async createMargin(actor: Actor, dto: CreateMarginDto) {
    const name = dto.name.trim();
    if (!name) throw new ConflictException('Name is required');
    return this.db.$transaction(async (tx) => {
      const dupe = await tx.sellingMarginComponent.findFirst({ where: { organizationId: actor.organizationId, name: { equals: name, mode: 'insensitive' } } });
      if (dupe) throw new ConflictException(`${name} already exists`);
      const row = await tx.sellingMarginComponent.create({ data: { organizationId: actor.organizationId, name, perKg: dto.perKg } });
      await audit(tx, actor, { action: 'CREATE_MARGIN', entity: 'COSTING', entityId: row.id, details: `Added selling margin ${name} ₹${dto.perKg}/kg` });
      return marginView(row);
    }, TX_OPTIONS);
  }

  async updateMargin(actor: Actor, id: string, dto: UpdateMarginDto) {
    return this.db.$transaction(async (tx) => {
      const found = await tx.sellingMarginComponent.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!found) throw new NotFoundException('Margin component not found');
      const name = dto.name?.trim() ?? found.name;
      if (!name) throw new ConflictException('Name is required');
      const clash = await tx.sellingMarginComponent.findFirst({ where: { organizationId: actor.organizationId, id: { not: id }, name: { equals: name, mode: 'insensitive' } } });
      if (clash) throw new ConflictException(`${name} already exists`);
      const row = await tx.sellingMarginComponent.update({ where: { id }, data: { name, ...(dto.perKg !== undefined && { perKg: dto.perKg }), ...(dto.status && { status: dto.status }) } });
      await audit(tx, actor, { action: 'UPDATE_MARGIN', entity: 'COSTING', entityId: id, details: `Updated selling margin ${name}`, metadata: { ...dto } });
      return marginView(row);
    }, TX_OPTIONS);
  }
}
