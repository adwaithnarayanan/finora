# ADR 0003: Authentication and owner identity

- Status: Accepted
- Date: 2026-10-25

## Context

Finora is private and single-owner, but its data model must support more
owners later and must not be tied to one auth provider. Supabase Auth is the
chosen provider; `@supabase/auth-helpers-nextjs` is deprecated.

## Decision

**Identity vs owner.** Supabase identifies a user by `auth.users.id` (JWT
`sub`). Finora never uses that as its own key. `finora.owners.id` is an
application UUID; `finora.owner_identities` maps `(provider, subject)` to it,
unique per `(provider, subject)` and per `(owner, provider)`. All future
owner-scoped tables reference `owners.id`.

**Adapter boundary.** `src/server/auth/types.ts` defines provider-neutral
ports (`IdentityProvider`, `OwnerDirectory`) and `authorizeOwner()` in
`authorize.ts` is pure and unit-tested with fakes. Supabase code lives only
in `src/server/auth/supabase/` and `src/proxy.ts` (ESLint-enforced). Replacing
the provider means a new adapter plus new identity rows, not a domain change.

**Verification.** Identity comes from `supabase.auth.getClaims()`, which
verifies the access token's signature and expiry (never `getSession()`).
Only `role = authenticated`, non-anonymous users qualify.

**Authorisation (fail closed).** `requireOwner()` (`src/server/auth/session.ts`)
is the Data Access Layer: no verified identity → `/login`; identity without an
active owner mapping (unmapped or `disabled_at` set) → `/unauthorized`. Every
protected page, server action and data access calls it; `proxy.ts` only
refreshes cookies and does an optimistic redirect. The owner object it returns
(`AuthorizedOwner`) is branded and is the only accepted input to
`withOwnerScope()`, so an owner id from the browser cannot reach the database.

**Registration.** Public sign-up is disabled (`[auth] enable_signup = false`).
The owner is provisioned by an operator with `npm run owner:provision`, which
sends a Supabase invite (the owner verifies their email and sets a password)
and creates the owner + identity rows with the privileged connection. The web
app's database role cannot create owners at all. A second owner requires
`--allow-additional`.

**Flows.**
- Sign-in: email + password; one generic error for every credential failure.
  A verified non-owner is signed out and sent to `/unauthorized`.
- Sign-out: POST-only server action (`scope: local`).
- Recovery: `resetPasswordForEmail` always shows the same message. Email links
  are token-hash links to `/auth/confirm`, which verifies only on an explicit
  POST, so mail scanners cannot consume tokens. After a password change all
  other sessions are revoked (`signOut({ scope: "others" })`).
- Redirects: every `next` value passes `safeNextPath()` (same-origin paths
  only; rejects `//`, backslashes, control characters, absolute URLs).
- Passwords: ≥12 characters with upper/lower/digit (`[auth]` config plus Zod),
  ≤72 bytes (bcrypt limit). `secure_password_change` is on.

**Secrets.** The app holds only the publishable key; `parseAuthEnv` rejects a
secret or service-role key. The secret key is used only by the provisioning
script and test fixtures.

## Deferred

- Mandatory TOTP MFA: dedicated security milestone (the AAL claim is available
  from `getClaims()` when it is needed).
- Rate limiting beyond Supabase Auth's built-in limits, CAPTCHA, CSP headers.

## Consequences

- Owner access can be revoked instantly with `disabled_at`, independent of
  outstanding JWTs (checked on every request).
- Each request costs one identity lookup transaction; acceptable for one owner.
- Hosted Supabase must be configured to match `supabase/config.toml`
  (see `docs/runbooks/hosted-setup.md`); the integration tests verify the
  local configuration only.
