import { z } from "zod";

export const MIN_PASSWORD_LENGTH = 12;
/** Supabase hashes with bcrypt, which only uses the first 72 bytes. */
export const MAX_PASSWORD_BYTES = 72;

export const signInSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
  next: z.string().max(2048).optional(),
});

export const resetRequestSchema = z.object({
  email: z.email().max(254),
});

export const newPasswordSchema = z
  .object({
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      .refine(
        (value) => new TextEncoder().encode(value).length <= MAX_PASSWORD_BYTES,
        `Use at most ${MAX_PASSWORD_BYTES} bytes.`,
      )
      .refine(
        (value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value),
        "Include upper- and lower-case letters and a digit.",
      ),
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    path: ["confirm"],
    message: "Passwords do not match.",
  });

export const emailLinkSchema = z.object({
  token_hash: z.string().min(1).max(1024),
  type: z.enum(["recovery", "invite"]),
  next: z.string().max(2048).optional(),
});

export type FormState = { readonly error?: string; readonly message?: string };

export function formEntries(formData: FormData): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of formData) {
    if (typeof value === "string") entries[key] = value;
  }
  return entries;
}
