# Finora

Private, double-entry personal finance PWA. Currently at **Milestone 1: foundation**
(app shell, money module, tooling, CI). No database, auth or financial features yet.

Architecture and decisions: [`docs/adr/`](docs/adr/).

## Requirements

- Node.js 24 LTS (see `.nvmrc`). `npm install`/`npm ci` refuse other major versions
  (`engine-strict` in `.npmrc`). With a version manager: `nvm use` or `fnm use`.
- npm (ships with Node). The committed `package-lock.json` is the source of truth.

## Setup

```bash
npm ci
cp .env.example .env.local   # optional; defaults work for local development
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server at http://localhost:3000 |
| `npm run lint` | ESLint (zero warnings allowed), including the domain import boundary |
| `npm run typecheck` | Generate Next.js route types, then `tsc --noEmit` |
| `npm test` | Unit and component tests (Vitest) |
| `npm run test:coverage` | Unit tests with coverage; enforces ≥95% on `src/domain/money` |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run test:e2e` | Playwright smoke tests against the production build (run `npm run build` first) |
| `npm run check` | Lint, typecheck, coverage and build in sequence |

First-time Playwright setup downloads a browser:

```bash
npx playwright install chromium          # add --with-deps on Debian/Ubuntu to install system libraries
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, lint, typecheck, `test:coverage`,
build and `test:e2e` on Node from `.nvmrc`.

## Layout

```
src/app/          routes and layouts (UI entry points)
src/components/   shared UI (shadcn/ui in components/ui)
src/domain/       pure TypeScript business rules; no framework/infra imports
src/server/       server-only application code (env validation for now)
tests/unit/       tests not colocated with a module (e.g. lint-rule tests)
tests/e2e/        Playwright specs
docs/adr/         architecture decision records
```
