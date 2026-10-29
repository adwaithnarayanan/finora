-- Credit cards (docs/adr/0008-credit-card-accounts.md), Milestone 5C step 2 of
-- 2: card payments (repayments of a credit card).
--
--  * transactions_shape (row CHECK): a 'card_payment' uses two distinct
--    accounts and no category, like a transfer. The CASE gains an explicit
--    branch for it and an `ELSE false`, so any transaction kind added later
--    without a branch here is refused instead of silently accepted (the old
--    CASE yielded NULL for an unhandled kind, and a CHECK accepts NULL).
--  * assert_transaction_valid (deferred, at COMMIT): a card payment must pay
--    a credit card (a liability ledger account of an account of type
--    credit_card) from a bank or cash account (an asset), with exactly
--    Dr the card / Cr the paying account for the transaction's amount. The
--    debit reduces the card's normal (credit) balance, so the amount owed
--    falls; the credit reduces what the paying account holds. No expense
--    category is touched.
--
-- Every rule for income, expenses, transfers and opening balances is
-- unchanged: a transfer to or from a credit card is still refused, so this
-- adds a rule rather than relaxing one. Every existing row therefore still
-- satisfies both the CHECK and the function, which is why re-adding the
-- CHECK below validates without a single refusal.
--
-- Locks and deployment: replacing the CHECK is a DROP plus an ADD in one
-- ALTER TABLE, which needs ACCESS EXCLUSIVE on finora.transactions and scans
-- the table once to validate. Step 0 takes that lock up front, so readers and
-- writers of finora.transactions wait from there until COMMIT; a single
-- owner's history is small, so that is brief. The function is replaced in
-- place (CREATE OR REPLACE keeps its trigger and privileges; SECURITY INVOKER
-- and the empty search_path are restated because CREATE OR REPLACE resets
-- them). No table, column, enum value, grant, policy or trigger is added or
-- removed, and no row is written.
--
-- Atomicity: `prisma migrate deploy` (Prisma 7.10.1) does NOT reliably wrap a
-- migration file in a transaction, and which files get one depends on their
-- statements. Verified on scratch databases: a file holding only
-- `LOCK TABLE` fails with "LOCK TABLE can only be used in transaction
-- blocks" (so there is no enclosing transaction), and a file of
-- `CREATE TABLE; SELECT 1/0` leaves the table behind (so it is not atomic) --
-- while the same pair preceded by a `LOCK TABLE` rolls back fully.
--
-- This file therefore takes its lock explicitly, as 20261025000700 does. That
-- gives it one transaction (so a failure anywhere rolls the whole file back,
-- leaving neither the CHECK nor the function changed) and puts the wait for
-- the lock under `lock_timeout` where an operator can bound it.
--
-- `lock_timeout` is set with a plain `SET`, not `SET LOCAL`: measured on the
-- real file, `SET LOCAL` was discarded before the lock was taken and a
-- contended deploy waited 689s without giving up, whereas the session-level
-- SET fails it in ~5s with 55P03. A plain SET is correct whether or not this
-- file gets an enclosing transaction; the last statement puts it back, and on
-- failure Prisma closes the connection, so the 5s bound never leaks into a
-- later migration.
--
-- Forward-only. Must not contain BEGIN/COMMIT.

-- 0. Bounded waiting, and one transaction for the whole file.
--    ACCESS EXCLUSIVE on finora.transactions is what the ALTER TABLE in step 1
--    needs anyway; taking it here, explicitly, bounds the wait under
--    lock_timeout and gives this file an enclosing transaction block (see the
--    header), so a later failure rolls back everything in it. Reads and
--    writes of transactions wait from here until COMMIT. Fail after 5s rather
--    than queue every other query behind the lock request.
SET lock_timeout = '5s';
LOCK TABLE "finora"."transactions" IN ACCESS EXCLUSIVE MODE;

