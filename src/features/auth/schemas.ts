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
