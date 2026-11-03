"use client";

import { Button } from "@/components/ui/button";

export default function AppError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div role="alert" className="grid max-w-md gap-3">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        Nothing was changed by the failed request. Try again; if it keeps
        happening, reload the page.
      </p>
      <div>
        <Button type="button" variant="outline" onClick={() => reset()}>
          Try again
        </Button>
      </div>
    </div>
  );
}
