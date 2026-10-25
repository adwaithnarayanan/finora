import { describe, expect, it } from "vitest";

import { DEFAULT_AFTER_LOGIN, safeNextPath } from "./redirect";

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/settings", "/settings"],
    ["/reports?month=2026-10#top", "/reports?month=2026-10#top"],
    ["/a/../b", "/b"],
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
  ])("keeps same-origin path %j", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    "https://evil.example",
    "http://localhost:3000/",
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "\\\\evil.example",
    "/\tevil",
    "/\nevil",
    "javascript:alert(1)",
    "evil.example",
    "",
    "x".repeat(10),
    `/${"a".repeat(2048)}`,
    undefined,
    null,
    42,
    ["/"],
  ])("falls back for unsafe value %j", (input) => {
    expect(safeNextPath(input)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it("uses the supplied fallback", () => {
    expect(safeNextPath("//evil", "/login")).toBe("/login");
  });
});
