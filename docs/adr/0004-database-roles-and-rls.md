# ADR 0004: Database roles, Row-Level Security and connections

- Status: Accepted
- Date: 2026-10-25

## Context

Prisma connects to Postgres directly, so Supabase's Data-API-oriented RLS
(`auth.uid()`) does not apply to it. Supabase's `postgres` role has
`BYPASSRLS`; if the app connected as `postgres`, RLS would protect nothing.
The Data API (PostgREST) exposes the `public` schema to `anon` and
`authenticated` by default.

## Decision

**Schema.** Application tables live in `finora`, which is not listed in
`[api] schemas`. All privileges on it are revoked from `PUBLIC`, `anon`,
`authenticated`, `service_role` and `authenticator`; default privileges are
revoked too. Prisma's `_prisma_migrations` table is kept in `finora`
(`?schema=finora` on the migration URL) so it is not exposed via `public`.

**Roles.**
- Migration role (`postgres`): owns schema and tables; used only by
  `prisma migrate deploy` and operator scripts via `MIGRATION_DATABASE_URL`.
- Runtime role `finora_app`: `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB
  NOREPLICATION NOINHERIT`, no role memberships, owns nothing, no `CREATE` on
  any schema. It has `USAGE` on `finora`, `SELECT` on the identity tables and
  (in future migrations) exactly the DML each table needs. Role settings:
  `statement_timeout = 15s`, `idle_in_transaction_session_timeout = 30s`,
  empty `search_path`. The migration refuses to proceed if `finora_app` exists
  with unsafe attributes. Its password is set per environment by an operator;
  none is stored in migrations.

**RLS.** Enabled on every `finora` table (the migrations table is exempt and
has no grants). Because `finora_app` is not the table owner, policies apply
without `FORCE`. Context is passed with `set_config(name, value, true)`, i.e.
transaction-local:
- `withOwnerScope(owner, fn)` runs `fn` in a Prisma interactive transaction
  with `finora.owner_id` set; `finora.current_owner_id()` reads it.
- Owner resolution runs in a separate transaction with only
  `finora.auth_provider`/`finora.auth_subject` set, which reveals exactly the
  matching identity and owner row and nothing owner-scoped.
- No context → `NULL` → no rows. A malformed value raises an error.
- Every owner-scoped table must call `finora.apply_owner_isolation(table)` in
  its migration (one `FOR ALL` policy with matching `USING`/`WITH CHECK`).
  A catalog test fails if any `finora` table lacks RLS or any `owner_id`
  table lacks the `owner_isolation` policy.

**Isolation from app code.** Only `src/server/db/**` may import the Prisma
client, adapter, scope helpers or `pg` (ESLint-enforced). Application code
uses `withOwnerScope()` and must pass an `AuthorizedOwner`.

**Connections.**
- Runtime (`DATABASE_URL`): production uses the Supavisor **transaction**
  pooler (port 6543, user `finora_app.<project-ref>`), small per-instance pool
  (`DATABASE_POOL_MAX`, default 5). Transaction-local settings are safe under
  transaction pooling because they end with the transaction.
- Migrations (`MIGRATION_DATABASE_URL`): direct connection or session pooler,
  as `postgres`, with `?schema=finora`.
- `DATABASE_URL` must authenticate as `finora_app` (validated at startup).

## Threat model and limits

RLS here is defence in depth against application bugs (a missing filter, a
wrong id), not against a stolen `finora_app` password: anyone who can run SQL
as `finora_app` can also set the context variables. The `finora_app`
credential is therefore a secret held only in the hosting environment.

## Verification

`npm run test:integration` (real local Postgres) checks role attributes,
grants, Data API exposure, constraints, owner resolution, read/insert/update/
delete isolation on an owner-scoped probe table, context non-leakage on a
reused pooled connection, and the schema-wide catalog guards. A manual
mutation check (temporarily disabling RLS on `finora.owners`) made six of
these tests fail, as intended.

## Not yet verified

- Supavisor accepting the `finora_app.<ref>` user on the hosted project, and
  interactive transactions through the hosted transaction pooler.
- The hosted project's grants/role attributes; run the catalog checks in
  `docs/runbooks/hosted-setup.md` after the first deployment.
