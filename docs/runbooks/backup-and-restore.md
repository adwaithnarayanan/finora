# Runbook: manual backup and restore

Scheduled backups are deliberately out of scope for now. Until they exist,
take a manual backup before every migration on a hosted environment and at
least weekly once real data is stored.

Tools: `pg_dump` / `pg_restore` matching the server's major version
(Postgres 17). They are not installed on the host by default; run them from a
container instead, e.g. `docker run --rm -it -v "$PWD:/backup" postgres:17 …`.

## What a backup contains

`--schema finora` captures Finora's tables, data, constraints, triggers,
functions, RLS policies, grants to `finora_app`, and the Prisma migration
history. It does **not** contain:

- roles (`finora_app` is cluster-wide; recreate it before restoring),
- Supabase Auth users (`auth` schema): recreate or re-invite the owner and
  re-link with `npm run owner:provision -- --existing`.

Do **not** add `--no-privileges` or `--no-acl`: that drops the grants the app
role needs, and the restored app would fail closed.

## Backup (hosted)

Use the direct (or session-pooler) connection as `postgres`. Type the password
when prompted; never store it in the repository or shell history.

```bash
pg_dump --host <db-host> --port 5432 --username postgres --dbname postgres \
  --schema finora --format custom \
  --file "finora-$(date +%Y%m%d-%H%M%S).dump"
```

Encrypt the dump (e.g. with `age` or `gpg`) and store it outside the
repository. Supabase's own plan-dependent backups are an extra layer, not a
replacement; check your plan's retention in the dashboard.

## Restore test (local only) — verified 2026-10-25

This exact procedure was run against the local stack: one owner + identity
were dumped and restored into a scratch database, and row counts, migration
history, RLS flags, both policies and the `finora_app` grant all matched, with
`anon` still denied. It was repeated after the ledger migration with a posted
journal entry: the entry, its lines, the currencies and the `finora_app`
ledger grants restored intact, and the restored copy still refused an
`UPDATE` of a posted line. (`pg_restore` creates triggers after loading data,
so the immutability triggers do not block a restore.)

```bash
docker cp finora-YYYYMMDD-HHMMSS.dump supabase_db_finora:/tmp/finora.dump
docker exec supabase_db_finora psql -U postgres -c "CREATE DATABASE finora_restore_test"
docker exec supabase_db_finora pg_restore -U postgres -d finora_restore_test --exit-on-error /tmp/finora.dump

# Verify
docker exec supabase_db_finora psql -U postgres -d finora_restore_test -Atc \
  "select count(*) from finora.owners; select count(*) from finora._prisma_migrations;
   select relname, relrowsecurity from pg_class where relnamespace='finora'::regnamespace and relkind='r';
   select has_table_privilege('finora_app','finora.owners','SELECT'), has_schema_privilege('anon','finora','USAGE');"

# Clean up
docker exec supabase_db_finora psql -U postgres -c "DROP DATABASE finora_restore_test WITH (FORCE)"
docker exec supabase_db_finora rm -f /tmp/finora.dump
```

Never restore into a hosted database to "test" a backup.

## Restore (hosted, disaster recovery) — not yet exercised

1. Take a fresh backup of the current state first, even if it is broken.
2. Prefer restoring into a **new** Supabase project; switch the app over only
   after verification.
3. Create the runtime role (it is not in the dump):
   `CREATE ROLE finora_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`
   then apply its `ALTER ROLE finora_app SET …` lines from
   `prisma/migrations/20261025000100_runtime_role_and_rls/migration.sql`.
4. `pg_restore --dbname postgres --exit-on-error <dump>` into an empty
   database (do not also run `prisma migrate deploy` first; the dump includes
   the schema and migration history).
5. Set the `finora_app` password and `DATABASE_URL` (see `hosted-setup.md`),
   re-create or re-link the owner, then run the catalog checks there.
