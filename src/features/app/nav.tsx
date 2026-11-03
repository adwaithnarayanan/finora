"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/accounts", label: "Accounts" },
  { href: "/transactions", label: "Transactions" },
  { href: "/categories", label: "Categories" },
] as const;

function NavLinks({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Main" className="-mx-1 flex gap-1 overflow-x-auto">
      {LINKS.map(({ href, label }) => {
        const active =
          pathname !== null &&
          (href === "/"
            ? pathname === "/"
            : pathname === href || pathname.startsWith(`${href}/`));
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className="rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground"
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppNav() {
  return <NavLinks pathname={usePathname()} />;
}

export function AppNavFallback() {
  return <NavLinks pathname={null} />;
}
