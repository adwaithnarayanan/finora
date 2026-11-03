import { Suspense } from "react";

import { Brand } from "@/components/brand";
import { AppNav, AppNavFallback } from "@/features/app/nav";
import { SignOutButton } from "@/features/auth/sign-out-button";
import { requireOwner } from "@/server/auth/session";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-96 bg-[radial-gradient(ellipse_at_top,var(--color-muted),transparent_70%)]"
      />
      <header className="relative mx-auto grid w-full max-w-5xl gap-3 px-4 py-5 sm:px-6">
        <div className="flex items-center justify-between">
          <Brand />
          <Suspense fallback={null}>
            <AccountControls />
          </Suspense>
        </div>
        <Suspense fallback={<AppNavFallback />}>
          <AppNav />
        </Suspense>
      </header>
      <main className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pt-8 pb-16 sm:px-6 sm:pt-12">
        {children}
      </main>
      <footer className="relative mx-auto w-full max-w-5xl border-t px-4 py-6 text-xs text-muted-foreground sm:px-6">
        Finora · amounts in en-IN format; balances are derived from the
        double-entry ledger
      </footer>
    </div>
  );
}

async function AccountControls() {
  await requireOwner();
  return <SignOutButton />;
}
