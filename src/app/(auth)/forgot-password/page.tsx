import type { Metadata } from "next";

import { AuthCard } from "@/features/auth/auth-card";
import { ForgotPasswordForm } from "@/features/auth/forgot-password-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Reset your password" description="We'll email a single-use link to the owner's address.">
      <ForgotPasswordForm />
    </AuthCard>
  );
}
