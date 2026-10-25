-- Runtime role, privileges and Row-Level Security for the `finora` schema.
-- See docs/adr/0004-database-roles-and-rls.md for the threat model.
--
-- Roles:
--   * migration role (the role running this file, `postgres` on Supabase): owns
--     the schema and tables. Used only by migrations and operator scripts.
--   * finora_app: the only role the application connects as. Not an owner,
--     not superuser, NOBYPASSRLS, and holds only the grants below.
-- No passwords live here: LOGIN + PASSWORD are set per environment by an
-- operator (local: `npm run db:local:setup`; hosted: docs/runbooks).

-- 1. Runtime role ------------------------------------------------------------
DO $$
DECLARE
  r pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname = 'finora_app';
  IF NOT FOUND THEN
    CREATE ROLE finora_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSIF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication THEN
    RAISE EXCEPTION 'finora_app exists with unsafe attributes; refusing to continue';
  END IF;
END
$$;

-- Fail fast instead of holding connections or locks.
ALTER ROLE finora_app SET statement_timeout = '15s';
ALTER ROLE finora_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE finora_app SET search_path = '';

-- 2. Lock the schema down -------------------------------------------------------
-- Nothing in `finora` is reachable by PUBLIC or by Supabase's API roles.
REVOKE ALL ON SCHEMA finora FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA finora FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA finora FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA finora FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA finora REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA finora REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA finora REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'authenticator']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA finora FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA finora FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA finora FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA finora FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA finora TO finora_app;

-- 3. Request context ---------------------------------------------------------
-- The server sets these with set_config(..., is_local => true) inside a
-- transaction, so they vanish at COMMIT/ROLLBACK and cannot leak to the next
-- user of a pooled connection. Unset context resolves to NULL, which matches
-- no rows (fail closed). A malformed owner id raises an error.
CREATE FUNCTION finora.current_owner_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = ''
AS $$ SELECT nullif(current_setting('finora.owner_id', true), '')::uuid $$;

CREATE FUNCTION finora.current_auth_provider() RETURNS text
  LANGUAGE sql STABLE
  SET search_path = ''
AS $$ SELECT nullif(current_setting('finora.auth_provider', true), '') $$;

CREATE FUNCTION finora.current_auth_subject() RETURNS text
  LANGUAGE sql STABLE
  SET search_path = ''
AS $$ SELECT nullif(current_setting('finora.auth_subject', true), '') $$;

REVOKE ALL ON FUNCTION finora.current_owner_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION finora.current_auth_provider() FROM PUBLIC;
REVOKE ALL ON FUNCTION finora.current_auth_subject() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finora.current_owner_id() TO finora_app;
GRANT EXECUTE ON FUNCTION finora.current_auth_provider() TO finora_app;
GRANT EXECUTE ON FUNCTION finora.current_auth_subject() TO finora_app;

-- 4. Owner-isolation template for every future owner-scoped table -------------
-- Migrations call this for each table that has an owner_id column. It enables
-- RLS and installs one policy restricting all commands to the current owner.
-- Callable only by the migration role (EXECUTE revoked from PUBLIC).
CREATE FUNCTION finora.apply_owner_isolation(target regclass) RETURNS void
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY owner_isolation ON %s AS PERMISSIVE FOR ALL TO finora_app '
    'USING (owner_id = finora.current_owner_id()) '
    'WITH CHECK (owner_id = finora.current_owner_id())',
    target
  );
END
$$;
REVOKE ALL ON FUNCTION finora.apply_owner_isolation(regclass) FROM PUBLIC;

-- 5. Identity tables -----------------------------------------------------------
-- The runtime role may only READ identity data. Owners and identities are
-- created by the operator provisioning script, never by the web application.
GRANT SELECT ON finora.owners, finora.owner_identities TO finora_app;

ALTER TABLE finora.owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE finora.owner_identities ENABLE ROW LEVEL SECURITY;

-- Visible rows: the identity matching the verified auth context (used once per
-- request to resolve the owner), or the current owner's own identities.
CREATE POLICY identity_resolution ON finora.owner_identities
  AS PERMISSIVE FOR SELECT TO finora_app
  USING (
    owner_id = finora.current_owner_id()
    OR (provider = finora.current_auth_provider() AND subject = finora.current_auth_subject())
  );

CREATE POLICY owner_self ON finora.owners
  AS PERMISSIVE FOR SELECT TO finora_app
  USING (
    id = finora.current_owner_id()
    OR id IN (
      SELECT i.owner_id FROM finora.owner_identities AS i
      WHERE i.provider = finora.current_auth_provider()
        AND i.subject = finora.current_auth_subject()
    )
  );
