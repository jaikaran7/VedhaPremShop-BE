import { Injectable, NotFoundException } from '@nestjs/common';
import { audit } from '../../common/audit';
import type { Actor } from '../../common/auth/actor';
import { OrgCache } from '../../common/cache';
import { businessTime, fromDbDate, toDbDate } from '../../common/dates';
import { formatRupees, fromPaise, toPaise } from '../../common/money';
import { PrismaService, TX_OPTIONS } from '../../database/prisma.service';
import type { CashAccount, CashAccountKind } from '../../generated/prisma/client';
import type { SetOpeningBalanceDto } from './expenses.dto';

const BOOK_TTL_MS = 30_000;

/** Same routing as the frontend's accountForMethod: UPI/QR → UPI account, bank/cheque/card → bank, everything else → cash. */
export function accountKindFor(method: string): CashAccountKind {
  if (method === 'UPI' || method === 'QR') return 'UPI';
  if (method === 'BANK_TRANSFER' || method === 'CHEQUE' || method === 'CARD') return 'BANK';
  return 'CASH';
}

/** The account that takes a payment of this kind: the first of that kind, else the first bank, else the first cash account. */
export function routeAccount(kind: CashAccountKind, accounts: Pick<CashAccount, 'id' | 'kind'>[]): string | null {
  return accounts.find((a) => a.kind === kind)?.id ?? accounts.find((a) => a.kind === 'BANK')?.id ?? accounts.find((a) => a.kind === 'CASH')?.id ?? null;
}

export interface DayFlow {
  receivedPaise: number;
  paidPaise: number;
}

/**
 * One account on one day: opening + received − paid out = closing, and the closing balance is the next day's opening.
 * `flows` maps day → money in/out for this account. Only days from the opening date on count, so a receipt or expense
 * entered later for an earlier day moves every later opening and closing balance by itself (nothing is stored per day).
 */
export function accountDay(account: { openingPaise: number; openingDate: string }, flows: Map<string, DayFlow>, date: string) {
  if (date < account.openingDate) return { beforeOpening: true, openingPaise: 0, receivedPaise: 0, paidPaise: 0, closingPaise: 0 };
  let opening = account.openingPaise;
  for (const [day, flow] of flows) if (day >= account.openingDate && day < date) opening += flow.receivedPaise - flow.paidPaise;
  const today = flows.get(date) ?? { receivedPaise: 0, paidPaise: 0 };
  return { beforeOpening: false, openingPaise: opening, receivedPaise: today.receivedPaise, paidPaise: today.paidPaise, closingPaise: opening + today.receivedPaise - today.paidPaise };
}

@Injectable()
export class CashBookService {
  constructor(private readonly db: PrismaService, private readonly cache: OrgCache) {}

  /** Owner only: set what is really in an account at the start of a day. Balances move on from there. */
  async setOpening(actor: Actor, id: string, dto: SetOpeningBalanceDto) {
    return this.db.$transaction(async (tx) => {
      const found = await tx.cashAccount.findFirst({ where: { id, organizationId: actor.organizationId } });
      if (!found) throw new NotFoundException('Account not found');
      const row = await tx.cashAccount.update({ where: { id }, data: { openingBalance: dto.openingBalance, openingDate: toDbDate(dto.openingDate) } });
      await audit(tx, actor, {
        action: 'SET_ACCOUNT_OPENING', entity: 'ACCOUNT', entityId: id,
        details: `${found.name} opening balance set to ${formatRupees(dto.openingBalance)} from ${dto.openingDate} (was ${formatRupees(Number(found.openingBalance))} from ${fromDbDate(found.openingDate)})`,
      });
      return { id: row.id, name: row.name, kind: row.kind, openingBalance: Number(row.openingBalance), openingDate: fromDbDate(row.openingDate) };
    }, TX_OPTIONS);
  }

  /** Owner only. Opening, money in, money out and closing for every account on `date`, plus that day's entries. */
  book(actor: Actor, date: string) {
    return this.cache.get(actor.organizationId, `cash-book:${date}`, BOOK_TTL_MS, () => this.buildBook(actor, date));
  }

