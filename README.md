# Finora

Private, double-entry personal finance PWA. Currently at **Milestone 4B:
financial accounts and basic transactions** (bank and cash accounts, opening
balances, income, expenses and transfers), built on the double-entry ledger
core (Milestone 3) and the database/auth foundation (Milestone 2). Sign-in
uses **email and password**; Google OAuth (Milestone 4A) is deferred.

Architecture and decisions: [`docs/adr/`](docs/adr/). Operations:
[`docs/runbooks/`](docs/runbooks/).

## Requirements

- Node.js 24.22.1 exactly (see `.nvmrc`). `npm install`/`npm ci` refuse any
  other version (`engine-strict` in `.npmrc`), and a unit test fails on one:
  account-name comparison keys depend on Node's Unicode data (ADR 0007). With
  a version manager: `nvm use` or `fnm use`.
- npm. The committed `package-lock.json` is the source of truth.
- Docker (for the local Supabase stack). The Supabase CLI is a pinned dev
  dependency; use it through `npx supabase` / the npm scripts.

## First-time setup

```bash
npm ci                          # also runs `prisma generate`
npm run db:local:start          # local Supabase on ports 55321-55329 (first run pulls images)
npm run db:local:setup          # apply migrations, enable the local finora_app login
npx playwright install chromium # for e2e tests (add --with-deps on Debian/Ubuntu)
```

Then create `.env.local` from `.env.example` for `npm run dev`:

| Variable | Local value |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | `http://localhost:3000` |
| `SUPABASE_URL` | "API URL" from `npx supabase status` |
| `SUPABASE_PUBLISHABLE_KEY` | "Publishable" key from `npx supabase status` (never the secret key) |
| `DATABASE_URL` | `postgresql://finora_app:<password>@127.0.0.1:55322/postgres`, local-only password in `scripts/lib/local-supabase.mjs` |
| `DATABASE_POOL_MAX` | optional, default 5 |

`MIGRATION_DATABASE_URL` and `SUPABASE_SECRET_KEY` are operator-only and are
never needed by the app. Local db scripts and all tests read the local stack
directly from `supabase status`; they do not use `.env` files and refuse
non-loopback targets.

## Sign-in (email and password; Google deferred)

The only way in is the owner's email and password. There is no public
sign-up and no email-based reset. A correct password alone never grants
access: an operator explicitly approves the account and maps it to the owner.
Design: [ADR 0003](docs/adr/0003-authentication-and-owner-identity.md).
Operations (provisioning, rotation, hosted settings):
[`docs/runbooks/owner-access.md`](docs/runbooks/owner-access.md).

Provision a local owner. The password is typed at a hidden prompt, never
passed as an argument:

```bash
npm run owner:provision -- prepare      --local --email you@example.com
npm run owner:provision -- set-password --local --email you@example.com
npm run owner:provision -- complete     --local --email you@example.com
npm run dev   # sign in at http://localhost:3000
```

Rotate the password with `set-password` again (this ends all sessions).
`relink` moves the owner to a different account and keeps its data; `cancel`
deletes a prepared user that was never completed. To bring Google back, see
"Restoring Google OAuth" in ADR 0003.

