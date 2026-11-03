import { Button } from "@/components/ui/button";

import { signOut } from "./actions";

export function SignOutButton({
  variant = "outline",
}: {
  variant?: "outline" | "ghost" | "default";
}) {
  return (
    <form action={signOut}>
      <Button type="submit" variant={variant} size="sm">
        Sign out
      </Button>
    </form>
  );
}
