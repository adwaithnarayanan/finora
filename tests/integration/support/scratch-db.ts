import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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
  /** Migration-role URL of this database (for further Prisma commands). */
  readonly url: URL;
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

/**
 * Runs a Prisma CLI command (e.g. ["migrate", "deploy"]) against `url`, with
 * the project's migrations or a `MigrationSet`; on failure, throws with its
 * (redacted) output.
 */
export function runPrisma(url: URL, args: readonly string[], set?: MigrationSet): void {
  try {
    execFileSync(
      path.join(process.cwd(), "node_modules", ".bin", "prisma"),
      [...args, ...(set ? ["--config", set.config] : [])],
      {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: { ...process.env, MIGRATION_DATABASE_URL: url.toString() },
      },
    );
  } catch (error) {
    const { stdout, stderr, status } = error as { stdout?: string; stderr?: string; status?: number | null };
    const output = redactCredentials(`${stdout ?? ""}\n${stderr ?? ""}`.trim(), url);
    throw new Error(`prisma ${args.join(" ")} failed (exit ${status ?? "unknown"}):\n${output || "(no output)"}`);
  }
}

/** Applies every migration with the Prisma CLI; on failure, throws with its (redacted) output. */
export function deployMigrations(url: URL, set?: MigrationSet): void {
  runPrisma(url, ["migrate", "deploy"], set);
}

export type MigrationSet = {
  /** Prisma config file pointing at the copied migrations. */
  readonly config: string;
  readonly remove: () => void;
};

/**
 * A temporary copy of prisma/migrations for testing a migration against an
 * earlier schema: only the migrations up to and including `through`, with
 * `append` SQL added to the end of named ones. The project's own migrations
 * directory is never modified.
 */
export function migrationSet({ through, append = {} }: { through?: string; append?: Record<string, string> } = {}): MigrationSet {
  const source = path.join(process.cwd(), "prisma", "migrations");
  const dir = mkdtempSync(path.join(os.tmpdir(), "finora-migrations-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  try {
    const target = path.join(dir, "migrations");
    cpSync(path.join(source, "migration_lock.toml"), path.join(target, "migration_lock.toml"));
    const names = readdirSync(source, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .filter((name) => through === undefined || name <= through);
    if (through !== undefined && !names.includes(through)) throw new Error(`no migration named ${through}`);
    for (const name of names) cpSync(path.join(source, name), path.join(target, name), { recursive: true });
    for (const [name, sql] of Object.entries(append)) {
      if (!names.includes(name)) throw new Error(`cannot append to missing migration ${name}`);
      appendFileSync(path.join(target, name, "migration.sql"), `\n${sql}\n`);
    }
    const config = path.join(dir, "prisma.config.mjs");
    const settings = {
      schema: path.join(process.cwd(), "prisma", "schema.prisma"),
      migrations: { path: target },
      datasource: { url: "" },
    };
    // The URL comes from the environment at run time, never from this file.
    writeFileSync(
      config,
      `const settings = ${JSON.stringify(settings)};\nsettings.datasource.url = process.env.MIGRATION_DATABASE_URL ?? "";\nexport default settings;\n`,
    );
    return { config, remove };
  } catch (error) {
    remove();
    throw error;
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
  { migrate = (url: URL) => deployMigrations(url) }: { migrate?: (url: URL) => void } = {},
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
  return { name, url, client, drop };
}
