-- Credit cards (docs/adr/0008-credit-card-accounts.md), Milestone 5D step 2 of
-- 2: card refunds, both linked to a recorded purchase and unlinked (a
-- merchant credit for a purchase Finora never recorded).
--
--  * `refunds_transaction_id` (new, nullable): the card purchase a refund
--    refunds, with a composite foreign key to (id, owner_id), so a refund can
--    never point at another owner's row. The runtime role keeps its
--    column-listed UPDATE grant (payee, note, reversal_entry_id), which does
--    NOT include this column, and transactions_update_guard now refuses a
--    change to it, so the link is write-once at INSERT.
--  * transactions_refund_link (row CHECK): only a 'card_refund' may set the
--    column, and never to itself.
--  * transactions_shape (row CHECK): a 'card_refund' uses the destination
--    account (the card) and a category, like income, and no source account.
--  * transactions_insert_guard: the category of a 'card_refund' must be an
--    *expense* category (its kind no longer has to equal the transaction's
--    kind), and a linked refund must fit within what is left of the purchase.
--  * assert_transaction_valid (deferred, at COMMIT): a card refund debits a
--    credit card and credits that category's expense ledger account, for the
--    transaction's amount. The debit reduces the amount owed; the credit
--    reduces the category's expense total, so a refund is a reduction of
--    expense and never income. A linked refund must reference an active
--    expense whose paying account is this very card, in the same currency,
--    and the active refunds of one purchase must never exceed its amount.
--    A purchase with active refunds cannot be voided.
--
-- CUMULATIVE LIMIT UNDER CONCURRENCY. Both the insert guard and the
-- COMMIT-time check take `FOR UPDATE` on the *purchase* row before summing
-- its active refunds. That lock is what makes the limit safe: without it two
-- transactions each reading "60 of 100 refunded" would both pass and commit
-- 120. With it, the second one waits for the first to commit, and because
-- each statement in READ COMMITTED takes a fresh snapshot, the sum it then
-- computes includes the first refund and the second is refused. The lock is
-- taken in the SECURITY DEFINER guard and in assert_transaction_valid (called
-- from the SECURITY DEFINER trigger function transactions_validate), so it
-- sees and locks true state whatever the caller's RLS context, and it applies
-- to raw SQL written through the application's database role, not just to
-- traffic that went through the service.
--
-- Every rule for income, expenses, transfers, card payments and opening
-- balances is unchanged. The one relaxation is that a category's kind need no
-- longer equal the transaction's kind; it must equal the kind the transaction
-- *requires*, which is unchanged for income and expense and is 'expense' for
-- a card refund. Every existing row therefore still satisfies every CHECK and
-- every function below, which is why the two new constraints and the replaced
-- transactions_shape all validate without a single refusal.
--
-- Locks and deployment: ADD COLUMN (nullable, no default) does not rewrite
-- the table; the new foreign key and the two CHECKs each validate with a
-- single scan, and on a brand-new all-NULL column there is nothing for the
-- foreign key or transactions_refund_link to reject. Replacing
-- transactions_shape is a DROP plus an ADD in one ALTER TABLE. All of it
-- needs ACCESS EXCLUSIVE on finora.transactions. Step 0 takes that lock up
-- front, so readers and writers of finora.transactions wait from there until
-- COMMIT; a single owner's history is small, so that is brief. The three
-- functions are replaced in place (CREATE OR REPLACE keeps their triggers and
-- privileges; the security attributes and empty search_path are restated
-- because CREATE OR REPLACE resets them). No table, enum value, grant, policy
-- or trigger is added or removed, and no row is written.
--
-- Atomicity: `prisma migrate deploy` (Prisma 7.10.1) does NOT reliably wrap a
-- migration file in a transaction, and which files get one depends on their
-- statements. Verified on scratch databases: a file holding only
-- `LOCK TABLE` fails with "LOCK TABLE can only be used in transaction
-- blocks" (so there is no enclosing transaction), and a file of
-- `CREATE TABLE; SELECT 1/0` leaves the table behind (so it is not atomic) --
-- while the same pair preceded by a `LOCK TABLE` rolls back fully.
--
-- This file therefore takes its lock explicitly, as 20261025000700 and
-- 20261026000100 do. That gives it one transaction (so a failure anywhere
-- rolls the whole file back, leaving the column, the constraints and all
-- three functions as they were) and puts the wait for the lock under
-- `lock_timeout` where an operator can bound it.
--
-- `lock_timeout` is set with a plain `SET`, not `SET LOCAL`: measured on
-- 20261026000100, `SET LOCAL` was discarded before the lock was taken and a
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

