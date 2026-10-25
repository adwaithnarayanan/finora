import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  ACTIVE_SIGN_IN_METHOD as SCRIPT_METHOD,
  APPROVED_GOOGLE_ID_KEY as SCRIPT_GOOGLE_KEY,
  APPROVED_PASSWORD_EMAIL_KEY as SCRIPT_PASSWORD_KEY,
  passwordProblem,
} from "../../scripts/lib/provisioning.mjs";
import { promptHidden, readStdinSecret } from "../../scripts/lib/read-secret.mjs";
import { APPROVED_GOOGLE_ID_KEY, APPROVED_PASSWORD_EMAIL_KEY } from "../../src/server/auth/supabase/identity";
import { ACTIVE_SIGN_IN_METHOD } from "../../src/server/auth/supabase/sign-in-method";

describe("provisioning script stays in sync with the app", () => {
  it("uses the same sign-in method and approval keys", () => {
    expect(SCRIPT_METHOD).toBe(ACTIVE_SIGN_IN_METHOD);
    expect(SCRIPT_PASSWORD_KEY).toBe(APPROVED_PASSWORD_EMAIL_KEY);
    expect(SCRIPT_GOOGLE_KEY).toBe(APPROVED_GOOGLE_ID_KEY);
  });
});

describe("passwordProblem", () => {
  it.each(["Correct-horse-9", "Abcdefghijk1", `Aa1${"x".repeat(69)}`])("accepts %s", (password) => {
    expect(passwordProblem(password)).toBeNull();
  });

  it.each([
    ["too short", "Short-pass1"],
    ["no digit", "No-digits-here"],
    ["no upper case", "no-upper-case-1"],
    ["no lower case", "NO-LOWER-CASE-1"],
    ["over 72 bytes", `Aa1${"x".repeat(70)}`],
    ["multi-byte over 72 bytes", `Aa1${"é".repeat(35)}`],
    ["leading whitespace", " Leading-space-1"],
    ["not a string", 123456789012],
  ])("rejects %s without echoing it", (_label, password) => {
    const problem = passwordProblem(password);
    expect(problem).toBeTruthy();
    expect(problem).not.toContain(String(password));
  });
});

/** A fake TTY: raw-mode capable input plus a captured output stream. */
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, rawMode: false, setRawMode(on: boolean) { input.rawMode = on; return input; } });
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => (written += String(chunk)));
  return { input, output, written: () => written };
}

describe("promptHidden", () => {
  it("returns what was typed without echoing it, and restores the terminal", async () => {
    const term = fakeTerminal();
    const answer = promptHidden("Password: ", { input: term.input as never, output: term.output as never });
    term.input.write("Secret-Pass");
    term.input.write("\u007f"); // backspace
    term.input.write("s-1\r");
    await expect(answer).resolves.toBe("Secret-Pas" + "s-1");
    expect(term.written()).toBe("Password: \n");
    expect(term.input.rawMode).toBe(false);
  });

  it("can be cancelled with Ctrl-C", async () => {
    const term = fakeTerminal();
    const answer = promptHidden("Password: ", { input: term.input as never, output: term.output as never });
    term.input.write("abc\u0003");
    await expect(answer).rejects.toThrow("Cancelled.");
  });

  it("refuses to prompt without a terminal", async () => {
    const notATerminal = new PassThrough();
    await expect(promptHidden("Password: ", { input: notATerminal as never, output: new PassThrough() as never })).rejects.toThrow(
      /--password-stdin/,
    );
  });
});

describe("readStdinSecret", () => {
  it("reads piped input and drops one trailing newline only", async () => {
    const input = new PassThrough();
    const result = readStdinSecret(input as never);
    input.end("Piped-Secret-1\n");
    await expect(result).resolves.toBe("Piped-Secret-1");
    const crlf = new PassThrough();
    const second = readStdinSecret(crlf as never);
    crlf.end("Two-lines-1\r\n\n");
    await expect(second).resolves.toBe("Two-lines-1\r\n");
  });
});
