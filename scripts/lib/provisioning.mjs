// Owner provisioning. Operator steps, never triggered by a login. The steps
// depend on the active sign-in method (ADR 0003); email/password is current,
// Google is deferred.
//
// Email/password (current):
//   1. prepare       Create a passwordless, email-confirmed Supabase user for the
//                    owner's email. It grants nothing: no mapping, no approval.
//   2. set-password  Set the password (typed interactively or piped on stdin,
//                    never an argument or env var; never printed). Also rotates.
//   3. complete      Record the approved email (app_metadata) and map the user
//                    to the owner.
//
// Google (deferred): prepare -> the owner signs in with Google (Supabase links
// the identity by verified email) -> complete approves that one Google account.
//
//   relink   Move the existing owner to another prepared user. The owner id
//            (and every financial record) is kept.
//   cancel   Delete a prepared user that was never mapped.
//
// Must run with the privileged (migration) connection and the Supabase secret
// key; neither the web app nor its runtime role can do any of this.
import { SUPABASE_PROVIDER, linkOwner } from "./owners.mjs";

/** Same values as src/server/auth/supabase/{sign-in-method,identity}.ts (a test checks). */
export const ACTIVE_SIGN_IN_METHOD = "password";
export const APPROVED_PASSWORD_EMAIL_KEY = "finora_password_email";
export const APPROVED_GOOGLE_ID_KEY = "finora_google_id";
/**
 * Set by set-password (admin-only app_metadata). Supabase stores a random hash
 * for passwordless users, so "has a password" cannot be read from auth.users.
 */
export const PASSWORD_SET_AT_KEY = "finora_password_set_at";

/** Same rules as Supabase Auth's configured policy ([auth] in supabase/config.toml). */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_BYTES = 72; // bcrypt ignores anything beyond

/** Returns why `password` is unacceptable, or null. Never includes the password. */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `use at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return `use at most ${MAX_PASSWORD_BYTES} bytes`;
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
    return "include upper- and lower-case letters and a digit";
  }
  if (password !== password.trim()) return "do not start or end with whitespace";
  return null;
}

const NON_INTERACTIVE = new Set(["email", "phone"]);

export class ProvisioningError extends Error {}

const fail = (message) => {
  throw new ProvisioningError(message);
};

export function normaliseEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("A valid --email is required.");
  return email;
}

async function findUserByEmail(admin, email) {
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.listUsers({ page, perPage: 200 });
    if (error) fail(`Could not list users (${error.code ?? error.status}).`);
    const match = data.users.find((user) => user.email?.toLowerCase() === email);
    if (match) return match;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function requireUser(admin, email) {
  const found = await findUserByEmail(admin, email);
  if (!found) fail("No Supabase user with that email. Run `prepare` first.");
  // Re-read by id: the authoritative identities and app_metadata.
  const { data, error } = await admin.getUserById(found.id);
  if (error || !data.user) fail(`Could not load the user (${error?.code ?? error?.status}).`);
  return data.user;
}

/**
 * The user's single verified Google identity, or a reason it is not usable.
 * Any other sign-in-capable identity disqualifies the user (fail closed).
 */
export function soleGoogleIdentity(user) {
  const interactive = (user.identities ?? []).filter((i) => !NON_INTERACTIVE.has(i.provider));
  if (interactive.length === 0) return { reason: "no Google identity is linked yet; the owner must sign in with Google first" };
  if (interactive.length > 1) return { reason: "more than one sign-in identity is linked; remove the extra identities first" };
  const [identity] = interactive;
  if (identity.provider !== "google") return { reason: `the linked identity is ${identity.provider}, not google` };
  if (identity.identity_data?.email_verified !== true) return { reason: "Google has not verified this email address" };
  const googleEmail = String(identity.identity_data?.email ?? "").toLowerCase();
  if (googleEmail !== String(user.email ?? "").toLowerCase()) {
    return { reason: "the Google identity's email does not match the user's email" };
  }
  return { identity };
}

async function mappedOwner(db, userId) {
  const { rows } = await db.query(
    "SELECT owner_id FROM finora.owner_identities WHERE provider = $1 AND subject = $2",
    [SUPABASE_PROVIDER, userId],
  );
  return rows[0]?.owner_id ?? null;
}

async function ownerCount(db) {
  const { rows } = await db.query("SELECT count(*)::int AS n FROM finora.owners");
  return rows[0].n;
}

/**
 * What `complete`/`relink` would approve for this user under `method`, as an
 * app_metadata key and value, or a reason it is not ready yet.
 */
async function approvalFor(db, user, method) {
  if (method === "google") {
    const { identity, reason } = soleGoogleIdentity(user);
    return identity ? { key: APPROVED_GOOGLE_ID_KEY, value: identity.id, label: `Google account id ${identity.id}` } : { reason };
  }
  if (method !== "password") fail(`Unknown sign-in method ${JSON.stringify(method)}.`);
  if (!user.email_confirmed_at) return { reason: "the user's email is not confirmed" };
  if (!(user.identities ?? []).some((i) => i.provider === "email")) return { reason: "the user has no email identity" };
  if (typeof user.app_metadata?.[PASSWORD_SET_AT_KEY] !== "string") {
    return { reason: "no password is set yet; run set-password first" };
  }
  const email = String(user.email).toLowerCase();
  return { key: APPROVED_PASSWORD_EMAIL_KEY, value: email, label: `email/password sign-in for ${email}` };
}

async function setApproval(admin, userId, key, value) {
  const { error } = await admin.updateUserById(userId, { app_metadata: { [key]: value } });
  if (error) fail(`Could not update the user's approval (${error.code ?? error.status}).`);
}