-- 1. Which accounts and category each kind uses (the posting templates).
--    A card payment has a source (bank or cash) and a destination (the card),
--    distinct, and no category. Its classes are checked at COMMIT below; this
--    row CHECK is the cheap first line of defence.
ALTER TABLE "finora"."transactions"
  DROP CONSTRAINT "transactions_shape",
  ADD CONSTRAINT "transactions_shape" CHECK (
    CASE "kind"
      WHEN 'income' THEN "destination_account_id" IS NOT NULL AND "source_account_id" IS NULL AND "category_id" IS NOT NULL
      WHEN 'expense' THEN "source_account_id" IS NOT NULL AND "destination_account_id" IS NULL AND "category_id" IS NOT NULL
      WHEN 'transfer' THEN "source_account_id" IS NOT NULL AND "destination_account_id" IS NOT NULL AND "category_id" IS NULL
        AND "source_account_id" <> "destination_account_id"
      WHEN 'card_payment' THEN "source_account_id" IS NOT NULL AND "destination_account_id" IS NOT NULL AND "category_id" IS NULL
        AND "source_account_id" <> "destination_account_id"
      WHEN 'opening_balance' THEN "destination_account_id" IS NOT NULL AND "source_account_id" IS NULL AND "category_id" IS NULL
      -- Fail closed: a kind added without a branch above is refused.
      ELSE false
    END
  );

