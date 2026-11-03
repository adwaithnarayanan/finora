import { execFileSync } from "node:child_process";
import path from "node:path";

export const LOCAL_APP_DB_PASSWORD = "finora-local-dev-only";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function assertLoopback(url, label) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `${label} must point at a local (loopback) host; refusing to continue`,
    );
  }
}

export function readLocalSupabase(projectRoot = process.cwd()) {
  const bin = path.join(projectRoot, "node_modules", ".bin", "supabase");
  let raw;
  try {
    raw = execFileSync(bin, ["status", "-o", "json"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(
      "Local Supabase is not running. Start it with `npx supabase start`.",
    );
  }
  const status = JSON.parse(raw);
  for (const key of ["API_URL", "DB_URL", "PUBLISHABLE_KEY", "SECRET_KEY"]) {
    if (!status[key]) throw new Error(`supabase status did not report ${key}`);
  }
  assertLoopback(status.API_URL, "Supabase API_URL");
  assertLoopback(status.DB_URL, "Supabase DB_URL");

  const migrationUrl = new URL(status.DB_URL);
  migrationUrl.searchParams.set("schema", "finora");

  const appUrl = new URL(status.DB_URL);
  appUrl.username = "finora_app";
  appUrl.password = LOCAL_APP_DB_PASSWORD;

  return {
    apiUrl: status.API_URL,
    publishableKey: status.PUBLISHABLE_KEY,
    secretKey: status.SECRET_KEY,
    mailpitUrl: status.MAILPIT_URL ?? status.INBUCKET_URL,
    migrationDatabaseUrl: migrationUrl.toString(),
    appDatabaseUrl: appUrl.toString(),
  };
}

export function localAppEnv(local, siteUrl) {
  return {
    NEXT_PUBLIC_SITE_URL: siteUrl,
    SUPABASE_URL: local.apiUrl,
    SUPABASE_PUBLISHABLE_KEY: local.publishableKey,
    DATABASE_URL: local.appDatabaseUrl,
  };
}
