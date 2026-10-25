// Read-only analysis of stored account names against the application's
// canonical form (ADR 0007). Uses the application's own function, so the
// result never depends on PostgreSQL's case mapping. Reports ids only: names
// and keys are financial data and are never returned.
import { canonicalAccountName } from "../../src/domain/finance/account-name.ts";

/** Same limit as the financial_accounts_name_format CHECK (code points). */
export const MAX_NAME_CODE_POINTS = 60;

/**
 * @param {readonly { id: string; ownerId: string; name: string; assigned?: boolean; nameKey?: string | null }[]} rows
 *   `assigned`: PostgreSQL's unicode_assigned(name); read in "preflight" only.
 *   `nameKey`: the stored name_key; read in "verify" only.
 * @param {{ mode: "preflight" | "verify" }} options
 *   "preflight": what would make migration 20261025000500 refuse to run. Its
 *   SQL normalises with PostgreSQL's Unicode tables, so a character the server
 *   does not know is a problem.
 *   "verify": after the migration. Names and keys are written by the
 *   application (pinned Node, its own Unicode tables), so the server's tables
 *   do not matter: every stored name and key must be exactly the
 *   application's, and keys unique per owner.
 */
export function analyseAccountNames(rows, { mode }) {
  if (mode !== "preflight" && mode !== "verify") throw new Error(`unknown analysis mode ${String(mode)}`);
  const unsupported = [];
  const untrimmed = [];
  const tooLong = [];
  const notNfc = [];
  const nameNotCanonical = [];
  const keyMismatch = [];
  const byKey = new Map();
  for (const row of rows) {
    const { display, key } = canonicalAccountName(row.name);
    if (mode === "preflight" && row.assigned !== true) unsupported.push(row.id);
    if (row.name !== row.name.trim()) untrimmed.push(row.id);
    if ([...row.name.normalize("NFC")].length > MAX_NAME_CODE_POINTS) tooLong.push(row.id);
    if (row.name !== row.name.normalize("NFC")) notNfc.push(row.id);
    if (mode === "verify" && row.name !== display) nameNotCanonical.push(row.id);
    if (mode === "verify" && row.nameKey !== key) keyMismatch.push(row.id);
    const group = `${row.ownerId}\u0000${key}`;
    byKey.set(group, [...(byKey.get(group) ?? []), row]);
  }
  const conflicts = [...byKey.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({ ownerId: group[0].ownerId, accountIds: group.map((row) => row.id).sort() }))
    .sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.accountIds[0].localeCompare(b.accountIds[0]));
  return { mode, total: rows.length, unsupported, untrimmed, tooLong, notNfc, nameNotCanonical, keyMismatch, conflicts };
}

/**
 * "preflight": problems that make migration 20261025000500 refuse to run
 * (a name that is merely not NFC is not one: the migration rewrites it).
 * "verify": any stored name or key that is not the application's, or drift.
 */
export function blockingProblems(analysis) {
  return [
    ...(analysis.unsupported.length ? [`${analysis.unsupported.length} name(s) with characters unassigned in the server's Unicode`] : []),
    ...(analysis.untrimmed.length ? [`${analysis.untrimmed.length} name(s) with leading or trailing whitespace`] : []),
    ...(analysis.tooLong.length ? [`${analysis.tooLong.length} name(s) over ${MAX_NAME_CODE_POINTS} characters after NFC`] : []),
    ...(analysis.conflicts.length ? [`${analysis.conflicts.length} group(s) of names sharing a comparison key`] : []),
    ...(analysis.nameNotCanonical.length ? [`${analysis.nameNotCanonical.length} stored name(s) not in canonical form (trimmed NFC)`] : []),
    ...(analysis.keyMismatch.length ? [`${analysis.keyMismatch.length} stored name_key value(s) not the application's key`] : []),
  ];
}

/** Human-readable report: counts and ids only. */
export function formatReport(analysis) {
  const lines = [`Accounts checked: ${analysis.total}`];
  const ids = (label, list) => {
    lines.push(`${label}: ${list.length}`);
    for (const id of list) lines.push(`  account ${id}`);
  };
  if (analysis.mode === "preflight") ids("Characters unassigned in the server's Unicode", analysis.unsupported);
  ids("Leading or trailing whitespace", analysis.untrimmed);
  ids(`Over ${MAX_NAME_CODE_POINTS} characters after NFC`, analysis.tooLong);
  lines.push(`Comparison-key conflicts: ${analysis.conflicts.length} group(s)`);
  for (const group of analysis.conflicts) lines.push(`  owner ${group.ownerId}: accounts ${group.accountIds.join(", ")}`);
  if (analysis.mode === "preflight") {
    lines.push(`Names the migration will rewrite to NFC (not a problem): ${analysis.notNfc.length}`);
  } else {
    ids("Stored name not canonical (trimmed NFC)", analysis.nameNotCanonical);
    ids("Stored name_key not the application's key", analysis.keyMismatch);
  }
  return lines.join("\n");
}
