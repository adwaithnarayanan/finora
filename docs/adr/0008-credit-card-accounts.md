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
card, Milestone 5C card payments (repayments), and Milestone 5D card
refunds.

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
- **Still refused** by 5B, by the domain with a field error ("… is a credit
  card; a card can only pay for an expense …") and by the database at COMMIT:
  income into a card, a transfer from a card, a transfer to a card, and a
  transfer between cards. 5C below adds the card payment as its own kind and
  keeps every one of those transfer and income refusals.
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

### Card payments (Milestone 5C)

A repayment of a card is a **new transaction kind**, `card_payment`: money
leaves a bank or cash account and reduces what is owed on a card. It is not
an expense (nothing was bought) and not income.

| Transaction | Debit | Credit | Example |
| --- | --- | --- | --- |
| card payment | the card (liability) | the paying account (asset) | ₹5,000 to HDFC Card from Axis: Dr HDFC Card 5,000 / Cr Axis 5,000 |

The debit reduces the card's normal (credit) balance, so the amount owed
falls; the credit reduces what the paying account holds. **No expense
category is touched**, and the entry balances in one currency like every
other.

**Why its own kind, not a transfer to a card.** The lines are the same as a
transfer's (Dr destination, Cr source), so reusing `transfer` would have been
a smaller change. It was rejected because it would have *weakened* an
existing rule: `assert_transaction_valid` would then have to accept a
transfer whose destination is a liability, and "a transfer to or from a card
is refused" (5A) would be gone. A separate kind adds a rule instead, leaves
the transfer rules exactly as strict as they were, lets the database pin the
repayment template precisely (asset source, `credit_card` destination, no
category), and gives history and the type filter an honest label. This is
also the direction 5B recorded ("a transfer to a card … with its own kind").

- **Domain.** `planTransaction` gains the `card_payment` template; the
  paying side must be an asset (bank or cash) and the side being paid must be
  a credit card. A card is refused as the payer (so no card pays another) and
  a bank or cash account is refused as the account being paid. Amount
  precision follows the card's currency, and both accounts must share it:
  there is no FX. Archived accounts on either side are refused as for any
  account. `TWO_SIDED_KINDS` (`transfer`, `card_payment`) is the one place
  that records which kinds have an account on both sides; the view layer and
  the payee rule read it instead of naming kinds.
- **Overpayment is allowed, and uncapped.** Paying more than is owed, or
  paying a card that owes nothing, leaves the card with a **credit balance in
  the owner's favour**, which `formatAccountBalance` already renders
  ("Credit balance ₹500.00"). No new rule was invented for this: balances are
  derived from posted lines and never stored, a liability's normal balance was
  always allowed to go negative (5A), and capping a payment at the derived
  balance would need to serialise against concurrent postings while refusing
  legitimate cases (paying a statement whose charges are not all entered yet).
  What stays unsupported is an *opening* credit balance, which needs an
  explicit "in your favour" choice rather than a sign.
- **Idempotency** is unchanged: the ledger fingerprint covers the date, the
  description ("Card payment", so a replayed transfer key conflicts) and both
  lines. Replaying a key with a different card, paying account, amount, date
  or note is an `IdempotencyConflictError`, never a silent change, and
  nothing is written.
- **Void** posts the exact mirror (Cr the card / Dr the paying account), so
  the amount owed and the balance both come back. Posted-entry immutability
  and the one-way void are unchanged.
- **Payee.** A card payment has no payee, like a transfer and an opening
  balance; the note is editable and the journal keeps its original text.
- **Database.** The row CHECK `transactions_shape` gains a `card_payment`
  branch (two distinct accounts, no category) and an `ELSE false`, so a kind
  added later without a branch is refused instead of silently accepted (the
  old `CASE` yielded NULL for an unhandled kind, which a CHECK accepts).
  `assert_transaction_valid` (deferred, at COMMIT) requires an asset source
  of type `bank` or `cash`, a liability destination of type `credit_card`,
  and exactly Dr the card / Cr the paying account for the transaction's
  amount. Archived accounts, other owners' rows and currency mismatches are
  refused by the existing insert guard, RLS and composite foreign keys,
  unchanged.
- **UI.** "Card payment" is a fourth type on the transaction form, with
  "Paid from" listing bank and cash accounts only and "Card to pay" listing
  cards only; there is no category and no payee field. Switching type clears
  a selection the new type's list cannot offer, so no stale account id is
  submitted. A card's page links to "Record repayment" with the card
  preselected. In history a payment reads as money in on the card's page (the
  debt fell), money out on the paying account's page, and neutral elsewhere,
  so it never enters expense or income totals.

