# ADR 0005: Double-entry ledger core

- Status: Accepted
- Date: 2026-10-25

## Context

Finora's accounting must be correct, auditable and owner-isolated even if
application code has a bug. Some invariants span several rows (an entry
balances only across its lines), so row-level CHECKs alone cannot enforce
them. Ledger accounts here are accounting primitives; user-facing financial
accounts and transaction workflows come later and will post through this
ledger.

## Decision

### Model (`finora` schema; `src/domain/ledger`)

- **`currencies`**: reference data (`code`, `exponent`), seeded to match
  `KNOWN_CURRENCIES` (a test compares them). The app can only read it, and
  updates are refused by trigger, because changing an exponent would
  reinterpret every stored amount.
- **`ledger_accounts`**: `owner_id`, `name` (unique per owner), `kind`
  (`asset | liability | equity | income | expense`) and `currency_code`.
  Each account holds one currency. Owner, kind and currency are immutable.
- **`journal_entries`**: `owner_id`, `status` (`draft | posted`),
  `entry_date` (accounting date), `description`, an optional
  `idempotency_key` with its `idempotency_fingerprint`, and the links
  `reverses_entry_id` and `replaces_entry_id`. Audit times are
  `created_at`, `updated_at` and `posted_at`, all assigned by the database
  clock.
- **`journal_lines`**: `owner_id`, `entry_id`, `line_no`, `account_id`,
  `currency_code`, `side` and `amount_minor`, plus an optional `memo`.

### Debit/credit representation

Every line has a **strictly positive `BIGINT` amount in minor units**
(`CHECK amount_minor > 0`) and an explicit **`side`** enum (`debit` or
`credit`). Zero and negative lines cannot be stored, and direction is never
encoded in the sign.

An entry balances when, **for each currency**, the sum of debits equals the
sum of credits. Each line's currency must equal its account's currency. The
composite foreign key `(account_id, owner_id, currency_code)` enforces this,
so a line can never be reinterpreted in another currency.

- **Domain code** uses `Money` (bigint) from the money module and never uses
  `number`. Inputs are decimal strings that `Money.parse` reads exactly.
  Sums are computed in `NUMERIC` in SQL and in `bigint` in TypeScript.
- **Balances** are never stored. They are reconstructed from posted lines:
  `net` = debits − credits, and `normal` is the same figure signed toward the
  account's normal side. Asset and expense accounts are debit-normal; the
  others are credit-normal.

### Lifecycle

- **Draft:** an entry is always inserted as a draft. The database refuses an
  insert with `status = 'posted'`. A draft's lines may be replaced (deleted
  and re-inserted), and a draft may be unbalanced. Drafts have no effect on
  balances.
- **Posted:** the draft → posted transition is an `UPDATE` of `status`, and
  a trigger stamps `posted_at := now()`. Posted is terminal. No role may
  update or delete a posted entry, or add, change or remove its lines. This
  includes the migration role, short of disabling triggers (see Limits).
- **Lines are never updated** by anyone; drafts change lines only by delete
  and insert.

### Corrections

- **Reversal:** a new posted entry with `reverses_entry_id` set, whose lines
  are the original's lines with every side swapped. The database checks that
  it **exactly offsets** the original, account by account. The original is
  untouched.
  - An entry can be reversed at most once (unique on `reverses_entry_id`).
  - A reversal cannot itself be reversed; post a new entry instead.
  - Only posted entries can be reversed.
- **Correction:** `correctEntry` posts the reversal and a replacement entry
  (`replaces_entry_id` set) in one transaction. The database requires the
  replaced entry to have a posted reversal.
- **Links:** reversal and replacement links are only valid on posted entries
  and are immutable.
- **Repeated reversal attempts:**
  - Retrying with the same idempotency key and the same content returns the
    existing reversal with `replayed: true`.
  - Any other attempt fails with `EntryAlreadyReversedError`.
  - Reversing a reversal fails with `EntryNotReversibleError("is-reversal")`.
  - Reversing a draft fails with `EntryNotReversibleError("not-posted")`.

### Idempotency

- **Scope:** keys are client-chosen: 1–128 characters from `[A-Za-z0-9._:-]`,
  starting with an alphanumeric. They are unique **per owner**
  (`UNIQUE (owner_id, idempotency_key)`), so two owners never collide or see
  each other's keys.
- **Fingerprint:** the key is stored with the SHA-256 of a canonical request,
  which includes the operation kind, date, description and exact
  minor-unit lines.
  - **Replay:** a retry with the same key and fingerprint returns the
    original result and changes nothing.
  - **Conflict:** the same key with a different request fails with
    `IdempotencyConflictError`.
- **Operations:**
  - `postEntry` requires a key.
  - `createDraft` accepts an optional key.
  - `reverseEntry` and `correctEntry` require a key.
  - `postDraft` is idempotent by entry id: posting a posted entry returns it
    with `replayed: true`.
