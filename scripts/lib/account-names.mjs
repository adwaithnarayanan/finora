import { canonicalAccountName } from "../../src/domain/finance/account-name.ts";

export const MAX_NAME_CODE_POINTS = 60;

export function analyseAccountNames(rows, { mode }) {
  if (mode !== "preflight" && mode !== "verify")
    throw new Error(`unknown analysis mode ${String(mode)}`);
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
    if ([...row.name.normalize("NFC")].length > MAX_NAME_CODE_POINTS)
      tooLong.push(row.id);
    if (row.name !== row.name.normalize("NFC")) notNfc.push(row.id);
    if (mode === "verify" && row.name !== display)
      nameNotCanonical.push(row.id);
    if (mode === "verify" && row.nameKey !== key) keyMismatch.push(row.id);
    const group = `${row.ownerId}\u0000${key}`;
    byKey.set(group, [...(byKey.get(group) ?? []), row]);
  }
  const conflicts = [...byKey.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      ownerId: group[0].ownerId,
      accountIds: group.map((row) => row.id).sort(),
    }))
    .sort(
      (a, b) =>
        a.ownerId.localeCompare(b.ownerId) ||
        a.accountIds[0].localeCompare(b.accountIds[0]),
    );
  return {
    mode,
    total: rows.length,
    unsupported,
    untrimmed,
    tooLong,
    notNfc,
    nameNotCanonical,
    keyMismatch,
    conflicts,
  };
}

export function blockingProblems(analysis) {
  return [
    ...(analysis.unsupported.length
      ? [
          `${analysis.unsupported.length} name(s) with characters unassigned in the server's Unicode`,
        ]
      : []),
    ...(analysis.untrimmed.length
      ? [
          `${analysis.untrimmed.length} name(s) with leading or trailing whitespace`,
        ]
      : []),
    ...(analysis.tooLong.length
      ? [
          `${analysis.tooLong.length} name(s) over ${MAX_NAME_CODE_POINTS} characters after NFC`,
        ]
      : []),
    ...(analysis.conflicts.length
      ? [
          `${analysis.conflicts.length} group(s) of names sharing a comparison key`,
        ]
      : []),
    ...(analysis.nameNotCanonical.length
      ? [
          `${analysis.nameNotCanonical.length} stored name(s) not in canonical form (trimmed NFC)`,
        ]
      : []),
    ...(analysis.keyMismatch.length
      ? [
          `${analysis.keyMismatch.length} stored name_key value(s) not the application's key`,
        ]
      : []),
  ];
}

export function formatReport(analysis) {
  const lines = [`Accounts checked: ${analysis.total}`];
  const ids = (label, list) => {
    lines.push(`${label}: ${list.length}`);
    for (const id of list) lines.push(`  account ${id}`);
  };
  if (analysis.mode === "preflight")
    ids("Characters unassigned in the server's Unicode", analysis.unsupported);
  ids("Leading or trailing whitespace", analysis.untrimmed);
  ids(`Over ${MAX_NAME_CODE_POINTS} characters after NFC`, analysis.tooLong);
  lines.push(`Comparison-key conflicts: ${analysis.conflicts.length} group(s)`);
  for (const group of analysis.conflicts)
    lines.push(
      `  owner ${group.ownerId}: accounts ${group.accountIds.join(", ")}`,
    );
  if (analysis.mode === "preflight") {
    lines.push(
      `Names the migration will rewrite to NFC (not a problem): ${analysis.notNfc.length}`,
    );
  } else {
    ids("Stored name not canonical (trimmed NFC)", analysis.nameNotCanonical);
    ids("Stored name_key not the application's key", analysis.keyMismatch);
  }
  return lines.join("\n");
}
