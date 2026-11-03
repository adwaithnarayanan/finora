import { z } from "zod";

type EnvSource = Record<string, string | undefined>;

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join("\n- ")}`);
    this.name = "EnvValidationError";
  }
}

const nodeEnv = z
  .enum(["development", "test", "production"])
  .default("development");

const httpUrl = z.url({ protocol: /^https?$/ });

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopback(url: string): boolean {
  return LOOPBACK.has(new URL(url).hostname);
}

function parseWith<T extends z.ZodType>(
  schema: T,
  source: EnvSource,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map(
        (issue) =>
          `${issue.path.join(".") || "(root)"}: ${issue.code}${
            issue.code === "custom" ? ` (${issue.message})` : ""
          }`,
      ),
    );
  }
  return result.data;
}

function requireHttpsInProduction(
  env: { NODE_ENV: string },
  key: string,
  url: string,
  ctx: z.RefinementCtx,
) {
  if (!URL.canParse(url)) return;
  if (
    env.NODE_ENV === "production" &&
    new URL(url).protocol !== "https:" &&
    !isLoopback(url)
  ) {
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: "must use https in production",
    });
  }
}

const siteSchema = z
  .object({
    NODE_ENV: nodeEnv,
    NEXT_PUBLIC_SITE_URL: httpUrl.default("http://localhost:3000"),
  })
  .superRefine((env, ctx) =>
    requireHttpsInProduction(
      env,
      "NEXT_PUBLIC_SITE_URL",
      env.NEXT_PUBLIC_SITE_URL,
      ctx,
    ),
  );

export type SiteEnv = z.infer<typeof siteSchema>;

export function parseSiteEnv(source: EnvSource): SiteEnv {
  return parseWith(siteSchema, source);
}

function isPrivilegedSupabaseKey(key: string): boolean {
  if (key.startsWith("sb_secret_")) return true;
  const payload = key.split(".")[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return claims?.role === "service_role";
  } catch {
    return false;
  }
}

const authSchema = z
  .object({
    NODE_ENV: nodeEnv,
    SUPABASE_URL: httpUrl,
    SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  })
  .superRefine((env, ctx) => {
    requireHttpsInProduction(env, "SUPABASE_URL", env.SUPABASE_URL, ctx);
    if (isPrivilegedSupabaseKey(env.SUPABASE_PUBLISHABLE_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["SUPABASE_PUBLISHABLE_KEY"],
        message: "a secret/service-role key must never be used by the app",
      });
    }
  });

export type AuthEnv = z.infer<typeof authSchema>;

export function parseAuthEnv(source: EnvSource): AuthEnv {
  return parseWith(authSchema, source);
}

const RUNTIME_ROLE = "finora_app";

const databaseSchema = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
  })
  .superRefine((env, ctx) => {
    // Supavisor usernames look like `finora_app.<project-ref>`.
    let user = "";
    try {
      user = decodeURIComponent(new URL(env.DATABASE_URL).username);
    } catch {
      return;
    }
    if (user !== RUNTIME_ROLE && !user.startsWith(`${RUNTIME_ROLE}.`)) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: `must connect as the ${RUNTIME_ROLE} role`,
      });
    }
  });

export type DatabaseEnv = z.infer<typeof databaseSchema>;

export function parseDatabaseEnv(source: EnvSource): DatabaseEnv {
  return parseWith(databaseSchema, source);
}

function lazy<T>(parse: (source: EnvSource) => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= parse(process.env));
}

export const getSiteEnv = lazy(parseSiteEnv);
export const getAuthEnv = lazy(parseAuthEnv);
export const getDatabaseEnv = lazy(parseDatabaseEnv);