  private async buildBook(actor: Actor, date: string) {
    const org = actor.organizationId;
    const day = toDbDate(date);
    const [accounts, receiptDays, expenseDays, receipts, expenses, timezone] = await Promise.all([
      this.db.cashAccount.findMany({ where: { organizationId: org }, orderBy: { createdAt: 'asc' } }),
      this.db.$queryRaw<{ kind: CashAccountKind; day: Date; total: unknown }[]>`
        SELECT CASE WHEN method IN ('UPI', 'QR') THEN 'UPI' WHEN method IN ('BANK_TRANSFER', 'CHEQUE', 'CARD') THEN 'BANK' ELSE 'CASH' END AS kind,
               received_on AS day, sum(amount) AS total
        FROM payments WHERE organization_id = ${org}::uuid AND received_on <= ${date}::date GROUP BY 1, 2`,
      this.db.expense.groupBy({ by: ['accountId', 'expenseDate'], where: { organizationId: org, expenseDate: { lte: day } }, _sum: { amount: true } }),
      this.db.payment.findMany({
        where: { organizationId: org, receivedOn: day },
        select: { id: true, receiptNumber: true, customerName: true, amount: true, method: true, referenceNumber: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.expense.findMany({
        where: { organizationId: org, expenseDate: day },
        select: { id: true, amount: true, paymentMethod: true, reference: true, createdAt: true, category: { select: { name: true } }, vendorParty: { select: { name: true } }, account: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.organization.findUniqueOrThrow({ where: { id: org }, select: { timezone: true } }),
    ]);

    const flows = new Map<string, Map<string, DayFlow>>(accounts.map((a) => [a.id, new Map()]));
    const flowOf = (accountId: string, dayKey: string): DayFlow | undefined => {
      const byDay = flows.get(accountId);
      if (!byDay) return undefined;
      const flow = byDay.get(dayKey) ?? { receivedPaise: 0, paidPaise: 0 };
      byDay.set(dayKey, flow);
      return flow;
    };
    for (const row of receiptDays) {
      const flow = flowOf(routeAccount(row.kind, accounts) ?? '', fromDbDate(row.day));
      if (flow) flow.receivedPaise += toPaise(Number(row.total));
    }
    for (const row of expenseDays) {
      const flow = flowOf(row.accountId, fromDbDate(row.expenseDate));
      if (flow) flow.paidPaise += toPaise(Number(row._sum.amount ?? 0));
    }

    const rows = accounts.map((a) => {
      const d = accountDay({ openingPaise: toPaise(Number(a.openingBalance)), openingDate: fromDbDate(a.openingDate) }, flows.get(a.id)!, date);
      return { id: a.id, name: a.name, kind: a.kind, openingDate: fromDbDate(a.openingDate), beforeOpening: d.beforeOpening, d };
    });
    const sum = (pick: (d: (typeof rows)[number]['d']) => number) => fromPaise(rows.reduce((t, r) => t + pick(r.d), 0));
    return {
      date,
      accounts: rows.map((r) => ({
        id: r.id, name: r.name, kind: r.kind, openingDate: r.openingDate, beforeOpening: r.beforeOpening,
        openingBalance: fromPaise(r.d.openingPaise), received: fromPaise(r.d.receivedPaise), paidOut: fromPaise(r.d.paidPaise), closingBalance: fromPaise(r.d.closingPaise),
      })),
      totals: { openingBalance: sum((d) => d.openingPaise), received: sum((d) => d.receivedPaise), paidOut: sum((d) => d.paidPaise), closingBalance: sum((d) => d.closingPaise) },
      entries: [
        ...receipts.map((p) => ({
          id: p.id, type: 'Collection' as const, time: businessTime(timezone.timezone, p.createdAt), party: p.customerName, method: p.method,
          reference: p.receiptNumber, amount: Number(p.amount), createdAt: p.createdAt.toISOString(),
        })),
        ...expenses.map((e) => ({
          id: e.id, type: (e.vendorParty ? 'Vendor payment' : 'Expense') as 'Vendor payment' | 'Expense', time: businessTime(timezone.timezone, e.createdAt),
          party: e.vendorParty?.name ?? e.category.name, method: e.paymentMethod, reference: e.reference ?? e.account.name, amount: -Number(e.amount), createdAt: e.createdAt.toISOString(),
        })),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    };
  }

  /** Everyone: the money collected on one day (receipts net of refunds), by payment method. No balances. */
  async dailyCollections(actor: Actor, date: string) {
    const rows = await this.db.payment.groupBy({ by: ['method'], where: { organizationId: actor.organizationId, receivedOn: toDbDate(date) }, _sum: { amount: true }, _count: true });
    const byMethod = rows.map((r) => ({ method: r.method, amount: Number(r._sum.amount ?? 0), receipts: r._count }));
    return { date, collected: fromPaise(byMethod.reduce((t, m) => t + toPaise(m.amount), 0)), byMethod };
  }
}


