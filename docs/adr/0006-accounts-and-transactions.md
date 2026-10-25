# ADR 0006: Financial accounts, opening balances and basic transactions

- Status: Accepted
- Date: 2026-10-25

## Context

Milestone 4B adds the first user-facing money features: bank and cash
accounts, opening balances, and income, expense and transfer transactions.
They must sit on the double-entry ledger from ADR 0005 without changing its
invariants, and keep owner isolation (ADR 0004) and server-side authorisation
(ADR 0003).

## Decision

### One accounting engine

All journal entries are created by the existing ledger code. The ledger
service was split into `ledgerOperations` (in `src/server/ledger/service.ts`):
the same posting, balance, reversal and correction logic, but runnable inside
a caller's owner-scoped transaction. The public ledger service delegates to
it.

The finance service (`src/server/finance/service.ts`) uses `ledgerOperations`
together with a `FinanceStore`, both bound to **one** `withOwnerScope`
transaction (`withFinanceStores`). The business record and its journal entry
therefore commit together or not at all. The ledger tables, triggers and
invariants are unchanged.

### Model (migration `20261025000300_accounts_and_transactions`)

- **`financial_accounts`**
  - Columns: `name` (unique per owner regardless of letter case: the service
    checks `lower(name)` under a per-name advisory lock for a friendly error,
    and the unique index `financial_accounts_owner_name_ci_key` on
    `(owner_id, lower(name))` enforces it; migration
    `20261025000400_account_name_case_insensitive`),
    `type` (`bank | cash`), `currency_code`, `ledger_account_id`, the creation
    key and fingerprint, timestamps, and `archived_at`.
  - Each account is backed by exactly one **asset** ledger account of the
    same owner and currency. A composite foreign key and a trigger enforce
    this.
  - The currency, ledger link and identity are immutable (trigger). Only the
    name, type and archive state can change, and only those columns are
    granted.
- **`categories`**
  - Columns: `name` (unique per owner and kind), `kind` (`income | expense`,
    immutable) and `archived_at`.
  - A category posts to one ledger account per currency, recorded in
    **`category_ledger_accounts`**. That ledger account is of the category's
    own kind (income or expense) and is created on first use.
- **`system_ledger_accounts`** holds Finora-managed ledger accounts, currently
  the **opening-balance equity** account per currency, created on first use.
- **`transactions`** records the business meaning of exactly one posted
  journal entry:
  - Columns: `kind` (`income | expense | transfer | opening_balance`),
    `occurred_on`, a positive `amount_minor`, `currency_code`, the source
    and/or destination account, the category, `payee`, `note`,
    `journal_entry_id`, `reversal_entry_id` and `voided_at` (set together,
    once), `replaces_transaction_id`, and timestamps.
  - The account foreign keys are `(account, owner, currency)`. A transaction
    can therefore only use the owner's own accounts, in the transaction's
    currency, and both sides of a transfer must share a currency.

Ledger account names are internal keys (`account:<id>`, `category:<id>:<CUR>`,
`system:opening-balance-equity:<CUR>`); users never see them. Balances are
never stored: an account's balance is `ledgerOperations.accountBalance()` over
posted lines, signed to the account's normal side.

### Posting templates

Clients submit an intent; the server resolves every reference under the
authorised owner and builds the lines with `planTransaction` /
`planOpeningBalance` (`src/domain/finance`). Each template produces exactly
two lines, for the same amount:

| Kind | Debit | Credit |
| --- | --- | --- |
| income | destination account (asset) | category's income account |
| expense | category's expense account | source account (asset) |
| transfer | destination account (asset) | source account (asset) |
| opening_balance | the account (asset) | opening-balance equity (per currency) |

- **Amounts** are decimal strings parsed exactly by the money module in the
  account's currency. They must be positive and fit a ledger line. There is no
  floating point and no FX: a transfer needs two accounts in the same currency.
