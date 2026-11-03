import { z } from "zod";

export const signInSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
  next: z.string().max(2048).optional(),
});
