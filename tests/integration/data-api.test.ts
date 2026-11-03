import { describe, expect, it } from "vitest";
import { inject } from "vitest";

describe("Supabase Data API exposure", () => {
  const { apiUrl, publishableKey, secretKey } = inject("local");

  async function get(path: string, key: string, profile?: string) {
    const headers: Record<string, string> = { apikey: key };
    if (!key.startsWith("sb_")) headers.authorization = `Bearer ${key}`;
    if (profile) headers["accept-profile"] = profile;
    const response = await fetch(`${apiUrl}/rest/v1/${path}`, { headers });
    return { status: response.status, body: await response.text() };
  }

  it.each([
    ["publishable key", () => publishableKey],
    ["secret key", () => secretKey],
  ])("rejects the finora schema profile with the %s", async (_label, key) => {
    for (const table of ["owners", "journal_entries", "journal_lines"]) {
      const result = await get(`${table}?select=*`, key(), "finora");
      expect(result.status, table).toBeGreaterThanOrEqual(400);
      expect(result.body, table).toMatch(/schema/i);
      expect(result.body, table).not.toMatch(
        /owner_id|disabled_at|amount_minor/,
      );
    }
  });

  it("does not expose finora tables through the default (public) schema", async () => {
    for (const table of [
      "owners",
      "owner_identities",
      "_prisma_migrations",
      "currencies",
      "ledger_accounts",
      "journal_entries",
      "journal_lines",
      "financial_accounts",
      "categories",
      "category_ledger_accounts",
      "system_ledger_accounts",
      "transactions",
    ]) {
      const result = await get(`${table}?select=*`, secretKey);
      expect(result.status, table).toBeGreaterThanOrEqual(400);
    }
  });
});