-- 1. The linked-purchase column, its foreign key, and the posting shapes.
--    The foreign key is composite on (refunds_transaction_id, owner_id), the
--    same owner-pinning every other reference in this schema uses, so a
--    refund of another owner's purchase cannot be written even with the
--    owner's own RLS context. RESTRICT on both sides: a purchase with refunds
--    cannot be deleted (transactions are never deleted anyway) and ids never
--    change.
ALTER TABLE "finora"."transactions"
  ADD COLUMN "refunds_transaction_id" UUID,
  ADD CONSTRAINT "transactions_refunds_fkey" FOREIGN KEY ("refunds_transaction_id", "owner_id")
    REFERENCES "finora"."transactions"("id", "owner_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Only a card refund links a purchase, and never itself. (That the target
  -- is an *expense* on the same card is checked by the guard and at COMMIT:
  -- a row CHECK cannot look at another row.)
  ADD CONSTRAINT "transactions_refund_link" CHECK (
    "refunds_transaction_id" IS NULL
      OR ("kind" = 'card_refund' AND "refunds_transaction_id" <> "id")
  ),
  DROP CONSTRAINT "transactions_shape",
  ADD CONSTRAINT "transactions_shape" CHECK (
    CASE "kind"
      WHEN 'income' THEN "destination_account_id" IS NOT NULL AND "source_account_id" IS NULL AND "category_id" IS NOT NULL
      WHEN 'expense' THEN "source_account_id" IS NOT NULL AND "destination_account_id" IS NULL AND "category_id" IS NOT NULL
      WHEN 'transfer' THEN "source_account_id" IS NOT NULL AND "destination_account_id" IS NOT NULL AND "category_id" IS NULL
        AND "source_account_id" <> "destination_account_id"
      WHEN 'card_payment' THEN "source_account_id" IS NOT NULL AND "destination_account_id" IS NOT NULL AND "category_id" IS NULL
        AND "source_account_id" <> "destination_account_id"
      -- A refund lands on the card (the destination) and reduces one expense
      -- category; nothing pays it, so there is no source account.
      WHEN 'card_refund' THEN "destination_account_id" IS NOT NULL AND "source_account_id" IS NULL AND "category_id" IS NOT NULL
      WHEN 'opening_balance' THEN "destination_account_id" IS NOT NULL AND "source_account_id" IS NULL AND "category_id" IS NULL
      -- Fail closed: a kind added without a branch above is refused.
      ELSE false
    END
  );

-- 2. "How much of this purchase is already refunded" as an index scan. The
--    column is NULL for every row except a linked refund, so the index stays
--    tiny.
CREATE INDEX "transactions_refunds_idx" ON "finora"."transactions"("refunds_transaction_id", "owner_id");

