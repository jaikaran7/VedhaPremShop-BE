import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { hashPassword } from '../src/modules/auth/passwords';

/**
 * Creates the first organization and its Owner on an empty database. There is no default admin in code.
 *   BOOTSTRAP_ORG_NAME="Vedhaprem Mandi Onion Wholesalers" BOOTSTRAP_ORG_SLUG=vedhaprem-mandi \
 *   BOOTSTRAP_ADMIN_USERNAME=owner BOOTSTRAP_ADMIN_NAME="Vedhaprem Reddy" BOOTSTRAP_ADMIN_PASSWORD=... npm run bootstrap:admin
 * The password comes from the environment, not argv, so it stays out of shell history and process lists.
 */
async function main() {
  const env = process.env;
  const required = ['DATABASE_URL', 'BOOTSTRAP_ORG_NAME', 'BOOTSTRAP_ORG_SLUG', 'BOOTSTRAP_ADMIN_USERNAME', 'BOOTSTRAP_ADMIN_NAME', 'BOOTSTRAP_ADMIN_PASSWORD'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing: ${missing.join(', ')}`);
  if (env.BOOTSTRAP_ADMIN_PASSWORD!.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL!, max: 1 }) });
  try {
    if ((await db.organization.count()) > 0) throw new Error('An organization already exists. Add users from Settings instead.');
    const passwordHash = await hashPassword(env.BOOTSTRAP_ADMIN_PASSWORD!);
    await db.$transaction(async (tx) => {
      const org = await tx.organization.create({ data: { slug: env.BOOTSTRAP_ORG_SLUG!, shopName: env.BOOTSTRAP_ORG_NAME! } });
      const user = await tx.user.create({ data: { username: env.BOOTSTRAP_ADMIN_USERNAME!.toLowerCase(), name: env.BOOTSTRAP_ADMIN_NAME!, passwordHash } });
      await tx.membership.create({ data: { userId: user.id, organizationId: org.id, role: 'OWNER' } });
      await tx.auditLog.create({ data: {
        organizationId: org.id, userId: user.id, userName: user.name, userRole: 'OWNER',
        action: 'BOOTSTRAP', entity: 'ORGANIZATION', entityId: org.id, details: 'Organization and first owner created',
      } });
    });
    console.log(`Created organization ${env.BOOTSTRAP_ORG_SLUG} and owner ${env.BOOTSTRAP_ADMIN_USERNAME}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
