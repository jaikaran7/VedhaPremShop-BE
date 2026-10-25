# Security Model

## Authentication

| Control | Implementation | Where |
|---|---|---|
| Password storage | scrypt N=2^15, r=8, p=1, 16-byte salt, 64-byte key; parameters stored with the hash | `modules/auth/passwords.ts` |
| Login | Case-insensitive username; constant work for unknown users (dummy hash); one generic 401 message | `auth.service.ts` |
| Access token | HS256 JWT, 15 min (`ACCESS_TOKEN_TTL_SECONDS`), claims `sub, org, role, name`; secret ≥ 32 chars | `auth.service.ts`, `config/env.ts` |
| Refresh token | 32 random bytes, stored as sha256, 30 days, **rotated on every use**; replay of a used token revokes the whole family | `auth.service.ts` |
| Browser storage | httpOnly cookies only: `vp_access` (path `/`), `vp_refresh` (path `/api/v1/auth`); `Secure` in production or cross-site; `SameSite=Lax`, or `None` when `COOKIE_CROSS_SITE=true` | `auth.controller.ts` |
| CSRF | Cookie-authenticated writes require `X-Requested-With`; CORS allowlist (`CORS_ORIGINS`) with credentials | `common/auth/auth.guard.ts`, `app.ts` |
| Rate limits | login 10/min, refresh 30/min, change-password 5/min, everything else 300/min per client IP | `@Throttle`, `app.module.ts` |
| Revocation | logout, password change, deactivation, role change and owner reset revoke refresh tokens | auth/users services |
| First admin | `npm run bootstrap:admin` on an empty database; password from env (≥ 12 chars), never argv; no default credentials anywhere in code | `scripts/bootstrap-admin.ts` |

Known gap: an access token stays valid up to 15 minutes after deactivation (no per-request user lookup). Lower the
TTL or add a `token_version` check if that window is unacceptable.

## Authorization

Global `AuthGuard` verifies the token, then the route's `@Roles(...)`. Matrix (mirrors `src/auth/permissions.ts`
in the frontend):

| Capability | Owner | Manager | Salesperson |
|---|---|---|---|
| Bills, receipts, customers (create, contact edits) | ✓ | ✓ | ✓ |
| Customer credit terms/status, delete customer | ✓ | ✓ | — |
| Stock adjustments, opening stock | ✓ | ✓ | — |
| Bill dated another day | ✓ posts at once | ✓ posts at once | ✓ posts at once |
| Cancel / rebill a bill | ✓ applies at once | request → Owner | request → Owner |
| See the approval queue | ✓ | ✓ (read) | ✓ (read) |
| Decide an approval | ✓ | — | — |
| Vendors, purchases and receiving, reports, costing settings (read), audit, users list | ✓ | ✓ | — |
| Settings (company, charges, marks, products, costing writes), user management | ✓ | — | — |
| See purchase rates / costs | ✓ | ✓ | — (fields omitted from responses) |

Resource level: every query is scoped by `organization_id` from the token; foreign ids resolve to 404.
Isolation is tested (`test/auth.e2e.spec.ts › organization isolation`). Postgres RLS is the planned second layer
before onboarding a second tenant (`system-architecture.md`).

## Input and output

- `ValidationPipe({ whitelist: true, transform: true })` on every DTO; numeric precision and ranges enforced;
  JSON body limit 256 kB.
- Responses are mapped explicitly; password hashes and refresh tokens are never serialized (tested).
- The error filter returns a generic message for 500s and logs the stack with the request id.

## Data integrity as a security property

Append-only triggers on stock movements, receivable ledger, payment allocations and audit logs: even a
compromised app path cannot silently rewrite history; corrections are new rows.

## Audit events

LOGIN, CHANGE_PASSWORD, CREATE_USER, UPDATE_USER, UPDATE_SETTINGS, CREATE/UPDATE_MARK, CREATE/UPDATE_PRODUCT,
CREATE/UPDATE/DELETE_CUSTOMER, UPDATE_CUSTOMER_CREDIT, CREATE/UPDATE_VENDOR, STOCK_ADJUSTMENT, OPENING_STOCK,
CREATE_SALE, CANCEL_SALE, SALE_CORRECTION_NOTED, RECORD_PAYMENT, BOOTSTRAP. Written in the same transaction as the
change. No secrets in details or metadata.

## Secrets and configuration

`.env` is git-ignored; `.env.example` has no values. Production secrets live in the host's secret store.
Generate `JWT_ACCESS_SECRET` with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
Rotating it signs everyone out within 15 minutes (refresh still works because refresh tokens are opaque).

## Dependency advisories (npm audit, production deps, 2026-10-25)

| Package | Severity | Exposure here |
|---|---|---|
| multer (via @nestjs/platform-express) | high, DoS in fileFilter | No multipart routes exist; not reachable. Patched multer 2.5.0 was published 3 days ago — add an `overrides` entry after a short cool-down. |
| js-yaml (via @nestjs/swagger) | moderate, CPU on crafted YAML | Swagger only runs outside production and only serializes our own spec. |
