import { Button } from "@/components/ui/button";

import { initializeDefaultCategoriesAction } from "./actions";

/** Creates the default income and expense categories when the owner asks for them. */
export function DefaultCategoriesButton({ returnTo }: { returnTo?: "/transactions/new" }) {
  return (
    <form action={initializeDefaultCategoriesAction}>
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <Button type="submit" variant="outline" size="sm">
        Add default categories
      </Button>
    </form>
  );
}