-- 3. Transactions: creation rules ------------------------------------------------------
-- SECURITY DEFINER so the checks and row locks see true state whatever the
-- caller's RLS context; every lookup is restricted to the row's own owner.
--  * no new transaction on an archived account or category (the account row
--    is locked FOR SHARE, so a concurrent archive waits or is waited for);
--  * the category's kind is the one the transaction's kind requires: 'income'
--    for income, 'expense' for an expense AND for a card refund (a refund
--    gives back what an expense category was charged, so it credits that same
--    kind of account);
--  * a linked card refund refunds an active expense paid by the very card it
--    credits, in the same currency, and fits within what is left of it. The
--    purchase row is locked FOR UPDATE *before* its refunds are summed, which
--    is what makes the cumulative limit safe when two refunds race (see the
--    header);
--  * at most one active (non-voided) opening balance per account (the account
--    row is locked FOR UPDATE, serialising concurrent attempts);
--  * created as not voided, with database timestamps.
CREATE OR REPLACE FUNCTION "finora"."transactions_insert_guard"() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  account_id uuid;
  archived timestamptz;
  category_kind finora.category_kind;
  category_archived timestamptz;
  expected_category finora.category_kind;
  purchase finora.transactions%ROWTYPE;
  refunded bigint;
BEGIN
  IF NEW.voided_at IS NOT NULL OR NEW.reversal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'finora.finance: transactions are created unvoided'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  FOREACH account_id IN ARRAY ARRAY[NEW.source_account_id, NEW.destination_account_id]
  LOOP
    CONTINUE WHEN account_id IS NULL;
    IF NEW.kind = 'opening_balance' THEN
      SELECT fa.archived_at INTO archived FROM finora.financial_accounts AS fa
       WHERE fa.id = account_id AND fa.owner_id = NEW.owner_id FOR UPDATE;
    ELSE
      SELECT fa.archived_at INTO archived FROM finora.financial_accounts AS fa
       WHERE fa.id = account_id AND fa.owner_id = NEW.owner_id FOR SHARE;
    END IF;
    -- A missing account falls through to the composite foreign key.
    IF archived IS NOT NULL THEN
      RAISE EXCEPTION 'finora.finance: archived accounts cannot take new transactions'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- The kind of category this kind of transaction posts to. NULL for the
  -- kinds that take none, which the shape CHECK already requires to have no
  -- category; if one is set anyway, the test below fails closed.
  expected_category := CASE NEW.kind
    WHEN 'income' THEN 'income'::finora.category_kind
    WHEN 'expense' THEN 'expense'::finora.category_kind
    WHEN 'card_refund' THEN 'expense'::finora.category_kind
  END;

  IF NEW.category_id IS NOT NULL THEN
    SELECT c.kind, c.archived_at INTO category_kind, category_archived FROM finora.categories AS c
     WHERE c.id = NEW.category_id AND c.owner_id = NEW.owner_id FOR SHARE;
    IF FOUND AND (expected_category IS NULL OR category_kind <> expected_category) THEN
      RAISE EXCEPTION 'finora.finance: the category kind does not match the transaction'
        USING ERRCODE = 'check_violation';
    END IF;
    IF category_archived IS NOT NULL THEN
      RAISE EXCEPTION 'finora.finance: archived categories cannot take new transactions'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Gated on the kind so that a link on any other kind is reported by the
  -- transactions_refund_link CHECK, which is its authority, rather than by a
  -- confusing eligibility message from here (BEFORE triggers run first).
  IF NEW.kind = 'card_refund' AND NEW.refunds_transaction_id IS NOT NULL THEN
    -- FOR UPDATE first: it serialises concurrent refunds of this purchase, so
    -- the sum below cannot miss one that is about to commit.
    SELECT * INTO purchase FROM finora.transactions AS t
     WHERE t.id = NEW.refunds_transaction_id AND t.owner_id = NEW.owner_id FOR UPDATE;
    -- A missing purchase falls through to the composite foreign key.
    IF FOUND THEN
      IF purchase.kind <> 'expense' OR purchase.voided_at IS NOT NULL
         OR purchase.source_account_id IS DISTINCT FROM NEW.destination_account_id
         OR purchase.currency_code <> NEW.currency_code THEN
        RAISE EXCEPTION 'finora.finance: a card refund can only refund an active purchase paid by the same card, in its currency'
          USING ERRCODE = 'check_violation';
      END IF;
      SELECT coalesce(sum(r.amount_minor), 0) INTO refunded FROM finora.transactions AS r
       WHERE r.refunds_transaction_id = NEW.refunds_transaction_id AND r.owner_id = NEW.owner_id
         AND r.voided_at IS NULL;
      IF refunded + NEW.amount_minor > purchase.amount_minor THEN
        RAISE EXCEPTION 'finora.finance: the refunds of a purchase cannot exceed what was paid for it'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  IF NEW.kind = 'opening_balance' AND EXISTS (
    SELECT 1 FROM finora.transactions AS t
     WHERE t.destination_account_id = NEW.destination_account_id AND t.owner_id = NEW.owner_id
       AND t.kind = 'opening_balance' AND t.voided_at IS NULL
  ) THEN
    RAISE EXCEPTION 'finora.finance: the account already has an opening balance; correct it instead'
      USING ERRCODE = 'unique_violation';
  END IF;

  NEW.created_at := now();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$;