-- 2. Transactions: agreement with the ledger, checked at COMMIT -----------------------
-- A transaction must record a posted, non-reversal journal entry whose lines
-- are EXACTLY its posting template (two lines, the right ledger accounts and
-- sides, the transaction's amount):
--   income           Dr destination asset     Cr category income account
--   expense          Dr category expense acct Cr source (asset, or credit-card liability)
--   transfer         Dr destination asset     Cr source asset
--   card_payment     Dr destination card      Cr source asset
--   opening_balance  asset account:     Dr account               Cr opening-balance equity
--                    liability account: Dr opening-balance equity Cr account
-- A credit card can be the source of an expense and the destination of a card
-- payment; income and transfers use asset (bank or cash) accounts only, so a
-- transfer to or from a card remains refused.
-- A void must link the posted reversal of that entry; a replacement must
-- record the entry that replaced the voided original's entry.
CREATE OR REPLACE FUNCTION "finora"."assert_transaction_valid"(target uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  t finora.transactions%ROWTYPE;
  entry finora.journal_entries%ROWTYPE;
  counterpart uuid;
  source_ledger uuid;
  source_kind finora.ledger_account_kind;
  source_type finora.financial_account_type;
  destination_ledger uuid;
  destination_kind finora.ledger_account_kind;
  destination_type finora.financial_account_type;
  debit_account uuid;
  credit_account uuid;
  original finora.transactions%ROWTYPE;
BEGIN
  SELECT * INTO t FROM finora.transactions WHERE id = target;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO entry FROM finora.journal_entries WHERE id = t.journal_entry_id;
  IF entry.status <> 'posted' OR entry.reverses_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'finora.finance: a transaction must record a posted, non-reversal journal entry'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT fa.ledger_account_id, la.kind, fa.type INTO source_ledger, source_kind, source_type
    FROM finora.financial_accounts AS fa
    JOIN finora.ledger_accounts AS la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id
   WHERE fa.id = t.source_account_id AND fa.owner_id = t.owner_id;
  SELECT fa.ledger_account_id, la.kind, fa.type INTO destination_ledger, destination_kind, destination_type
    FROM finora.financial_accounts AS fa
    JOIN finora.ledger_accounts AS la ON la.id = fa.ledger_account_id AND la.owner_id = fa.owner_id
   WHERE fa.id = t.destination_account_id AND fa.owner_id = t.owner_id;

  -- Asset accounts everywhere, except that the source of an expense may be a
  -- credit card (both its type and its liability ledger account are checked).
  IF t.kind IN ('income', 'expense', 'transfer')
     AND ((t.source_account_id IS NOT NULL AND source_kind IS DISTINCT FROM 'asset'
           AND NOT (t.kind = 'expense' AND source_kind = 'liability' AND source_type = 'credit_card'))
       OR (t.destination_account_id IS NOT NULL AND destination_kind IS DISTINCT FROM 'asset')) THEN
    RAISE EXCEPTION 'finora.finance: a credit card can only pay an expense or be paid by a card payment; income and transfers use bank and cash accounts only'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A card payment pays a credit card from a bank or cash account: never a
  -- card from a card, and never a bank or cash account as the destination.
  IF t.kind = 'card_payment'
     AND (source_kind IS DISTINCT FROM 'asset' OR source_type = 'credit_card'
       OR destination_kind IS DISTINCT FROM 'liability' OR destination_type IS DISTINCT FROM 'credit_card') THEN
    RAISE EXCEPTION 'finora.finance: a card payment pays a credit card from a bank or cash account'
      USING ERRCODE = 'check_violation';
  END IF;

  IF t.kind IN ('income', 'expense') THEN
    SELECT m.ledger_account_id INTO counterpart FROM finora.category_ledger_accounts AS m
     WHERE m.category_id = t.category_id AND m.owner_id = t.owner_id AND m.currency_code = t.currency_code;
  ELSIF t.kind = 'opening_balance' THEN
    SELECT m.ledger_account_id INTO counterpart FROM finora.system_ledger_accounts AS m
     WHERE m.owner_id = t.owner_id AND m.purpose = 'opening_balance_equity' AND m.currency_code = t.currency_code;
  END IF;

  -- NULL (no template) for anything else, which fails the check below.
  IF t.kind = 'opening_balance' THEN
    debit_account := CASE destination_kind WHEN 'asset' THEN destination_ledger WHEN 'liability' THEN counterpart END;
    credit_account := CASE destination_kind WHEN 'asset' THEN counterpart WHEN 'liability' THEN destination_ledger END;
  ELSIF t.kind = 'card_payment' THEN
    -- Dr the card (reduces the amount owed), Cr the paying account.
    debit_account := destination_ledger;
    credit_account := source_ledger;
  ELSE
    debit_account := CASE t.kind WHEN 'expense' THEN counterpart ELSE destination_ledger END;
    credit_account := CASE t.kind WHEN 'income' THEN counterpart ELSE source_ledger END;
  END IF;

  IF debit_account IS NULL OR credit_account IS NULL
     OR (SELECT count(*) FROM finora.journal_lines WHERE entry_id = t.journal_entry_id) <> 2
     OR NOT EXISTS (SELECT 1 FROM finora.journal_lines WHERE entry_id = t.journal_entry_id
                     AND account_id = debit_account AND side = 'debit' AND amount_minor = t.amount_minor)
     OR NOT EXISTS (SELECT 1 FROM finora.journal_lines WHERE entry_id = t.journal_entry_id
                     AND account_id = credit_account AND side = 'credit' AND amount_minor = t.amount_minor) THEN
    RAISE EXCEPTION 'finora.finance: the journal entry does not match the transaction'
      USING ERRCODE = 'check_violation';
  END IF;

  IF t.reversal_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finora.journal_entries
     WHERE id = t.reversal_entry_id AND status = 'posted' AND reverses_entry_id = t.journal_entry_id
  ) THEN
    RAISE EXCEPTION 'finora.finance: a void must link the posted reversal of the transaction''s entry'
      USING ERRCODE = 'check_violation';
  END IF;

  IF t.replaces_transaction_id IS NOT NULL THEN
    SELECT * INTO original FROM finora.transactions WHERE id = t.replaces_transaction_id;
    IF original.kind <> t.kind OR original.reversal_entry_id IS NULL
       OR entry.replaces_entry_id IS DISTINCT FROM original.journal_entry_id THEN
      RAISE EXCEPTION 'finora.finance: a replacement must record the entry that replaced the voided original'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF t.kind = 'opening_balance' AND (
    SELECT count(*) FROM finora.transactions
     WHERE destination_account_id = t.destination_account_id AND kind = 'opening_balance' AND voided_at IS NULL
  ) > 1 THEN
    RAISE EXCEPTION 'finora.finance: an account can have only one active opening balance'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- CREATE OR REPLACE keeps existing privileges; restated so this file alone
-- shows that PUBLIC cannot call it.
REVOKE ALL ON FUNCTION "finora"."assert_transaction_valid"(uuid) FROM PUBLIC;

-- 4. Put lock_timeout back, so the 5s bound set in step 0 does not carry over
--    to any later migration applied on this same connection. (If a statement
--    above failed, this one does not run and the migration's connection is
--    closed, so nothing carries over either way.)
SET lock_timeout = DEFAULT;

-- The lock taken in step 0 is released at COMMIT, with everything above.

