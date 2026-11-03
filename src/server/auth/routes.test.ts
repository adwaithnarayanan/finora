import { describe, expect, it } from "vitest";

import { isPublicPath } from "./routes";

describe("isPublicPath", () => {
  it.each(["/login", "/auth/callback", "/unauthorized"])(
    "treats %s as public",
    (path) => expect(isPublicPath(path)).toBe(true),
  );

  it.each([
    "/",
    "/settings",
    "/loginx",
    "/login-evil",
    "/auth",
    "/auth/other",
    "/auth/callbackx",
    "/api/anything",
    "/forgot-password",
    "/reset-password",
    "/auth/confirm",
  ])("protects %s", (path) => expect(isPublicPath(path)).toBe(false));
});
