import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { fromDbDate, toDbDate } from '../../common/dates';
import { fromPaise, toPaise } from '../../common/money';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import type { CashAccount, Expense, ExpenseCategory } from '../../generated/prisma/client';
import { vendorBalances } from '../vendors/payables';
import type { CreateExpenseCategoryDto, RecordExpenseDto } from './expenses.dto';

/** The frontend treats an expense in this category as a payment to a vendor (matched by name, ignoring case). */
export const VENDOR_PAYMENT_CATEGORY = 'purchase payments';
export const isVendorPaymentCategory = (name: string): boolean => name.trim().toLowerCase() === VENDOR_PAYMENT_CATEGORY;

const accountView = (row: CashAccount) => ({ id: row.id, name: row.name, kind: row.kind, openingBalance: Number(row.openingBalance) });
const categoryView = (row: ExpenseCategory) => ({ id: row.id, name: row.name, trackingCategory: row.trackingCategory });

type ExpenseRow = Expense & { category: ExpenseCategory; account: CashAccount; vendorParty: { name: string } | null };
const INCLUDE = { category: true, account: true, vendorParty: { select: { name: true } } } as const;

/** Frontend `Expense` shape. */
function expenseView(row: ExpenseRow) {
  return {
    id: row.id,
    categoryId: row.categoryId,
    categoryName: row.category.name,
    trackingCategory: row.trackingCategory,
    amount: Number(row.amount),
    date: fromDbDate(row.expenseDate),
    paymentMethod: row.paymentMethod,
    accountId: row.accountId,
    accountName: row.account.name,
    ...(row.reference && { reference: row.reference }),
    ...(row.vendorPartyId && { vendorId: row.vendorPartyId, vendorName: row.vendorParty?.name ?? '' }),
    recordedBy: row.recordedByName,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class ExpensesService {
  constructor(private readonly db: PrismaService) {}

  async accounts(actor: Actor) {
    const rows = await this.db.cashAccount.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } });
    return rows.map(accountView);
  }

  async categories(actor: Actor) {
    const rows = await this.db.expenseCategory.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } });
    return rows.map(categoryView);
  }

  /** An existing name (any case) returns the existing category instead of a duplicate. */
  async createCategory(actor: Actor, dto: CreateExpenseCategoryDto) {
    const name = dto.name.trim();
    if (!name) throw new UnprocessableEntityException('Enter a category name');
    return this.db.$transaction(async (tx) => {
      const existing = await tx.expenseCategory.findFirst({ where: { organizationId: actor.organizationId, name: { equals: name, mode: 'insensitive' } } });
      if (existing) return categoryView(existing);
      const row = await tx.expenseCategory.create({ data: { organizationId: actor.organizationId, name, trackingCategory: dto.trackingCategory ?? null } });
      await audit(tx, actor, { action: 'CREATE_EXPENSE_CATEGORY', entity: 'EXPENSE', entityId: row.id, details: `Added expense category ${name}` });
      return categoryView(row);
    }, TX_OPTIONS);
  }

  async list(actor: Actor, limit: number, offset: number) {
    const rows = await this.db.expense.findMany({
      where: { organizationId: actor.organizationId }, include: INCLUDE,
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }], take: limit, skip: offset,
    });
    return rows.map(expenseView);
  }

  /**
   * One payment out of one account. A Purchase Payments expense must name its vendor and cannot exceed what is owed to them;
   * the vendor row is locked while the balance is read so two payments cannot both spend the last rupee owed.
   */
  async record(actor: Actor, dto: RecordExpenseDto) {
    const id = await this.db.$transaction(async (tx) => {
      const category = await tx.expenseCategory.findFirst({ where: { id: dto.categoryId, organizationId: actor.organizationId } });
      if (!category) throw new NotFoundException('Expense category not found');
      const account = await tx.cashAccount.findFirst({ where: { id: dto.accountId, organizationId: actor.organizationId } });
      if (!account) throw new NotFoundException('Account not found');
      const amountPaise = toPaise(dto.amount);

      let vendorName: string | null = null;
      if (isVendorPaymentCategory(category.name)) {
        if (!dto.vendorId) throw new UnprocessableEntityException('Choose the vendor this payment is for.');
        const locked = await tx.$queryRaw<{ party_id: string }[]>`
          SELECT party_id FROM vendors WHERE party_id = ${dto.vendorId}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
        if (!locked[0]) throw new NotFoundException('Vendor not found');
        const vendor = await tx.party.findUniqueOrThrow({ where: { id: dto.vendorId }, select: { name: true } });
        vendorName = vendor.name;
        const balance = (await vendorBalances(tx, actor.organizationId, dto.vendorId)).get(dto.vendorId);
        const owedPaise = (balance?.purchasedPaise ?? 0) - (balance?.paidPaise ?? 0);
        if (amountPaise > owedPaise) {
          throw new ConflictException(`₹${dto.amount.toLocaleString('en-IN')} is more than the ₹${fromPaise(owedPaise).toLocaleString('en-IN')} owed to ${vendor.name}.`);
        }
      } else if (dto.vendorId) {
        throw new UnprocessableEntityException('A vendor can only be attached to a Purchase Payments expense.');
      }

      const expense = await tx.expense.create({ data: {
        organizationId: actor.organizationId,
        categoryId: category.id,
        accountId: account.id,
        vendorPartyId: dto.vendorId ?? null,
        amount: fromPaise(amountPaise),
        expenseDate: toDbDate(dto.date),
        paymentMethod: dto.paymentMethod,
        reference: dto.reference?.trim() || null,
        trackingCategory: dto.trackingCategory === undefined ? category.trackingCategory : dto.trackingCategory,
        recordedByUserId: actor.userId,
        recordedByName: actor.name,
      } });
      await audit(tx, actor, {
        action: 'RECORD_EXPENSE', entity: 'EXPENSE', entityId: expense.id,
        details: `Expense ${category.name} of ₹${fromPaise(amountPaise).toLocaleString('en-IN')} paid from ${account.name}${vendorName ? ` to ${vendorName}` : ''}`,
      });
      return expense.id;
    }, TX_OPTIONS);
    const row = await this.db.expense.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    return expenseView(row);
  }
}