**Out of scope for 5C:** refunds and chargebacks, cashback and other income
to a card, cash advances, balance transfers and card-to-card payments,
paying a card in another currency (FX), statements and reconciliation,
minimum payments, credit limits and available credit, due dates, autopay,
interest accrual, and opening credit balances. 5D below adds refunds.

### Card refunds (Milestone 5D)

Money a merchant gives back onto a card is a **new transaction kind**,
`card_refund`. It has two modes:

- **Linked**: it refunds a card purchase Finora recorded. Preferred whenever
  the purchase is there, because it is the honest record and because it is
  what lets Finora cap the refund at what was actually paid.
- **Unlinked**: a merchant credit for a purchase Finora never recorded. The
  owner chooses the expense category themselves.

| Transaction | Debit | Credit | Example |
| --- | --- | --- | --- |
| card refund | the card (liability) | the expense category | Rs 1,250 back from Bata on HDFC Card: Dr HDFC Card 1,250 / Cr Shopping 1,250 |

It is the **exact mirror of a card expense**. The debit reduces the card's
normal (credit) balance, so the amount owed falls; the credit reduces the
expense account's normal (debit) balance, so that category's expenses for the
period fall. **A refund is a reduction of expense, never income.**

**Why not income, and why its own kind.** Recording a refund as income into
the card was rejected twice over: income to a card is refused by 5A-5C, and it
would inflate income for the period while leaving the original expense
standing, so both totals would be wrong. An `expense` with a negative amount
was impossible (`transactions_amount_positive`). Reusing `income` with an
expense category would have broken the rule that a transaction's category kind
equals its own kind, for every kind. A separate kind adds a rule instead of
weakening one, lets the database pin the template precisely (a `credit_card`
destination, no source, an expense category), and gives history and the type
filter an honest label, exactly as 5C argued for `card_payment`.

**The linked purchase.** `transactions.refunds_transaction_id` (nullable)
points at the purchase, with a composite foreign key to `(id, owner_id)`, so a
refund of another owner's purchase cannot be written even with the owner's own
RLS context. It is **write-once**: the runtime role's UPDATE grant is
column-listed (`payee`, `note`, `reversal_entry_id`) and does not include it,
and `transactions_update_guard` now refuses a change to it. The row CHECK
`transactions_refund_link` allows it only on a `card_refund`, and never
pointing at the row itself.

- **A linked refund takes its category from the purchase**, not from the
  request, so the credit lands on exactly the expense account the purchase
  debited and per-category reporting stays correct. The form therefore shows no
  category picker in linked mode, and a submitted category is not read.
- **Eligibility.** The target must be an `expense`, not voided, whose **source
  account is the very card being credited**, in the same currency. That makes a
  refund of a refund impossible (its kind is not `expense`), and with it any
  chain or cycle: a refund may only point at an expense, and an expense may
  never point anywhere.
- **Partial and repeated refunds** are supported. The refunded total of a
  purchase is `sum(amount_minor)` over its refunds with `voided_at IS NULL` --
  derived, never stored, like every balance. `transactions_refunds_idx` keeps
  it an index scan.
- **Unlinked refunds are kept separate**: `refunds_transaction_id IS NULL`, so
  they never enter any purchase's total, even on the same card and in the same
  category.

**The cumulative limit, and why it is safe under concurrency.** The active
refunds of one purchase must never exceed its amount. A read-then-write would
not do: two transactions each reading "60 of 100 refunded" would both pass and
commit 120. Every check therefore takes `FOR UPDATE` **on the purchase row
before summing its refunds**, in three places:

