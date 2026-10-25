import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { type Actor, isOwner, isManagement } from '../../common/auth/actor';
import { OrgCache } from '../../common/cache';
import { fromDbDate, toDbDate } from '../../common/dates';
import { formatRupees, fromPaise, toPaise } from '../../common/money';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import type { CashAccount, Expense, ExpenseCategory } from '../../generated/prisma/client';
import type { CreateExpenseCategoryDto, RecordExpenseDto } from './expenses.dto';

/** The frontend treats an expense in this category as a payment to a vendor (matched by name, ignoring case). */
export const VENDOR_PAYMENT_CATEGORY = 'purchase payments';
export const isVendorPaymentCategory = (name: string): boolean => name.trim().toLowerCase() === VENDOR_PAYMENT_CATEGORY;

const ACCOUNTS_TTL_MS = 60_000;
const accountView = (row: CashAccount, owner: boolean) => ({
  id: row.id, name: row.name, kind: row.kind,
  ...(owner && { openingBalance: Number(row.openingBalance), openingDate: fromDbDate(row.openingDate) }),
});
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
  constructor(private readonly db: PrismaService, private readonly cache: OrgCache) {}

  /** Account names are for everyone (the expense form needs them); opening balances are the Owner's alone. */
  accounts(actor: Actor) {
    const owner = isOwner(actor);
    return this.cache.get(actor.organizationId, `accounts:${owner}`, ACCOUNTS_TTL_MS, async () => {
      const rows = await this.db.cashAccount.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } });
      return rows.map((row) => accountView(row, owner));
    });
  }

  categories(actor: Actor) {
    return this.cache.get(actor.organizationId, 'expense-categories', ACCOUNTS_TTL_MS, async () => {
      const rows = await this.db.expenseCategory.findMany({ where: { organizationId: actor.organizationId }, orderBy: { createdAt: 'asc' } });
      return rows.map(categoryView);
    });
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

  /** Owner and Manager see every expense; a salesperson sees the ones they recorded themselves. */
  async list(actor: Actor, limit: number, offset: number) {
    const rows = await this.db.expense.findMany({
      where: { organizationId: actor.organizationId, ...(!isManagement(actor) && { recordedByUserId: actor.userId }) }, include: INCLUDE,
      orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }], take: limit, skip: offset,
    });
    return rows.map(expenseView);
  }

  /**
   * One payment out of one account. A Purchase Payments expense must name its vendor. Paying more than is owed is allowed:
   * the extra is an advance with the vendor and the next bill uses it (see vendors/vendor-ledger.calc.ts).
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
        const vendor = await tx.vendor.findFirst({ where: { partyId: dto.vendorId, organizationId: actor.organizationId }, select: { party: { select: { name: true } } } });
        if (!vendor) throw new NotFoundException('Vendor not found');
        vendorName = vendor.party.name;
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
      const payee = vendorName ? ` to ${vendorName}` : '';
      await audit(tx, actor, {
        action: 'RECORD_EXPENSE', entity: 'EXPENSE', entityId: expense.id,
        details: `Expense ${category.name} of ${formatRupees(fromPaise(amountPaise))} paid from ${account.name}${payee}`,
      });
      return expense.id;
    }, TX_OPTIONS);
    const row = await this.db.expense.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    return expenseView(row);
  }
}