/** Step 1. Refuses if an owner already exists, unless relinking or adding one deliberately. */
export async function prepare({ admin, db, email, purpose = "new-owner" }) {
  if (purpose === "new-owner" && (await ownerCount(db)) > 0) {
    fail("An owner already exists. Use `prepare --relink` to move it to a new account, or --allow-additional.");
  }
  const existing = await findUserByEmail(admin, email);
  if (existing) {
    if (await mappedOwner(db, existing.id)) fail("That user is already mapped to an owner.");
    return { userId: existing.id, created: false };
  }
  // No password yet (set-password does that), so nobody can sign in as this
  // user. The operator vouches for the address, so it is created confirmed;
  // Finora sends no confirmation links (ADR 0003).
  const { data, error } = await admin.createUser({ email, email_confirm: true });
  if (error || !data.user) fail(`Could not create the user (${error?.code ?? error?.status}).`);
  return { userId: data.user.id, created: true };
}

/**
 * Sets (or rotates) a user's password. The password is validated here and by
 * Supabase Auth, and is never logged or returned. Every existing session of
 * that user ends: Supabase Auth (v2.197.0, verified locally) already deletes
 * them on an admin password change, and this also deletes any that remain.
 * The app checks the session with the Auth server on every request, so old
 * cookies stop working at once.
 */
export async function setPassword({ admin, db, email, password }) {
  const problem = passwordProblem(password);
  if (problem) fail(`Password rejected: ${problem}.`);
  const user = await requireUser(admin, email);
  const { error } = await admin.updateUserById(user.id, {
    password,
    app_metadata: { [PASSWORD_SET_AT_KEY]: new Date().toISOString() },
  });
  // Supabase's message can describe the policy; it never contains the password,
  // but only the code is surfaced anyway.
  if (error) fail(`Supabase refused the password (${error.code ?? error.status}).`);
  await db.query("DELETE FROM auth.sessions WHERE user_id = $1", [user.id]);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM auth.sessions WHERE user_id = $1", [user.id]);
  return { userId: user.id, remainingSessions: rows[0].n };
}

/**
 * Final step. Approves the user for `method` and maps it to a new owner.
 * Approval alone grants nothing; the mapping (one DB transaction) is the step
 * that authorises. If mapping fails the approval is withdrawn, so no partial
 * state is left behind. Re-running for a mapped user (re-)approves it for
 * `method` and keeps the existing owner (this is how an owner moves between
 * sign-in methods without losing data).
 */
export async function complete({ admin, db, email, method = ACTIVE_SIGN_IN_METHOD, allowAdditional = false }) {
  const user = await requireUser(admin, email);
  const approval = await approvalFor(db, user, method);
  if (!approval.key) fail(`Cannot complete: ${approval.reason}.`);

  const existingOwner = await mappedOwner(db, user.id);
  const previous = user.app_metadata?.[approval.key] ?? null;
  await setApproval(admin, user.id, approval.key, approval.value);
  if (existingOwner) return { ownerId: existingOwner, created: false, approved: approval.label };

  try {
    const { ownerId, created } = await linkOwner(db, { subject: user.id, allowAdditional });
    return { ownerId, created, approved: approval.label };
  } catch (error) {
    await setApproval(admin, user.id, approval.key, previous);
    throw error;
  }
}

/**
 * Moves the single existing owner (and so all of its data) to another user
 * that is ready for `method`. The owner id never changes. The old user loses
 * access at once: it is no longer mapped, and its approvals are removed.
 */
export async function relink({ admin, db, email, method = ACTIVE_SIGN_IN_METHOD }) {
  const user = await requireUser(admin, email);
  const approval = await approvalFor(db, user, method);
  if (!approval.key) fail(`Cannot relink: ${approval.reason}.`);
  if (await mappedOwner(db, user.id)) fail("That user is already mapped to an owner.");

  const { rows } = await db.query(
    "SELECT owner_id, subject FROM finora.owner_identities WHERE provider = $1",
    [SUPABASE_PROVIDER],
  );
  if (rows.length !== 1) fail(`Relink needs exactly one owner identity, found ${rows.length}.`);
  const [{ owner_id: ownerId, subject: previousUserId }] = rows;

  await setApproval(admin, user.id, approval.key, approval.value);
  try {
    await db.query("BEGIN");
    const moved = await db.query(
      `UPDATE finora.owner_identities SET subject = $1
        WHERE owner_id = $2 AND provider = $3 AND subject = $4`,
      [user.id, ownerId, SUPABASE_PROVIDER, previousUserId],
    );
    if (moved.rowCount !== 1) fail("The owner mapping changed concurrently; nothing was moved.");
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    await setApproval(admin, user.id, approval.key, null);
    throw error;
  }

  // Hygiene: the old user is already unmapped (no access); drop its approvals too.
  const cleared = await admin.updateUserById(previousUserId, {
    app_metadata: { [APPROVED_PASSWORD_EMAIL_KEY]: null, [APPROVED_GOOGLE_ID_KEY]: null },
  });
  return { ownerId, previousUserId, previousApprovalCleared: !cleared.error, approved: approval.label };
}

/** Deletes a prepared user that was never mapped to an owner. */
export async function cancel({ admin, db, email }) {
  const user = await requireUser(admin, email);
  if (await mappedOwner(db, user.id)) fail("That user is mapped to an owner; refusing to delete it.");
  const { error } = await admin.deleteUser(user.id);
  if (error) fail(`Could not delete the user (${error.code ?? error.status}).`);
  return { userId: user.id };
}
