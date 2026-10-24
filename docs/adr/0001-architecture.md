# ADR 0001: Modular monolith with a pure domain layer

- Status: Accepted
- Date: 2026-10-25

## Context

Finora is a single-owner personal finance PWA that must stay correct (double-entry,
exact money, immutable postings) and later support multiple users without a domain
redesign. It is built and run by one person, so operational simplicity matters.

## Decision

- One Next.js (App Router) application, deployed to Vercel, backed by one PostgreSQL
  database (Supabase, from Milestone 2). No microservices or extra infrastructure.
- Layers, with dependencies pointing inward only:
  - `src/domain/**`: pure TypeScript business rules (money, ledger, posting
    templates, budgets). No Next.js, React, Prisma, Supabase, Node built-ins or
    app-layer imports.
  - `src/server/**`: application use cases, authorisation, persistence adapters and
    environment validation.
  - `src/app/**`, `src/components/**`, `src/features/**`: UI and route entry points
    (server components, server actions, route handlers).
- The domain boundary is enforced by ESLint (`no-restricted-imports` plus a ban on
  dynamic `import()`/`require()` in `src/domain`), and the rule itself is covered by
  `tests/unit/domain-boundary.test.ts`.
- Server environment is validated with Zod (`src/server/env.ts`); validation errors
  name the variable but never echo its value.

## Consequences

- Domain logic is unit-testable without a database or framework.
- Auth and persistence can change (e.g. away from Supabase Auth) by replacing
  adapters in `src/server`, not domain code.
- Every domain dependency on infrastructure must go through an interface defined in
  the domain or application layer, which adds a little ceremony.
