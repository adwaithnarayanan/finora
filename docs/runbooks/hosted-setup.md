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
refuses card income, any transfer involving a card and any opening balance
in the wrong direction at COMMIT, so nothing incorrect is posted. (Before
`20261025000800` it also refuses every card expense; after it, an expense
on a card is accepted only with the correct Dr category / Cr card lines.) Users of old
code would see a generic "the ledger refused this change" error instead.

**Operator decision:** after credit-card accounts have been created, fix
forward (deploy a corrected 5A-or-later application). Do not roll the
application back to pre-5A code unless there is a reviewed, explicit recovery
plan. Never delete account history, delete card accounts that have history,
or change a ledger account's kind to make old code work.

### Card-expense migration (Milestone 5B)

**Status: not run against hosted Supabase.** `20261025000800_card_expenses`
was tested only on local scratch databases (applied on top of 0700 with
existing bank, cash and card data); that does not establish hosted
readiness.

It replaces one function, `finora.assert_transaction_valid`, so that an
expense may be paid by a credit card (ADR 0008, "Expenses paid by card").
It writes no row, re-checks no row (the change only relaxes a rule), takes no
table lock, and changes no table, column, enum value, grant, policy,
trigger, owner or security attribute.

**Prerequisite and order.** 0600 and 0700 applied (check with
`npx prisma migrate status`). Then migrate (0800), then deploy the 5B
application code. No maintenance window is needed for 0800 itself; if 0500
is still pending, the 0500 window above applies to the whole run. The 5B
code needs 0800: without it, recording a card expense fails at COMMIT with a
generic error and writes nothing.

**Failure and recovery.** A failure rolls the whole file back (nothing is
changed) and Prisma records the migration as failed. After fixing the cause:
`npx prisma migrate resolve --rolled-back 20261025000800_card_expenses && npm run db:migrate:deploy`.

**Rollback.** Forward-only. Restoring the 0700 function body would be a new,
reviewed migration, and is only valid while no card expense exists: once one
exists, every later update of it (void, payee or note edit) re-runs the
COMMIT-time check, which the 0700 rules would refuse. Prefer fixing forward.
Never delete or edit posted card expenses to make a rollback pass.

### Card-payment migrations (Milestone 5C)

**Status: not run against hosted Supabase.** `20261026000000_card_payment_kind`
and `20261026000100_card_payments` were tested only on local scratch
databases (applied on top of 0800 with existing bank, cash, card, card-expense
and voided data); that does not establish hosted readiness.

Together they let a credit card be repaid from a bank or cash account as a
new transaction kind, `card_payment` (ADR 0008, "Card payments"):

- `20261026000000_card_payment_kind` adds only the enum value
  `card_payment` to `finora.transaction_kind`. PostgreSQL cannot use a new
  enum value in the transaction that adds it, which is why it is a file of
  its own (as 0600 was). Unused, it changes nothing.
- `20261026000100_card_payments` replaces the row CHECK
  `transactions_shape` (adding a `card_payment` branch and an `ELSE false`,
  so an unhandled kind is refused rather than silently accepted) and the
  function `finora.assert_transaction_valid` (requiring Dr the card / Cr the
  paying bank or cash account). It writes no row and changes no table,
  column, grant, policy, trigger, owner or security attribute. Every rule
  for income, expenses, transfers and opening balances is unchanged — a
  transfer to or from a card is still refused — so this adds a rule rather
  than relaxing one.

**Locks: plan a quiet moment.** Unlike 0800, `20261026000100` replaces a row
CHECK with one `ALTER TABLE` (`DROP CONSTRAINT` plus `ADD CONSTRAINT`), which
takes **ACCESS EXCLUSIVE** on `finora.transactions`: reads and writes of
transactions wait until that statement commits, and the `ADD` scans the table
once to validate. A single owner's history is small, so expect this to be
brief. No existing row can fail the new CHECK: the five existing branches are
unchanged and no row has the new kind.

The file sets `lock_timeout = '5s'` and then takes the lock explicitly
(`LOCK TABLE finora.transactions IN ACCESS EXCLUSIVE MODE`), the same shape
as 0700, so a contended deploy fails fast instead of queueing every later
reader and writer of `finora.transactions` behind its lock request. Verified
on a scratch database with a reader holding `ACCESS SHARE`: the deploy fails
after ~5s with `ERROR: canceling statement due to lock timeout (55P03)`,
changing nothing.

