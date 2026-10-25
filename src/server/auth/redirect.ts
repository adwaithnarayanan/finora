/** Where to land after sign-in when no (valid) destination was requested. */
export const DEFAULT_AFTER_LOGIN = "/";

const BASE = "http://finora.invalid";

/**
 * Turns an untrusted `next` value into a same-origin path, or the default.
 * Rejects absolute and protocol-relative URLs, backslash tricks, control
 * characters and anything that would leave the app's origin.
 */
export function safeNextPath(
  input: unknown,
  fallback: string = DEFAULT_AFTER_LOGIN,
): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 2048) {
    return fallback;
  }
  if (!input.startsWith("/") || input.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(input)) return fallback;

  let url: URL;
  try {
    url = new URL(input, BASE);
  } catch {
    return fallback;
  }
  if (url.origin !== BASE) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
