import { Button } from "@/components/ui/button";

import { signOut } from "./actions";

/** POST-only sign-out (a GET link could be triggered cross-site). */
export function SignOutButton({ variant = "outline" }: { variant?: "outline" | "ghost" | "default" }) {
  return (
    <form action={signOut}>
      <Button type="submit" variant={variant} size="sm">
        Sign out
      </Button>
    </form>
  );
}
