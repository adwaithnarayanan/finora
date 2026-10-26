# ADR 0008: Credit-card accounts (liability foundation and card-paid expenses)

- Status: Accepted
- Date: 2026-10-25

## Context

Milestone 5 adds credit cards. A card is a liability: its balance is what the
owner owes, it grows with purchases and shrinks with repayments. Milestone 5A
lays the foundation only: card accounts, their opening amount owed, and the
invariants that keep an account's type and its ledger account consistent.
Purchases, repayments and refunds come in later milestones and are refused
until then. Milestone 5B (below) adds purchases and other expenses paid by
card; repayments and refunds are still refused.

Before this change every financial account was an asset, and the
`financial_accounts_guard` checked the ledger kind only on INSERT, while the
runtime role may UPDATE `type`. Adding a liability type without closing that
gap would have let a single UPDATE turn a bank account into a "card" that
still posts to an asset ledger account.

## Decision

### Cards are financial accounts

A credit card is a `financial_accounts` row with `type = 'credit_card'`,
backed by one **liability** ledger account of the same owner and currency.
It reuses everything accounts already have: canonical names and the
per-owner `(owner_id, name_key)` uniqueness shared with bank and cash
accounts (ADR 0007), composite owner/currency foreign keys, RLS, grants,
archive/restore, delete-only-without-history, and creation idempotency
(the v1 creation fingerprint already includes the type; its meaning is
unchanged). A separate table would have duplicated all of it.

No credit limit, available credit, statement or pending state is modelled.

### One mapping from type to ledger kind

| Type | Ledger account kind |
| --- | --- |
| `bank` | `asset` |
| `cash` | `asset` |
| `credit_card` | `liability` |

`ACCOUNT_LEDGER_KIND` (`src/domain/finance/accounts.ts`) is the
application's mapping; `finora.financial_account_ledger_kind(type)` is the
database's copy (migration `20261025000700`). An integration test compares
them for every value of the enum, so adding a type without mapping it fails.
The SQL function returns NULL for an unknown type, which every caller treats
as a violation.

- A new account's ledger account is created with `ACCOUNT_LEDGER_KIND[type]`.
- **Type changes stay within a class.** Bank and cash can still be swapped;
  a card can never become a bank or cash account, and neither can become a
  card (`parseAccountTypeChange` in the domain; the guard in the database).
  The account page shows a card's type as fixed text, with no control.
- **Database enforcement.** `financial_accounts_guard` (still
  `SECURITY DEFINER`, `search_path = ''`) requires the ledger account to be
  of the type's class on INSERT and on any UPDATE that changes `type`. The
  ledger link and the ledger account's kind were already immutable, so only
  a type change could break the invariant.

### Balances

Balances are still never stored. A card's balance is
`ledgerOperations.accountBalance().normal` of its liability account
(credits − debits): positive means owed, negative a credit in the owner's
favour. The UI shows "Owed ₹12,000.00", "Credit balance ₹500.00" or
"Nothing owed (₹0.00)" (`formatAccountBalance`, `en-IN`). In transaction
history, a card's opening amount owed reads as money out.

### Opening balances by class

The opening balance stays one posted entry against the owner's
opening-balance equity account in the account's currency, on the side that
increases the account's normal balance:

| Account | Debit | Credit | Example |
| --- | --- | --- | --- |
| asset (bank, cash) | the account | opening-balance equity | ₹50,000 held: Dr Axis 50,000 / Cr OBE 50,000 |
| liability (credit card) | opening-balance equity | the card | ₹12,000 owed: Dr OBE 12,000 / Cr HDFC Card 12,000 |

