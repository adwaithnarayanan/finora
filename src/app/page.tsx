import { BookOpenCheck, Lock, WifiOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const principles = [
  {
    icon: BookOpenCheck,
    title: "Double-entry at the core",
    description:
      "Every rupee is recorded twice and must balance. Corrections are reversals, never silent edits.",
  },
  {
    icon: Lock,
    title: "Private by default",
    description:
      "A single-owner workspace. No public sign-up, and every request is authorised on the server.",
  },
  {
    icon: WifiOff,
    title: "Honest offline",
    description:
      "Entries made offline stay clearly marked as pending until the server confirms them.",
  },
] as const;

export default function HomePage() {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-40 h-96 bg-[radial-gradient(ellipse_at_top,var(--color-muted),transparent_70%)]"
      />

      <header className="relative mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5 sm:px-6">
        <span className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span
            aria-hidden
            className="grid size-7 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground"
          >
            F
          </span>
          Finora
        </span>
        <Badge variant="outline">Foundation preview</Badge>
      </header>

      <main className="relative mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pt-12 pb-16 sm:px-6 sm:pt-20">
        <section className="max-w-2xl">
          <p className="text-sm font-medium text-muted-foreground">
            Personal finance, accounted for
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Know exactly where your money is.
          </h1>
          <p className="mt-5 text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
            Finora brings your accounts, cards, loans, deposits and budgets
            into one exact, private ledger. The foundations are being laid; the
            features follow.
          </p>
        </section>

        <section
          aria-label="Design principles"
          className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {principles.map(({ icon: Icon, title, description }) => (
            <Card key={title}>
              <CardHeader>
                <Icon aria-hidden className="mb-2 size-5 text-muted-foreground" />
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </section>
      </main>

      <footer className="relative mx-auto w-full max-w-5xl border-t px-4 py-6 text-xs text-muted-foreground sm:px-6">
        Finora · Milestone 1 foundation
      </footer>
    </div>
  );
}
