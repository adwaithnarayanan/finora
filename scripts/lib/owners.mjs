export const SUPABASE_PROVIDER = "supabase";

export async function linkOwner(
  client,
  { provider = SUPABASE_PROVIDER, subject, allowAdditional = false },
) {
  await client.query("BEGIN");
  try {
    const existing = await client.query(
      "SELECT owner_id FROM finora.owner_identities WHERE provider = $1 AND subject = $2",
      [provider, subject],
    );
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return { ownerId: existing.rows[0].owner_id, created: false };
    }
    if (!allowAdditional) {
      await client.query(
        "LOCK TABLE finora.owners IN SHARE ROW EXCLUSIVE MODE",
      );
      const count = await client.query(
        "SELECT count(*)::int AS n FROM finora.owners",
      );
      if (count.rows[0].n > 0) {
        throw new Error(
          "An owner already exists. Pass --allow-additional to add another deliberately.",
        );
      }
    }
    const owner = await client.query(
      "INSERT INTO finora.owners DEFAULT VALUES RETURNING id",
    );
    const ownerId = owner.rows[0].id;
    await client.query(
      "INSERT INTO finora.owner_identities (owner_id, provider, subject) VALUES ($1, $2, $3)",
      [ownerId, provider, subject],
    );
    await client.query("COMMIT");
    return { ownerId, created: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

export async function unlinkOwners(client, ownerIds) {
  if (ownerIds.length === 0) return;
  await client.query(
    "DELETE FROM finora.owner_identities WHERE owner_id = ANY($1::uuid[])",
    [ownerIds],
  );
  await client.query("DELETE FROM finora.owners WHERE id = ANY($1::uuid[])", [
    ownerIds,
  ]);
}
