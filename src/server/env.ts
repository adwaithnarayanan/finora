import { z } from "zod";

/**
 * Server environment contract. Milestone 1 needs no secrets; database and auth
 * variables are added here (as required, non-optional) when those milestones land.
 */
const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Public origin of the app, used for absolute URLs and metadata. */
  NEXT_PUBLIC_SITE_URL: z
    .url({ protocol: /^https?$/ })
    .default("http://localhost:3000"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.name = "EnvValidationError";
  }
}

/**
 * Validates an environment record. Error messages name the variable and the
 * problem but never echo the supplied value, so secrets cannot leak into logs.
 */
export function parseServerEnv(
  source: Record<string, string | undefined>,
): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`,
      ),
    );
  }
  if (
    result.data.NODE_ENV === "production" &&
    new URL(result.data.NEXT_PUBLIC_SITE_URL).protocol !== "https:" &&
    !isLoopback(result.data.NEXT_PUBLIC_SITE_URL)
  ) {
    throw new EnvValidationError([
      "NEXT_PUBLIC_SITE_URL: must use https in production",
    ]);
  }
  return result.data;
}

function isLoopback(url: string): boolean {
  const { hostname } = new URL(url);
  return hostname === "localhost" || hostname === "127.0.0.1";
}

let cached: ServerEnv | undefined;

/** Lazily validated process environment for server code. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
