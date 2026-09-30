# ARCHITECTURE

## 1. Shape of the system

```
                 ┌──────────────────────────────────────────────────────────┐
  Excel  ───────►│  src/lib/import        repeatable, idempotent migration  │
  (import only)  └───────────────────────────┬──────────────────────────────┘
                                             ▼
                 ┌──────────────────────────────────────────────────────────┐
                 │  src/db        schema.ts + index.ts                      │
                 │  PostgreSQL — the ONLY two files (plus                   │
                 │  drizzle.config.ts) that know the engine                 │
                 └───────────────────────────┬──────────────────────────────┘
                                             ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  src/lib            domain rules, no HTTP, no React, no SQL dialect      │
   │  ─────────────────────────────────────────────────────────────────────   │
   │  domain.ts     the vocabulary (completion, schedule status, RAG, roles)  │
   │  periods.ts    fiscal / calendar quarter arithmetic                      │
   │  schedule.ts   schedule status + RAG calculation                         │
   │  metrics.ts    plan vs actual, derived percentages                       │
   │  reschedule.ts the rescheduling engine (preview + apply + cascade)       │
   │  audit.ts      the audit trail                                           │
   │  rbac.ts       permissions, deliberately separate from business logic    │
   │  validation.ts Zod schemas — the gate in front of every write            │
   │  config.ts     every path and tunable, from the environment              │
   └───────────────────────────┬─────────────────────────────────────────────┘
                               ▼
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  src/lib/services   queries, dashboards, updates, export, backup,        │
   │                     gantt, reporting                                     │
   └──────────┬───────────────────────────────────────┬──────────────────────┘
              ▼                                       ▼
   ┌────────────────────────┐            ┌────────────────────────────────────┐
   │  src/app/**/page.tsx   │            │  src/app/api/**/route.ts           │
   │  React server          │            │  CRUD · bulk · reschedule ·        │
   │  components + small    │            │  dependencies · rag-override ·     │
   │  client islands        │            │  export · backup · audit · gantt · │
   │                        │            │  quality · health · reporting/*    │
   └────────────────────────┘            └───────────────┬────────────────────┘
                                                         ▼
                                          ┌────────────────────────────────────┐
                                          │  existing Node.js weekly           │
                                          │  PowerPoint automation             │
                                          │  GET /api/reporting/weekly         │
                                          └────────────────────────────────────┘
```

Pages read through the service layer directly on the server. Mutations always
go through an API route, because that is where authorization, validation and
audit are applied. There is no second write path.

## 2. Stack and why

| Choice | Reason |
|---|---|
| **Next.js 15 + React 19 (App Router)** | server components keep large registers on the server — filtering, sorting and paging happen in SQL, and the browser never receives 2,000 goal rows. One process serves both the UI and the API the PPT automation will call. |
| **TypeScript, strict** | the build fails on a type error, so a schema change cannot silently break a screen. |
| **Drizzle ORM** | TypeScript-first, generates plain SQL migrations, and has no separate query engine to download or license. `prisma` was the first choice; its engine binaries are fetched from `binaries.prisma.sh`, which the build environment's egress policy blocks, so the equivalent ORM was used instead. Drizzle also made the SQLite→PostgreSQL move a three-file change, because every query is built by the query builder rather than written as dialect SQL. |
| **PostgreSQL + `pg` (node-postgres)** | the production target, adopted directly rather than piloting on SQLite. `pg` is pure JavaScript, so `npm install` needs no C++ toolchain on any Node version — which is what ended the SQLite pilot: `better-sqlite3` has no prebuilt binary for Node 24 and wanted Visual Studio Build Tools. PostgreSQL also gives real concurrent writers, which an embedded engine cannot. |
| **Zod** | one validation boundary. `IN_PROGRESS` and `completionPercent` are unrepresentable, not merely discouraged. |
| **Recharts** | small, declarative charts; used sparingly. |
| **SheetJS (`xlsx`)** | reads the source workbooks and writes the snapshot exports. |
| **Vitest** | fast, runs the real migration as a fixture. |
| **Tailwind CSS** | dense, consistent tables and cards without a component library to fight. |

## 3. Data model

```
projects ──┬── project_phases ──┐
           ├── packages ────────┼── package_fees
           ├── goals ───────────┼── goal_revisions
           │                    ├── team_assignments
           ├── design_deliverables ─── (goal, package, phase, discipline, owner)
           ├── drawings ─────────────── (package, phase, discipline)
           └── critical_requirements

dependencies         (predecessor/successor across GOAL | DELIVERABLE | DRAWING | PACKAGE)
reschedule_history   (every date movement, with reason, scope, batch and user)
rag_overrides        (management override + the calculated value it replaced)
audit_log            (every material change)
import_runs / import_issues   (migration bookkeeping)
users / disciplines / app_settings
```

