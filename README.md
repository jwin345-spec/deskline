# deskline

[![CI](https://github.com/jwin345-spec/deskline/actions/workflows/ci.yml/badge.svg)](https://github.com/jwin345-spec/deskline/actions/workflows/ci.yml)

A multi-tenant customer-support helpdesk: a shared inbox fed by inbound email, real-time
collaboration between agents, SLA timers enforced by a background worker, and AI-drafted replies
that an agent always reviews before anything is sent.

It is built with Next.js (App Router), React, TypeScript (strict), PostgreSQL through Kysely, and
Tailwind CSS. For local development and the test suite, Postgres runs embedded through
[PGlite](https://pglite.dev) (Postgres compiled to WASM), so nothing needs Docker. A
`docker-compose.yml` runs the same app against a real PostgreSQL 17 server.

This is a portfolio project. It has no production deployment, users or customers; everything
below describes what the code does and how it is tested.

![Ticket view: conversation thread, reply composer, properties, SLA and activity log, with another agent's presence shown in the header](docs/screenshots/ticket.png)

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Multi-tenancy and security model](#multi-tenancy-and-security-model)
- [Real-time design](#real-time-design)
- [SLA worker design](#sla-worker-design)
- [AI reply suggestions](#ai-reply-suggestions)
- [Inbound email webhook](#inbound-email-webhook)
- [Testing](#testing)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [Limitations](#limitations)

## Features

| Area                     | What it does                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth**                 | Email and password with scrypt hashing (`node:crypto`), server-side sessions in an httpOnly, SameSite=Lax cookie. Only a SHA-256 of the session token is stored.                                               |
| **Workspaces and roles** | Every row belongs to a workspace. Owners, admins and agents, with all permission checks in one table ([`rbac.ts`](src/server/domain/rbac.ts)).                                                                 |
| **Inbox**                | Filters by status, priority and assignee, Postgres full-text search (with stemming) over subjects and messages, ticket-number and customer-email lookup, keyset (cursor) pagination.                           |
| **Ticket view**          | Conversation thread, public replies, internal notes, status, priority and assignment, SLA targets, and an append-only audit log of every change.                                                               |
| **Inbound email**        | An HMAC-signed webhook creates tickets, idempotent by message id, and threads replies onto existing tickets via `In-Reply-To`/`References` or a `[#123]` subject token.                                        |
| **Real-time**            | Server-Sent Events push ticket changes to every agent in the workspace; pages re-render in place and announce changes through an `aria-live` region. Presence shows who is viewing a ticket.                   |
| **SLA timers**           | First-response and resolution targets per priority. A DB-backed job queue, claimed with `FOR UPDATE SKIP LOCKED`, flags breaches and records them.                                                             |
| **AI replies**           | "Suggest reply" drafts a response with Claude through the official `@anthropic-ai/sdk`. The draft lands in the editor; it is never sent automatically. Without an API key the button is disabled and says why. |
| **Dashboard**            | Ticket counts by status and priority, SLA breaches and median first-response time, computed in SQL from the live tables.                                                                                       |

| Inbox                                                                            | Dashboard                                                                                                        |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ![Inbox with filters, SLA badges and live indicator](docs/screenshots/inbox.png) | ![Dashboard with stat tiles, status and priority breakdowns and recent breaches](docs/screenshots/dashboard.png) |

| Team and roles                                               | Sign in                                     | Mobile                                                              |
| ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------- |
| ![Team page with role management](docs/screenshots/team.png) | ![Sign-in page](docs/screenshots/login.png) | ![Inbox on a phone-sized screen](docs/screenshots/inbox-mobile.png) |

The screenshots are captured from the running app by
[`e2e/screenshots/screenshots.spec.ts`](e2e/screenshots/screenshots.spec.ts) (`npm run screenshots`).

## Quick start

Requires Node.js 22.12 or later.

### Embedded Postgres (no Docker)

```bash
npm install
cp .env.example .env     # optional; the defaults work
npm run db:seed          # migrates and loads the demo workspaces into ./.data/deskline
npm run dev              # http://localhost:3000
```

`DATABASE_URL=pglite:./.data/deskline` (the default) keeps an embedded Postgres in `./.data`.
`npm run db:reset` wipes it and seeds again.

Send a signed inbound email to the running app and watch it appear in the inbox live:

```bash
npm run inbound:send -- --subject "Order #4417 has not arrived" --text "Tracking has not updated since Monday."
```

### PostgreSQL with Docker

```bash
docker compose up --build    # postgres:17, a one-shot seed job, then the app on :3000
```

Or point the dev server at the compose database: `docker compose up -d postgres`, set
`DATABASE_URL=postgres://deskline:deskline@localhost:5432/deskline`, then `npm run db:migrate`,
`npm run db:seed` and `npm run dev`.

### Demo accounts

All demo users share the password `deskline-demo`.

| Email               | Role  | Workspace        |
| ------------------- | ----- | ---------------- |
| `maya@acme.test`    | Owner | Acme Support     |
| `sam@acme.test`     | Admin | Acme Support     |
| `alex@acme.test`    | Agent | Acme Support     |
| `jordan@acme.test`  | Agent | Acme Support     |
| `grace@globex.test` | Owner | Globex Help Desk |

Sign in as Alex and as Sam in two browsers (or one normal and one private window) to see presence
and live updates. Grace belongs to a different workspace and cannot see any Acme data.

The seed goes through the real services (inbound email, replies, notes, assignment) with a
backdated clock, then runs the SLA worker once, so breaches, audit entries and response times in
the demo are produced by the same code paths as in normal use.

### Enabling AI suggestions

Set `ANTHROPIC_API_KEY` in `.env` (or in the environment for Docker) and restart. Nothing else
changes; without the key the feature is off and the rest of the app works the same.

### Scripts

| Script                                        | Purpose                                                             |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `npm run dev` / `build` / `start`             | Next.js dev server, production build, production server             |
| `npm run db:migrate`                          | Apply pending SQL migrations                                        |
| `npm run db:seed` / `db:reset`                | Load demo data / wipe and reload it                                 |
| `npm run inbound:send`                        | Post a signed inbound email to the webhook                          |
| `npm run lint` / `format:check` / `typecheck` | ESLint, Prettier, `tsc --noEmit`                                    |
| `npm test`                                    | Vitest unit and integration tests (PGlite, or `TEST_DATABASE_URL`)  |
| `npm run test:e2e`                            | Playwright against the production build (run `npm run build` first) |
| `npm run screenshots`                         | Regenerate `docs/screenshots`                                       |

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[React UI<br/>server + client components]
    ES[EventSource]
  end
  subgraph Next.js server - one Node process
    RSC[Pages / RSC]
    SA[Server Actions]
    RH[Route handlers<br/>SSE, webhook, AI, health]
    SVC[Services<br/>tickets, inbound email,<br/>SLA, dashboard, AI]
    DAL[Data access<br/>withTenant + repositories]
    BUS[Realtime broker<br/>+ presence registry]
    W[SLA job worker]
  end
  PG[(PostgreSQL / PGlite<br/>RLS policies)]
  MAIL[Email provider] -- HMAC-signed POST --> RH
  CLAUDE[Claude API]

  UI --> RSC
  UI --> SA
  ES <-- text/event-stream --> RH
  RSC --> SVC
  SA --> SVC
  RH --> SVC
  SVC --> DAL --> PG
  SVC -- after commit --> BUS --> RH
  W -- SKIP LOCKED --> PG
  W --> BUS
  SVC --> CLAUDE
```

```
src/
  app/                    Next.js routes
    (app)/                signed-in area: inbox, tickets/[id], dashboard, team, settings
    api/events            SSE stream (live updates + presence)
    api/webhooks/...      inbound email webhook
    api/tickets/[id]/...  AI reply suggestion
    login/                sign-in page and auth actions
  components/             UI building blocks (badges, live updates, navigation)
  server/
    domain/               pure rules: types, RBAC table, SLA maths, errors
    db/                   Kysely setup, PGlite dialect, migrator, withTenant()
    repositories/         tenant-scoped queries
    services/             use cases: tickets, inbound email, SLA worker, AI, dashboard
    realtime/             event broker and presence
    auth/                 passwords, sessions, request helpers
migrations/               forward-only SQL migrations (schema, RLS policies, grants)
test/                     Vitest unit and integration tests
e2e/                      Playwright tests and the screenshot script
```

Layering is strict in one direction: route handlers and server actions validate input and call
services; services enforce permissions and business rules and run inside a tenant transaction;
repositories hold the queries; `domain/` has no I/O at all. Every boundary that receives outside
data (form fields, query strings, webhook bodies, job payloads, environment variables) parses it
with Zod.

## Multi-tenancy and security model

Tenant isolation is enforced twice, by independent mechanisms.

1. **The data-access layer.** All tenant data is read and written through
   [`withTenant(db, ctx, fn)`](src/server/db/tenant.ts). It opens a transaction, switches to the
   unprivileged `deskline_app` role and sets `app.workspace_id`, both with `LOCAL` scope so they
   end with the transaction and never leak to the next user of a pooled connection.
   Repositories only accept the resulting `TenantTx` and still add explicit
   `workspace_id = $1` predicates (which also keeps the planner on the composite indexes).
2. **PostgreSQL row-level security.** Every tenant table has a policy comparing `workspace_id`
   with `app.workspace_id`, for reads and writes (`USING` and `WITH CHECK`). A query that forgets
   its `WHERE` clause, or tries to insert a row for another workspace, gets nothing or an error
   from the database itself.

The `deskline_app` role also has narrow grants: it cannot read `users.password_hash` (column-level
grant), cannot update or delete audit events, cannot touch sessions, and may only insert jobs.

System work runs as the owning role, outside RLS: resolving a session cookie, routing a webhook to
its workspace by address, and the SLA worker, which serves all workspaces and names the workspace
explicitly in every statement.

[`test/integration/tenancy.test.ts`](test/integration/tenancy.test.ts) checks this: raw
unfiltered SQL inside a tenant transaction sees only its own workspace; another workspace's ticket
id behaves as "not found" for reads, replies and status changes; cross-workspace inserts fail on
the RLS policy; cross-workspace assignees are rejected; the audit log cannot be modified; password
hashes are unreadable; and the role and workspace setting do not outlive the transaction. An E2E
test signs in as the Globex owner and gets a 404 for an Acme ticket URL.

**RBAC.** [`src/server/domain/rbac.ts`](src/server/domain/rbac.ts) is the only place roles are
mapped to permissions. Services call `authorize(actor, permission)`; the UI calls `can()` only to
decide what to show. Rules beyond the table (agents may assign tickets to themselves but not to
others; admins manage agents and admins; only owners manage owners; the last owner cannot be
demoted) are unit-tested and tested again through the services.

**Other measures.**

- Passwords: scrypt with N=2^17, r=8, p=1 and a random salt; unknown emails still cost one
  verification so response time does not reveal which accounts exist.
- Sessions: 32 random bytes in the cookie, SHA-256 in the database, 7-day expiry. Removing a
  membership revokes access on the next request because session lookup joins memberships.
- CSRF: mutations are Server Actions (Next.js checks Origin against Host) or route handlers that
  call `assertSameOrigin()`; the cookie is SameSite=Lax. The webhook authenticates by HMAC instead.
- Security headers (`X-Frame-Options: DENY`, `nosniff`, referrer and permissions policies).

## Real-time design

```mermaid
sequenceDiagram
  participant Sam as Sam (browser)
  participant SA as Server Action
  participant DB as Postgres
  participant Bus as Realtime broker
  participant SSE as /api/events
  participant Alex as Alex (browser)

  Alex->>SSE: EventSource ?view=ticket:42
  SSE->>Bus: subscribe(workspace) + presence.join
  Bus-->>Sam: presence: Alex viewing ticket 42
  Sam->>SA: reply + set status
  SA->>DB: BEGIN; insert message; update ticket; insert audit; COMMIT
  SA->>Bus: afterCommit: ticket.message
  Bus->>SSE: event
  SSE-->>Alex: data: {"type":"ticket.message",...}
  Alex->>Alex: router.refresh() + aria-live announcement
```

- **Transport: Server-Sent Events.** Traffic is server-to-client only (writes already go through
  Server Actions), SSE is plain HTTP that passes through proxies, and `EventSource` reconnects on
  its own. A 15-second comment heartbeat keeps idle connections open.
- **Events only after commit.** Services register publications with `tx.afterCommit()`, so a
  rolled-back transaction never produces an event.
- **Events carry ids, not content.** The client re-renders the server components in place
  (`router.refresh()`), so data shown after an event goes through the same tenant-scoped,
  permission-checked queries as a page load. React keeps client state, so a half-written reply
  survives a refresh.
- **Presence from connections.** Opening the stream with `?view=ticket:<id>` registers the user
  as viewing that ticket until the stream closes. There are no heartbeats or timeouts to tune: the
  open connection is the lease.
- **Accessibility.** Changes made by others are announced in an `aria-live="polite"` region, and a
  visible toast shows the same text.

The broker is in-process, which is correct for the single Node process this repository deploys.
Running several instances needs a shared bus (Postgres `LISTEN/NOTIFY` or Redis pub/sub) behind
the same `publish`/`subscribe` interface, and a shared presence store.

## SLA worker design

When a ticket is created, the service computes its first-response and resolution targets from the
workspace's policy for that priority and, in the same transaction, inserts one `sla.check` job per
target with `run_at` set to the due time. So a job exists if and only if its ticket committed.

```mermaid
stateDiagram-v2
  [*] --> queued: ticket created / priority changed
  queued --> running: claim (FOR UPDATE SKIP LOCKED), lease 60s
  running --> done: handler ok
  running --> queued: handler failed, attempts < max (backoff 5s, 10s, 20s...)
  running --> failed: attempts exhausted
  running --> running: lease expired, re-claimed by another worker
```

- **Claiming.** Each tick runs one `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`
  that marks a batch `running` with a lease. Any number of workers can poll the same table without
  blocking each other or taking the same job twice.
- **Leases.** A job whose worker died is claimable again once `locked_until` passes; the attempt
  counter increases each time.
- **Re-checking at run time.** The handler locks the ticket row and re-evaluates it. If the
  ticket's due date no longer matches the job (a priority change rescheduled it), the job is
  stale and does nothing, so old jobs never need to be cancelled. Breaches are inserted with
  `ON CONFLICT DO NOTHING` on `(ticket_id, kind)`, so a retried job cannot record a breach twice.
- **Side effects.** A breach writes an `sla.breached` audit event and pushes a real-time event to
  the workspace.

The worker runs in-process, started from Next.js
[`instrumentation.ts`](src/instrumentation.ts) when the server boots. In a larger deployment the
same `JobWorker` class would run as its own process; nothing in it depends on Next.js.

Tests ([`sla-worker.test.ts`](test/integration/sla-worker.test.ts)) cover: nothing happens before
targets are due, breaches with and without replies, priority changes making old jobs stale,
duplicate breach prevention, concurrent claiming returning disjoint sets, lease expiry, and retry
with backoff until `failed`. CI also runs them against PostgreSQL 17, where claims really race.

## AI reply suggestions

The "Suggest reply" button calls
[`POST /api/tickets/:id/suggest-reply`](src/app/api/tickets/[id]/suggest-reply/route.ts), which
calls [`suggestReply()`](src/server/services/ai-reply.ts):

- **Model and request.** The official `@anthropic-ai/sdk`, model `claude-opus-5-5`, adaptive
  thinking with `effort: "medium"`, and the API's server-side refusal fallback
  (`fallbacks: "default"`). A `refusal` stop reason is reported as "no draft", never shown as
  text; a `max_tokens` stop marks the draft as possibly truncated.
- **Human in the loop.** The draft is returned to the browser and placed in the reply editor with
  a banner saying it is AI-generated. Sending is the normal "Send reply" action. The audit log
  records that a draft was requested, and whether the reply that was sent started from one.
- **Prompt hygiene.** Customer messages are untrusted input: they are wrapped in a delimited
  `<conversation>` block with angle brackets escaped, and the system prompt tells the model never
  to follow instructions inside it. Internal notes are left out of the prompt so they cannot leak
  into a customer reply.
- **No transaction held open.** Ticket data is read in one short tenant transaction, the model is
  called with no database connection held, and the audit entry is written in a second transaction.
- **Errors.** SDK errors are mapped with `instanceof` checks on the typed exceptions
  (authentication, rate limit, bad request, connection, other API errors) to messages the UI can
  show.
- **Graceful degradation.** With no `ANTHROPIC_API_KEY`, the server never constructs a client and
  the button renders disabled with the reason next to it.

The tests use a fake SDK client and a fake drafter; no test or CI job calls the real API.

## Inbound email webhook

`POST /api/webhooks/inbound-email` stands in for an email provider's inbound-parse hook.

```http
POST /api/webhooks/inbound-email
Content-Type: application/json
X-Deskline-Timestamp: 1772442000
X-Deskline-Signature: sha256=<hex HMAC-SHA256(workspace secret, "<timestamp>.<raw body>")>

{"messageId":"<abc@mail.example>","from":{"email":"jane@example.com","name":"Jane"},
 "to":"support@acme.inbound.deskline.test","subject":"Order missing","text":"...",
 "inReplyTo":"<previous@deskline.local>","references":["<previous@deskline.local>"]}
```

1. Body size is capped at 256 KiB and the `to` address selects the workspace.
2. The signature covers the timestamp and the raw body, is compared in constant time, and the
   timestamp must be within five minutes, which bounds replay. Unknown addresses and bad
   signatures both return 401.
3. The payload is validated with Zod.
4. In one tenant transaction: return `200 {"outcome":"duplicate"}` if this message id was already
   processed; otherwise upsert the customer, find the thread, append the message, and record the
   message id in `inbound_emails` (primary key `(workspace_id, message_id)`). A concurrent
   duplicate delivery blocks on that key and then fails; the handler catches the unique violation
   and reports the winner's ticket.
5. Threading: `In-Reply-To`, then `References` newest first, are matched against stored message
   ids (agent replies get their own `Message-ID`). Failing that, a `[#123]` subject token matches,
   but only when the sender is that ticket's customer, so guessing a number cannot inject messages
   into someone else's ticket. A reply reopens a resolved ticket and wakes a pending one.

## Testing

| Suite                         | Command                                     | What it covers                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and integration (Vitest) | `npm test`                                  | 83 tests in 11 files: tenancy isolation and RLS, RBAC table and service enforcement, webhook signatures, idempotency, concurrency and threading, SLA rules and worker behaviour, full-text search, filters and keyset pagination, sessions and password hashing, AI request shape and error mapping, dashboard aggregates, realtime broker and presence |
| Same suite on PostgreSQL 17   | `TEST_DATABASE_URL=postgres://... npm test` | Each test file migrates into its own schema on a real server; runs in CI                                                                                                                                                                                                                                                                                |
| End to end (Playwright)       | `npm run build && npm run test:e2e`         | 7 tests against the production build with a freshly seeded PGlite database: login errors, login → search → open ticket → reply → note → resolve with audit trail, properties and RBAC hints, cross-workspace 404, unsigned webhook rejection, webhook idempotency, and two browser contexts seeing presence and each other's changes live               |

`npx playwright install chromium` installs the bundled browser; to use an installed Chrome or Edge
instead, set `PLAYWRIGHT_CHANNEL=chrome` (or `msedge`).

Integration tests use a real database (in-memory PGlite by default), not mocks, because the
behaviour under test lives in SQL: RLS policies, grants, triggers, `SKIP LOCKED`, `ON CONFLICT`.
Services take a clock, so SLA tests move time forward instead of waiting.

## Design decisions and trade-offs

- **Kysely and SQL migrations rather than an ORM schema.** The interesting parts of this schema
  (RLS policies, column grants, triggers, partial and GIN indexes) are SQL anyway. Plain `.sql`
  migrations keep them reviewable; Kysely gives typed queries without hiding the SQL.
- **RLS plus explicit predicates.** RLS is the backstop that does not depend on every query being
  written correctly; explicit `workspace_id` predicates keep queries readable and index-friendly.
  The cost is a `SET LOCAL ROLE` and `set_config` per transaction.
- **Search document maintained by triggers.** `tickets.search_vector` combines the subject
  (weight A) and all public message bodies (weight B), recomputed by triggers on insert. This
  keeps search a single indexed lookup at the cost of rewriting the vector on every message,
  which is fine for support threads but would need incremental updates for very long ones.
- **Keyset pagination ordered by last activity.** Stable while new tickets arrive and constant
  cost at any depth. Search results use the same order rather than relevance ranking, which keeps
  one cursor format; ranking would need a different cursor.
- **SSE plus `router.refresh()` instead of pushing data.** Simpler and safer (one read path, always
  permission-checked) at the cost of an extra round trip per update.
- **Jobs in Postgres rather than Redis.** Jobs are created in the same transaction as the ticket
  they belong to, so there is no dual-write problem, and the deployment has one stateful
  dependency.
- **PGlite for development and tests.** Real Postgres semantics (RLS, triggers, full-text search)
  with no Docker. PGlite is single-connection, so its driver serialises transactions; concurrency
  behaviour is exercised against PostgreSQL in CI.

## Limitations

- **Single process.** The realtime broker, presence registry and in-process worker assume one
  Node process. Horizontal scaling needs a shared bus and presence store (see above); the job queue
  already supports several workers.
- **Email is simulated.** Inbound mail arrives through the signed webhook (or
  `npm run inbound:send`); agent replies are stored with RFC 5322 message ids for threading but
  are not delivered to a mail server.
- **SLA clocks run 24/7.** No business hours, holidays, or pausing while a ticket is pending.
  Policies are seeded per workspace and shown in Settings but not editable in the UI.
- **No account management UI.** No sign-up, invitations, password reset or workspace switching;
  a user with several memberships lands in the oldest one. Role changes are supported.
- **No attachments, rich text, macros or customer portal.**
- **Rate limiting** of the login form and webhook is not implemented and would belong at the edge
  or in a shared store.
- **Docker image** is built and smoke-tested in CI only; it was not run on the development
  machine.

## License

[MIT](LICENSE)
