import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EnvValidationError,
  parseAuthEnv,
  parseDatabaseEnv,
  parseSiteEnv,
} from "./env";

const PUBLISHABLE = "sb_publishable_0123456789abcdefghij";
const jwtWithRole = (role: string) =>
  [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ role })).toString("base64url"),
    "signature",
  ].join(".");

function issuesOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as EnvValidationError).issues;
  }
  throw new Error("expected EnvValidationError");
}

describe("parseSiteEnv", () => {
  it("applies defaults for an empty environment", () => {
    expect(parseSiteEnv({})).toEqual({
      NODE_ENV: "development",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    });
  });

  it("accepts a valid production configuration", () => {
    expect(
      parseSiteEnv({
        NODE_ENV: "production",
        NEXT_PUBLIC_SITE_URL: "https://finora.example.com",
      }).NEXT_PUBLIC_SITE_URL,
    ).toBe("https://finora.example.com");
  });

  it("allows loopback http for local production builds", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3100"]) {
      expect(
        parseSiteEnv({ NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: url })
          .NEXT_PUBLIC_SITE_URL,
      ).toBe(url);
    }
  });

  it("requires https for non-local production URLs", () => {
    expect(() =>
      parseSiteEnv({
        NODE_ENV: "production",
        NEXT_PUBLIC_SITE_URL: "http://finora.example.com",
      }),
    ).toThrow(/https in production/);
  });

  it.each(["not a url", "ftp://example.com", "javascript:alert(1)"])(
    "rejects site URL %j",
    (url) => {
      expect(() => parseSiteEnv({ NEXT_PUBLIC_SITE_URL: url })).toThrow(
        EnvValidationError,
      );
    },
  );

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseSiteEnv({ NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });
});

describe("parseAuthEnv", () => {
  const valid = {
    SUPABASE_URL: "http://127.0.0.1:55321",
    SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
  };

  it("accepts a publishable key", () => {
    expect(parseAuthEnv(valid).SUPABASE_PUBLISHABLE_KEY).toBe(PUBLISHABLE);
  });

  it("accepts a legacy anon JWT", () => {
    const anon = jwtWithRole("anon");
    expect(
      parseAuthEnv({ ...valid, SUPABASE_PUBLISHABLE_KEY: anon })
        .SUPABASE_PUBLISHABLE_KEY,
    ).toBe(anon);
  });

  it("requires both variables", () => {
    expect(issuesOf(() => parseAuthEnv({}))).toEqual([
      "SUPABASE_URL: invalid_type",
      "SUPABASE_PUBLISHABLE_KEY: invalid_type",
    ]);
  });

  it.each([
    ["new-format secret key", "sb_secret_0123456789abcdefghij"],
    ["legacy service_role JWT", jwtWithRole("service_role")],
  ])("refuses a %s in the app environment", (_label, key) => {
    expect(() =>
      parseAuthEnv({ ...valid, SUPABASE_PUBLISHABLE_KEY: key }),
    ).toThrow(/secret\/service-role key must never be used/);
  });

  it("requires an https Supabase URL in production", () => {
    expect(() =>
      parseAuthEnv({
        ...valid,
        NODE_ENV: "production",
        SUPABASE_URL: "http://abc.supabase.co",
      }),
    ).toThrow(/SUPABASE_URL: custom/);
  });
});

describe("parseDatabaseEnv", () => {
  const url = (user: string) =>
    `postgresql://${user}:pw@127.0.0.1:55322/postgres`;

  it("accepts the finora_app role directly or through Supavisor", () => {
    expect(parseDatabaseEnv({ DATABASE_URL: url("finora_app") })).toEqual({
      DATABASE_URL: url("finora_app"),
      DATABASE_POOL_MAX: 5,
    });
    expect(
      parseDatabaseEnv({ DATABASE_URL: url("finora_app.abcdefghijkl") })
        .DATABASE_URL,
    ).toContain("finora_app.abcdefghijkl");
  });

  it.each(["postgres", "supabase_admin", "service_role", "finora_appx"])(
    "refuses to run the app as %s",
    (user) => {
      expect(() => parseDatabaseEnv({ DATABASE_URL: url(user) })).toThrow(
        /must connect as the finora_app role/,
      );
    },
  );

  it("validates the pool size", () => {
    expect(
      parseDatabaseEnv({
        DATABASE_URL: url("finora_app"),
        DATABASE_POOL_MAX: "2",
      }).DATABASE_POOL_MAX,
    ).toBe(2);
    expect(() =>
      parseDatabaseEnv({
        DATABASE_URL: url("finora_app"),
        DATABASE_POOL_MAX: "0",
      }),
    ).toThrow(/DATABASE_POOL_MAX/);
  });

  it.each(["", "not a url"])("reports a malformed DATABASE_URL %j without crashing", (value) => {
    expect(issuesOf(() => parseDatabaseEnv({ DATABASE_URL: value }))).toEqual([
      "DATABASE_URL: invalid_format",
    ]);
  });

  it("rejects non-Postgres URLs", () => {
    expect(() =>
      parseDatabaseEnv({ DATABASE_URL: "mysql://finora_app@h/db" }),
    ).toThrow(EnvValidationError);
  });
});

describe("secret hygiene", () => {
  it("never echoes supplied values in errors", () => {
    const secret = "sb_secret_DO_NOT_LEAK_0123456789";
    const dbPassword = "hunter2-db-password";
    const messages = [
      issuesOf(() =>
        parseAuthEnv({
          SUPABASE_URL: "http://127.0.0.1:55321",
          SUPABASE_PUBLISHABLE_KEY: secret,
        }),
      ),
      issuesOf(() =>
        parseDatabaseEnv({
          DATABASE_URL: `postgresql://postgres:${dbPassword}@db.example.com/postgres`,
        }),
      ),
      issuesOf(() =>
        parseSiteEnv({ NEXT_PUBLIC_SITE_URL: "https://user:sup3r@" }),
      ),
    ].flat();
    const joined = messages.join("\n");
    expect(joined).not.toContain("DO_NOT_LEAK");
    expect(joined).not.toContain(dbPassword);
    expect(joined).not.toContain("sup3r");
  });
});

describe("cached accessors", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("validate process.env once", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://cached.example.com");
    const { getSiteEnv } = await import("./env");
    expect(getSiteEnv().NEXT_PUBLIC_SITE_URL).toBe(
      "https://cached.example.com",
    );
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://changed.example.com");
    expect(getSiteEnv().NEXT_PUBLIC_SITE_URL).toBe(
      "https://cached.example.com",
    );
  });

  it("do not require auth or database variables until used", async () => {
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", undefined);
    const env = await import("./env");
    expect(() => env.getSiteEnv()).not.toThrow();
    expect(() => env.getAuthEnv()).toThrow(env.EnvValidationError);
    expect(() => env.getDatabaseEnv()).toThrow(env.EnvValidationError);
  });
});
