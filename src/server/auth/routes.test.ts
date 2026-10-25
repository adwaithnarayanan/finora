import { describe, expect, it } from "vitest";

import { isPublicPath } from "./routes";

describe("isPublicPath", () => {
  it.each(["/login", "/forgot-password", "/auth/confirm", "/reset-password", "/unauthorized"])(
    "treats %s as public",
    (path) => expect(isPublicPath(path)).toBe(true),
  );

  it.each(["/", "/settings", "/loginx", "/login-evil", "/auth", "/auth/other", "/api/anything"])(
    "protects %s",
    (path) => expect(isPublicPath(path)).toBe(false),
  );
});
