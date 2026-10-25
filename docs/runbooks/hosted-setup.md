# Runbook: hosted Supabase setup (not yet performed)

The hosting region is not decided; nothing below assumes one. Do not run
destructive commands against a hosted database.

## 1. Auth settings (dashboard → Authentication), matching `supabase/config.toml`

Current mode is email/password: follow `docs/runbooks/owner-access.md`
section 5. In short, Email is on, sign-ups are off, and every other provider is
off. Use the neutral email templates, OTP length 10 and empty Redirect URLs.
(Google is deferred; see `docs/runbooks/google-oauth.md` when restoring it.)

## 2. Data API

API settings → exposed schemas: keep `finora` **out** of the list.

## 3. Database

Use the pinned Node (`nvm use`; `node -v` must print the version in
`.nvmrc`): account-name keys depend on its Unicode data (ADR 0007).

```bash
# In your shell only; never commit these values.
export MIGRATION_DATABASE_URL='postgresql://postgres:…@<direct-host>:5432/postgres?schema=finora'
```

Read-only preflight (nothing is written). The `20261025000500_account_name_key`
migration needs PostgreSQL 17+ (`unicode_assigned`) and a UTF8 database; it
refuses older servers itself, and so does `db:account-names`:

```bash
psql "${MIGRATION_DATABASE_URL%%\?*}" -X -v ON_ERROR_STOP=1 -c 'BEGIN READ ONLY' \
  -c "SELECT current_setting('server_version') AS version, current_setting('server_encoding') AS encoding, unicode_version()" \
  -c 'ROLLBACK'
# Expect version >= 17, encoding UTF8. Record unicode_version() (local: 15.1).
npm run db:account-names -- conflicts
# Expect "OK: no problems found." It prints counts and account/owner ids,
# never names. Any listed account must be renamed (by or with the owner)
# before deploying; nothing is ever renamed automatically.
```

Then deploy. **Migration `20261025000500_account_name_key` and the
application code that writes `name_key` must go live in one maintenance
window, with no account writes between the migration and the new code
becoming active.** The old code cannot populate `name_key`: after the
migration its account creation fails and its renames would leave a stale
key (which `verify` reports). On a first setup with no running app this is
automatic. Otherwise:

1. Announce the window. Stop the old application, or put it in maintenance
   mode, so nothing can create, rename, archive or restore accounts.
2. Run the preflight above (`conflicts` must print "OK").
3. Migrate:

   ```bash
   npm run db:migrate:deploy
   ```

   The migration takes `ACCESS EXCLUSIVE` on `finora.financial_accounts`
   and sets `lock_timeout = '5s'` for its own transaction. If something
   still holds a lock on the table (a stray session, a long query), it fails
   with "canceling statement due to lock timeout" and changes nothing. Find
   and end that session, then recover as below.
4. Deploy the new application code; confirm it is the only version serving.
5. Before reopening, run the post-deployment checks in section 5 (catalog
   index query and `npm run db:account-names -- verify`). Reopen only when
   both pass.

Expected data change: every account's `updated_at` becomes the migration
time (the backfill sets `name_key` on every row with the guard trigger on),
and non-NFC names are rewritten to NFC. Nothing else changes.

If a migration fails, PostgreSQL rolled the whole file back (each migration
runs as one transaction), so nothing of it was applied, but Prisma records it
as failed and refuses further deploys. Do not edit the migration or the
database by hand. Instead:

1. Read the error. For `20261025000400_account_name_case_insensitive` ("differ
   only by letter case") run its hint query; for
   `20261025000500_account_name_key` ("share a comparison key", "whitespace",
   "60 characters", "unassigned") run `npm run db:account-names -- conflicts`.
   For "lock timeout", end the session holding the lock (no renames needed).
2. Rename the listed accounts (by or with the owner) in the version of the
   app that is still running: the new app code needs the migration, so
   migrate before deploying it. This reopens the old app briefly; start a
   new maintenance window afterwards. On a first setup there are no
   accounts yet.
3. Mark the failed attempt rolled back and deploy again:
   `npx prisma migrate resolve --rolled-back <migration name> && npm run db:migrate:deploy`.

For a PostgreSQL older than 17, upgrade the project first; the migration
cannot run there and changes nothing when it fails.

### Credit-card account migrations

**Status: these migrations have not been run against hosted Supabase.** They
were tested only on local scratch databases; that does not establish hosted
readiness. Run the preflight below first, on the hosted database, and record
the result.

Migrations `20261025000600_credit_card_account_type` (enum value only) and
`20261025000700_account_ledger_class` (account-class guard and class-aware
opening balances; ADR 0008) are Milestone 5A.

**Prerequisite.** They assume the hosted database already has
`20261025000500_account_name_key` applied **and** the Milestone 4D application
code (which writes `name_key`) live. Check first:

```bash
npx prisma migrate status   # with MIGRATION_DATABASE_URL set in the shell
```

- **If 0500 and the 4D code are already live**, and 0600 and 0700 are the
  only pending migrations: deploy migrations first, then the 5A application
  code. No maintenance window is needed for these two, because the 4D code
  only creates bank and cash accounts on asset ledger accounts, which the new
  rules accept. The 5A code needs both migrations (creating a card fails at
  the old guard without them).
- **If the environment is behind that** (0500 pending, or older code live),
  `npm run db:migrate:deploy` applies every pending migration in one run,
  including 0500, 0600 and 0700. Then the whole deployment needs 0500's
  maintenance window and write coordination, as described for
  `20261025000500_account_name_key` earlier in this section: stop account
  writes, run `npm run db:account-names -- conflicts`, migrate, deploy the
  5A code, run the section 5 checks, then reopen. A window is required in
  that case.

Read-only preflight (expect `0`). It does not use anything the migration
creates, so it also works before the migration and after a refused attempt:

```bash
psql "${MIGRATION_DATABASE_URL%%\?*}" -X -v ON_ERROR_STOP=1 -c 'BEGIN READ ONLY' \
  -c "SELECT count(*) FROM finora.financial_accounts fa
        JOIN finora.ledger_accounts la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id
       WHERE la.kind::text IS DISTINCT FROM CASE fa.type::text WHEN 'bank' THEN 'asset'
             WHEN 'cash' THEN 'asset' WHEN 'credit_card' THEN 'liability' END" \
  -c 'ROLLBACK'
```

An account type the query does not know maps to NULL and is counted (fail
closed).

`20261025000700` takes `SHARE ROW EXCLUSIVE` on `finora.financial_accounts`
(account writes wait; reads do not) with `lock_timeout = '5s'`. It refuses,
changing nothing, if:

- "financial account(s) have a ledger account of the wrong class": an
  account's type does not match its ledger account. Nothing is ever
  reclassified automatically. The error's HINT gives a read-only query (the
  same `CASE` mapping as the preflight, safe to run after the rollback) that
  lists the account id, owner id, type and ledger kind of each such account,
  never names. Decide with the owner what each account really is and fix it
  by a reviewed change; never edit ledger history or change a ledger
  account's kind. Then recover as below;
- "lock timeout": end the session holding the lock, then recover as below;
- an existing transaction fails the replaced COMMIT-time check (not expected:
  before credit cards every account is an asset, for which the templates are
  unchanged). Stop and investigate; do not edit posted rows.