### 3.1 One record exists once

There is no `goals_q1`, no `goals_revised`, no per-leader table and no
dashboard table. A goal is `(project, phase, discipline, design lead,
description, period)` with attributes. Quarters are a **column**, revisions are
a **child table**, and per-leader views are a **filter**.

### 3.2 The three-date model

Every schedulable record carries three dates, and they mean different things:

| Column | Written by | Meaning |
|---|---|---|
| `baseline*Date` | the migration, or creation | the original commitment. **Never updated.** `updateEntity` refuses it and the reschedule engine only touches the expected column. |
| `currentExpected*Date` | rescheduling, or an explicit date change | the live forecast |
| `actual*Date` | marking an item completed | when it was actually released |

Slippage, variance, reschedule count and schedule performance are all
differences between these three. That is why the baseline is immutable: without
it none of those numbers exist.

### 3.3 Completion is binary — structurally

* the column holds only `COMPLETED` / `NOT_COMPLETED`
* `completionStatusSchema` is a two-value Zod enum on every write path
* `rejectForbiddenFields` refuses `completionPercent`, `percentComplete`,
  `progressPercent`, `forecast` and both baseline fields at the API boundary
* no percentage column exists on `drawings` or `design_deliverables` — a test
  reads `pragma table_info` and fails if one ever appears
* the UI renders completion only through one `CompletionBadge` /
  `CompletionToggle` pair, so there is nowhere for a slider to appear

Percentages live only in `metrics.ts`, computed on read.

### 3.4 Schedule status and RAG are computed, never stored

`assessSchedule()` returns one of `ON_TRACK`, `DUE_SOON`, `RESCHEDULED`,
`DELAYED`, `COMPLETED_ON_TIME`, `COMPLETED_LATE`, `NOT_SCHEDULED` from the three
dates plus today. `calculateRag()` returns a colour **and a reason string** from
record counts. Because neither is stored, neither can go stale, and a management
override keeps the calculated value beside it in `rag_overrides`.

## 4. Reads

`src/lib/services/queries.ts` is the only place list screens get data. Each
register has:

* a `select` projection with the joins the screen needs
* a condition builder driven by the shared `ListFilters` type
* an allow-listed sort map (so `?sort=` cannot inject)
* `limit`/`offset` paging and a separate `count(*)`

Indexes exist on every filtered column: project, discipline, design lead,
package, completion status, current expected date, and `(fiscalYear, quarter)`.

The one filter applied in memory is `scheduleStatus`, because it is derived
from three columns and today's date; it runs after paging, and the UI says so.
If that ever needs to page correctly at scale, it becomes a generated column.

## 5. Writes

Every mutation goes through `src/lib/services/updates.ts`:

1. the route handler validates the body with Zod and rejects forbidden fields
2. the route handler calls `assertCan(role, permission)` — authorization never
   sits inside a domain function
3. `updateEntity` loads the row, diffs the patch field by field, refuses the
   baseline column, and writes the change **and its audit rows in a single
   database transaction**
4. nothing is written when nothing changed, so the audit trail has no noise

Transactions are real and asynchronous:

```ts
await db.transaction(async (tx) => {
  await writeExpectedDate(tx, type, id, newDate);
  await tx.insert(rescheduleHistory).values({ … });
  await recordAudit({ … }, tx);           // same transaction as the change
});
```

A reschedule either lands with every date, history row and audit row, or none of
them. Write helpers take a `DbLike` (the pool-backed client *or* a transaction)
so the same function works in both contexts, and `recordAudit` takes the
transaction handle — which is what keeps a change and its audit record from ever
diverging.

One rule that matters with an async driver: **every statement inside the
callback must be awaited.** An un-awaited statement escapes the transaction and
runs on its own connection.

## 6. Authentication and authorization

`src/lib/auth.ts` exposes one interface:

```ts
interface AuthProvider { name: string; resolve(headers?: Headers): Promise<SessionUser> }
```

`dev` resolves the user from the `x-user-email` header (falling back to
`DEV_USER_EMAIL`). `entra` is registered but deliberately throws, so nobody can
half-ship SSO. To move to Microsoft Entra ID, implement `resolve()` to read the
validated token claims and map them to `SessionUser` — the rest of the
application is unaffected, because `src/lib/rbac.ts` maps roles to permissions
independently.

## 7. Integration points, kept behind interfaces

