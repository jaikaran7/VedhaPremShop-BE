# Backend Development Standards (Mandatory)

These rules apply to every change to this backend, every time, without being asked. Before generating or modifying any code, analyze the
existing codebase and follow the project's architecture, folder structure, naming conventions, coding style, response format, logging
mechanism, validation approach, Swagger standards, dependency injection pattern, repository pattern, and error handling strategy.

**Finish every task by running `npm run typecheck && npm run lint && npm test && npm run build`** and walking through the Final Review Checklist
at the bottom. `npm run lint` includes the SonarQube-style rules (`eslint-plugin-sonarjs`); a change that adds a lint error is not finished.

## How this project already does things (follow these, do not invent new patterns)

| Topic | The project's pattern |
|---|---|
| Stack | NestJS 11, Prisma 7 (`PrismaService`), PostgreSQL, Jest. Modules in `src/modules/<name>/` with `*.controller.ts`, `*.service.ts`, `*.dto.ts`, `*.module.ts`; pure business rules in `*.calc.ts` with a `*.spec.ts` beside them |
| Data access | Services use `PrismaService` directly (no separate repository classes). Raw SQL (`$queryRaw`) only for row locks, conditional updates and aggregates. Always inside `this.db.$transaction(…, TX_OPTIONS)` when several rows must change together |
| Money and weight | Integer paise (`toPaise`/`fromPaise`) and grams (`toGrams`); never floats for authoritative amounts. Helpers live in `src/common/money.ts` |
| Response format | The API returns the shapes the frontend already uses (plain arrays/objects, no wrapper); do not add a wrapper. Errors always use `AllExceptionsFilter`: `{ statusCode, error, message, requestId }`. Lists that need a total return it in the `X-Total-Count` header |
| Errors | Throw Nest exceptions: 400 shape (class-validator), 401/403 auth, 404 not found (also for another organization's record), 409 conflict/duplicate/stale, 422 business rule |
| Validation | Every body, query and path parameter is validated: class-validator DTOs under a global whitelist `ValidationPipe`, `ParseUUIDPipe` for ids, `@IsIsoDate()` (`src/common/http/is-iso-date.ts`, rejects impossible dates such as 2026-02-30) for dates, bounded numbers with decimal limits, `IsIn` for enums. Query lists extend `ListQueryDto` (limit ≤ 5000) |
| Auth | Global `AuthGuard`; roles via `@Roles()` / `@Management()`; `organization_id` comes from the token only, never from the request |
| Logging | `AuditLog` rows written inside the business transaction with `audit()` for every business action; `RequestLogInterceptor` logs every write request as structured JSON; `AllExceptionsFilter` logs failures. Never log passwords, tokens, secrets, request bodies or customer details |
| Delete | Posted money, stock and purchase history is never deleted: corrections are new rows or recorded revisions (database triggers enforce it). Only masters with no history may be deleted |
| Listing order | Newest first (`createdAt`/date descending) as the frontend expects; lists are bounded, never unbounded |
| Swagger | `@ApiTags` and `@ApiStandardErrors()` on every controller class; `@ApiEndpoint(summary, description, status?)` on every method (wraps `@ApiOperation` + the success response; all in `src/common/http/swagger.ts`); plus `@ApiProperty`/`@ApiPropertyOptional` with `example`/`description` on DTOs |
| Caching | `OrgCache` (per organization, in memory, no Redis) for read-mostly data; cleared by `CacheInvalidationInterceptor` on any write. A writer that re-reads its own data must call `cache.invalidate` first |
| N+1 | Fixed number of queries per endpoint, proven by a query-count test (`PrismaService.queryCount`) when an endpoint reads collections |
| Migrations | `prisma/migrations`, generated against a scratch database, with CHECK constraints and triggers appended by hand; never `db push`/`migrate reset` on shared databases |
| Safety | Never touch the production database (`ep-round-bar`); run tests only against the local test database; never `source` `.env` |

## Code Quality Standards

* Follow SOLID principles.
* Follow Clean Code principles.
* Follow DRY (Don't Repeat Yourself).
* Avoid code duplication.
* Reuse existing services, helpers, utilities, constants, validators, repositories, and common functions whenever possible.
* Keep methods small and focused on a single responsibility.
* Prefer composition over duplication.
* Use meaningful and consistent naming conventions.
* Avoid hardcoded values; use constants, enums, or configuration values.
* Remove all unused imports, variables, methods, interfaces, and dependencies.
* Ensure code is production-ready.

## SonarQube Compliance (Mandatory)

Generated code must not introduce new SonarQube issues.

### Cognitive Complexity

* Keep functions and methods simple.
* Refactor large methods into smaller private/helper methods.
* Use early returns where possible.
* Avoid deeply nested if/else statements.
* Avoid excessive switch-case complexity.

### Async/Await

* Properly await all asynchronous operations.
* Do not ignore returned promises.
* Do not assign Promise-returning functions where a void-returning callback is expected.
* Handle async errors appropriately.

### Logging

* Never interpolate objects directly into template strings.
* Use structured logging or JSON.stringify() where appropriate.
* Log meaningful context only.
* Do not log sensitive information.

### Null Safety

* Handle null and undefined values safely.
* Validate external inputs before processing.
* Use optional chaining and null checks where appropriate.

### Maintainability

* Avoid duplicate logic.
* Extract reusable code into helper methods or shared services.
* Reduce method complexity.
* Keep class responsibilities focused.

### Reliability

* Handle all possible failure scenarios.
* Add proper exception handling.
* Validate external dependencies and responses.

### Security

* Never expose secrets, tokens, passwords, or credentials.
* Validate and sanitize user input.
* Prevent injection vulnerabilities.
* Follow project security standards.

## Validation Standards

* Validate all request payloads.
* Validate path parameters.
* Validate query parameters.
* Validate required fields.
* Validate enums and allowed values.
* Validate data types.
* Validate lengths, formats, and ranges where applicable.
* Return standardized validation errors consistent with the project.

## Logging Standards

Follow the project's existing logging implementation.

Log:

* Create operations
* Update operations
* Delete operations
* Business-critical actions
* Warnings
* Exceptions
* External API failures
* Database failures

Do not:

* Log passwords
* Log secrets
* Log tokens
* Log sensitive customer information

Use consistent log levels:

* INFO
* WARN
* ERROR
* DEBUG (only when project standard allows)

## Error Handling Standards

Follow the project's existing exception handling pattern.

Handle:

* Validation failures
* Record not found
* Duplicate records
* Database exceptions
* External service failures
* Authorization failures
* Unexpected exceptions

Return standardized error responses.

## CRUD Standards

For every CRUD module:

### Create

* Validate input.
* Check business rules.
* Log successful creation.

### Get By Id

* Return standardized response.
* Handle not-found scenarios.

### Get All

* Exclude soft-deleted records.
* Support pagination if project supports it.
* Support filtering if project supports it.
* Order by primary key descending unless project standard differs.

### Update

* Validate input.
* Check record existence.
* Log update activity.

### Delete

* Use soft delete if the project follows soft-delete architecture.
* Never physically delete records unless the project explicitly uses hard deletes.
* Exclude deleted records from retrieval APIs.

## Swagger Standards

Document all APIs.

Include:

* Summary
* Description
* Request examples
* Response examples
* Query parameters
* Path parameters
* Validation requirements
* Error responses

Follow existing Swagger conventions in the project.

## Response Standards

Use the project's existing response wrapper.

Ensure:

* Consistent success responses.
* Consistent error responses.
* Proper HTTP status codes.
* Standardized response structure.

## Database Standards

* Follow existing ORM patterns.
* Reuse repositories/services.
* Avoid N+1 query problems.
* Select only required fields.
* Optimize queries.
* Use transactions where required.
* Follow existing migration and schema conventions.

## Final Review Checklist

Before generating code:

* No SonarQube issues.
* No code duplication.
* No unused imports.
* No unused variables.
* No unused methods.
* No cognitive complexity violations.
* No Promise handling violations.
* No object stringification warnings.
* Proper validation implemented.
* Proper logging implemented.
* Proper error handling implemented.
* Swagger documentation included.
* Consistent response format.
* Production-ready code.
* Consistent with existing project architecture.
