# Development Setup

Requirements: Node 22 LTS or newer, npm, a Neon **development** branch (PostgreSQL 18) for running the app, and a local Postgres (17 is what the tests have run on) for `npm test`.
The uncommented `DATABASE_URL` in `.env` must be the dev branch; keep the production URL commented out and never run migrations or seeds against it by accident.

```bash
npm install
cp .env.example .env          # then fill JWT_ACCESS_SECRET (see the comment in the file)
```

Local Postgres on macOS (Homebrew): `brew install postgresql@17`, then create the databases:

```bash
createdb -h localhost -U postgres vedhaprem_dev
```

```bash
createdb -h localhost -U postgres vedhaprem_test
```

Apply migrations and load demo data (users `owner`, `manager`, `salesperson`, all with `SEED_USER_PASSWORD`):

```bash
npm run db:migrate
```

```bash
SEED_USER_PASSWORD='choose-a-dev-password' npm run db:seed
```

Run the API (build + watch) on `http://localhost:4000/api/v1`, Swagger at `http://localhost:4000/api/docs`:

```bash
npm run dev
```

## Frontend against this API

In `vedhapremshop/.env.local`:

```
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1
```

Keep `CORS_ORIGINS=http://localhost:3000` in the API `.env`. Leave the variable empty to return to the mock.

## Checks

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

`npm test` runs unit specs (`src/**/*.spec.ts`) and e2e specs (`test/*.e2e.spec.ts`) **serially** against
`DATABASE_URL_TEST`; e2e specs migrate it and truncate every table before each test. The harness refuses a URL that
does not contain `test`.

## Schema changes

1. Edit `prisma/schema.prisma`, then `npx prisma format && npx prisma validate`.
2. Generate the SQL against a scratch database (see `docs/architecture/database-design.md` → Migrations) and read it.
3. `npm run db:migrate` on the dev branch, `npm test`, commit schema + migration together.

## Integrity check on any database

```bash
DATABASE_URL=... npx tsx -e "import {PrismaPg} from '@prisma/adapter-pg';import {PrismaClient} from './src/generated/prisma/client';import {stockDrift,receivableDrift,counterCashDrift,purchaseDrift} from './src/database/reconciliation';const db=new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});Promise.all([stockDrift(db),receivableDrift(db),counterCashDrift(db),purchaseDrift(db)]).then(r=>{console.log(r);return db.\$disconnect()})"
```

Four empty arrays mean stock, receivables, counter cash and purchases reconcile.
