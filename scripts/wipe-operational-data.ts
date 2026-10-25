import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/** Transactional tables only. Users, organization, products, marks, accounts and categories stay. */
const OPERATIONAL_TABLES = [
  'payment_allocations',
  'payments',
  'customer_ledger_entries',
  'sale_items',
  'sales',
  'purchase_revisions',
  'purchase_expenses',
  'purchase_items',
  'purchases',
  'stock_movements',
  'lot_marks',
  'lots',
  'expenses',
  'approvals',
  'audit_logs',
  'customers',
  'vendors',
  'parties',
] as const;

function assertSafeTarget(url: string): void {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to wipe a production environment');
  if (url.includes('ep-round-bar')) throw new Error('Refusing to wipe the production database');
}

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('DATABASE_URL is required');
  assertSafeTarget(url);

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });
  try {
    const quoted = OPERATIONAL_TABLES.map((name) => `"${name}"`).join(', ');
    await db.$executeRawUnsafe(`TRUNCATE ${quoted} CASCADE`);
    await db.$executeRawUnsafe(`UPDATE cash_accounts SET opening_balance = 0`);
    await db.$executeRawUnsafe(`UPDATE document_sequences SET next_value = 1 WHERE kind IN ('CUSTOMER', 'VENDOR', 'INVOICE', 'RECEIPT')`);
    const leftover = await db.$queryRaw<{ customers: number; vendors: number; lots: number; sales: number; payments: number; expenses: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM customers) AS customers,
        (SELECT COUNT(*)::int FROM vendors) AS vendors,
        (SELECT COUNT(*)::int FROM lots) AS lots,
        (SELECT COUNT(*)::int FROM sales) AS sales,
        (SELECT COUNT(*)::int FROM payments) AS payments,
        (SELECT COUNT(*)::int FROM expenses) AS expenses`;
    console.log('Cleared operational data.', leftover[0]);
    console.log('Kept users, organization, products, marks, cash accounts and expense categories.');
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
