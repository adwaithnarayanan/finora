# ADR 0007: Deterministic account-name normalisation and uniqueness

- Status: Accepted
- Date: 2026-10-25
- Supersedes: the name rules in ADR 0006 ("Case-insensitive names" and
  "Unicode letter case")

## Context

Until now, account names were unique per owner under PostgreSQL's
`lower(name)` (migration `20261025000400`). The ADR 0006 assessment found
three problems with that:

- what counted as "the same name" depended on the database's collation
  provider and version;
- names were not Unicode-normalised, so a precomposed "é" (U+00E9) and
  "e" + U+0301 were different names;
- the advisory-lock key used JavaScript `toLowerCase()` while the index used
  SQL `lower()`.

This ADR fixes one algorithm in application code, stores its result, and
makes the database compare that result byte for byte.

## Decision

### Policy (`src/domain/finance/account-name.ts`)

1. **Trim** with `String.prototype.trim()`: ECMAScript WhiteSpace and
   LineTerminator at either end. Inner spacing is kept.
2. **Display name** = NFC of the trimmed text. This is what is stored in
   `name` and shown. It is never NFKC: compatibility characters (ligatures,
   fullwidth forms, circled digits) are kept as typed.
3. **Comparison key** = `toLowerCase()` of the display name, then NFC again.
   ECMAScript defines `toLowerCase()` as Unicode Default Case Conversion with
   full mappings (SpecialCasing's unconditional entries and Final_Sigma) and
   no locale tailoring.
4. No case folding: "ß" and "ss" stay different.
5. Names are unique per owner by key. Different owners may use the same name.

`canonicalAccountName()` is the only function that produces an
`AccountName` (`{ display, key }`, a branded type). Create and rename both
parse input with `parseAccountName()`, which calls it and checks the
60-character limit on the NFC form. The store only accepts an `AccountName`,
so a name and its key cannot be supplied separately.

Resulting semantics (each is a test in
`src/domain/finance/account-name.test.ts` and, end to end, in
`tests/integration/finance-service.test.ts`):

| Inputs                                             | Same name? | Why                                                          |
| -------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| " Cash " / "Cash"                                  | yes        | trimmed                                                      |
| "Café" as U+00E9 / as "e" + U+0301                 | yes        | NFC                                                          |
| "HDFC Savings" / "hdfc SAVINGS"                    | yes        | lower-cased                                                  |
| "ÉCOLE" / "école"; "Ecole" / "école"               | yes; no    | accents are significant, case is not                         |
| "İstanbul" / "i̇stanbul" (i + U+0307)              | yes        | U+0130 lowers to i + combining dot above                     |
| "İstanbul" / "Istanbul"; "ıstanbul" / "istanbul"   | no; no     | no Turkish tailoring; dotless ı is its own letter            |
| "ΟΔΟΣ" / "οδος"                                    | yes        | Final_Sigma: Σ at the end of a word lowers to ς              |
| "οδοσ" / "οδος"                                    | no         | lower-casing does not equate σ and ς                         |
| "Straße" / "STRASSE"; "STRAẞE" / "straße"          | no; yes    | no folding; capital ẞ (U+1E9E) lowers to ß                   |
| "ﬁle" / "file"                                     | no         | no NFKC                                                      |

### Storage (migration `20261025000500_account_name_key`)

- `name`: the display name (trimmed, NFC). The existing CHECK (1 to 60
  characters, `btrim`) still applies.
- `name_key TEXT COLLATE "C" NOT NULL`, with CHECK `char_length >= 1`.
  `"C"` is deterministic and byte-wise, so nothing in the database
  lower-cases, normalises or otherwise reinterprets the key.
- Unique index `financial_accounts_owner_name_key_key` on
  `(owner_id, name_key)` (btree, column collation `"C"`). It is the authority
  for uniqueness, including under concurrency. `owner_id` comes first, as in
  every owner-scoped unique index (ADR 0004).
- Dropped: `financial_accounts_owner_name_ci_key` (`lower(name)`) and
  `financial_accounts_owner_name_key` (`(owner_id, name)`, now implied).
- `finora_app` gains `UPDATE (name_key)`. RLS and the explicit owner filters
  are unchanged.

### Write paths (`src/server/finance/service.ts`, `src/server/db/finance-store.ts`)

Create and rename each run in one owner-scoped transaction:

1. `parseAccountName(input)`.
2. Advisory lock `account-name:<key>`, qualified by owner.
3. `accountNameTaken(name)`, which matches `name_key = key` with an explicit
   `owner_id` filter as well as RLS.
4. Insert or update both `name` and `name_key`.

A unique violation on the index (a racing writer, or any path that skipped
the check) becomes the friendly `FinanceConflictError("account-name-taken")`.
The error carries no SQL text. The transaction rolls back, including a ledger
account created in the same request.

### Migration safety

Existing rows need keys from **this** algorithm, not from PostgreSQL's
`lower()`. Prisma migrations are SQL, so the migration embeds a SQL copy of
the algorithm, generated from the pinned Node and checked against it:

- `scripts/lib/account-name-key-sql.mjs` probes the runtime's own
  `toLowerCase()` and `trim()` for every code point. It records lowercase
  mappings, which neighbours Final_Sigma skips (case-ignorable) or counts
  (cased), and the trim set. It emits two `pg_temp` (session-local)
  functions; the migration file is pure ASCII.
- Unit test (`tests/unit/account-name-key-sql.test.ts`): the migration's block
  is byte-identical to the generator's output on the pinned runtime. A
  JavaScript model of the SQL agrees with the application for:
  - every code point;
  - every code point before and after a capital sigma;
  - 50,000 random strings.
- Integration test (`tests/integration/account-name-key.test.ts`): the real
  SQL on PostgreSQL agrees with the application for:
  - all 1,112,062 code points;
  - Final_Sigma contexts;
  - every canonical decomposition;
  - reordered combining marks.

  On PostgreSQL 17.11 (Unicode 15.1) none of the 1,112,062 single code points
  differed.

Order of operations, all in one transaction:

0. `SET LOCAL lock_timeout = '5s'`, then refuse unless PostgreSQL is 17 or
   later (`server_version_num`), before anything that needs 17. Steps 2-4
   need `ACCESS EXCLUSIVE` on `financial_accounts`; if another transaction
   holds any lock on it for 5 seconds the migration fails and rolls back
   instead of waiting indefinitely (and queueing every other query on the
   table behind it). `SET LOCAL` lasts only until the migration's
   transaction ends. An integration test holds a lock and checks this.
1. Refuse with a clear error, changing nothing, if any existing name:
   - contains a character unassigned in the server's Unicode
     (`unicode_assigned`). PostgreSQL's `normalize()` must agree with Node's
     NFC, which Unicode's normalisation stability guarantees only for
     characters both versions know;
   - starts or ends with whitespace the application would trim. Trimming
     here would silently rename;
   - exceeds 60 characters after NFC;
   - shares a key with another name of the same owner.
2. Drop the two old name indexes and add the column.
3. Backfill: `name = normalize(name, NFC)` and `name_key = key(name)`. The
   guard trigger stays enabled (it is never disabled or bypassed). Because
   every row gets a key, **every account's `updated_at` moves to the
   migration time**, including accounts whose name does not change. No other
   column changes: the integration test compares every column of every row
   before and after.
4. `NOT NULL`, the CHECK, the unique index and the grant. The `pg_temp`
   helpers are dropped.

**Atomicity.** `prisma migrate deploy` sends a migration file as one
simple-protocol query, and PostgreSQL runs that as a single implicit
transaction. The integration tests show this through the real CLI:

- a key conflict changes nothing;
- a failure injected after every DDL statement (`SELECT 1/0` appended to a
  temporary copy) leaves no column, no index change and no rewritten name.

Prisma then records the migration as failed and refuses further deploys
until it is resolved. The file therefore must not contain `BEGIN`/`COMMIT`
or statements that cannot run in a transaction.

**Diagnostics.** `npm run db:account-names` (read-only) uses the
application's own `canonicalAccountName`, imported from the TypeScript
file. It reports owner and account ids, never names or keys, and refuses
to run on PostgreSQL older than 17. Two modes:

- `conflicts` (preflight; before or after the migration) lists the rows that
  would make the migration refuse, including names with characters the
  server's Unicode does not know (the migration normalises with
  PostgreSQL's tables). Names that are merely not NFC are reported as "will
  rewrite", not as problems.
- `verify` (after the migration) checks that every stored name is trimmed
  NFC, every `name_key` is exactly the application's key, and keys are
  unique per owner. Characters unknown to PostgreSQL are not a problem here:
  the application, not PostgreSQL, computed those names and keys.

Recovery is in `docs/runbooks/hosted-setup.md`.

**Catalog check.** `scripts/db/sql/verify-account-name-key-index.sql`
(read-only) asserts:

- the index exists on `financial_accounts`, is unique, valid and ready;
- its keys are exactly `(owner_id, name_key)`, with no expression, predicate
  or INCLUDE;
- its key collation and the column's collation are `"C"`, and the column is
  NOT NULL;
- no other index on the table involves `name` or `name_key`;
- `pg_get_indexdef` matches exactly.

Integration tests run it and confirm that 15 materially different variants
fail. `npm run db:local:drift` covers the rest, but Prisma does not model
column collation, so the catalog check is the authority for it.

### Runtime pinning

Keys depend on the runtime's Unicode data (ICU). The project pins
**Node 24.22.1** (ICU 78.3, Unicode 17.0) exactly, in `.nvmrc` and
`package.json` `engines` (`engine-strict`). CI uses `.nvmrc`. A unit test
fails on any other Node version, and another asserts the ICU and Unicode
versions. Node patch releases can update ICU, so the pin is exact.

## Limitations and assumptions

- **Changing Node.** Do not assume another Node (or another ICU) gives
  identical keys. Before changing `.nvmrc`:
  1. Run the unit tests on the new version. The "generated SQL" test shows
     whether the case tables changed.
  2. Run `npm run db:account-names -- verify` against each database.
  3. If any stored key or name is no longer canonical, add a re-key migration
     (same pattern, with conflict refusal). Never edit applied migrations.
- **PostgreSQL's Unicode.** Only the backfill uses PostgreSQL's
  `normalize()`. New writes are normalised by Node. The migration refuses
  characters PostgreSQL does not know. Sequences combining such characters are
  the residual risk, and the post-deployment `verify` catches it. The
  migration needs PostgreSQL 17 or later (`unicode_assigned`). On older
  servers its first check fails with an explicit version error, changing
  nothing.
- **Database writers.** The database cannot recompute the key, so it trusts
  the application to store `key(name)`. Only the application writes accounts
  (RLS, grants). `verify` detects any drift.
- **Names of unassigned code points** (in Node's Unicode 17.0) are accepted.
  NFC leaves them unchanged today. A future Unicode version could assign them
  differently, which is what the "Changing Node" procedure covers.
- **Idempotent retries.** The v1 creation fingerprint keeps its pre-ADR
  meaning: it hashes the submitted name after `trim()` only, not the
  canonical display name. The migration rewrites stored names to NFC but not
  fingerprints, so an identical retry of a request made before it (even a
  non-NFC one) still replays. The consequence is that, for one key, the
  same name typed in another Unicode form counts as a changed request and is
  refused, as any other byte difference always was. Changing what is hashed
  requires a new version tag. Tested across the migration in
  `tests/integration/account-name-key.test.ts`.
- **Deployment window.** Old application code does not write `name_key`:
  after the migration its account inserts fail (`NOT NULL`) and its renames
  would leave a stale key. The migration and the new code are deployed in
  one maintenance window with no account writes in between
  (`docs/runbooks/hosted-setup.md`); `verify` afterwards confirms it.
- **No `IS NFC NORMALIZED` CHECK.** Considered and not added. It would make
  writes depend on PostgreSQL's Unicode tables, which this ADR avoids.
  Today it would be harmless: PostgreSQL 17.11 (Unicode 15.1) accepted all
  6,672,616 canonical names and keys tried (every code point alone and in
  combining-mark contexts), as normalisation stability predicts when the
  database's Unicode is older than Node's. But a later PostgreSQL could know
  more of Unicode than the pinned Node. A code point unassigned in Node's
  Unicode 17.0 (accepted by policy and left unchanged by Node's NFC) could
  then be a combining mark to PostgreSQL. It would reject the name, and
  because CHECKs are re-evaluated on every UPDATE, even archiving an existing
  account would fail after a server upgrade. It would also be incomplete:
  it checks NFC only, not trimming or `name_key = key(name)`. `verify`
  checks all three against Node.
- **Length.** The application limits names to 60 UTF-16 code units; the
  database CHECK counts code points. This is unchanged from ADR 0006.
- **Categories** keep their earlier rules (ADR 0006); they are out of scope
  here.