-- 4. Transactions: immutability ---------------------------------------------------------
-- Only metadata (payee, note) may change, plus a one-way void that links the
-- posted reversal. Nothing that has an accounting effect can be edited, and
-- transactions are never deleted. `refunds_transaction_id` joins that list:
-- a refund cannot be moved to another purchase, and a link cannot be added to
-- or removed from an existing row.
CREATE OR REPLACE FUNCTION "finora"."transactions_update_guard"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'finora.finance: transactions are never deleted; void them instead'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.kind <> OLD.kind
     OR NEW.occurred_on <> OLD.occurred_on OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency_code <> OLD.currency_code
     OR NEW.source_account_id IS DISTINCT FROM OLD.source_account_id
     OR NEW.destination_account_id IS DISTINCT FROM OLD.destination_account_id
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.journal_entry_id <> OLD.journal_entry_id
     OR NEW.replaces_transaction_id IS DISTINCT FROM OLD.replaces_transaction_id
     OR NEW.refunds_transaction_id IS DISTINCT FROM OLD.refunds_transaction_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'finora.finance: a transaction''s accounting fields are immutable; void and re-enter it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.reversal_entry_id IS NOT NULL THEN
    IF NEW.reversal_entry_id IS DISTINCT FROM OLD.reversal_entry_id OR NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
      RAISE EXCEPTION 'finora.finance: a void cannot be undone or changed'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.reversal_entry_id IS NOT NULL THEN
    NEW.voided_at := now();
  ELSIF NEW.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'finora.finance: voided_at is set only by linking a reversal'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := greatest(now(), OLD.updated_at);
  RETURN NEW;
END;
$$;

