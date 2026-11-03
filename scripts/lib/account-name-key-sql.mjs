export const BEGIN_MARKER =
  "-- BEGIN GENERATED account_name_key (scripts/db/generate-account-name-key-sql.mjs)";
export const END_MARKER = "-- END GENERATED account_name_key";

const SIGMA = 0x3a3;
const MAX_CODE_POINT = 0x10ffff;

export function* textCodePoints() {
  for (let cp = 1; cp <= MAX_CODE_POINT; cp += 1) {
    if (cp < 0xd800 || cp > 0xdfff) yield cp;
  }
}

/**
 * The runtime's case data, observed through toLowerCase():
 *  - lower: context-free full lowercase mapping of each code point that
 *    changes (capital sigma is handled by context instead);
 *  - ignorable / cased: how Final_Sigma treats a neighbour. ICU skips
 *    case-ignorable characters first, so "cased" here means cased and not
 *    case-ignorable. Probes: "A" + c + U+03A3 lowers to a final sigma
 *    (U+03C2) when c is skipped or cased; "1" + c + U+03A3 only when c is
 *    cased.
 *  - space: what trim() removes.
 */
export function caseTables() {
  const lower = new Map();
  const ignorable = [];
  const cased = [];
  const space = [];
  for (const cp of textCodePoints()) {
    const c = String.fromCodePoint(cp);
    const lowered = c.toLowerCase();
    if (lowered !== c && cp !== SIGMA) lower.set(cp, lowered);
    const afterCased = `A${c}\u03a3`.toLowerCase().endsWith("\u03c2");
    const afterUncased = `1${c}\u03a3`.toLowerCase().endsWith("\u03c2");
    if (afterUncased) cased.push(cp);
    else if (afterCased) ignorable.push(cp);
    if (c.trim() === "") space.push(cp);
  }
  return { lower, ignorable, cased, space };
}

export function toRanges(codePoints) {
  const ranges = [];
  for (const cp of codePoints) {
    const last = ranges.at(-1);
    if (last && last[1] === cp) last[1] = cp + 1;
    else ranges.push([cp, cp + 1]);
  }
  return ranges;
}

const hex = (cp) => cp.toString(16).toUpperCase().padStart(4, "0");
const asciiJson = (text) =>
  JSON.stringify(text).replace(
    /[\u007f-\uffff]/g,
    (u) => `\\u${hex(u.charCodeAt(0))}`,
  );

function wrap(items, indent, width = 100) {
  const lines = [];
  let line = "";
  for (const item of items) {
    if (line && line.length + item.length + 1 > width - indent.length) {
      lines.push(line);
      line = "";
    }
    line = line ? `${line} ${item}` : item;
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join("\n");
}

function multirangeLiteral(codePoints, indent) {
  const items = toRanges(codePoints).map(
    ([a, b], i, all) => `[${a},${b})${i < all.length - 1 ? "," : ""}`,
  );
  return `'{\n${wrap(items, indent)}\n${indent.slice(2)}}'::int4multirange`;
}

function lowerMapLiteral(lower, indent) {
  const entries = [...lower].map(
    ([cp, s], i) => `"${cp}":${asciiJson(s)}${i < lower.size - 1 ? "," : ""}`,
  );
  return `'{\n${wrap(entries, indent)}\n${indent.slice(2)}}'::jsonb`;
}

export function accountNameKeySql(tables = caseTables()) {
  const header = [
    BEGIN_MARKER,
    `-- Generated on Node ${process.version} (ICU ${process.versions.icu}, Unicode ${process.versions.unicode}).`,
    "-- Do not edit by hand; regenerate and compare (tests/unit/account-name-key-sql.test.ts).",
  ];
  return `${header.join("\n")}
-- Session-local (pg_temp): it disappears with the migration's connection, so
-- the database keeps no second implementation of the algorithm.
CREATE FUNCTION pg_temp.finora_account_name_is_trimmed(input text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT
AS $fn$
  SELECT NOT (
    ${multirangeLiteral(tables.space, "      ")} @> ascii(input)
    OR ${multirangeLiteral(tables.space, "      ")} @> ascii(right(input, 1))
  )
$fn$;

CREATE FUNCTION pg_temp.finora_account_name_key(input text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT
AS $fn$
  WITH chars AS MATERIALIZED (
    SELECT u.o, ascii(u.c) AS cp,
           ${multirangeLiteral(tables.ignorable, "             ")} @> ascii(u.c) AS ignorable,
           ${multirangeLiteral(tables.cased, "             ")} @> ascii(u.c) AS cased
      FROM unnest(string_to_array(normalize(input, NFC), NULL)) WITH ORDINALITY AS u(c, o)
  )
  SELECT normalize(coalesce(string_agg(
    CASE
      WHEN c.cp <> ${SIGMA} THEN coalesce(
        ${lowerMapLiteral(tables.lower, "          ")} ->> c.cp::text,
        chr(c.cp))
      -- Final_Sigma: the nearest non-ignorable neighbour before is cased and
      -- the nearest one after is not (or there is none).
      WHEN coalesce((SELECT p.cased FROM chars AS p WHERE p.o < c.o AND NOT p.ignorable ORDER BY p.o DESC LIMIT 1), false)
       AND NOT coalesce((SELECT f.cased FROM chars AS f WHERE f.o > c.o AND NOT f.ignorable ORDER BY f.o LIMIT 1), false)
      THEN chr(${0x3c2})
      ELSE chr(${0x3c3})
    END, '' ORDER BY c.o), ''), NFC)
    FROM chars AS c
$fn$;
${END_MARKER}`;
}

export function extractGeneratedBlock(sql) {
  const start = sql.indexOf(BEGIN_MARKER);
  const end = sql.indexOf(END_MARKER);
  if (start < 0 || end < start) return null;
  return sql.slice(start, end + END_MARKER.length);
}
