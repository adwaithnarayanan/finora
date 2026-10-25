import { describe, expect, it } from "vitest";

import { SIGN_IN_NOTICES, callbackErrorNotice, isAuthorizationCode, parseSignInNotice } from "./callback";

describe("isAuthorizationCode", () => {
  it.each(["2f1c3b8e-5a9d-4c3e-8f7a-1b2c3d4e5f60", "abcDEF12_-.~"])("accepts %s", (code) => {
    expect(isAuthorizationCode(code)).toBe(true);
  });

  it.each([null, undefined, "", "short", "x".repeat(257), "has space", "a/b/c/d/e", "<script>x", 42])(
    "rejects %j",
    (code) => expect(isAuthorizationCode(code)).toBe(false),
  );
});

describe("callbackErrorNotice", () => {
  const notice = (query: string) => callbackErrorNotice(new URLSearchParams(query));

  it("is null for a normal callback", () => {
    expect(notice("code=abc")).toBeNull();
  });

  it("reports refused accounts as denied", () => {
    expect(notice("error=access_denied&error_code=signup_disabled&error_description=Signups+not+allowed")).toBe("denied");
    expect(notice("error=access_denied&error_code=user_banned")).toBe("denied");
  });

  it("reports everything else generically", () => {
    expect(notice("error=access_denied&error_description=The+user+denied")).toBe("oauth");
    expect(notice("error=server_error&error_code=unexpected_failure")).toBe("oauth");
    expect(notice("error_code=bad_oauth_state")).toBe("oauth");
  });

  it("never echoes provider text into the notice", () => {
    const description = "Unverified email with google: owner@example.com";
    for (const text of Object.values(SIGN_IN_NOTICES)) expect(text).not.toContain(description);
    expect(notice(`error=x&error_description=${encodeURIComponent(description)}`)).toBe("oauth");
  });
});

describe("parseSignInNotice", () => {
  it("accepts only known notices", () => {
    expect(parseSignInNotice("oauth")).toBe("oauth");
    expect(parseSignInNotice("denied")).toBe("denied");
    for (const value of ["link", "<b>hi</b>", ["oauth"], undefined]) expect(parseSignInNotice(value)).toBeUndefined();
  });
});
