# Deployment

Not deployed yet. This is the intended, tested-locally path.

## Topology

- **Frontend:** existing Vercel project (`vedhapremshop.vercel.app`). Set `NEXT_PUBLIC_API_BASE_URL=https://<api-host>/api/v1`.
- **API:** one long-running Node 22 container (Railway, Render, Fly.io or similar) in the same region as Neon.
  NestJS is not a good fit for per-request serverless functions: cold starts and one pool per invocation.
- **Database:** Neon project, PostgreSQL 18, production branch (`ep-round-bar`; **no migrations have been applied there yet**); use the **pooled** connection string with `sslmode=require`.

Cookies across `*.vercel.app` and another host are third-party cookies: set `COOKIE_CROSS_SITE=true` (SameSite=None;
Secure). Some browsers restrict third-party cookies; the robust option is a custom domain for both, e.g.
`app.example.com` and `api.example.com`, with `COOKIE_CROSS_SITE=false`.

## Environment (production)

| Variable | Value |
|---|---|
| NODE_ENV | production (disables Swagger, enables JSON logs and Secure cookies) |
| PORT | provided by host |
| DATABASE_URL | Neon pooled URL |
| DB_POOL_MAX | 5–10 per instance |
| JWT_ACCESS_SECRET | 48 random bytes, from the host's secret store |
| CORS_ORIGINS | `https://vedhapremshop.vercel.app` (comma-separate others) |
| COOKIE_CROSS_SITE | `true` unless frontend and API share a site |

## Release steps

```bash
npm ci && npm run typecheck && npm run lint && npm test && npm run build
```

```bash
DATABASE_URL="$NEON_PRODUCTION_URL" npm run db:migrate
```

Then start `node dist/main.js` and check `GET /api/v1/health/ready`. First release only: run
`npm run bootstrap:admin` with the `BOOTSTRAP_*` variables (see the script header). Never run `db:seed` in production
(it refuses).

Run migrations on a Neon branch copied from production first; promote only if the reconciliation check passes.

## Backups and recovery

Neon keeps point-in-time history (retention depends on plan). Recovery: create a branch at a timestamp before the
incident, verify with the reconciliation queries, then point `DATABASE_URL` at it or restore. Rehearse once before
go-live and record the time it took.

## Monitoring

- Liveness `GET /api/v1/health`, readiness `GET /api/v1/health/ready`.
- Logs are JSON with `requestId`; 5xx errors log the stack.
- Add an error tracker / APM (e.g. Sentry) when deployed; alert on 5xx rate and on any reconciliation drift (run
  the check nightly).

## Scaling notes

Rate-limit counters are in memory per instance: with more than one instance, move them to a shared store or rely on
the platform's edge rate limiting. Everything else is stateless.
