import { PrismaPg } from '@prisma/adapter-pg';
import { toDbDate } from '../common/dates';
import { type CashAccountKind, type CollectionCategory, type CostingExpenseKind, PrismaClient, type PurchaseExpenseType, type QualityGrade, type UserRole } from '../generated/prisma/client';
import { hashPassword } from '../modules/auth/passwords';
import fixture from './seeds/dev-fixture.json';

const OPENING_DATE = '2026-09-30';
const LEGACY_EXPENSE_NAMES: Record<string, string> = { FREIGHT: 'Freight', HAMALI: 'Hamali', MANDI_TAX: 'Mandi tax', COMMISSION: 'Commission', OTHER: 'Other' };

/**
 * Development data mirroring the frontend's mock seed, so screens look the same against the API.
 * Customer balances become OPENING ledger entries; lot balances become OPENING_STOCK movements, so the
 * stock and receivable reconciliations hold from the first row.
 */
export async function seedDevData(db: PrismaClient, password: string): Promise<{ organizationId: string }> {
  const passwordHash = await hashPassword(password);
  return db.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: {
      slug: 'vedhaprem-mandi', ...fixture.company, amaliPerBag: 20, marketFeePerBag: 10, amaliEnabled: true, marketFeeEnabled: true,
    } });
    const organizationId = org.id;
    await tx.documentSequence.createMany({ data: [
      { organizationId, kind: 'INVOICE', nextValue: 1085 },
      { organizationId, kind: 'RECEIPT', nextValue: 510 },
      { organizationId, kind: 'CUSTOMER', nextValue: fixture.customers.length + 1 },
      { organizationId, kind: 'VENDOR', nextValue: fixture.vendors.length + 1 },
    ] });

    const userIds = new Map<string, string>();
    for (const u of fixture.users) {
      const user = await tx.user.create({ data: { username: u.username.toLowerCase(), name: u.name, email: u.email, phone: u.phone, passwordHash } });
      await tx.membership.create({ data: { userId: user.id, organizationId, role: u.role as UserRole } });
      userIds.set(u.key, user.id);
    }
    const owner = fixture.users.find((u) => u.role === 'OWNER')!;

    const productIds = new Map<string, string>();
    for (const p of fixture.products) {
      const product = await tx.product.create({ data: { organizationId, code: p.code, name: p.name } });
      productIds.set(p.key, product.id);
    }
    await tx.mark.createMany({ data: fixture.marks.map((m) => ({
      organizationId, code: m.code.toUpperCase(), name: m.name, description: m.description,
      defaultSellingRate: m.defaultSellingRate, defaultPurchaseRate: m.defaultPurchaseRate,
      qualityGrade: m.qualityGrade as QualityGrade, colorTag: m.colorTag ?? null,
    })) });

    for (const c of fixture.customers) {
      const party = await tx.party.create({ data: { organizationId, name: c.name, phone: c.phone, email: c.email ?? '', address: c.address, location: c.marketLocation } });
      await tx.customer.create({ data: { partyId: party.id, organizationId, code: c.code, creditLimit: c.creditLimit, creditDays: c.creditDays } });
      if (c.openingBalance > 0) {
        await tx.customerLedgerEntry.create({ data: {
          organizationId, customerPartyId: party.id, entryDate: toDbDate(OPENING_DATE), type: 'OPENING', referenceNo: 'OPN-2026',
          description: 'Opening balance for season', debit: c.openingBalance,
        } });
      }
    }

    const vendorIds = new Map<string, string>();
    for (const v of fixture.vendors) {
      const party = await tx.party.create({ data: { organizationId, name: v.name, phone: v.phone, email: v.email ?? '', address: v.address, location: v.mandiCity } });
      await tx.vendor.create({ data: { partyId: party.id, organizationId, code: v.code } });
      vendorIds.set(v.key, party.id);
    }

    await tx.cashAccount.createMany({ data: fixture.cashAccounts.map((a) => ({ organizationId, name: a.name, kind: a.kind as CashAccountKind, openingBalance: a.openingBalance, openingDate: toDbDate(OPENING_DATE) })) });
    await tx.expenseCategory.createMany({ data: fixture.expenseCategories.map((c) => ({ organizationId, name: c.name, trackingCategory: c.trackingCategory as CollectionCategory | null })) });

    const expenseTypeIds = new Map<string, string>();
    for (const t of fixture.costingExpenseTypes) {
      const type = await tx.costingExpenseType.create({ data: { organizationId, name: t.name, kind: t.kind as CostingExpenseKind } });
      expenseTypeIds.set(t.key, type.id);
    }

    // Consignments already in the yard when the system starts: RECEIVED, with their stock carried as opening movements below.
    const purchaseIds = new Map<string, string>();
    for (const p of fixture.purchases) {
      const gross = p.items.reduce((t, i) => t + i.totalAmount, 0);
      const expenses = p.expenses.reduce((t, e) => t + e.amount, 0);
      const purchase = await tx.purchase.create({ data: {
        organizationId, billNumber: p.billNumber, vendorPartyId: vendorIds.get(p.vendorId)!, productId: productIds.get(p.productId)!,
        purchaseDate: toDbDate(p.date), lotNumber: p.lotNumber.toUpperCase(), notes: 'notes' in p ? (p.notes as string) : null,
        grossAmount: gross, totalExpenses: expenses, netAmount: gross + expenses,
        receiptStatus: 'RECEIVED', receivedAt: new Date(`${p.date}T00:00:00Z`),
        receivingRecord: { receivedAt: `${p.date}T00:00:00.000Z`, stockPosted: true, expenses: [], groups: [], issues: [] },
        createdByUserId: userIds.get(owner.key)!, createdByName: owner.name,
        items: { create: p.items.map((i, position) => ({ organizationId, position, markCode: i.markCode.toUpperCase(), bags: i.bags, weightKg: i.weightKg, ratePerKg: i.ratePerKg, totalAmount: i.totalAmount })) },
        expenses: { create: p.expenses.map((e, position) => ({
          organizationId, position, type: e.type as PurchaseExpenseType, amount: e.amount, description: e.description,
          expenseTypeId: 'expenseTypeId' in e ? (expenseTypeIds.get(e.expenseTypeId as string) ?? null) : null,
          expenseTypeName: 'expenseTypeName' in e ? (e.expenseTypeName as string) : LEGACY_EXPENSE_NAMES[e.type] ?? e.type,
        })) },
      } });
      purchaseIds.set(p.billNumber, purchase.id);
    }

    for (const l of fixture.lots) {
      const lot = await tx.lot.create({ data: {
        organizationId, lotNumber: l.lotNumber.toUpperCase(), productId: productIds.get(l.productId)!, vendorPartyId: vendorIds.get(l.vendorId)!,
        purchaseId: purchaseIds.get(l.purchaseBillNo) ?? null, purchaseBillNo: l.purchaseBillNo, arrivalDate: toDbDate(l.arrivalDate), notes: l.notes ?? null,
      } });
      for (const m of l.marks) {
        const mark = await tx.lotMark.create({ data: {
          organizationId, lotId: lot.id, markCode: m.markCode.toUpperCase(), initialBags: m.initialBags, initialWeightKg: m.initialWeightKg,
          remainingBags: m.remainingBags, remainingWeightKg: m.remainingWeightKg, purchaseRate: m.purchaseRate,
        } });
        if (m.remainingBags > 0 || m.remainingWeightKg > 0) {
          await tx.stockMovement.create({ data: {
            organizationId, lotMarkId: mark.id, type: 'OPENING_STOCK', bagsDelta: m.remainingBags, weightDeltaKg: m.remainingWeightKg,
            balanceBagsAfter: m.remainingBags, balanceWeightKgAfter: m.remainingWeightKg, referenceType: 'OPENING',
            reason: 'Opening stock carried into the system', movementDate: toDbDate(OPENING_DATE),
            performedByUserId: userIds.get(owner.key)!, performedByName: owner.name,
          } });
        }
      }
    }
    return { organizationId };
  }, { maxWait: 20_000, timeout: 120_000 });
}

if (require.main === module) {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  const url = process.env.DATABASE_URL;
  const password = process.env.SEED_USER_PASSWORD ?? '';
  if (!url) throw new Error('DATABASE_URL is required');
  if (password.length < 8) throw new Error('Set SEED_USER_PASSWORD (8+ characters) for the demo users');
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });
  db.organization.count()
    .then(async (existing) => {
      if (existing > 0) throw new Error('Database already has an organization; seed only an empty database');
      await seedDevData(db, password);
      console.log('Seeded demo organization. Users: owner, manager, salesperson');
    })
    .finally(() => db.$disconnect());
}