Production values are set in the hosting provider's environment settings;
see [`docs/runbooks/hosted-setup.md`](docs/runbooks/hosted-setup.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server at http://localhost:3000 |
| `npm run lint` | ESLint (zero warnings), incl. domain and infrastructure import boundaries |
| `npm run typecheck` | Generate Next.js route types, then `tsc --noEmit` |
| `npm test` | Unit and component tests (no database or credentials needed) |
| `npm run test:coverage` | Unit tests with coverage; enforces ≥95% on `src/domain/money`, `src/domain/ledger` and `src/domain/finance` |
| `npm run test:integration` | Real Postgres + Supabase Auth tests (needs the local stack) |
| `npm run build` | Production build (no secrets needed) |
| `npm start` | Serve the production build |
| `npm run test:e2e` | Playwright against the production build + local stack (`npm run build` first) |
| `npm run check` | Lint, typecheck, coverage and build |

## Accounts and transactions

- `/accounts`: bank and cash accounts with balances derived from posted
  journal lines (never stored). Create one with an optional opening balance,
  which is posted against opening-balance equity, not recorded as income.
  Edit the name or type; archive (history kept), restore, or delete one that
  has no history.
- `/transactions/new`: record income, an expense, or a transfer. The browser
  submits intent only; server-side templates build the journal lines.
- `/transactions`: history with search and filters (date, type, account,
  category). Each transaction can have its payee or note edited, or be voided
  through a ledger reversal. Opening balances are corrected from the account
  page (reversal plus replacement).
- `/categories`: income and expense categories; a new owner can add a
  default set with one click (pages never create categories by themselves).

Amounts are typed as decimals, parsed exactly, and shown in `en-IN` format;
INR is the default currency. The accounting treatment is in
[ADR 0006](docs/adr/0006-accounts-and-transactions.md).

## Ledger

`src/domain/ledger` (pure rules) and `src/server/ledger` (the application
service and the in-transaction `ledgerOperations` that the finance service
composes) implement a double-entry ledger: ledger accounts, draft and posted
journal entries, positive minor-unit amounts with explicit debit/credit sides,
per-currency balancing, idempotent posting, reversals and atomic corrections.
Posted history is immutable and balances are always derived from posted
lines. PostgreSQL enforces the invariants as well (deferred balancing
triggers, immutability triggers, owner-scoped composite keys, RLS). Design:
[ADR 0005](docs/adr/0005-double-entry-ledger.md).

Server code calls it with the owner from `requireOwner()`:

```ts
import { ledger } from "@/server/ledger";

const owner = await requireOwner();
await ledger.postEntry(owner, {
  idempotencyKey: "salary-2026-10",
  entryDate: "2026-10-25",
  description: "October salary",
  lines: [
    { accountId: bank.id, side: "debit", amount: "50000.00", currency: "INR" },
    { accountId: salary.id, side: "credit", amount: "50000.00", currency: "INR" },
  ],
});
```

No route or server action exposes the ledger directly; user-facing features
go through `src/server/finance` and its posting templates. To work on it:

```bash
npm run db:local:setup      # apply the ledger migration locally
npm run db:local:drift      # schema.prisma and migrations agree
npm test -- src/domain/ledger
npx vitest run --config vitest.integration.config.mts tests/integration/ledger-*.test.ts tests/integration/finance-*.test.ts
```

## Database workflow (local)

| Command | What it does |
| --- | --- |
| `npm run db:local:start` / `db:local:stop` | Start / stop the local stack (data volumes are kept) |
| `npm run db:local:setup` | Apply pending migrations; enable the local `finora_app` login |
| `npm run db:local:status` | Show migration status |
| `npm run db:local:new -- <name>` | Create a migration from `schema.prisma` changes without applying it; review and add RLS (`finora.apply_owner_isolation`) and constraints by hand |
| `npm run db:local:drift` | Fail if migrations and `schema.prisma` disagree (uses a throwaway shadow database) |
| `npm run db:local:reset -- --yes` | **Deletes all local data**, then re-applies migrations |
| `npm run db:account-names -- <conflicts\|verify> --local` | Read-only account-name checks with the app's own canonicalisation; prints ids, never names (ADR 0007) |
| Studio | http://127.0.0.1:55323 (inspect tables) |

Rules (catalog tests in `tests/integration/db-roles-and-grants.test.ts`
enforce them): every new owner-scoped table has an `owner_id` column and calls
`finora.apply_owner_isolation(...)` in its migration; foreign keys between
owner-scoped tables include `owner_id` on both sides; unique indexes on
owner-scoped tables include `owner_id`; functions pin `search_path`; and
`finora_app` gets only the DML it needs (the exact grant list is pinned, so
update the test when you add a grant). Never point local scripts at a
hosted database; hosted migrations use `npm run db:migrate:deploy` with
`MIGRATION_DATABASE_URL` supplied in the shell (see the hosted runbook).
Backups: [`docs/runbooks/backup-and-restore.md`](docs/runbooks/backup-and-restore.md).

## Testing safely

- Unit tests use fakes and need nothing running.
- Integration and e2e tests create uniquely named users/owners (`itest-*`,
  `e2e-*`) in the **local** stack and delete them afterwards. They obtain
  connection details from `supabase status`, never from `.env` files.
- Password sign-in is tested for real against the local Auth server, in the
  integration and e2e suites. Tests that prove other sign-in methods are
  refused build those sessions in the **local** Auth database
  (`tests/support/google-simulation.ts`). Google itself is never contacted.
- Local auth emails go to the Mailpit inbox (http://127.0.0.1:55324);
  nothing is sent externally.

## Layout

```
src/app/            routes: (auth) public pages, (app) owner-only pages
src/proxy.ts        session refresh + optimistic redirects (not the security boundary)
src/components/     shared UI (shadcn/ui in components/ui)
src/domain/         pure TypeScript business rules (money, owner, ledger, finance); no framework/infra imports
src/features/       feature UI and server actions (auth, accounts, transactions, categories)
src/server/auth/    provider-neutral authorisation + Supabase adapter
src/server/ledger/  ledger application service (server-only API)
src/server/finance/ accounts, categories, transactions (posting templates over the ledger)
src/server/db/      Prisma client (private), RLS scope helpers, ledger store
src/server/env.ts   Zod-validated server configuration
prisma/             schema and SQL migrations (roles, grants, RLS)
supabase/           local stack config and auth email templates
scripts/            local db workflow, owner provisioning
tests/              unit (lint rules), integration (real DB), e2e (Playwright)
docs/               ADRs and runbooks
```
