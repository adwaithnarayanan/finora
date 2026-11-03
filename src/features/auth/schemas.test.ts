import { describe, expect, it } from "vitest";

import { signInSchema } from "./schemas";

describe("signInSchema", () => {
  it("accepts an email and any non-empty password", () => {
    expect(signInSchema.safeParse({ email: "owner@example.com", password: "x" }).success).toBe(true);
    expect(signInSchema.safeParse({ email: "owner@example.com", password: "x", next: "/reports" }).success).toBe(true);
  });

  it.each([
    ["missing email", { password: "x" }],
    ["not an email (no usernames)", { email: "owner", password: "x" }],
    ["over-long email", { email: `${"a".repeat(250)}@b.co`, password: "x" }],
    ["empty password", { email: "owner@example.com", password: "" }],
    ["over-long password", { email: "owner@example.com", password: "x".repeat(1025) }],
    ["over-long next", { email: "owner@example.com", password: "x", next: `/${"a".repeat(2048)}` }],
  ])("rejects %s", (_label, input) => {
    expect(signInSchema.safeParse(input).success).toBe(false);
  });
});
