import { BookOpenCheck, Lock, WifiOff } from "lucide-react";

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

export function HomeOverview() {
  return (
    <>
      <section className="max-w-2xl">
        <p className="text-sm font-medium text-muted-foreground">
          Personal finance, accounted for
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Know exactly where your money is.
        </h1>
        <p className="mt-5 text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
          Finora brings your accounts, cards, loans, deposits and budgets into
          one exact, private ledger. Bank and cash accounts, income, expenses
          and transfers are ready; the rest follows.
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
    </>
  );
}