**Do not assume a migration file is one transaction.** `prisma migrate
deploy` (Prisma 7.10.1) does not reliably wrap one, and whether a file gets a
transaction depends on its statements. Measured directly on scratch
databases:

- a file containing only `LOCK TABLE` fails with "LOCK TABLE can only be
  used in transaction blocks" — so there is no enclosing transaction;
- a file of `CREATE TABLE …; SELECT 1/0;` leaves the table behind — so that
  file was **not** atomic;
- the same pair preceded by a `LOCK TABLE` rolls back completely.

An earlier draft of `20261026000100` used `SET LOCAL lock_timeout` and no
explicit `LOCK TABLE`; in that shape the setting was discarded before the
`ALTER TABLE` and a contended deploy waited **689 seconds** without giving
up. Both the explicit lock and the plain (non-`LOCAL`) `SET` in the shipped
file exist for that reason.

When recovering any migration here, check what actually landed rather than
assuming a clean rollback. The notes for 0300, 0700 and 0800 above, and
those files' headers, state or imply whole-file atomicity; 0700 does get a
transaction (it takes `LOCK TABLE` first), but the general claim does not
hold for this tool version. Those migrations are already applied and are not
being edited here.

**Prerequisite and order.** 0800 applied (check with
`npx prisma migrate status`). Then migrate (both files, normally one
`npm run db:migrate:deploy` run), then deploy the 5C application code. Code
already running (4D, 5A or 5B) never records a card payment, so migrating
ahead of the deploy is safe. The 5C code needs both: without the enum value
the row cannot be written at all, and with the enum value but not
`20261026000100` a repayment is refused at COMMIT with a generic error,
writing nothing. If 0500 is still pending, the 0500 window above applies to
the whole run.

### Card-refund migrations (Milestone 5D)

**Status: not run against hosted Supabase.** `20261029000000_card_refund_kind`
and `20261029000100_card_refunds` were tested only on local scratch databases
(applied on top of the 5C migrations with existing bank, cash, card,
card-expense, card-payment and voided data); that does not establish hosted
readiness.

Together they let a merchant credit money back onto a card as a new
transaction kind, `card_refund`, either linked to a recorded card purchase or
unlinked (ADR 0008, "Card refunds"). A refund debits the card and credits the
expense category, so the amount owed and that category's expenses both fall;
it is never income.

- `20261029000000_card_refund_kind` adds only the enum value `card_refund` to
  `finora.transaction_kind`, for the same PostgreSQL reason as 0600 and
  `20261026000000`. Unused, it changes nothing, and a raw-SQL row with the new
  kind written before the next file is already refused by the `ELSE false` in
  `transactions_shape`.
- `20261029000100_card_refunds`:
  - adds the nullable column `refunds_transaction_id` with a composite foreign
    key to `(id, owner_id)` and the row CHECK `transactions_refund_link` (only
    a `card_refund` may set it, never to itself);
  - replaces `transactions_shape` with a `card_refund` branch (the `ELSE
    false` stays);
  - creates `transactions_refunds_idx`;
  - replaces `transactions_insert_guard`, `transactions_update_guard` and
    `assert_transaction_valid`.

  It writes no row and adds or removes no table, enum value, grant, policy,
  trigger, owner or security attribute. `finora_app` gains `SELECT, INSERT` on
  the new column from its existing table-level grants and deliberately **not**
  `UPDATE`, whose grant stays column-listed (`payee`, `note`,
  `reversal_entry_id`), so the runtime role can never move or clear a refund's
  link.

**One rule is relaxed, not weakened.** A category's kind no longer has to
*equal* the transaction's kind; it has to equal the kind the transaction
*requires*, which is unchanged for income and expenses and is `expense` for a
card refund. Every existing row still satisfies it, which is why the two new
constraints and the replaced CHECK all validate without a refusal (the test
asserts all three come out `convalidated`).

**Locks: plan a quiet moment**, as for `20261026000100` and for the same
reasons. The `ALTER TABLE` takes **ACCESS EXCLUSIVE** on `finora.transactions`
for the column, the foreign key and both CHECKs, so reads and writes of
transactions wait until it commits. `ADD COLUMN` of a nullable column with no
default does not rewrite the table, and on a brand-new all-NULL column neither
the foreign key nor `transactions_refund_link` can reject anything, so the
work is a validation scan of a small table. The file sets `lock_timeout = '5s'`
(a plain `SET`, for the reason measured on `20261026000100`) and takes the lock
explicitly, which also gives it one transaction.