- **Entry text:** the entry description is the kind plus the payee ("Expense to
  BigBasket"). The note is the memo of the first line. Both are therefore part
  of the ledger's idempotency fingerprint and audit trail.
- **Transfers** have no category and are neither income nor expense.

### Opening balances (accounting treatment)

An opening balance is an account's position when tracking starts, not income
for any period. It is recorded as a posted entry:

  Dr account (asset), Cr Opening-balance equity

in the account's currency, dated "as of" the opening date. Equity is the
standard counterpart for amounts that existed before the books began. Using
it keeps income and expense totals free of starting positions, and lets
future features (credit cards, loans) open with credit balances against the
same equity account.

- **Atomic with creation:** creating an account with an opening balance is a
  single transaction covering the account, its ledger account and the posted
  entry.
- **One active opening balance per account.** This is enforced in the
  database: an insert trigger locks the account row `FOR UPDATE` and refuses a
  second active one. A deferred check backs this up.
- **Never overwritten.** A correction uses the ledger's `correctEntry`:
  - a reversal of the original entry and a replacement entry, in one
    transaction;
  - the original transaction is marked void (its reversal is linked);
  - a new `opening_balance` transaction with `replaces_transaction_id` records
    the replacement.
- **Positive only in this release.** Negative (overdrawn) opening balances
  aren't supported yet.

### Lifecycle

- **Accounts:**
  - *Create:* `createAccount`, idempotent on the form's request key.
  - *Edit:* name and type only.
  - *Archive:* the account stops taking new ordinary transactions and new
    opening balances, and keeps its history and balance. *Restore* reverses
    this.
  - *Delete:* only an account **without any journal lines**. This removes the
    account and its unused ledger account, guarded by a trigger and the
    foreign keys. The runtime role gained `DELETE` on `ledger_accounts` for
    this; foreign keys from journal lines restrict it to unused accounts.
- **Categories:**
  - *Create* and *rename*.
  - *Archive* and *restore*: archived categories can't take new transactions.
  - Defaults are added only by an explicit, owner-authorised action
    ("Add default categories", `initializeDefaultCategories`). It is
    idempotent, runs in one transaction under a per-owner lock, and does
    nothing once the owner has any category. Rendering a page never creates
    categories.
- **Transactions:**
  - *Record:* `recordTransaction`.
  - *Edit details:* `payee` and `note` only. They have no accounting effect,
    and the journal keeps the original text.
  - *Void:* `voidTransaction` posts the ledger reversal and links it; the
    original stays in history. Re-entering the corrected transaction is a new
    record.
  - Amount, date, accounts, category and kind are never edited, and
    transactions are never deleted (both enforced by triggers).

### Idempotency and concurrency

- **Request keys:** every create, record, void and opening-balance form
  carries a server-generated request key (a UUID per rendered form).
- **Transactions** reuse the ledger's per-owner idempotency:
  - *Replay:* the same key and the same intent return the transaction
    recorded the first time, with `replayed`.
  - *Conflict:* the same key with a different intent is refused.
- **Account creation** stores its key and a fingerprint on the account. It
  serialises same-key requests with a per-owner advisory lock, so racing
  duplicates create one account (and one opening-balance entry, keyed
  `<key>:opening`).
- **Lazily created ledger accounts** (category or equity) are created under an
  advisory lock, then re-checked.
- **Archiving vs. posting:** the insert trigger locks each account row
  `FOR SHARE`, so archiving and posting serialise. Opening balances lock it
  `FOR UPDATE`.

### Database enforcement (defence in depth)

- **Row CHECKs:**
  - which accounts and category each kind uses;
  - distinct transfer accounts;
  - a positive amount;
  - text bounds;
  - the void fields set together.
- **Guard triggers:**
  - asset/income/expense/equity kinds on every ledger mapping;
  - immutable identity, currency and accounting fields;
  - one-way void;
  - no deletes or truncation of transactions;
  - no new transactions on archived accounts or categories;
  - the category kind matches the transaction kind.
- **COMMIT-time agreement with the ledger** (deferred constraint trigger
  `assert_transaction_valid`). Every transaction must record a posted,
  non-reversal entry whose two lines are exactly its template, as listed
  above. A void must link the posted reversal of that entry, and a
  replacement must record the entry that replaced the voided original. A bug
  that recorded a different amount, account or side therefore can't commit.
- **Grants and RLS:**
  - `financial_accounts`: SELECT, INSERT, DELETE, plus UPDATE of name, type
    and archived_at.
  - `categories`: SELECT, INSERT, plus UPDATE of name and archived_at.
  - Mapping tables: SELECT, INSERT.
  - `transactions`: SELECT, INSERT, plus UPDATE of payee, note and
    reversal_entry_id.
  - `finora.apply_owner_isolation()` on all five tables.
  - The catalog tests pin the grants and cover RLS, owner-safe foreign keys
    and `owner_id` in every unique index.

### Case-insensitive names: migration safety

Migration `20261025000400` first counts owner/name groups that differ only
by letter case. If any exist it raises an error (with a hint query) and
changes nothing; accounts are never renamed or deleted automatically. Prisma
cannot express expression indexes, so the index lives only in SQL and
`npm run db:local:drift` does not see it; integration tests assert that it
exists and is effective (and that the conflict guard fires).

## Consequences

- **Atomicity:** a business transaction can't exist without its posted entry,
  and the service never posts an entry without recording its transaction. (The
  ledger itself can still hold entries with no business record; no
  user-facing path creates one.)
- **Corrections are additive:** void and re-enter, or reverse and replace an
  opening balance. History is never rewritten.
- **Cost:** each account balance is a ledger query. Lists are small (one
  owner), so N queries per page is acceptable for now; a batched balance query
  can come later without changing the model.
- **Deferred:**
  - credit cards, loans, investments and deposits (further account types,
    likely liability-normal);
  - FX transfers;
  - editing a transaction through a single correction step (today: void and
    re-enter);
  - negative opening balances;
  - pagination beyond the 200 most recent matches.