1. the service, before it posts anything (`lockTransaction`), so the owner
   gets a precise field error naming what is left;
2. `transactions_insert_guard` (`BEFORE INSERT`, `SECURITY DEFINER`), which
   also covers raw SQL written through the runtime role;
3. `assert_transaction_valid` (deferred, at COMMIT), the standing invariant.

The loser waits on that lock; because each statement in READ COMMITTED takes a
fresh snapshot, the sum it computes once it acquires the lock includes the
winner's committed refund, and it is refused. Both 2 and 3 are reached inside
`SECURITY DEFINER` functions, so they see and lock true state whatever the
caller's RLS context. An integration test proves it twice: six simultaneous
Rs 60 refunds of a Rs 100 purchase through the service, and the same six
written as raw SQL on six separate connections -- one is accepted, five are
refused with the cumulative-limit error, and the derived balance agrees.

- **Idempotency** is unchanged, so a replayed refund is never counted twice:
  the ledger fingerprint covers the date, the description (which carries the
  merchant) and both lines, and the business transaction is found by its entry.
  Replaying a key with a different amount, date, note or payee is an
  `IdempotencyConflictError`, and nothing is written.
- **Void** posts the exact mirror (Cr the card / Dr the category), so the
  amount owed and the category's expenses both come back, **and the refundable
  amount is restored** -- the total counts only non-voided refunds, so no
  posted line is edited to achieve it. Posted-entry immutability and the
  one-way void are unchanged.
- **A purchase with active refunds cannot be voided.** Otherwise its refunds
  would refund nothing and the limit would guard an amount of zero. Refused by
  the service with a conflict error and at COMMIT by
  `assert_transaction_valid`; voiding the refunds first then allows it. A
  refund that has itself been voided is allowed to point at a purchase voided
  afterwards, so editing its note later is not refused.
- **Overpayment semantics are unchanged.** A refund larger than what is owed
  (or onto a card that owes nothing, which only an unlinked refund can be)
  leaves a **credit balance in the owner's favour**, which
  `formatAccountBalance` already renders. This is the same rule 5C settled for
  repayments; no new one was invented.
- **Payee.** A refund has a merchant ("Refunded by"), like an income or an
  expense; the note is editable and the journal keeps its original text.
- **UI.** "Card refund" is a fifth type on the transaction form, with
  "Refunded to" listing cards only, no paying account, and a mode choice
  between a recorded purchase and one not in Finora. Linked mode offers only
  the chosen card's purchases that are not voided and not refunded in full,
  each labelled with the amount left, and names the category the refund will
  credit. Switching mode or card drops a choice the new state cannot offer, so
  no stale purchase id or category travels with a submission; a refused
  submission comes back on the same mode with every value intact. A card
  purchase's page shows how much of it is refunded, the refunds themselves,
  and a "Record a refund" link; a refund's page links back to the purchase, or
  says it is a merchant credit. A card's page offers "Record refund" for the
  unlinked case. In history a refund reads as money in (the debt fell), titled
  "Refund: <category>" and badged "Card refund", so it never looks like
  another expense in that category and never like income.

**Out of scope for 5D:** chargebacks as a distinct concept, cashback and other
income to a card, a refund that changes a purchase's category, refunding an
expense paid from a bank or cash account, refunds in a currency other than the
purchase's (FX), cash advances, balance transfers, card-to-card payments,
statements and reconciliation, credit limits and available credit, due dates,
interest accrual, and opening credit balances.

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

4. `20261026000000_card_payment_kind` (Milestone 5C): only
   `ALTER TYPE transaction_kind ADD VALUE 'card_payment'`, for the same
   PostgreSQL reason as 0600. Unused, it changes nothing. In the window
   before the next migration, a raw-SQL `card_payment` row would not be
   caught by `transactions_shape` (its `CASE` has no `ELSE` yet, so an
   unhandled kind yields NULL, which a CHECK accepts); `assert_transaction_valid`
   still requires exactly Dr destination / Cr source for it, which is the
   card-payment template, and no application code writes the kind.
