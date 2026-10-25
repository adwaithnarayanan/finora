import { describe, expect, it } from "vitest";

import { InvalidOwnerIdError, parseOwnerId } from "./index";

describe("parseOwnerId", () => {
  it("accepts canonical UUIDs", () => {
    const id = "3f6c1a52-8a3b-4c6e-9d1f-0a2b3c4d5e6f";
    expect(parseOwnerId(id)).toBe(id);
  });

  it.each([
    "",
    "not-a-uuid",
    "3F6C1A52-8A3B-4C6E-9D1F-0A2B3C4D5E6F",
    "3f6c1a52-8a3b-4c6e-9d1f-0a2b3c4d5e6",
    " 3f6c1a52-8a3b-4c6e-9d1f-0a2b3c4d5e6f",
    "3f6c1a52-8a3b-0c6e-9d1f-0a2b3c4d5e6f",
    "00000000-0000-0000-0000-000000000000",
    42,
    null,
    undefined,
  ])("rejects %j", (value) => {
    expect(() => parseOwnerId(value)).toThrow(InvalidOwnerIdError);
  });
});
