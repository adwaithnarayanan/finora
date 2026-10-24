import { afterEach, describe, expect, it, vi } from "vitest";

import { EnvValidationError, parseServerEnv } from "./env";

describe("parseServerEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("applies defaults for an empty environment", () => {
    expect(parseServerEnv({})).toEqual({
      NODE_ENV: "development",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    });
  });

  it("accepts a valid production configuration", () => {
    expect(
      parseServerEnv({
        NODE_ENV: "production",
        NEXT_PUBLIC_SITE_URL: "https://finora.example.com",
      }),
    ).toEqual({
      NODE_ENV: "production",
      NEXT_PUBLIC_SITE_URL: "https://finora.example.com",
    });
  });

  it("allows a localhost URL for local production builds", () => {
    expect(
      parseServerEnv({
        NODE_ENV: "production",
        NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      }).NEXT_PUBLIC_SITE_URL,
    ).toBe("http://localhost:3000");
    expect(
      parseServerEnv({
        NODE_ENV: "production",
        NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000",
      }).NODE_ENV,
    ).toBe("production");
  });

  it("requires https for non-local production URLs", () => {
    expect(() =>
      parseServerEnv({
        NODE_ENV: "production",
        NEXT_PUBLIC_SITE_URL: "http://finora.example.com",
      }),
    ).toThrow(/https in production/);
  });

  it.each(["not a url", "ftp://example.com", "javascript:alert(1)"])(
    "rejects site URL %j",
    (url) => {
      expect(() => parseServerEnv({ NEXT_PUBLIC_SITE_URL: url })).toThrow(
        EnvValidationError,
      );
    },
  );

  it("rejects an unknown NODE_ENV", () => {
    expect(() => parseServerEnv({ NODE_ENV: "staging" })).toThrow(
      /NODE_ENV/,
    );
  });

  it("never echoes supplied values in errors", () => {
    const secretLike = "https://user:sup3r-s3cret@";
    try {
      parseServerEnv({ NEXT_PUBLIC_SITE_URL: secretLike, NODE_ENV: "nope" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as Error).message;
      expect(message).not.toContain("sup3r-s3cret");
      expect(message).not.toContain("nope");
      expect((error as EnvValidationError).issues).toHaveLength(2);
    }
  });

  it("validates and caches process.env through getServerEnv", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://cached.example.com");
    const { getServerEnv } = await import("./env");
    expect(getServerEnv().NEXT_PUBLIC_SITE_URL).toBe(
      "https://cached.example.com",
    );
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://changed.example.com");
    expect(getServerEnv().NEXT_PUBLIC_SITE_URL).toBe(
      "https://cached.example.com",
    );
  });
});