-- 5. Transactions: agreement with the ledger, checked at COMMIT -----------------------
-- A transaction must record a posted, non-reversal journal entry whose lines
-- are EXACTLY its posting template (two lines, the right ledger accounts and
-- sides, the transaction's amount):
--   income           Dr destination asset     Cr category income account
--   expense          Dr category expense acct Cr source (asset, or credit-card liability)
--   transfer         Dr destination asset     Cr source asset
--   card_payment     Dr destination card      Cr source asset
--   card_refund      Dr destination card      Cr category expense account
--   opening_balance  asset account:     Dr account               Cr opening-balance equity
--                    liability account: Dr opening-balance equity Cr account
-- A credit card can be the source of an expense, the destination of a card
-- payment and the destination of a card refund; income and transfers use
-- asset (bank or cash) accounts only, so a transfer to or from a card remains
-- refused. A card refund's credit lands on an *expense* account, so it
-- reduces expenses for the period instead of adding income.
-- A void must link the posted reversal of that entry; a replacement must
-- record the entry that replaced the voided original's entry.
-- A linked refund must reference an active expense paid by the card it
-- credits, and the active refunds of one purchase must never exceed its
-- amount; the purchase row is locked FOR UPDATE before they are summed (see
-- the header). A purchase with active refunds cannot be voided.
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
  purchase finora.transactions%ROWTYPE;
  refunded bigint;
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
    RAISE EXCEPTION 'finora.finance: a credit card can only pay an expense, be paid by a card payment or be credited by a card refund; income and transfers use bank and cash accounts only'
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

  -- A card refund credits a credit card. Nothing pays it, so it has no source
  -- account (the shape CHECK requires that too).
  IF t.kind = 'card_refund'
     AND (destination_kind IS DISTINCT FROM 'liability' OR destination_type IS DISTINCT FROM 'credit_card') THEN
    RAISE EXCEPTION 'finora.finance: a card refund credits a credit card'
      USING ERRCODE = 'check_violation';
  END IF;

  IF t.kind IN ('income', 'expense', 'card_refund') THEN
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
  ELSIF t.kind = 'card_refund' THEN
    -- Dr the card (reduces the amount owed, or builds a credit balance),
    -- Cr the category's EXPENSE account (reduces that category's expenses).
    debit_account := destination_ledger;
    credit_account := counterpart;
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

  IF t.kind = 'card_refund' AND t.refunds_transaction_id IS NOT NULL THEN
    -- FOR UPDATE first: it serialises concurrent refunds of this purchase, so
    -- the sum below cannot miss one that is about to commit (see the header).
    SELECT * INTO purchase FROM finora.transactions
     WHERE id = t.refunds_transaction_id AND owner_id = t.owner_id FOR UPDATE;
    IF NOT FOUND OR purchase.kind <> 'expense'
       OR purchase.source_account_id IS DISTINCT FROM t.destination_account_id
       OR purchase.currency_code <> t.currency_code
       -- An active refund needs an active purchase. A refund that has itself
       -- been voided may point at a purchase voided afterwards, so editing
       -- its note later is not refused.
       OR (purchase.voided_at IS NOT NULL AND t.voided_at IS NULL) THEN
      RAISE EXCEPTION 'finora.finance: a card refund can only refund an active purchase paid by the same card, in its currency'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(r.amount_minor), 0) INTO refunded FROM finora.transactions AS r
     WHERE r.refunds_transaction_id = t.refunds_transaction_id AND r.owner_id = t.owner_id
       AND r.voided_at IS NULL;
    IF refunded > purchase.amount_minor THEN
      RAISE EXCEPTION 'finora.finance: the refunds of a purchase cannot exceed what was paid for it'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Voiding a purchase would leave its refunds refunding nothing, so the
  -- refunds come first. (Voiding a refund is never blocked; it gives the
  -- purchase its refundable amount back.)
  IF t.kind = 'expense' AND t.voided_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM finora.transactions AS r
     WHERE r.refunds_transaction_id = t.id AND r.owner_id = t.owner_id AND r.voided_at IS NULL
  ) THEN
    RAISE EXCEPTION 'finora.finance: void a purchase''s refunds before voiding the purchase'
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
-- shows that PUBLIC cannot call these.
REVOKE ALL ON FUNCTION "finora"."transactions_insert_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "finora"."transactions_update_guard"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "finora"."assert_transaction_valid"(uuid) FROM PUBLIC;

-- No GRANT is needed for the new column: finora_app's SELECT and INSERT on
-- finora.transactions are table-level and cover it, while its UPDATE grant is
-- column-listed (payee, note, reversal_entry_id) and deliberately does not,
-- so the runtime role cannot move or clear a refund's link.

-- 6. Put lock_timeout back, so the 5s bound set in step 0 does not carry over
--    to any later migration applied on this same connection. (If a statement
--    above failed, this one does not run and the migration's connection is
--    closed, so nothing carries over either way.)
SET lock_timeout = DEFAULT;

-- The lock taken in step 0 is released at COMMIT, with everything above.
