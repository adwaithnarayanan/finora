/**
 * The query an operator is told to run in the HINT of migration
 * 20261025000700_account_ledger_class's preflight, exactly as PostgreSQL
 * prints it: the adjacent string literals joined, '' unescaped, and the text
 * from SELECT up to its terminating semicolon.
 */
export function preflightHintQuery(migrationSql: string): string {
  const hint = /USING HINT = ((?:'(?:[^']|'')*'\s*)+);/.exec(migrationSql);
  if (!hint) throw new Error("no USING HINT in the migration");
  const text = [...hint[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]!.replaceAll("''", "'")).join("");
  const query = /SELECT [^;]*;/.exec(text);
  if (!query) throw new Error("no query in the hint");
  return query[0];
}