Between 0600 and 0700 (normally the same `migrate deploy` run) the old guard
still requires an asset ledger account, so no liability-backed account can
exist. A `credit_card`-typed row on an asset ledger account can, however, be
written by raw SQL in that window (an insert, or an `UPDATE` of `type`, which
the old guard does not check); the application never does this. 0700's
preflight refuses such rows. The comment in the 0600 file ("no credit card
can be created") is narrower than this; that applied migration is not edited.

Recovery is the same as for any failed migration here:
`npx prisma migrate resolve --rolled-back 20261025000700_account_ledger_class && npm run db:migrate:deploy`.

**Rollback.** Both migrations are forward-only: an enum value cannot be
dropped, and undoing 0700 would be a new, reviewed migration restoring the
previous function bodies, valid only while no credit-card account exists.

Once any credit-card account exists, rolling the **application** back to
pre-5A code (4D or earlier) is not a supported rollback path:

- the old code does not know the `credit_card` type: account views may show
  no type label, and its account handling does not expect the type at all
  (whether every page still renders has not been tested);
- the old transaction workflows do not know account classes: they offer
  cards in account pickers and plan card transactions and opening balances
  as if every account were an asset.

The 5A database rules still hold under old code: `assert_transaction_valid`
refuses any income, expense or transfer on a card and any opening balance in
the wrong direction at COMMIT, so nothing incorrect is posted. Users of old
code would see a generic "the ledger refused this change" error instead.

**Operator decision:** after credit-card accounts have been created, fix
forward (deploy a corrected 5A-or-later application). Do not roll the
application back to pre-5A code unless there is a reviewed, explicit recovery
plan. Never delete account history, delete card accounts that have history,
or change a ledger account's kind to make old code work.

Set the runtime role's login password (generate a long random value; store it
only in the hosting provider's secret settings):

```sql
ALTER ROLE finora_app WITH LOGIN PASSWORD '<generated>';
```

App environment (hosting provider settings): `NEXT_PUBLIC_SITE_URL`,
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL` (Supavisor
transaction pooler, user `finora_app.<project-ref>`, port 6543), optionally
`DATABASE_POOL_MAX`. Never `SUPABASE_SECRET_KEY` or `MIGRATION_DATABASE_URL`.

## 4. Owner

Explicit three-step provisioning (prepare, set-password, complete):
`docs/runbooks/owner-access.md` section 1. Supply
`SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `MIGRATION_DATABASE_URL` in the shell
for each command only.

## 5. Verify (catalog checks, as `postgres`)

```sql
SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'finora_app'; -- all false
SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'finora'::regnamespace AND relkind = 'r';
SELECT has_schema_privilege('anon', 'finora', 'USAGE'),
       has_schema_privilege('authenticated', 'finora', 'USAGE');                       -- false, false
-- Ledger (Milestone 3): triggers present and enabled ('O'), currencies seeded.
SELECT tgrelid::regclass, tgname, tgenabled FROM pg_trigger
 WHERE tgrelid::regclass::text LIKE 'finora.%' AND NOT tgisinternal ORDER BY 1, 2;     -- 17 rows (ledger, finance and owners_set_updated_at), all 'O'
SELECT code, exponent FROM finora.currencies ORDER BY code;                           -- EUR GBP INR JPY KWD USD
SELECT has_table_privilege('finora_app', 'finora.journal_lines', 'UPDATE'),
       has_table_privilege('finora_app', 'finora.journal_entries', 'DELETE');          -- false, false
-- Account classes (ADR 0008): every account's ledger kind matches its type.
SELECT t::text, finora.financial_account_ledger_kind(t)::text
  FROM unnest(enum_range(NULL::finora.financial_account_type)) AS t;                  -- bank asset, cash asset, credit_card liability
SELECT count(*) FROM finora.financial_accounts fa JOIN finora.ledger_accounts la ON la.id = fa.ledger_account_id
 WHERE la.kind IS DISTINCT FROM finora.financial_account_ledger_kind(fa.type);         -- 0
```

Account-name uniqueness (ADR 0007). Prisma's drift check cannot see the key
column's `"C"` collation, so this catalog query is the authority. Read-only:
the transaction is `READ ONLY` and rolled back. `${…%%\?*}` drops
`?schema=finora`, which `psql` rejects:

```bash
{ echo 'BEGIN READ ONLY; SET LOCAL search_path = pg_catalog;'
  cat scripts/db/sql/verify-account-name-key-index.sql
  echo 'ROLLBACK;'; } | psql "${MIGRATION_DATABASE_URL%%\?*}" -X -x -v ON_ERROR_STOP=1
# Expect one record with every column t (ok = t) and
# definition = CREATE UNIQUE INDEX financial_accounts_owner_name_key_key
#              ON finora.financial_accounts USING btree (owner_id, name_key)
npm run db:account-names -- verify
# Expect "OK: no problems found.": every stored name is trimmed NFC, every
# name_key is exactly what the pinned Node computes, and keys are unique per
# owner. (Characters unknown to the server's Unicode are fine after the
# migration and are not reported.) A nonzero exit lists account ids only.
```

Run both right after deploying the application code that includes ADR 0007,
before reopening the app (section 3). If `verify` reports a stale key after
the window, an old-code write slipped through: do not edit names or keys by
hand; keep the app closed and investigate with the listed ids.

The same checks run in the integration suite
(`tests/integration/finance-database.test.ts`,
`tests/integration/account-name-key.test.ts`). If `ok` is false, do not edit
the index by hand. Find which column is false and compare with migration
`20261025000500`. Repeat `verify` after any change of Node version (ADR 0007,
"Changing Node").

Database locale (informational since ADR 0007: name comparison no longer
depends on it). Record the result and compare it with the local stack (ICU,
`en-US`):

```sql
SELECT current_setting('server_version') AS version, datlocprovider, datcollate, datctype
  FROM pg_database WHERE datname = current_database();
```

Then work through the manual checklist in `docs/runbooks/owner-access.md`
section 6.
