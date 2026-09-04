# Melager — Backend

Express + Drizzle ORM + PostgreSQL (Neon) + Resend email.

## Setup

```bash
npm install
cp .env.example .env       # then fill DATABASE_URL, SESSION_SECRET, RESEND_API_KEY, RESEND_FROM_EMAIL
npm run db:push            # create tables in Neon
npm run dev                # http://localhost:5000
```

## Scripts

- `npm run dev` — build with esbuild + run with source maps
- `npm run build` — bundle to `dist/`
- `npm start` — run the built bundle
- `npm run db:push` — apply Drizzle schema to the configured DB
- `npm run db:migrate:offline-sync` — add the idempotency ledger and cursor change feed tables
- `npm run codegen` — regenerate Zod schemas from `openapi.yaml`
- `npm run typecheck` — `tsc --noEmit`

## Flat layout

```
app.ts                  Express setup (middleware, routes, error handler)
index.ts                Entry: reads PORT, starts listening
routes/                 Auth, mess, data, settings, meal-schedule, deposit-entries, health
controllers/            Request handlers and business logic used by routes
utils/                  Reusable stateless helpers shared by controllers
lib/                    Logger, email and mess-access helpers
middleware/auth.ts      Authentication middleware and JWT helpers
db/
  dbConfig.ts           PostgreSQL pool and Drizzle client configuration
  schema/index.ts       All Drizzle table definitions
zod/
  generated/            Auto-generated Zod schemas + types from OpenAPI spec
  index.ts              Re-export entry
openapi.yaml            API contract (source of truth for both repos)
orval.config.ts         Orval codegen config (regenerates zod/)
drizzle.config.ts       Drizzle Kit config
build.mjs               esbuild bundler
```

## Env vars

| Var                 | Required | Example                                                      |
| ------------------- | -------- | ------------------------------------------------------------ |
| `PORT`              | yes      | `5000`                                                       |
| `DATABASE_URL`      | yes      | `postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require` |
| `SESSION_SECRET`    | yes      | 48 random bytes hex                                          |
| `RESEND_API_KEY`    | yes      | `re_xxx`                                                     |
| `RESEND_FROM_EMAIL` | yes      | `Melager <noreply@yourdomain.com>`                           |

## Deployment

Run `npm run build`, then `node ./dist/index.mjs` (or use the platform's preset for Node ESM). Set all required env vars.