5. `20261026000100_card_payments` (Milestone 5C):
   - `SET lock_timeout = '5s'`, then `LOCK TABLE finora.transactions IN
     ACCESS EXCLUSIVE MODE` — the same shape as 0700, and for two reasons.
     **`prisma migrate deploy` (7.10.1) does not reliably wrap a migration
     file in a transaction**, and whether a file gets one depends on its
     statements. Measured on scratch databases: a file containing only
     `LOCK TABLE` fails with "LOCK TABLE can only be used in transaction
     blocks" (no enclosing transaction), and `CREATE TABLE; SELECT 1/0`
     leaves the table behind (not atomic) — yet the same pair preceded by a
     `LOCK TABLE` rolls back completely. Taking the lock explicitly
     therefore (a) gives this file one transaction, so a failure anywhere
     rolls back the CHECK *and* the function together, and (b) puts the wait
     for the lock the `ALTER TABLE` needs anyway under `lock_timeout`.
     `lock_timeout` uses a plain `SET`, not `SET LOCAL`: measured on the real
     file, `SET LOCAL` was discarded before the lock was taken and a
     contended deploy waited **689s** without giving up, while the plain SET
     fails it in ~5s with `55P03`. A plain SET is correct whether or not the
     file gets an enclosing transaction; the last statement restores
     `lock_timeout = DEFAULT`, and on failure Prisma closes the connection,
     so the bound never leaks into a later migration.
   - Replaces `transactions_shape` (one `ALTER TABLE` with a `DROP
     CONSTRAINT` and an `ADD CONSTRAINT`), adding the `card_payment` branch
     and `ELSE false`. This takes **ACCESS EXCLUSIVE** on
     `finora.transactions` (readers and writers wait) and scans the table
     once to validate. Every existing row satisfies the new predicate — the
     five existing branches are unchanged and no row has another kind — so
     the validation cannot refuse; the test asserts the constraint comes out
     `convalidated`.
   - Replaces `assert_transaction_valid` (`CREATE OR REPLACE`, still
     `SECURITY INVOKER` behind the `SECURITY DEFINER` trigger function,
     `search_path = ''` restated, `EXECUTE` revoked from PUBLIC) with the
     card-payment rule. Existing rows are not re-checked: this only adds a
     rule for a kind no row has, and every other branch is unchanged.
   - No table, column, grant, policy or trigger is added or removed, and no
     row is written. A scratch-database test compares every finora
     function's attributes, owner, privileges and body and every trigger
     before and after, and every constraint on `transactions`: only
     `assert_transaction_valid`'s body and `transactions_shape`'s definition
     differ.
   - **Failure leaves nothing partly applied**, verified two ways on scratch
     databases. With a reader holding `ACCESS SHARE`, the deploy fails after
     ~5s (`55P03`) with `transactions_shape` and `assert_transaction_valid`
     byte-identical to before. With a failing statement injected at the end
     of the real file, both objects are again byte-identical: the explicit
     `LOCK TABLE` gives the file one transaction, so the CHECK cannot be
     swapped without the function. Recovery is
     `prisma migrate resolve --rolled-back 20261026000100_card_payments` then
     redeploy; re-running from the start is safe, since
     `DROP`/`ADD CONSTRAINT` and `CREATE OR REPLACE` are idempotent in effect
     (verified: resolve plus redeploy completed and left the CHECK
     `convalidated`). A failure of `20261026000100` does leave
     `20261026000000`'s enum value applied — a separate file — which is the
     documented, harmless intermediate state.

6. `20261029000000_card_refund_kind` (Milestone 5D): only
   `ALTER TYPE transaction_kind ADD VALUE 'card_refund'`, for the same
   PostgreSQL reason as 0600. Unused, it changes nothing. Unlike 5C's enum
   migration there is no window to document: `20261026000100` gave
   `transactions_shape` an `ELSE false`, so a raw-SQL `card_refund` row
   written between the two files is already refused by that CHECK.