- **Concurrency:** `INSERT … ON CONFLICT (owner_id, idempotency_key) DO NOTHING`
  waits for a concurrent insert of the same key to commit or roll back. Then
  it either inserts or reads the winner's row, so racing duplicates yield
  exactly one entry without aborting the transaction. Reversal and posting
  take a row lock (`FOR UPDATE`) on the target entry first, which serialises
  concurrent attempts.

### Database enforcement (migration `20261025000200_ledger_core`)

Prisma generated the tables, keys and indexes. The rest is a hand-written SQL
migration, because Prisma's schema language cannot express CHECKs, triggers,
policies or column grants.

- **Composite foreign keys** keep references inside one owner:
  - each line points to `(entry_id, owner_id)` and
    `(account_id, owner_id, currency_code)`;
  - reversal and replacement links point to `(id, owner_id)`.
  A row can never reference another owner's entry or account, even through a
  bug.
- **Unique indexes on owner-scoped tables include `owner_id`.** Unique checks
  ignore RLS, so `(entry_id, line_no)` alone let a line insert aimed at
  another owner's entry id reveal that the entry exists. A test caught this
  during this milestone; a catalog test now enforces the rule.
- **Row CHECKs:**
  - positive amount;
  - text formats;
  - the key and fingerprint are both set or both null;
  - `posted_at` is set exactly when `status` is `posted`;
  - no self-reference;
  - an entry is not both a reversal and a replacement.
- **Guard triggers** (BEFORE row triggers):
  - draft-only inserts and DB-assigned timestamps;
  - immutability of posted entries and of all lines;
  - immutable account classification and currencies.
  - `journal_lines_guard` is `SECURITY DEFINER`. It locks the parent entry
    `FOR UPDATE`, filtered by the line's own `owner_id`, so a line change
    racing a post waits and then sees `posted`, and no other owner's state is
    revealed. A `BEFORE TRUNCATE` trigger blocks bulk erasure.
- **Balancing at COMMIT:** `DEFERRABLE INITIALLY DEFERRED` constraint
  triggers on entries and lines run `assert_journal_entry_valid(entry)`. For a
  posted entry it checks:
  - the entry has lines;
  - it balances per currency;
  - a reversal is exact;
  - a replacement's original is reversed.

  This lets a multi-line entry be built over several statements and still
  never commit invalid. `SET CONSTRAINTS … IMMEDIATE` only moves the check
  earlier. The check runs `SECURITY DEFINER`, so it sees every line no matter
  what RLS context the transaction holds at COMMIT; a test switches the
  context mid-transaction to prove it.
- **Grants (least privilege) for `finora_app`:**
  - `SELECT` on `currencies`;
  - `SELECT, INSERT` on `ledger_accounts`;
  - `SELECT, INSERT` plus `UPDATE (status)` on `journal_entries`;
  - `SELECT, INSERT, DELETE` on `journal_lines`;
  - nothing else. A test pins this exact list.
- **RLS:** `finora.apply_owner_isolation()` on all three owner-scoped tables;
  `currencies` is read-only to `finora_app`. Nothing is granted to `PUBLIC`
  or the Supabase API roles, and the schema is not exposed via the Data API.

### Application layer

- **`src/domain/ledger`:** pure rules covering
  - line building and validation;
  - per-currency balancing;
  - lifecycle checks;
  - reversal planning;
  - balances;
  - idempotency keys and canonical requests.
- **`src/server/ledger`:**
  - the `createLedgerService(runner)` application service;
  - the `LedgerStore` port;
  - error translation: database refusals become `LedgerIntegrityError` with
    Finora's own reason text, never raw SQL or connection details.
- **`src/server/db/ledger-store.ts`:** the Prisma adapter. `withLedgerStore`
  runs each operation in one `withOwnerScope` transaction, so the existing
  transaction-local owner context is the only mechanism.
- **Owner input:** every service method takes an `AuthorizedOwner` from
  `requireOwner()`, never an owner id.
- **No client entry point:** no route, server action or other
  client-reachable API exists yet.

## Consequences and limits

- **Migration role:** it owns the tables, so it can disable the triggers
  (`ALTER TABLE … DISABLE TRIGGER`, or `session_replication_role = replica`,
  which Supabase grants to `postgres`). The protection is against the runtime
  role and against accidental DML, not against a malicious operator.
  Integration-test cleanup uses `replica` mode locally to delete test owners'
  posted rows; nothing in the schema offers a bypass.
- **Restore:** `pg_restore` creates the triggers after loading data, so dumps
  with posted entries restore normally. This was verified locally.
- **Primary keys:** they are server-generated UUIDs and are not owner-prefixed.
  A client that could choose ids might probe for collisions; no API accepts
  client-supplied ids.
- **Duplicated validation:** posting runs domain validation, then the
  database repeats it at COMMIT. This costs extra queries per post and keeps
  defence in depth.
- **Deferred:** archiving accounts, multi-currency FX, a period close, and
  balance as of a date. Financial accounts and transaction intents will map
  onto ledger accounts later; no rules for them are defined here.