`planOpeningBalance` picks the template from `AccountRef.ledgerKind`;
`setOpeningBalance`, `correctOpeningBalance` (reversal plus replacement, in
the class's direction) and `voidTransaction` (an exact mirror) need no other
change. The deferred `assert_transaction_valid` check now derives the
expected debit and credit accounts from the destination account's ledger
kind, so an opening entry in the wrong direction cannot commit.

- The amount is positive: for a card, the amount owed. Zero, negative and
  over-precise amounts are refused; **a negative amount is never read as a
  credit balance**. An opening credit balance in the owner's favour is not
  supported yet: it needs an explicit "in your favour" choice, not a sign.

### Expenses paid by card (Milestone 5B)

A purchase, fee or any other ordinary expense can be paid by card. It is an
ordinary `expense` transaction whose source account is the card; there is no
separate purchase kind. The posting template is the expense template, whose
credit now lands on a liability:

| Transaction | Debit | Credit | Example |
| --- | --- | --- | --- |
| expense from a bank or cash account | expense category | the account (asset) | ₹40 groceries from Axis: Dr Groceries 40 / Cr Axis 40 |
| expense paid by card | expense category | the card (liability) | ₹1,250 at Bata on HDFC Card: Dr Shopping 1,250 / Cr HDFC Card 1,250 |

The credit increases the card's normal (credit) balance, so the amount owed
grows by the purchase: a card owing ₹12,000 owes ₹13,250 after the example.
Voiding a card expense posts the exact mirror (Dr card / Cr category), which
reduces the amount owed again. In transaction history a card expense reads
as money out ("−₹1,250.00"), like a card's opening amount owed.

- **Domain.** `planTransaction` accepts a card only as the source of an
  expense. Amount precision follows the card's currency, and the category's
  ledger account is the one in the card's currency (created on first use),
  so a card in USD posts in USD on both lines. Archived cards and archived
  categories are refused as for any account.
- **Idempotency** is unchanged: the ledger fingerprint covers the date, the
  description (which carries the payee) and every line (ledger account, side,
  amount, currency, memo carrying the note). Replaying a key with a different
  card or account, category, amount, date, payee or note is an
  `IdempotencyConflictError`, never a silent change.
- **Database.** `assert_transaction_valid` (deferred, at COMMIT) accepts an
  expense whose source account has type `credit_card` **and** a liability
  ledger account; every other rule is as before (exact two lines, the
  category's ledger account in the transaction's currency, posted
  non-reversal entry, void and replacement links). Archived accounts and
  categories, other owners' rows and currency mismatches are refused by the
  existing insert guard, RLS and composite foreign keys, unchanged.
- **Still refused**, by the domain with a field error ("… is a credit card; a
  card can only pay for an expense …") and by the database at COMMIT ("a
  credit card can only pay an expense; income and transfers use bank and cash
  accounts only"): income into a card, a transfer from a card, a transfer to
  a card (which is what a card payment will be, with its own kind), and a
  transfer between cards.
- **UI.** The "Paid from" picker of an expense lists active cards with
  their balance as "Owed …" and explains that a card expense adds to the
  amount owed. Income and transfer pickers list bank and cash only; switching
  away from an expense clears a selected card. A card's page links to
  "Record card expense" with the card preselected.

**Out of scope for 5B:** card payments (repayments), refunds and
chargebacks, cashback and other income to a card, cash advances, balance
transfers and card-to-card transfers, foreign-currency purchases on a card
of another currency, statements and reconciliation, credit limits and
available credit, due dates, interest accrual.

### Migrations

1. `20261025000600_credit_card_account_type`: only
   `ALTER TYPE financial_account_type ADD VALUE 'credit_card'`. PostgreSQL
   refuses to use an enum value in the transaction that adds it, and each
   migration file runs as one transaction. Between the two migrations the old
   guard still requires an asset ledger account, so no liability-backed
   account can exist yet. A `credit_card`-typed row on an *asset* ledger
   account can still be written by raw SQL in that window (an insert, or an
   `UPDATE` of `type`, which the old guard does not check), though the
   application never does so; 0700's preflight refuses such rows. (The
   0600 file's header, "no credit card can be created", is narrower than
   this; that applied migration is not edited.)
2. `20261025000700_account_ledger_class`:
   - `SET LOCAL lock_timeout = '5s'`, then `SHARE ROW EXCLUSIVE` on
     `financial_accounts` (blocks account writes, not reads, until COMMIT).
   - Creates `financial_account_ledger_kind` (`IMMUTABLE`, not
     `SECURITY DEFINER`, `search_path = ''`, no `EXECUTE` for PUBLIC).
   - **Preflight:** refuses, changing nothing, if any existing account's
     ledger kind differs from its type's class. Accounts are never
     reclassified automatically. The refusal's HINT lists the offending
     accounts (ids, type and kind only) with a self-contained `CASE`
     mapping, because the mapping function is rolled back with the
     refused migration.
   - Replaces `financial_accounts_guard` and `assert_transaction_valid`
     (`CREATE OR REPLACE`; triggers and privileges are kept, security
     attributes restated).
   - Re-runs `assert_transaction_valid` over every existing transaction and
     refuses if any fails. Before cards, every account is an asset, for which
     the templates are unchanged.
3. `20261025000800_card_expenses` (Milestone 5B): replaces only
   `assert_transaction_valid` (`CREATE OR REPLACE`, still `SECURITY INVOKER`
   behind the `SECURITY DEFINER` trigger function, `search_path = ''`
   restated, `EXECUTE` revoked from PUBLIC), relaxing one rule: an expense's
   source may be a credit card. Every transaction valid before is valid after,
   so it neither re-checks rows nor takes a table lock. No table, column,
   enum value, grant, policy or trigger changes, and no row is written; a
   scratch-database test compares every finora function's attributes, owner
   and privileges and every trigger before and after, and only that one
   function body differs.

In all three, no table, column, grant, policy or trigger is added or
removed, and the `SECURITY DEFINER` set is unchanged (the catalog tests pin
both).

**Hosted status:** these migrations (0600, 0700 and 0800) have not been run
against hosted Supabase. They were tested on local scratch databases only, which does not
establish hosted readiness (docs/runbooks/hosted-setup.md, "Credit-card
account migrations").

**Prerequisite and deployment order:** 5A assumes
`20261025000500_account_name_key` and the Milestone 4D application code are
already deployed. Then: migrate (0600, 0700), then deploy the 5A code. In that
state no maintenance window is needed for 5A, because the 4D code creates only
bank and cash accounts on asset ledger accounts, which the new rules accept.
If an environment is behind that prerequisite, one `migrate deploy` applies
0500, 0600 and 0700 together, and the deployment needs 0500's maintenance
window and write coordination. The 5A code needs both migrations: creating a
card fails at the old guard without them.

For 5B: migrate (0800), then deploy the 5B code. No maintenance window is
needed: 0800 only relaxes a COMMIT-time check, and code already running
(4D or 5A) never posts a card expense. The 5B code needs 0800: without it a
card expense is refused at COMMIT and the user sees a generic "the ledger
refused this change" error, with nothing written.

**Rollback:** all three migrations are forward-only. An enum value cannot be
dropped. Undoing 0700 would be a new, reviewed migration restoring the
previous function bodies, valid only while no credit-card account exists.
Undoing 0800 likewise would restore 0700's `assert_transaction_valid`, valid
only while no card expense exists: afterwards the check runs again on every
UPDATE of a transaction (voiding it, editing its payee or note), so restored
5A rules would refuse those updates for existing card expenses.

Once a credit-card account exists, rolling the application back to pre-5A
code is not a supported path. That code does not know the `credit_card`
type (views may show no type label) or account classes (it offers cards in
transaction pickers and plans opening balances as if every account were an
asset). The database rules above still refuse card income, transfers
involving a card and any wrong-direction opening balance at COMMIT, so
nothing incorrect is posted, but old code surfaces a generic ledger error.
(After 0800, an expense that old code plans on a card uses the same
Dr category / Cr card template and is accepted, which is correct.) Rolling
5B code back to 5A code keeps existing card expenses readable and voidable
(the database still accepts them), but 5A code refuses new ones; this path
has not been tested end to end.
Operators should fix forward; roll the application back only with a
reviewed, explicit recovery plan, and never by deleting account history or
changing a ledger account's kind.

## Consequences

- The existing `UPDATE (type)` grant can no longer break the ledger mapping,
  for the runtime role or the migration role (short of disabling triggers;
  see ADR 0005).
- Two hand-written PL/pgSQL functions grew. Their previous bodies are in
  migrations `20261025000300`; diff against it when reviewing.
- Account-picker filtering and the card refusals were narrowed by 5B (cards
  pay expenses) and are narrowed again by the payment and refund milestones.
- **Deferred:** card payments, refunds, opening credit balances, credit
  limits and available credit, statements, due dates, interest accrual (an
  interest charge or fee can be recorded by hand as an expense paid by
  card), cashback, cash advances and balance transfers, FX.