| Future integration | Where it plugs in | Status |
|---|---|---|
| Microsoft Entra ID | `AuthProvider` in `src/lib/auth.ts` | interface ready, provider stubbed |
| Weekly PowerPoint automation | `src/lib/services/reporting.ts`, exposed at `/api/reporting/weekly`, `/api/reporting/project/:id`, `/api/reporting/kpis`. Importable in-process too. | **done** |
| SharePoint / Teams / Power Automate | consume the same reporting endpoints, or add a notifier module alongside `services/` | not built (deliberately) |
| Scheduled backup | `services/backup.ts` + `scripts/backup.ts`; drive it from Task Scheduler or cron | manual + CLI today |
| Alerts (overdue, upcoming, reschedule) | the queries already exist in `dashboard.ts` under `attention` | not wired to a transport |

Nothing about those integrations is assumed by the data model, which is why they
can be added without touching it.

## 8. Performance

* server-side filtering, sorting and paging on every register
* indexes on all filter columns
* aggregate screens read narrow projections (`allGoalsForMetrics` selects 15
  columns, not the row)
* the browser receives one page of rows, never a full register
* the Gantt view is capped and paged by scope, not by loading everything

Current scale: 2,181 goals, 418 delivery items, 88 drawings, 75 projects. The
dashboard renders in well under a second. The next bottleneck at
10–100× would be the in-memory portfolio aggregation in
`buildExecutiveDashboard`; the fix is a grouped SQL query, and the function
signature would not change.

## 8a. PostgreSQL specifics worth knowing

Things that behaved differently from the SQLite pilot and are now handled
explicitly:

| Concern | How it is handled |
|---|---|
| **Case-insensitive search** | SQLite's `LIKE` ignores ASCII case; PostgreSQL's does not. Every search uses `ILIKE` (`likeAll()` in `queries.ts`, and the audit search). Using `LIKE` would have quietly turned every search box case-sensitive. |
| **`count(*)` and `sum()` return bigint** | which arrives as a *string* over the wire. Every aggregate is cast in SQL (`count(*)::int`, `coalesce(sum(x), 0)::int`) rather than relying on each call site remembering `Number()`. |
| **Date arithmetic** | the one dialect-specific expression (the deliverable quarter filter) is `extract(month from …)`; everything else is ordinary date maths in TypeScript over `timestamptz` columns. |
| **Timestamps** | every date column is `timestamp with time zone`, surfaced as a JS `Date`. A structural test fails the build if a date column is ever added without a timezone. |
| **Connection pooling** | one `pg.Pool` per process, held on `globalThis` so dev-server hot reloads reuse it. An `error` listener is attached, because an unhandled idle-client error takes the process down. |
| **Pools keep processes alive** | every CLI script and the test bootstrap end with `closeDb()` in a `finally`. Without it `npm run migrate:excel` would hang after printing its summary. |
| **`db:reset` bookkeeping** | Drizzle records applied migrations in its own `drizzle` schema. Dropping only `public` leaves it claiming migration 0000 is applied, so the next setup silently skips it and leaves an empty database. `resetSchema()` drops both. |
| **Destructive commands** | `db:reset` and `restore` refuse a non-local host without `--force`. |
| **Backup** | `pg_dump -Fc` / `pg_restore --clean --single-transaction`, with an up-front check that the tools are reachable so the UI can say so instead of failing on click. |

## 9. Testing strategy

* **unit** — periods, schedule status, RAG, metrics, validation. No database.
* **integration** — a throwaway **separate database** (`<database>_test`) built
  from the real workbooks by `tests/global-setup.ts`, whose schema is dropped on
  every run. The suite refuses to start if that resolves to the working
  database. The migration is therefore itself under test: totals,
  idempotency, duplicate prevention, the binary-completion invariant, CRUD,
  bulk updates, rescheduling with cascades and lag, dashboards, reporting,
  export, backup.
* **structural** — tests read `information_schema` and `pg_indexes` to assert
  that no percentage-shaped column exists on any delivery table, that
  completion is a two-value text column rather than a database enum, that every
  date column is `timestamptz`, and that every filtered column is indexed. A
  further test walks `src/` and fails if a project name or code is ever compared
  to a literal in business logic.
* **end-to-end** — `scripts/e2e-check.ts` drives the running application over
  HTTP through the 19 required steps and restores what it touched.

## 10. Deliberate non-goals

* Not multi-tenant. One database serves one portfolio.
* Not a CPM engine. No float, no resource levelling, no calendars or shifts, no
  multi-baseline sets. `SCHEDULING.md` sets out exactly what the engine does.
* Not a document management system. Drawings are records with dates and
  revisions, not files. SharePoint keeps the files.
* Not a general BI tool. The dashboards answer the six management questions in
  the specification and nothing more.
* No per-item progress tracking. That is the point.
