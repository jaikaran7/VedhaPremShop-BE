import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { audit } from '../../common/audit';
import { type Actor, isOwner, isManagement } from '../../common/auth/actor';
import { OrgCache } from '../../common/cache';
import { daysBetween, fromDbDate, toDbDate } from '../../common/dates';
import { formatRupees, fromPaise, toPaise } from '../../common/money';
import { nextSequence } from '../../common/sequences';
import { type Db, type Tx, PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import type { CashAccount, Expense, ExpenseCategory } from '../../generated/prisma/client';
import { vendorTotals } from '../vendors/payables';
import { vendorMoney } from '../vendors/vendors.service';
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
function expenseView(row: ExpenseRow, money?: { remainingDue: number; previousDue?: number }) {
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
    ...(row.nextPaymentDate && { nextPaymentDate: fromDbDate(row.nextPaymentDate) }),
    ...(row.receiptNumber && { receiptNumber: row.receiptNumber }),
    ...(money && { remainingDue: money.remainingDue, previousDue: money.previousDue }),
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
    return rows.map((row) => expenseView(row));
  }

  async get(actor: Actor, id: string) {
    const row = await this.db.expense.findFirst({
      where: { id, organizationId: actor.organizationId, ...(!isManagement(actor) && { recordedByUserId: actor.userId }) },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException('Expense not found');
    const remainingDue = row.vendorPartyId ? await this.remainingDue(this.db, actor.organizationId, row.vendorPartyId) : undefined;
    return expenseView(row, remainingDue === undefined ? undefined : { remainingDue });
  }

  /**
   * One payment out of one account. A Purchase Payments expense must name its vendor. Paying more than is owed is allowed:
   * the extra is an advance with the vendor and the next bill uses it (see vendors/vendor-ledger.calc.ts).
   */
  async record(actor: Actor, dto: RecordExpenseDto) {
    const { id, previousDue } = await this.db.$transaction(async (tx) => {
      const category = await tx.expenseCategory.findFirst({ where: { id: dto.categoryId, organizationId: actor.organizationId } });
      if (!category) throw new NotFoundException('Expense category not found');
      const account = await tx.cashAccount.findFirst({ where: { id: dto.accountId, organizationId: actor.organizationId } });
      if (!account) throw new NotFoundException('Account not found');
      const amountPaise = toPaise(dto.amount);
      const vendorPayment = isVendorPaymentCategory(category.name);
      const vendorName = await this.resolveVendorPayment(tx, actor.organizationId, vendorPayment, dto);
      const receiptNumber = vendorPayment
        ? `${(await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId }, select: { receiptPrefix: true } })).receiptPrefix}-${await nextSequence(tx, actor.organizationId, 'RECEIPT')}`
        : null;
      const previousDue = vendorPayment && dto.vendorId ? await this.remainingDue(tx, actor.organizationId, dto.vendorId) : undefined;

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
        nextPaymentDate: dto.nextPaymentDate ? toDbDate(dto.nextPaymentDate) : null,
        receiptNumber,
        recordedByUserId: actor.userId,
        recordedByName: actor.name,
      } });
      const payee = vendorName ? ` to ${vendorName}` : '';
      await audit(tx, actor, {
        action: 'RECORD_EXPENSE', entity: 'EXPENSE', entityId: expense.id,
        details: `Expense ${category.name} of ${formatRupees(fromPaise(amountPaise))} paid from ${account.name}${payee}`,
      });
      return { id: expense.id, previousDue };
    }, TX_OPTIONS);
    const row = await this.db.expense.findUniqueOrThrow({ where: { id }, include: INCLUDE });
    const remainingDue = row.vendorPartyId ? await this.remainingDue(this.db, actor.organizationId, row.vendorPartyId) : undefined;
    return expenseView(row, remainingDue === undefined ? undefined : { remainingDue, previousDue });
  }

  private async resolveVendorPayment(tx: Tx, organizationId: string, vendorPayment: boolean, dto: RecordExpenseDto): Promise<string | null> {
    if (dto.nextPaymentDate && !vendorPayment) {
      throw new UnprocessableEntityException('A next payment date can only be set on a vendor payment.');
    }
    if (dto.nextPaymentDate && daysBetween(dto.date, dto.nextPaymentDate) < 0) {
      throw new UnprocessableEntityException('The next payment date cannot be before the payment date.');
    }
    if (!vendorPayment) {
      if (dto.vendorId) throw new UnprocessableEntityException('A vendor can only be attached to a Purchase Payments expense.');
      return null;
    }
    if (!dto.vendorId) throw new UnprocessableEntityException('Choose the vendor this payment is for.');
    const vendor = await tx.vendor.findFirst({ where: { partyId: dto.vendorId, organizationId }, select: { party: { select: { name: true } } } });
    if (!vendor) throw new NotFoundException('Vendor not found');
    return vendor.party.name;
  }

  private async remainingDue(db: Db, organizationId: string, vendorId: string) {
    const totals = await vendorTotals(db, organizationId, vendorId);
    const t = totals.get(vendorId);
    return vendorMoney(t?.openingPaise ?? 0, t?.billedPaise ?? 0, t?.paidPaise ?? 0).payableAmount;
  }
}
