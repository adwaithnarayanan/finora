import { Suspense } from "react";

import { HomeOverview } from "@/features/home/home-overview";
import { requireOwner } from "@/server/auth/session";

export default function HomePage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <OwnerHome />
    </Suspense>
  );
}

async function OwnerHome() {
  await requireOwner();
  return <HomeOverview />;
}