**Recovery differs from 5C in one way worth knowing.** As before:
`npx prisma migrate resolve --rolled-back 20261029000100_card_refunds` then
redeploy. But re-running this file from the start is **not** idempotent in
effect: `ADD COLUMN` and `ADD CONSTRAINT` have no `IF NOT EXISTS`, so they fail
if a previous attempt committed them. The explicit `LOCK TABLE` gives the file
one transaction, so a failure rolls all of it back and that state should not
arise; if it somehow does, drop `refunds_transaction_id`,
`transactions_refund_link` and `transactions_refunds_fkey` before redeploying,
and check `transactions_shape` and the three function bodies against the file.
A failure of `20261029000100` leaves `20261029000000`'s enum value applied,
which is harmless.

**Prerequisite and order.** The 5C migrations applied (check with
`npx prisma migrate status`). Then migrate (both files, normally one
`npm run db:migrate:deploy` run), then deploy the 5D application code. Code
already running (4D through 5C) never records a card refund, so migrating
ahead of the deploy is safe.

**The 5D code needs `20261029000100` for every transaction, not only refunds.**
Its finance store reads and writes `refunds_transaction_id` on every
transaction row, so deployed against a 5C database it fails to record even an
ordinary expense ("The column `refunds_transaction_id` ... does not exist").
Migrate first, without exception. This is stricter than 5B and 5C, where the
new code only failed on the new kind.

**After deploying,** check that a card purchase's page shows "0.00 refunded of
…", that a linked refund of part of it reduces the amount owed and the
category's expenses, and that the purchase then refuses to be voided until its
refunds are voided.

Read-only check after deploying (expect `card_payment` last, and a
`transactions_shape` definition that mentions it):

```bash
psql "${MIGRATION_DATABASE_URL%%\?*}" -X -v ON_ERROR_STOP=1 -c 'BEGIN READ ONLY' \
  -c "SELECT unnest(enum_range(NULL::finora.transaction_kind))::text AS kind" \
  -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint
        WHERE conrelid = 'finora.transactions'::regclass AND conname = 'transactions_shape'" \
  -c 'ROLLBACK'
```

**Failure and recovery.** Prisma records the migration as failed
(`finished_at` null) and nothing of it is applied: because the file takes
`LOCK TABLE` first it runs as one transaction, verified by injecting a
failing statement at the end of the real file and confirming that both
`transactions_shape` and `assert_transaction_valid` were left byte-identical.
The likely cause of a failure is the lock: find and end the session holding a
lock on `finora.transactions` (a long-running query or an idle-in-transaction
session), then recover. Run the read-only check above first to confirm the
state. Re-running the file from the start is safe (`DROP`/`ADD CONSTRAINT`
and `CREATE OR REPLACE` are idempotent in effect):

```bash
npx prisma migrate resolve --rolled-back 20261026000100_card_payments
npm run db:migrate:deploy
```

Verified end to end on a scratch database: after a lock-timeout failure,
resolve plus redeploy completed and left `transactions_shape` present,
mentioning `card_payment`, and `convalidated`.

Note that `20261026000000_card_payment_kind` is a separate file, so a failure
of `20261026000100` leaves the **enum value applied**. That is the documented
intermediate state and needs no repair: nothing writes the kind, and an enum
value cannot be dropped anyway.

**Rollback.** Forward-only: an enum value cannot be dropped. Restoring
0800's function body and CHECK would be a new, reviewed migration, valid
only while no card payment exists — once one exists, the restored CHECK
(with no `card_payment` branch and an `ELSE false`) would refuse every
update of it, and so would the restored COMMIT-time check. Prefer fixing
forward. Never delete or edit posted card payments to make a rollback pass.

Rolling the **application** back from 5C to 5B leaves existing card payments
in the database, readable and voidable, but 5B code does not know the kind:
it has no label for it, so history and the type filter would render a
missing label, and it refuses new repayments. This path has not been tested
end to end.

**Local databases that applied 0500 or 0700 before their files were last
edited** keep the old checksums in `_prisma_migrations` (a development-only
condition; a fresh or hosted database records the current files). Do not
edit `_prisma_migrations` by hand to "fix" this. Before applying 0800 or the
5C migrations to such a database, check `npx prisma migrate status` and apply
them deliberately; the automated test suites run `migrate deploy` against the
local database in their global setup, so on a database with mismatched
checksums run the suites only after deciding what to do about them.

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