7. `20261029000100_card_refunds` (Milestone 5D):
   - `SET lock_timeout = '5s'`, then `LOCK TABLE finora.transactions IN
     ACCESS EXCLUSIVE MODE`, for exactly the reasons measured for
     `20261026000100` above (Prisma 7.10.1 does not reliably wrap a migration
     file in a transaction, and a plain `SET` is needed because `SET LOCAL` was
     discarded before the lock was taken). The lock gives the file one
     transaction and bounds the wait.
   - One `ALTER TABLE` adds the nullable column `refunds_transaction_id`, its
     composite foreign key `transactions_refunds_fkey` to `(id, owner_id)`, the
     row CHECK `transactions_refund_link`, and the replacement
     `transactions_shape` (a `card_refund` branch; the `ELSE false` stays).
     ADD COLUMN of a nullable column with no default does not rewrite the
     table, and on a brand-new all-NULL column neither the foreign key nor
     `transactions_refund_link` can reject anything. All of it needs ACCESS
     EXCLUSIVE, which step 0 already holds.
   - `CREATE INDEX transactions_refunds_idx`, which is cheap on a column that
     is NULL for every existing row.
   - Replaces three functions with `CREATE OR REPLACE` (triggers and
     privileges kept, `SECURITY DEFINER`/`SECURITY INVOKER` and the empty
     `search_path` restated, `EXECUTE` revoked from PUBLIC):
     `transactions_insert_guard` (the required category kind, and the linked
     refund's eligibility and cumulative limit under `FOR UPDATE`),
     `transactions_update_guard` (`refunds_transaction_id` joins the immutable
     set) and `assert_transaction_valid` (the refund template, eligibility, the
     cumulative limit, and the refusal to void a refunded purchase).
   - **One rule is relaxed, not weakened:** a category's kind no longer has to
     *equal* the transaction's kind, it has to equal the kind the transaction
     *requires*. That is unchanged for income and expenses and is `expense` for
     a card refund, so every existing row still satisfies it.
   - No table, enum value, grant, policy or trigger is added or removed, and no
     row is written. A scratch-database test compares every finora function's
     attributes, owner, privileges and body, every trigger, every constraint on
     `transactions` and every row of all eight tables before and after: only
     the three function bodies and `transactions_shape` differ, the two new
     constraints are the only ones added, all three are `convalidated`, the new
     column is NULL on every existing row, and `finora_app` gains
     `SELECT, INSERT` but not `UPDATE` on it.
   - **Recovery** is as for `20261026000100`:
     `prisma migrate resolve --rolled-back 20261029000100_card_refunds` then
     redeploy. Re-running from the start is **not** idempotent in effect here,
     unlike 5C: `ADD COLUMN` and `ADD CONSTRAINT` without `IF NOT EXISTS` fail
     if a previous attempt committed them. Because the explicit `LOCK TABLE`
     gives the file one transaction, a failure rolls the whole file back, so
     that state should not arise; if it somehow does (for example the lock
     statement itself was reordered or removed), an operator must drop the
     column and the two constraints before redeploying. A failure of
     `20261029000100` does leave `20261029000000`'s enum value applied -- a
     separate file -- which is the documented, harmless intermediate state.

In all seven, no table, grant, policy or trigger is added or removed, and the
`SECURITY DEFINER` set is unchanged (the catalog tests pin both). 0500-0800
write no enum value; 0600, 20261026000000 and 20261029000000 each add one.
`20261029000100` is the only one that adds a column, and the only one that
adds constraints other than by replacing one.

**Hosted status:** these migrations (0600, 0700, 0800 and the two 5C and two
5D migrations) have not been run against hosted Supabase. They were tested on local scratch databases only, which does not
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

For 5D: migrate (`20261029000000`, then `20261029000100`, normally one
`migrate deploy` run), then deploy the 5D code. **A brief maintenance window
or a quiet moment is advisable**, as for 5C and for the same reason:
`20261029000100` takes ACCESS EXCLUSIVE on `finora.transactions` to add the
column, the foreign key and the CHECKs, so transaction reads and writes wait
for it (a single owner's table is small, so this is short, and
`lock_timeout = '5s'` bounds the wait for the lock itself, failing the deploy
in ~5s instead of queueing traffic). Code already running (4D through 5C)
never posts a card refund, so migrating ahead of the deploy is safe. **The 5D
code needs `20261029000100` for every transaction, not only refunds**, because
its finance store reads and writes `refunds_transaction_id` on every
transaction row: deployed against a 5C database it would fail to record even
an ordinary expense, so the migration must land first.

For 5C: migrate (`20261026000000`, then `20261026000100`, normally one
`migrate deploy` run), then deploy the 5C code. **A brief maintenance window
or a quiet moment is advisable**, unlike 5B: `20261026000100` takes ACCESS
EXCLUSIVE on `finora.transactions` to replace the row CHECK, so transaction
reads and writes wait for it (a single owner's table is small, so this is
short, and `lock_timeout = '5s'` bounds the wait for the lock itself, failing
the deploy in ~5s instead of queueing traffic). Code
already running (4D, 5A or 5B) never posts a card payment, so migrating
ahead of the deploy is safe. The 5C code needs both migrations: without the
enum value, recording a repayment fails when the row is written; with the
enum value but not `20261026000100`, it is refused at COMMIT and the user
sees a generic "the ledger refused this change" error, with nothing written.

**Rollback:** all seven migrations are forward-only. An enum value cannot be
dropped. Undoing 0700 would be a new, reviewed migration restoring the
previous function bodies, valid only while no credit-card account exists.
Undoing 0800 likewise would restore 0700's `assert_transaction_valid`, valid
only while no card expense exists: afterwards the check runs again on every
UPDATE of a transaction (voiding it, editing its payee or note), so restored
5A rules would refuse those updates for existing card expenses. Undoing
`20261026000100` would restore 0800's `assert_transaction_valid` and
`transactions_shape`, valid only while no card payment exists: the restored
CHECK has no `card_payment` branch, so with the `ELSE false` it would refuse
every existing payment on any UPDATE of it, and without the branch the
COMMIT-time check would too.

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
has not been tested end to end. The same holds for 5C: rolling 5C code back
to 5B code leaves existing card payments in the database (readable and
voidable, since the kind and the rules remain), but 5B code does not know
the kind — `RECORD_KIND_LABELS[kind]` is undefined for it, so history and
the type filter would render a missing label — and it refuses new ones. This
path has not been tested either.

Rolling 5D code back to 5C code is also untested and leaves the same kind of
gap: the column is nullable, so 5C code keeps recording ordinary transactions,
but it does not know the `card_refund` kind (a missing label again), and it
offers no way to void a refund, which the database now requires before its
purchase can be voided. Undoing `20261029000100` itself would mean restoring
5C's three function bodies and `transactions_shape` and dropping the column
with its two constraints, valid only while no card refund exists: afterwards
the restored CHECK has no `card_refund` branch, so with the `ELSE false` it
would refuse every existing refund on any UPDATE of it, and the restored
COMMIT-time check would too.
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
  pay expenses) and again by 5C (cards are paid), and would be narrowed once
  more by a refund milestone.
- `transaction_kind` now has a sixth value, and `transactions_shape` fails
  closed on an unhandled one. Adding a kind therefore means: an enum
  migration, a branch in that CHECK, a branch in `assert_transaction_valid`,
  a branch in `requiredCategoryKind` (and in the insert guard's mirror of it)
  if it posts to a category, the Prisma enum, and `RECORD_KIND_LABELS` —
  which is the intended cost.
- `finora.transactions` now references itself twice: `replaces_transaction_id`
  (one-to-one, a correction) and `refunds_transaction_id` (many-to-one, the
  refunds of a purchase). Both are owner-pinned and immutable after insert.
- Two invariants are now enforced by locking a *related* row rather than by a
  constraint: the single active opening balance per account (5A, locking the
  account) and the cumulative refund limit per purchase (5D, locking the
  purchase). Anything added later that must be bounded across rows should
  follow the same shape, because a row CHECK cannot see another row and a
  deferred check without a lock is not safe under concurrency.
- **Deferred:** opening credit balances, credit limits and
  available credit, statements, due dates, minimum payments and autopay,
  interest accrual (an interest charge or fee can be recorded by hand as an
  expense paid by card), cashback, cash advances, balance transfers,
  card-to-card payments, FX.
