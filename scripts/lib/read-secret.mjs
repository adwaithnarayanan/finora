// Reads a secret without echoing it, either from an interactive terminal or,
// with --password-stdin, from piped standard input. The value is never
// written anywhere (not even as asterisks) and never passes through argv or
// the environment.

/** Prompts on a TTY with echo disabled. Rejects when stdin is not a terminal. */
export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("No terminal for a hidden prompt; run interactively or use --password-stdin."));
  }
  output.write(question);
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003" || char === "\u0004") return done(new Error("Cancelled."));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}

/** Reads all of stdin and removes one trailing newline (as `echo`/`printf` add). */
export async function readStdinSecret(input = process.stdin) {
  let value = "";
  input.setEncoding("utf8");
  for await (const chunk of input) value += chunk;
  return value.replace(/\r?\n$/, "");
}
