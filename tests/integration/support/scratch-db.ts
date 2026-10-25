import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

import pg from "pg";
import { inject } from "vitest";

import { assertLoopback } from "../../../scripts/lib/local-supabase.mjs";

import { adminClient } from "./db";

const PREFIX = "finora_itest_";
const LABEL = /^[a-z0-9_]{1,30}$/;
const SCRATCH_NAME = /^finora_itest_[a-z0-9_]+_[0-9a-f]{12}$/;

export type ScratchDatabase = {
  readonly name: string;
  readonly client: pg.Client;
  /** Drops this run's database (only it). Idempotent; reports every failure. */
  readonly drop: () => Promise<void>;
};

/** `finora_itest_<label>_<random>`: unique per call, so concurrent runs never share (or drop) a database. */
export function scratchDatabaseName(label: string, suffix = randomBytes(6).toString("hex")): string {
  if (!LABEL.test(label)) throw new Error("scratch database labels are 1-30 characters of a-z, 0-9 and _");
  return assertScratchName(`${PREFIX}${label}_${suffix}`);
}

/** The only names this module ever creates or drops (also safe to interpolate as an identifier). */
export function assertScratchName(name: string): string {
  if (!SCRATCH_NAME.test(name) || name.length > 63) throw new Error(`refusing to use ${JSON.stringify(name)} as a scratch database`);
  return name;
}

/** Removes the connection URL and its password from tool output. */
export function redactCredentials(text: string, url: URL): string {
  const secrets = [url.toString(), url.password, decodeURIComponent(url.password)].filter((s) => s.length > 0);
  return secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
}

/** Applies every migration with the Prisma CLI; on failure, throws with its (redacted) output. */
export function deployMigrations(url: URL): void {
  try {
    execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      env: { ...process.env, MIGRATION_DATABASE_URL: url.toString() },
    });
  } catch (error) {
    const { stdout, stderr, status } = error as { stdout?: string; stderr?: string; status?: number | null };
    const output = redactCredentials(`${stdout ?? ""}\n${stderr ?? ""}`.trim(), url);
    throw new Error(`prisma migrate deploy failed (exit ${status ?? "unknown"}):\n${output || "(no output)"}`);
  }
}

async function dropDatabase(name: string): Promise<void> {
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${assertScratchName(name)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * A throwaway database on the LOCAL server with every migration applied, for
 * tests whose subject is a database-wide rule (e.g. the single-owner rule)
 * that must not depend on, or touch, data already in the local database.
 *
 * Each call creates a new uniquely named `finora_itest_<label>_<random>`
 * database and only ever drops that one. If setup fails after the database
 * was created, it is dropped before the error is rethrown.
 */
export async function createMigratedScratchDatabase(
  label: string,
  { migrate = deployMigrations }: { migrate?: (url: URL) => void } = {},
): Promise<ScratchDatabase> {
  const name = scratchDatabaseName(label);
  const url = new URL(inject("local").migrationDatabaseUrl);
  assertLoopback(url.toString(), "scratch database server");
  url.pathname = `/${name}`;

  const admin = await adminClient();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  let client: pg.Client | undefined;
  let dropped = false;
  const drop = async () => {
    if (dropped) return;
    const failures: unknown[] = [];
    try {
      await client?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      await dropDatabase(name);
      dropped = true;
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, `cleanup of scratch database ${name} failed`);
  };

  try {
    migrate(url);
    const plain = new URL(url);
    plain.search = "";
    const connected = new pg.Client({ connectionString: plain.toString() });
    await connected.connect(); // kept only once connected, so drop() never ends a half-open client
    client = connected;
  } catch (error) {
    try {
      await drop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `scratch database ${name}: setup failed, then cleanup failed`);
    }
    throw error;
  }
  return { name, client, drop };
}
