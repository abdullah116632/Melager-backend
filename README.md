# Melager — Backend

REST + realtime API for **Melager**, a mess (shared kitchen) management app. It handles
accounts, messes and members, daily meals, expenses, deposits, bazar lists, notices,
chat, push notifications, and offline sync for the mobile app.

**Stack:** Node.js · Express 5 · TypeScript · Drizzle ORM · PostgreSQL (Neon) ·
Socket.IO · Resend (email) · Expo Push · esbuild

---

## Contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [npm scripts](#npm-scripts)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
  - [Authentication](#authentication)
  - [Mess access and roles](#mess-access-and-roles)
  - [Realtime (Socket.IO)](#realtime-socketio)
  - [Offline sync](#offline-sync)
  - [Push notifications](#push-notifications)
- [API reference](#api-reference)
- [Database and migrations](#database-and-migrations)
- [Build and deploy (cPanel)](#build-and-deploy-cpanel)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Requires **Node.js 20+** and a PostgreSQL database (Neon is used in production).

```bash
cd backend
npm install
cp .env.example .env     # fill in the values, see below
npm run dev              # starts on http://localhost:$PORT with hot reload
```

Check that it is up:

```bash
curl http://localhost:5000/api/healthz
# {"status":"ok"}
```

On startup the server logs its LAN address (for example `http://192.168.1.10:5000`).
Put that in `mobile/.env.local` to use the API from a phone on the same network.

---

## Environment variables

The server reads `.env` from the working directory. It **refuses to start** if a required
value is missing or invalid.

| Variable            | Required | Description |
| ------------------- | :------: | ----------- |
| `PORT`              | ✅ | HTTP port, for example `5000`. |
| `DATABASE_URL`      | ✅ | PostgreSQL connection string. For Neon, use the **pooled** connection with `?sslmode=require`. |
| `SESSION_SECRET`    | ✅ | JWT signing key. **At least 32 characters.** Changing it signs out every user. |
| `GOOGLE_CLIENT_IDS` | ✅* | Comma-separated Google OAuth client IDs (Android, iOS, web). *Required only for Google sign-in. See [GOOGLE_AUTH_SETUP.md](GOOGLE_AUTH_SETUP.md). |
| `RESEND_API_KEY`    | ✅* | Resend API key. *Required for every email: OTPs, invites and summaries. |
| `RESEND_FROM_EMAIL` | ✅* | Sender, for example `Melager <noreply@yourdomain.com>`. The domain must be verified in Resend. |
| `NODE_ENV`          |    | Set to `production` on the server. This switches logs from pretty output to JSON. |
| `APP_TIME_ZONE`     |    | Time zone for meal days, month boundaries and meal windows. Default: `Asia/Dhaka`. |
| `LOG_LEVEL`         |    | Pino log level. Default: `info`. |
| `DB_POOL_MAX`       |    | Maximum Postgres pool connections. Default: `10`. |

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## npm scripts

| Script | What it does |
| ------ | ------------ |
| `npm run dev` | Runs `index.ts` with `tsx watch` (hot reload) using `.env`. |
| `npm run build` | Bundles the app into `dist/index.mjs` with esbuild. |
| `npm start` | Runs the built bundle in production mode. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run format` | Prettier over the source folders. |
| `npm run db:push` | Applies the Drizzle schema to `DATABASE_URL`. Read [Database and migrations](#database-and-migrations) first. |
| `npm run db:push:force` | Same as above, without confirmation prompts. |
| `npm run db:migrate:offline-sync` | Creates the `sync_client_mutations` and `sync_changes` tables. |
| `npm run db:migrate:meal-opt-out-scope` | Adds `scope` and `ended_date` to `meal_opt_outs`. |
| `npm run codegen` | Regenerates `zod/generated/` from `openapi.yaml` with Orval. |

---

## Project structure

```
backend/
├── index.ts                 Entry point: loads .env, checks PORT, starts HTTP + Socket.IO
├── app.ts                   Express app: logging, CORS, JSON body, /api router, error handler
├── routes/                  One router per feature, combined in indexRoute.ts
├── controllers/             Request handlers and business logic
│   └── *SyncController.ts   Idempotent offline-sync endpoints
├── utils/                   Stateless helpers (dates, accounting, OTP, access checks, …)
├── lib/
│   ├── logger.ts            Pino logger
│   ├── sessionSecret.ts     Loads and validates SESSION_SECRET once
│   ├── email.ts             Resend email templates
│   ├── mess-access.ts       Membership and role lookup in one query
│   └── notificationDelivery.ts  Socket events + Expo push delivery
├── middleware/auth.ts       JWT signing and the requireAuth middleware
├── realtime/socket.ts       Socket.IO server, rooms and presence
├── db/
│   ├── dbConfig.ts          pg Pool + Drizzle client
│   └── schema/index.ts      Every table definition
├── scripts/                 Hand-written SQL/TS migrations
├── zod/                     Orval-generated Zod schemas (from openapi.yaml)
├── build.mjs                esbuild bundler config
├── cpanel-start.mjs         cPanel/Passenger startup file (imports dist/index.mjs)
└── drizzle.config.ts        Drizzle Kit config
```

---

## How it works

### Authentication

- Every protected endpoint needs `Authorization: Bearer <token>`.
- Tokens are JWTs holding `{ userId }`, signed with `SESSION_SECRET`. They are valid for **30 days**.
- **Email sign-up** sends a 6-digit OTP. The account is usable after `/auth/verify-otp`.
- **Google sign-in** (`/auth/google`) verifies the Google ID token on the server. A verified
  Google email that matches an existing account is linked to that account.
- **OTP rules** apply to sign-up, password reset, security actions and account deletion:
  - A code expires after **10 minutes**.
  - A code is burned after **5 wrong attempts**, which returns `429`.
  - A new code can be requested only after a **60-second cooldown**.
- **Sensitive actions** need a security OTP first: changing email, transferring admin,
  adding a co-admin and removing yourself as admin. The flow is
  `/settings/security/request-otp` → the action endpoint with the code.

### Mess access and roles

A user can belong to several messes, so most endpoints take a **`messId`**. `GET` requests
read it from the query string and write requests read it from the body. Every request checks
membership:

| Role | Who |
| ---- | --- |
| **admin** | The mess owner (`messes.admin_user_id`) or a consumer with `is_admin = true` (co-admin). |
| **member** | Any other consumer of the mess. |

Non-members get `403 Access denied`. Admin-only endpoints (expenses, deposits, meal
schedule, notices, bazar management, …) return `403 Admin access required` to members.

Errors are always JSON: `{ "error": "message" }`.

### Realtime (Socket.IO)

Socket.IO runs on the same HTTP server and port as the API (path `/socket.io`).

**Connect** with the same JWT and the mess to watch:

```js
io(API_URL, { auth: { token, messId } });
```

The handshake is rejected if the token is invalid or the user is not in that mess. Each
socket joins two rooms: `mess:<messId>` and `user:<userId>`.

**Server → client events**

| Event | Room | When |
| ----- | ---- | ---- |
| `meals:updated` | mess | Daily meals changed |
| `meal-schedule:updated` | mess | Meal schedule, menu or windows changed |
| `expenses:updated` | mess | Expenses changed |
| `deposits:updated` | mess | Deposits changed |
| `message:created` | mess | New chat message |
| `message:reaction` | mess | Reaction added, changed or removed |
| `notification:created` | user | New bell notification |
| `bazar-assignment:created` | user | User was assigned bazar duty |
| `consumer-breakdown:created` | user | Admin shared a consumer breakdown |

**Client → server events**

| Event | Payload | Purpose |
| ----- | ------- | ------- |
| `conversation:enter` | `{ messId }` | The user opened the chat screen. Chat pushes are skipped while they are viewing it. |
| `conversation:leave` | `{ messId }` | The user left the chat screen. |

> Rooms and chat presence are kept **in memory**. Run a **single Node process**, otherwise
> events and presence will not reach every client.

### Offline sync

The mobile app queues changes while offline and replays them through the `…/sync` endpoints
(daily meals, expenses, deposits, bazar, notices, messages).

- **Idempotency.** Each request carries a client-generated `clientMutationId`. The server
  stores a receipt in `sync_client_mutations` (per user) together with a hash of the request:
  - Replaying the same mutation returns the stored response and does not write again.
  - Reusing a `clientMutationId` with a different payload returns `409 Duplicate mutation conflict`.
- **Conflict checks.** Bazar and notice updates compare `updated_at` before writing, so a
  stale offline edit cannot silently overwrite a newer one.
- **Change feed.** Daily meal, bazar and notice writes also append to `sync_changes`. The id
  column works as a cursor. Clients catch up with:

  ```
  GET /api/mess/daily-meals/changes?messId=1&yearMonth=2026-09&cursor=<last cursor>
  ```

  It returns up to 500 changes per call, plus the next `cursor`.

### Push notifications

- Devices register their Expo push token with `POST /devices/push-token`. Tokens are stored in `push_tokens`.
- `lib/notificationDelivery.ts` emits the socket event first, then sends an Expo push in batches of 100.
- Tokens that Expo reports as `DeviceNotRegistered` are deleted automatically.
- Push delivery is best-effort. A failed push never fails the API request.

---

## API reference

All routes are prefixed with **`/api`**. 🔒 means `Authorization: Bearer <token>` is required.

### Health

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/healthz` | Health check → `{ "status": "ok" }` |

### Auth

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST | `/auth/signup` | Create an account and email an OTP |
| POST | `/auth/verify-otp` | Verify the sign-up OTP and get a token |
| POST | `/auth/resend-otp` | Resend the sign-up OTP |
| POST | `/auth/login` | Email + password login |
| POST | `/auth/google` | Sign in with a Google ID token |
| POST | `/auth/forgot-password` | Email a password reset OTP |
| POST | `/auth/resend-reset-otp` | Resend the reset OTP |
| POST | `/auth/reset-password` | Set a new password with the OTP |
| POST | `/auth/account-deletion/request-otp` | Email an account deletion OTP |
| POST | `/auth/account-deletion/confirm` | Delete the account with the OTP |
| GET 🔒 | `/auth/me` | Current user, their messes and join requests |

### Mess and members

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST 🔒 | `/mess/create` · `/v2/mess/create` | Create a mess |
| POST 🔒 | `/mess/join` | Request to join with a mess key |
| POST 🔒 | `/mess/rejoin` | Re-request to join after a rejection (no mess key needed) |
| GET 🔒 | `/mess/info` | Mess details |
| GET 🔒 | `/mess/member-requests` | Pending join requests |
| POST 🔒 | `/mess/member-requests/:id/accept` · `/reject` | Accept or reject a request |
| GET 🔒 | `/mess/consumers` | List consumers |
| GET 🔒 | `/mess/consumer-user` | Look up a user by email before adding |
| POST 🔒 | `/mess/consumers` | Add a consumer |
| DELETE 🔒 | `/mess/consumers/:id` | Remove a consumer |
| POST 🔒 | `/mess/invite` | Email an invite with the mess key |

### Meals, expenses, deposits

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET 🔒 | `/mess/data/:yearMonth` | Whole month: meals, expenses, deposits |
| PUT 🔒 | `/mess/meals` | Set meals for a day |
| POST 🔒 | `/mess/daily-meals/sync` | Offline sync for daily meals |
| GET 🔒 | `/mess/daily-meals/changes` | Daily meal change feed (cursor) |
| PUT 🔒 | `/mess/expenses` | Set expense items for a day |
| POST 🔒 | `/mess/expenses/sync` | Offline sync for expenses |
| PUT 🔒 | `/mess/deposits` | Set deposits |
| POST 🔒 | `/mess/deposit-entry` | Add a deposit entry |
| GET 🔒 | `/mess/deposit-entries` | List deposit entries |
| PATCH 🔒 | `/mess/deposit-entry/:id` | Edit a deposit entry |
| DELETE 🔒 | `/mess/deposit-entry/:id` | Delete a deposit entry |
| POST 🔒 | `/mess/deposits/sync` | Offline sync for deposits |
| POST 🔒 | `/mess/send-summary` · `/mess/send-blended-summary` | Email monthly summaries |

### Meal schedule and status

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET 🔒 | `/mess/today-schedule` | Today's schedule and menu |
| PUT 🔒 | `/mess/meal-schedule` · `/v2/mess/meal-schedule` | Update meal on/off, menu and windows |
| POST 🔒 | `/mess/meal-opt-out` · `/v2/mess/meal-status/opt-out` | Toggle a meal opt-out |
| GET 🔒 | `/mess/meal-opt-outs` | List opt-outs |
| GET 🔒 | `/v2/mess/meal-status/day` | Meal status for one day |
| GET 🔒 | `/v2/mess/meal-status/calendar` | Meal status calendar |

### Bazar

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET 🔒 | `/mess/bazar` | Bazar items and assignments |
| POST 🔒 | `/mess/bazar/sync` | Offline sync for bazar |
| POST 🔒 | `/mess/bazar/items` | Add an item |
| PATCH 🔒 | `/mess/bazar/items/:id` | Edit an item |
| PATCH 🔒 | `/mess/bazar/items/:id/status` | Mark an item completed or not (`completed: boolean`) |
| DELETE 🔒 | `/mess/bazar/items/:id` · `/mess/bazar/items` | Delete one or many items |
| POST 🔒 | `/mess/bazar/items/add-to-expense` | Turn bought items into an expense |
| POST 🔒 | `/mess/bazar/assignments` · `/bulk` | Assign bazar duty |
| DELETE 🔒 | `/mess/bazar/assignments/:id` | Remove an assignment |
| POST 🔒 | `/mess/bazar/assignments/notify` | Notify assigned members |
| GET 🔒 | `/mess/bazar/assignments/unread-count` | Unread duty alerts |
| POST 🔒 | `/mess/bazar/assignments/read` | Mark duty alerts read |

### Notices and notifications

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET 🔒 | `/mess/notices` | List notices |
| POST 🔒 | `/mess/notices` | Create a notice |
| PATCH 🔒 | `/mess/notices/:id` | Edit a notice |
| DELETE 🔒 | `/mess/notices/:id` | Delete a notice |
| PATCH 🔒 | `/mess/notices/reorder` | Reorder notices |
| POST 🔒 | `/mess/notices/sync` | Offline sync for notices |
| GET 🔒 | `/mess/notices/unread-count` | Unread notice count |
| POST 🔒 | `/mess/notices/read` | Mark notices read |
| GET 🔒 | `/mess/notifications` | Bell notifications |
| POST 🔒 | `/mess/notifications/:id/read` | Mark a notification read |
| POST 🔒 | `/devices/push-token` | Register an Expo push token |

### Messages (chat)

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET 🔒 | `/mess/messages` | Paged history (`beforeId` / `afterId`) |
| POST 🔒 | `/mess/messages` | Send a message |
| POST 🔒 | `/mess/messages/sync` | Offline sync for messages |
| GET 🔒 | `/mess/messages/unread-count` | Unread message count |
| POST 🔒 | `/mess/messages/read` | Mark messages read |
| POST 🔒 | `/mess/messages/reaction` | Set or remove a reaction |

### Consumer breakdown

| Method | Path | Description |
| ------ | ---- | ----------- |
| POST 🔒 | `/mess/consumer-breakdown/notify` | Notify members about a breakdown |
| GET 🔒 | `/mess/consumer-breakdown/unread-count` | Unread breakdown alerts |
| POST 🔒 | `/mess/consumer-breakdown/read` | Mark alerts read |

### Settings

| Method | Path | Description |
| ------ | ---- | ----------- |
| PATCH 🔒 | `/settings/profile` | Update name |
| PATCH 🔒 | `/settings/profile/phone` | Update phone |
| PATCH 🔒 | `/settings/mess` | Update mess details |
| DELETE 🔒 | `/settings/mess` | Delete a mess |
| DELETE 🔒 | `/settings/account` | Delete own account |
| POST 🔒 | `/settings/security/request-otp` · `/resend-otp` | Security OTP |
| POST 🔒 | `/settings/security/change-password` | Change password |
| POST 🔒 | `/settings/security/update-email` | Change email |
| POST 🔒 | `/settings/security/add-admin` · `/v2/…` | Transfer the admin role |
| POST 🔒 | `/settings/security/add-co-admin` · `/v2/…` | Add a co-admin |
| POST 🔒 | `/settings/security/remove-self-admin` · `/v2/…` | Step down as admin |
| GET 🔒 | `/settings/security/eligible-admins` · `/v2/…` | Members who can become admin |
| GET 🔒 | `/v2/settings/security/admins` | Current admins |

> `v1` and `v2` routes run side by side so older app builds keep working. New app code should use `v2` where it exists.

---

## Database and migrations

The schema lives in [db/schema/index.ts](db/schema/index.ts). It defines 28 tables, grouped as:

- **Accounts:** `users`, `otp_verifications`, `password_resets`, `security_otps`, `account_deletion_otps`
- **Mess:** `messes`, `consumers`, `member_requests`
- **Money and meals:** `meals`, `expense_days`, `deposits`, `deposit_entries`, `meal_control`, `meal_control_helper`, `meal_opt_outs`
- **Bazar:** `bazar_items`, `bazar_assignments`, `bazar_assignment_notifications`
- **Communication:** `notices`, `notice_read_states`, `notifications`, `messages`, `message_reactions`, `message_read_states`, `consumer_breakdown_notifications`, `push_tokens`
- **Offline sync:** `sync_client_mutations`, `sync_changes`

### Two ways to change the schema

**1. New or disposable database.** Run `npm run db:push`. Drizzle compares the schema with
the database and applies the difference.

**2. Production database.** Use the scripts in [scripts/](scripts/). Run them **once** in the
Neon SQL editor, or with the matching `npm run db:migrate:*` command.

Most scripts use `IF NOT EXISTS` and are safe to re-run. **Read these before running them:**

| Script | Warning |
| ------ | ------- |
| `add-bazar-item-name-uniqueness.sql` | **Deletes** duplicate bazar items (same mess, date and name) and keeps the oldest. |
| `migrate-bazar-items-to-dates.sql` | Converts weekday-based items to dated items and **drops** the `weekday` column. |
| `migrate-meal-control-helper-remove-date.sql` | **Deletes** duplicate helper rows and drops the date dimension. |
| `add-message-support.sql` | Contains a `DROP` statement. |

> ⚠️ Do not run `db:push` against production without reading the diff. The production
> database has at least one constraint whose name differs from the schema:
> `meal_control_daily_new_mess_date_uq` in the database versus `meal_control_mess_date_uq`
> in the schema. Drizzle will try to rename or recreate it.

### Rules for a schema change

1. Edit `db/schema/index.ts`.
2. Add a script to `scripts/` that is safe to re-run where possible (`IF NOT EXISTS`, wrapped in `BEGIN/COMMIT`).
3. Give every new column a default, so the currently deployed build keeps working.
4. Run the script on production **before** deploying code that depends on it.

---

## Build and deploy (cPanel)

esbuild bundles the whole app into one file, `dist/index.mjs`. Only `pino`, `pino-pretty`
and `thread-stream` stay external, so the server still needs an `npm install`.

### 1. Build and package locally

```bash
cd backend
npm run typecheck
npm run build
bsdtar -a -cf backend-deploy.zip dist cpanel-start.mjs package.json package-lock.json
# or, if zip is installed:
# zip -r backend-deploy.zip dist cpanel-start.mjs package.json package-lock.json
```

The zip contains only these files. Do **not** include `node_modules`, `.env` or source files.

```
dist/index.mjs
dist/index.mjs.map
cpanel-start.mjs
package.json
package-lock.json
```

### 2. Upload to cPanel

1. **Setup Node.js App** → open the app → **STOP APP**.
2. **File Manager** → the app root → delete `dist`, `package.json` and `package-lock.json`.
   - Keep `node_modules` (a cPanel symlink), `tmp`, `.env`/`.htaccess` if present, and `stderr.log`.
3. **Upload** `backend-deploy.zip` → select it → **Extract** into the same folder.

### 3. Configure and start

1. In **Setup Node.js App**, check these settings:
   - Node.js version **20+**
   - Mode **Production**
   - Startup file **`cpanel-start.mjs`**
2. Check that every [environment variable](#environment-variables) is set, then click **SAVE**.
3. Click **Run NPM Install**. If it fails, open the cPanel Terminal, activate the app
   environment with the `source …/activate` command shown at the top of the app page,
   then run `npm ci --omit=dev`.
4. Click **START APP** (or **RESTART**).
5. Open `https://<your-domain>/api/healthz`. It should return `{"status":"ok"}`.

### Rolling back

Stop the app, delete the new `dist`, `package.json` and `package-lock.json`, extract the
previous release zip, run NPM Install, then start the app again.

> After moving the API to a new domain, update `EXPO_PUBLIC_API_URL` in `mobile/.env` and rebuild the app.

---

## Troubleshooting

| Symptom / log message | Fix |
| --------------------- | --- |
| `SESSION_SECRET environment variable is required` | Set `SESSION_SECRET`. |
| `SESSION_SECRET must be at least 32 characters` | Use a longer secret. Changing it logs everyone out. |
| `DATABASE_URL must be set` | Set `DATABASE_URL`. |
| `PORT environment variable is required` | Set `PORT`. |
| `Cannot find package 'pino'` | Dependencies are missing. Run NPM Install / `npm ci --omit=dev`. |
| `SyntaxError` / `Unexpected token` on start | The Node.js version is too old. Use 20+. |
| `RESEND_API_KEY is not configured` | Email features need `RESEND_API_KEY`. |
| Emails not delivered | `RESEND_FROM_EMAIL` must use a domain verified in Resend. |
| Google login returns 503 | `GOOGLE_CLIENT_IDS` is empty. |
| Google login returns 401 | The app's client ID is not in `GOOGLE_CLIENT_IDS`. |
| Realtime events missing or `Session ID unknown` | More than one Node process is running, or the host blocks WebSockets. Run one instance. |
| Warning about `sslmode=require` being an alias for `verify-full` | Harmless. Use `sslmode=verify-full` to silence it. |
| 503 / blank page on cPanel | Read `stderr.log` in the app root. |

Unknown routes return Express's default HTML `404`, not JSON.
