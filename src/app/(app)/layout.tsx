import { Suspense } from "react";

import { Brand } from "@/components/brand";
import { SignOutButton } from "@/features/auth/sign-out-button";
import { requireOwner } from "@/server/auth/session";

/**
 * Shell for owner-only routes. The layout check is not the security boundary:
 * each page and every data access calls requireOwner() / withOwnerScope().
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-96 bg-[radial-gradient(ellipse_at_top,var(--color-muted),transparent_70%)]"
      />
      <header className="relative mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <Brand />
        <Suspense fallback={null}>
          <AccountControls />
        </Suspense>
      </header>
      <main className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pt-12 pb-16 sm:px-6 sm:pt-20">
        {children}
      </main>
      <footer className="relative mx-auto w-full max-w-5xl border-t px-4 py-6 text-xs text-muted-foreground sm:px-6">
        Finora · Milestone 2 foundation
      </footer>
    </div>
  );
}

async function AccountControls() {
  await requireOwner();
  return <SignOutButton />;
}
