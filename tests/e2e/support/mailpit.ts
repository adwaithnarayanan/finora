import { readLocalSupabase } from "../../../scripts/lib/local-supabase.mjs";

type Summary = { ID: string; Created: string };

/** Fetches the newest message to `address` from the local Mailpit inbox. */
export async function latestEmailHtml(address: string, after: Date): Promise<string> {
  const { mailpitUrl } = readLocalSupabase();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await fetch(
      `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
    );
    const { messages } = (await search.json()) as { messages: Summary[] };
    const fresh = messages.find((m) => new Date(m.Created) >= after);
    if (fresh) {
      const message = await fetch(`${mailpitUrl}/api/v1/message/${fresh.ID}`);
      const { HTML } = (await message.json()) as { HTML: string };
      return HTML;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("no email arrived");
}

export async function countEmails(address: string): Promise<number> {
  const { mailpitUrl } = readLocalSupabase();
  const search = await fetch(
    `${mailpitUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  const { messages } = (await search.json()) as { messages: Summary[] };
  return messages.length;
}

/** Extracts the /auth/confirm link and re-targets it at the test server. */
export function confirmLink(html: string, baseURL: string): string {
  const match = /href="([^"]*\/auth\/confirm\?[^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error("no confirm link in email");
  const link = new URL(match[1].replaceAll("&amp;", "&"));
  return new URL(`${link.pathname}${link.search}`, baseURL).toString();
}
