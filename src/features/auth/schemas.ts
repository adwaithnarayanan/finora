import { z } from "zod";

/**
 * Sign-in input. Deliberately lenient (no strength rules): every malformed or
 * wrong submission gets the same generic error as a wrong password. Password
 * strength is enforced where passwords are set (operator provisioning and
 * Supabase Auth's own policy).
 */
export const signInSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
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
