import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { type Actor, isManagement } from '../../common/auth/actor';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import type { Mark, Product } from '../../generated/prisma/client';
import type { CompanySettingsDto, CreateMarkDto, SaleChargeSettingsDto, UpdateMarkDto, UpdateProductDto } from './settings.dto';

@Injectable()
export class SettingsService {
  constructor(private readonly db: PrismaService) {}

  async company(actor: Actor): Promise<CompanySettingsDto> {
    const org = await this.org(actor);
    return {
      shopName: org.shopName,
      mandiLicenseNo: org.mandiLicenseNo,
      gstNo: org.gstNo,
      address: org.address,
      phone: org.phone,
      altPhone: org.altPhone,
      email: org.email,
      termsAndConditions: org.termsAndConditions,
      invoicePrefix: org.invoicePrefix,
      receiptPrefix: org.receiptPrefix,
    };
  }

  async updateCompany(actor: Actor, dto: CompanySettingsDto): Promise<CompanySettingsDto> {
    await this.db.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: actor.organizationId }, data: { ...dto } });
      await audit(tx, actor, { action: 'UPDATE_SETTINGS', entity: 'COMPANY', entityId: 'CONFIG', details: 'Updated wholesale company details' });
    }, TX_OPTIONS);
    return this.company(actor);
  }

  async saleCharges(actor: Actor): Promise<SaleChargeSettingsDto> {
    const org = await this.org(actor);
    return {
      amaliPerBag: Number(org.amaliPerBag),
      marketFeePerBag: Number(org.marketFeePerBag),
      amaliEnabled: org.amaliEnabled,
      marketFeeEnabled: org.marketFeeEnabled,
    };
  }

  /** Applies to bills created afterwards. Saved bills keep their own charge snapshot. */
  async updateSaleCharges(actor: Actor, dto: SaleChargeSettingsDto): Promise<SaleChargeSettingsDto> {
    await this.db.$transaction(async (tx) => {
      await tx.organization.update({ where: { id: actor.organizationId }, data: { ...dto } });
      await audit(tx, actor, {
        action: 'UPDATE_SETTINGS', entity: 'SALE_CHARGES', entityId: 'CONFIG',
        details: 'Updated Amali and market fee settings for new sales', metadata: { ...dto },
      });
    }, TX_OPTIONS);
    return this.saleCharges(actor);
  }

  async listMarks(actor: Actor) {
    const rows = await this.db.mark.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } });
    return rows.map((row) => this.markView(row, actor));
  }

  async createMark(actor: Actor, dto: CreateMarkDto) {
    const code = dto.code.trim().toUpperCase();
    return this.db.$transaction(async (tx) => {
      const dupe = await tx.mark.findUnique({ where: { organizationId_code: { organizationId: actor.organizationId, code } } });
      if (dupe) throw new ConflictException(`Mark ${code} already exists`);
      const row = await tx.mark.create({ data: { ...dto, code, description: dto.description ?? '', organizationId: actor.organizationId } });
      await audit(tx, actor, { action: 'CREATE_MARK', entity: 'MARK', entityId: row.id, details: `Created onion quality mark ${code}` });
      return this.markView(row, actor);
    }, TX_OPTIONS);
  }

  async updateMark(actor: Actor, id: string, dto: UpdateMarkDto) {
    return this.db.$transaction(async (tx) => {
      const found = await tx.mark.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!found) throw new NotFoundException('Mark not found');
      const row = await tx.mark.update({ where: { id }, data: { ...dto } });
      await audit(tx, actor, { action: 'UPDATE_MARK', entity: 'MARK', entityId: id, details: `Updated mark ${row.code}`, metadata: { ...dto } });
      return this.markView(row, actor);
    }, TX_OPTIONS);
  }

  async listProducts(actor: Actor) {
    const rows = await this.db.product.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } });
    return rows.map(productView);
  }

  async createProduct(actor: Actor, name: string) {
    const trimmed = name.trim();
    const base = trimmed.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'PRODUCT';
    return this.db.$transaction(async (tx) => {
      const existing = await tx.product.findMany({ where: { organizationId: actor.organizationId }, select: { code: true, name: true } });
      if (existing.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) throw new ConflictException(`${trimmed} already exists`);
      const used = new Set(existing.map((p) => p.code));
      let code = base;
      for (let suffix = 2; used.has(code); suffix += 1) code = `${base}_${suffix}`;
      const row = await tx.product.create({ data: { organizationId: actor.organizationId, name: trimmed, code } });
      await audit(tx, actor, { action: 'CREATE_PRODUCT', entity: 'PRODUCT', entityId: row.id, details: `Added product ${trimmed}` });
      return productView(row);
    }, TX_OPTIONS);
  }

  async updateProduct(actor: Actor, id: string, dto: UpdateProductDto) {
    return this.db.$transaction(async (tx) => {
      const found = await tx.product.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!found) throw new NotFoundException('Product not found');
      if (dto.name) {
        const clash = await tx.product.findFirst({ where: { organizationId: actor.organizationId, id: { not: id }, name: { equals: dto.name.trim(), mode: 'insensitive' } } });
        if (clash) throw new ConflictException(`${dto.name.trim()} already exists`);
      }
      const row = await tx.product.update({ where: { id }, data: { ...(dto.name && { name: dto.name.trim() }), ...(dto.status && { status: dto.status }) } });
      await audit(tx, actor, { action: 'UPDATE_PRODUCT', entity: 'PRODUCT', entityId: id, details: 'Updated product master without rewriting saved sales' });
      return productView(row);
    }, TX_OPTIONS);
  }

  private async org(actor: Actor) {
    const org = await this.db.organization.findUnique({ where: { id: actor.organizationId } });
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /** Purchase rates are cost data: hidden from Salesperson in the response, not just the UI. */
  private markView(row: Mark, actor: Actor) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      defaultSellingRate: Number(row.defaultSellingRate),
      ...(isManagement(actor) && { defaultPurchaseRate: Number(row.defaultPurchaseRate) }),
      qualityGrade: row.qualityGrade,
      ...(row.colorTag && { colorTag: row.colorTag }),
    };
  }
}

const productView = (row: Product) => ({ id: row.id, code: row.code, name: row.name, status: row.status });
