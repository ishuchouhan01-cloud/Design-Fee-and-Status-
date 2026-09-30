# Project Drawing Status — a copy of the Design Goals & Delivery Control System

An internal web application that replaces the Excel-based design-goal and
design-delivery process. After migration the **database is the single source of
truth**; Excel is only an import format and a snapshot export format.

Node.js / TypeScript throughout. No Python anywhere.

---

## Project Drawing Status (this copy)

This folder is a **separate copy** of the Design Goals & Delivery Control
System with a sign-in screen and three roles. The original application is not
changed and keeps running from its own folder.

| | Original application | Project Drawing Status (this copy) |
|---|---|---|
| Folder | `design-control` | `project-drawing-status` |
| Start | `START-DESIGN-CONTROL.bat` | `START-PROJECT-DRAWING-STATUS.bat` |
| Address | http://localhost:3000 | http://localhost:3100 (`PORT` in `.env`) |
| Database | `design_control` | `project_drawing_status` (its own; cloned from the original on the first start) |
| Sign-in | none (this computer's user) | Viewer · Admin · Super Admin (session cookie `pds_session`, `SESSION_SECRET`) |

**Running both side by side.** Start each with its own .bat file. They use
different ports, databases, `.env` files and session secrets, so they share no
data and no sign-in. Versions and rollback (`ROLLBACK.bat`, `.versions/`) are
per folder.

**First start of the copy.** `.env` holds `DATABASE_URL` (the new database),
`CLONE_FROM_DATABASE_URL` (the original database, only read), `PORT`,
`PG_BIN_DIR`, `SESSION_SECRET` (made by the launcher when missing) and the two
passwords. The launcher:

1. creates `project_drawing_status` by `pg_dump` of the original and `pg_restore`;
2. backs it up and applies migration 0009 (sign-in, Responsible Person,
   archive, package dependencies);
3. stores the Admin and Super Admin passwords from `.env` as bcrypt hashes
   (`login_accounts`). After that the two `*_PASSWORD` lines can be deleted
   from `.env`; `npm run logins:set -- --role ADMIN` sets a new one.

### Roles

| | Viewer | Admin | Super Admin |
|---|---|---|---|
| Password | none | `ADMIN_PASSWORD` | `SUPER_ADMIN_PASSWORD` |
| Existing role it acts as | Viewer | Manager, plus billing and release withdrawal | Administrator |
| Project Drawing Status | read only | yes | yes |
| Billing (columns and menu) | — | yes | yes |
| Edit Mode | — | yes | yes |
| Import (Import Centre) | — | yes | yes |
| Export to Excel / CSV | — | yes | yes |
| DFS Summary, Year / Quarter, Drawing list tabs | — | — | yes |
| Dashboard, Projects, Goals, Design Delivery, Design Goals – FY 2026–27, Drawing Control, Update Centre, Schedule / Reschedule, Audit | — | — | yes |
| Settings | Switch User | Switch User | everything + Switch User |

Every page and API route checks the role (the middleware, then the server
against the session in the database), and the existing permission checks
still apply. A Viewer gets 403 on every write, billing, import and export
endpoint and every other screen, and its responses carry no billing fields.
Passwords are checked on the server only; five wrong passwords from one
address (or twenty from anywhere) lock that sign-in for 15 minutes.
Switch User ends the session and turns Edit Mode off. Sessions last
`SESSION_HOURS` (12).

### Project Drawing Status

Full screen (the sidebar folds to icons; **Full Screen** uses the browser's
full-screen mode). The table fills the window and scrolls inside itself with a
sticky header and Name column:

`Name | Responsible Person | Package Status | Release Date | Packages Complete | Drawings Released | Total · Billed · Unbilled (Admin)`

- Projects and towers show "x complete · y pending"; Not Applicable appears
  only on discipline rows (or a package marked so) and is not in the "of"
  counts. A package without drawings is Pending.
- **Responsible Person** is stored on packages and drawings (a user when the
  name matches, else the name as given), read from a Responsible / Design lead
  / Owner column when a source workbook has one, searchable, filterable and
  exported. None of the current registers has such a column, so it shows "—"
  until set.
- **Billing**: Total = the design fee (scope), Billed = the amount billed to
  date, Unbilled = Total − Billed, summed package → discipline → tower →
  project with each package once. A pending package shows "Eligible to bill
  after completion"; a Billed amount on a pending package shows a warning.
- **Edit Mode** (Admin, Super Admin; off at every sign-in): click a cell to
  change it — Responsible Person, package code and name, drawing name,
  number, revision, discipline and release status, billing amounts (Billing
  view) — and use a row's ⋯ menu to add a tower / product, package,
  discipline or drawing, move an expected date (with a reason, through the
  reschedule engine; the baseline is kept), manage dependencies, or archive a
  row (hidden everywhere, never deleted). Every change is audited and marked
  as edited, so a later import keeps it.

## 0. Starting the application (everyday use)

Double-click:

```
START-PROJECT-DRAWING-STATUS.bat
```

That is the whole procedure. It opens a window, starts the application, waits
until the server is actually answering, and then opens your browser at
`http://localhost:3000`.

**Keep that window open while you use the application. Closing it stops the
application.**

What the launcher does and does not do:

| Does | Does not |
|---|---|
| Checks Node.js, the dependencies, the configuration and the database | Reset, delete or overwrite the database |
| Creates the database tables on a first run, and applies a schema update if one is genuinely pending | Re-import the Excel workbooks (that stays an administrator command) |
| Builds the application the first time, and again only if the source has changed since the last build | Rebuild on every start |
| Builds into its own folder (`.next-prod`), so `npm run dev` can run at the same time | Share a build folder with `next dev` |
| Repairs a damaged or half-finished build automatically, once | Show you a webpack stack trace |
| Detects that the application is already running and just opens the browser | Start a second copy |
| Falls back to the next free port if 3000 is taken | Install dependencies silently — it asks first |

If something is wrong it stops with a plain-language message naming the fix
(PostgreSQL not running, wrong password, database missing, dependencies not
installed) and keeps the window open so the message can be read.

The launcher is `scripts/launcher.mjs`; `START-PROJECT-DRAWING-STATUS.bat` only finds
Node.js and runs it. Neither file contains a path specific to one computer, so
the folder can be moved or copied to another machine.

**Why there are two build folders.** `next dev` and `next build` cannot share
one: starting the dev server deletes the production `BUILD_ID` and rewrites the
compiled server output, which leaves the production server loading chunks that
no longer exist — `Cannot find module './372.js'`. So the launcher builds and
serves from `.next-prod` (via `NEXT_DIST_DIR`, read by `next.config.mjs`) and
`npm run dev` keeps `.next`. If you ever see that error from a dev server,
delete `.next` and start it again; the launcher is unaffected.

To put it on someone's Desktop, create a **shortcut** to the .bat — do not copy
the file out of the project folder.

---

## 0a. Versions and rolling back

Every version of the application that reaches this computer is kept, and any
earlier one can be put back.

* **Automatic.** Each time `START-PROJECT-DRAWING-STATUS.bat` finds changed
  application files, it saves them as a new version (in the `.versions`
  folder). When the application then starts, that version is marked *worked*.
  Before it applies database updates it takes a database backup
  (`backups/…-before-update.dump`) and records it with the version.
* **A failed update never leaves you without the application.** The last
  working build is kept aside while a new version is prepared. If preparing
  fails, it is put back and started, and the window says so.
* **Going back.** Close the application window and double-click
  **`ROLLBACK.bat`**. It lists the versions (newest first, with *worked* /
  *failed to prepare*), suggests the last one that worked, and asks whether to
  restore the database backup too. The version on disk before the rollback is
  saved first, so a rollback can itself be undone. Then start the application
  again.
* From a terminal: `npm run versions` (list), `npm run versions:save -- "note"`,
  `npm run rollback`, or `node scripts/versions.mjs rollback <version> --with-database`.
* No extra software is needed; git is not required on this computer. Not kept
  in versions: `.env` (passwords), `node_modules`, build output, backups and
  import reports. The folder is also a git repository (`git log`), with one
  commit per delivered update, for IT and developers.

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 20 or newer | `node --version`. Tested on 22 LTS and 24. |
| npm 10+ | ships with Node |
| **PostgreSQL 14 or newer** | local for development, a server instance for production |
| PostgreSQL client tools (`pg_dump`, `pg_restore`) | installed with the server. Needed for backup/restore only. On Windows they are not on PATH — set `PG_BIN_DIR` (see below). |
| Windows 11, Windows Server, Linux, or a container | nothing OS-specific in the code |

No native compilation, no C++ build tools, and no Python. The database driver
(`pg`) is pure JavaScript, so `npm install` works on any Node version without a
toolchain.

---

## 2. Installation

```bash
# from the project folder
npm install
copy .env.example .env        # Windows
# cp .env.example .env        # macOS / Linux
```

Edit `.env` and set `DATABASE_URL` to your PostgreSQL connection string:

```
DATABASE_URL="postgresql://postgres:YOUR_PASSWORD@localhost:5432/design_control"
```

Then create the schema:

```bash
npm run db:setup
```

`db:setup` creates the database if it does not exist, applies the migrations and
seeds the reference data. It is safe to re-run.

---

## 3. Environment variables

Every path and setting comes from `.env`. **No user-specific path appears
anywhere in the source.**

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string. The application refuses to start without it, and rejects a non-PostgreSQL URL with a clear message. |
| `TEST_DATABASE_URL` | `<database>_test` on the same server | the database `npm test` uses. Its schema is dropped on every run, so it must never be the working database — the suite refuses if they match. |
| `DB_POOL_MAX` | `10` | connections per application process |
| `DB_SSL` | `false` | set `true` for a managed PostgreSQL service that requires TLS |
| `PG_BIN_DIR` | *(empty)* | folder holding `pg_dump`/`pg_restore` when they are not on PATH, e.g. `C:\Program Files\PostgreSQL\17\bin` |
| `PORT` | `3000` | HTTP port |
| `APP_BASE_URL` | `http://localhost:3000` | used by the E2E check and for absolute links |
| `EXCEL_GOALS_WORKBOOK` | `./import/Design Goals FY26-27 trial.xlsx` | the portfolio goals workbook |
| `EXCEL_PROJECT_PLAN_WORKBOOKS` | `./import/0118_Violet Hill_ 03YPlan…xlsx` | one or more project plan workbooks, separated by `;` |
| `IMPORT_DIR` | `./import` | folder scanned when no explicit workbook is given |
| `IMPORT_DERIVE_PACKAGE_LINKS` | `true` | derive Finish-to-Start links from the numbered batch sequence |
| `PLAN_START_DATE` | parsed from the plan workbook file name | start date used to chain packages that contain no dated drawings |
| `BACKUP_DIR` | `./backups` | backup destination — **must not be a OneDrive/SharePoint synced folder** |
| `BACKUP_RETENTION` | `20` | how many backups to keep |
| `FISCAL_YEAR_START_MONTH` | `4` | April → Indian FY. Set to `1` for calendar-year fiscal reporting |
| `APP_TIME_ZONE` | `Asia/Kolkata` | Time zone of the edit date and time shown as "Updated On" |
| `DUE_SOON_DAYS` | `14` | horizon for the "Due soon" schedule status |
| `SESSION_SECRET` | made by the launcher | signs the sign-in cookies (32+ characters); keep private |
| `SESSION_HOURS` | `12` | how long a sign-in lasts |
| `ADMIN_PASSWORD` / `SUPER_ADMIN_PASSWORD` | — | read once and stored as bcrypt hashes; can then be removed |
| `CLONE_FROM_DATABASE_URL` | — | first start only: the original database to copy into `DATABASE_URL` |
| `AUTH_PROXY_HEADER` | `x-ms-client-principal-name` | `proxy` only: the request header that carries the signed-in user's e-mail, set by the proxy |
| `AUTH_ADMIN_EMAILS` | *(empty)* | `proxy` only: e-mails (`;`-separated) that are Administrators on first sign-in; everyone else starts as Viewer |
| `LOCAL_USER_EMAIL` | `DEV_USER_EMAIL` | `local` only: the one user of this computer (an Administrator) |
| `DEV_USER_EMAIL` | `admin@company.local` | the default user in `dev` mode, and in `local` mode when `LOCAL_USER_EMAIL` is not set |
| `IMPORT_UPLOAD_DIR` | the system temp folder | where Import uploads are kept between the dry run and the import |

---

## 4. Database setup

```bash
npm run db:setup             # create the database if needed, migrate, seed (idempotent)
npm run db:reset             # drop the schema first, then do the above
npm run db:reset -- --force  # same, against a non-local database
```

`db:reset` is destructive: it drops and recreates both the `public` schema and
Drizzle's `drizzle` migration-bookkeeping schema. It refuses to run against a
non-local host unless you add `--force`, so a production database cannot be
wiped by a stale `.env`.

Migrations are plain SQL files in `drizzle/`, generated from
`src/db/schema.ts`. After changing the schema:

```bash
npm run db:generate    # writes a new migration
npm run db:setup       # applies it
npm run db:studio      # optional: browse the data with Drizzle Studio
```

---

## 5. Migrating the Excel workbooks

Put the workbooks in `./import` (or point `.env` at them) and run:

```bash
npm run migrate:excel
```

Options:

```bash
npm run migrate:excel -- --goals "C:\path\Design Goals FY26-27.xlsx" \
                         --plan  "C:\path\0118 Violet Hill 03YPlan.xlsx"
npm run migrate:excel -- --dir "C:\path\to\folder"     # every .xlsx in a folder
```

The migration is **repeatable and idempotent**: every record is matched on a
natural key, so a second run updates instead of duplicating. It prints a
summary, writes a full JSON log to `import-reports/`, and stores every warning
in the database (visible on **Settings → Import history**).

Sheets that are per-design-lead copies or pivots are deliberately *not*
imported — the application reproduces them as filters and calculated
aggregates. See `DATA-MAPPING.md` for the sheet-by-sheet decisions.

To inspect a workbook without importing anything:

```bash
npm run inspect:excel -- "C:\path\to\workbook.xlsx"
```

> The import makes a database round-trip per record, so on PostgreSQL it takes
> roughly 15 seconds against a local server (it was ~6 seconds on the embedded
> SQLite pilot). It is a one-off, and the application itself is unaffected.

---

## 5b. Design Goals FY 26

A separate module with its own importer, its own tables and its own page. It
does not touch Projects, Goals, Design Delivery or Drawings.

Put the FY26 workbooks in `./data/fy26` (or set `FY26_SOURCE_DIR`), then:

```bash
npm run fy26:import                       # preview — reads everything, writes nothing
npm run fy26:import -- --apply            # write the hierarchy
npm run fy26:import -- --dir "C:\path\to\FY26 folder"
```

Both forms print a validation table and refuse to call a run successful when the
totals differ:

```
| Metric        | Expected | Actual   | Difference | Status |
| projects      |       27 |       27 |          0 | PASS   |
| phases        |       22 |       22 |          0 | PASS   |
| packages      |      435 |      435 |          0 | PASS   |
| dependencies  |      334 |      334 |          0 | PASS   |
| planBillingCr | 163.4425 | 163.4425 |          0 | PASS   |
```

Open it at **Design Goals FY 26** in the sidebar, or `/fy26`.

### What the importer does and does not take

The 17 workbooks hold 430 sheets, of which 41 are visible and 18 are read. The
rest are hidden FY25/Q1/Q2 archives, per-design-lead copies and pivots.

* **Dependencies are not identified by `Step N`.** 65 genuine dependency rows
  carry nothing in column B — only a description, date, owner and remark. They
  are imported and shown as “no step”.
* **A date alone does not make a row real.** The Excel template block ships with
  plausible dates already filled in (`Task description 1 | 2026-10-15 |
  User 1`), so 533 template rows are skipped. A row is real when it has a real
  description, a real owner, or a remark.
* **Project and phase identity comes from an explicit table**, not from banner
  nesting in the sheet. Nesting would make `Blue in Green` a phase of `OtF` and
  `TR Mills Chamarajpet` a phase of `KIADB - Mys`; both are separate projects. A
  column-B label that is not in `fy26_scope_map` is rejected to the issue log,
  never guessed.
* **There is no billing date anywhere** — no column, no field, no UI, and it is
  never derived from the release date. The source has billing *amounts*
  (`Plan - Billing [Cr.]`, `Actuals - Billing [Cr.]`) and one release date.
* Two package rows whose billing and team values sit below their package are
  merged upward, and the one case where the orphan row contradicts its parent's
  phase is logged rather than applied.
* The stale duplicate sheet in the “New projects” workbook is skipped, and the
  two `Pkgs Summary (Status)` sheets in the SftH workbook — whose titles name
  SftW — are excluded as a source ambiguity rather than attributed by guesswork.

Every exclusion is recorded with its workbook, sheet and row in
`fy26_import_issues`, readable at `/api/fy26/import`.

### How it relates to the existing Projects

FY26 reads the hierarchy as `ITQE → Ph1`, while the older model has `ITQE-Ph1`
as a project in its own right. Rather than rename production records — six
tables reference `projects.id` — the FY26 tables carry a nullable
`legacy_project_id` and link to them:

```
projects (unchanged)
   ▲                      ▲
   │ legacy_project_id    │ legacy_project_id
fy26_projects ──< fy26_phases ──< fy26_packages ──< fy26_package_dependencies
```

So `OTR` links to `TEHPL-OTR`, and its phases `PH01`/`PH02`/`MUSEUM` link to the
legacy `OTR-PH01`/`OTR-PH02`/`OTR-MUSEUM` records, which keep working exactly as
before. `SftH` is a new project with no legacy counterpart.

### Re-importing over edited data

Every field edited in the application is recorded in `user_edited_fields`, and
the importer skips those fields on the next run, logging each one as
`FIELD_PROTECTED_USER_EDIT`. Dependencies added through **+ Add dependency** are
never removed by an import. Baseline release dates are written once, on first
import, and are rejected by the API thereafter.

To discard the module's data and re-import from scratch:

```bash
npm run fy26:import -- --apply --rebuild --yes
```

That clears only the four FY26 hierarchy tables. It does not touch `projects`,
`goals`, `design_deliverables` or anything else — but it does discard FY26 edits
and manually added dependencies, which is why it insists on `--yes`.

---

## 5c. Design Fee Schedule (DFS) & Drawing Control

Two modules over the one `drawings` table:

* **Design Fee Schedule (DFS)** — `/drawings` (also `/dfs`) and `/drawings/<id>`,
  for every role with `drawing.read`. Tabs:
  * **Design Fee Schedule (DFS)** — one table:
    *Project → [child project: Tower / Product] → [Phase] → Tower / Product /
    Block / Villa / Group → Package → Discipline → Drawings.* Columns: **Name ·
    Package Status · Release Date · Packages Complete · Drawings Released.**
    Project and heading rows read "8 complete · 76 pending" and "x of y"; a
    package or discipline row shows Complete / Pending (with "no drawings yet"
    where it has none) and the date its last drawing was released. A discipline
    row opens into a compact drawing list (Drawing Name, Drawing Number,
    Revision, Discipline, Updated On, Status), 50 at a time. Rows load when they
    are opened; **Expand to Packages** opens everything down to packages;
    **Export to Excel / CSV** exports the filtered view with the hierarchy in
    columns. Filters: Search (drawing number, drawing name, package or
    project), Project (top-level projects only), Discipline, Package Status,
    Drawing Release, Schedule Status.
  * **DFS Summary** — packages (*Packages · Complete · Pending · Overall*) and
    billing (*Total · Billed · Unbilled*, ₹ Cr) per project, its towers /
    products, and discipline.
  * **Year / Quarter** — packages planned / complete and billing per quarter,
    Calendar Year or Financial Year (April–March).
  * **Drawing list** — every drawing in one searchable list with the drawing
    figures.
* **Drawing Control** — `/drawing-control`, for `drawing.write`: add, edit,
  release, revisions, dependencies, reschedule (through the reschedule engine),
  history, the two-week look-ahead; conflicts and deletion for `drawing.admin`.
  Every change shows in the DFS on the next load — nothing is cached.

Rules:

* **Hierarchy** — the Project List (full names, parent project) and each
  project's base DFS, its Design Fee sheet (`dfs_wbs_nodes`,
  `packages.wbs_node_id`). A level with no record is not shown. A project with
  no package definition shows Discipline → Drawings directly under it.
  Drawings that no package holds are shown under *Drawings not assigned to a
  package*, which is never counted as a package.
* **Package status** is binary and comes only from the drawings: **Complete**
  when the package has at least one drawing and every one is released,
  otherwise **Pending** ("no drawings yet" when it has none). **Not
  Applicable** only when set explicitly (every fee line of the package NA and
  no drawings). A discipline row follows the same rule over its own drawings.
* **Counting** — *Packages Complete* counts package records only (never
  towers, disciplines or drawings), each once, under exactly one parent; every
  parent row is the sum of its children. The DFS Summary's discipline rows
  count package × discipline lines, the unit billing is made of.
* **Disciplines** are grouped by `disciplines.dfs_group`: Master Planning and
  Urban Design count under Architecture; Public Health Engineering,
  Electrical and Integrated Building Management System under Mechanical,
  Electrical & Plumbing.
* **Billing**: *Total* = the design fee of the line (`package_fees.fee_value`);
  *Billed* = Total of lines whose discipline status is Complete; *Unbilled* =
  Total − Billed. Billing follows completion and never writes to the fee rows.
* **Release dates** — a released drawing without a date shows "—"; its
  evidence ("Issued before 01-Jan-2026") is shown in the drawing detail and the
  data-quality page, and Year / Quarter keeps it in its own *Before* column. No
  date is made up.
* **Filters** are applied on the server, keep the rows above what they find,
  and change what is counted — never how a package is judged.
* All counting is done in SQL, grouped by project, package and discipline.

### Importing the PoaRR drawing registers

The sources and every project-specific rule live in a manifest,
`data/drawing-sources/poarr.json`; the nine workbooks sit in
`data/drawing-sources/poarr/`. Take a backup first, then:

```bash
npm run backup
npm run drawings:import                  # preview — writes no drawing data
npm run drawings:import -- --apply       # one transaction; refused unless every target matches
```

(or Drawing Control → Import, as an Admin). The import validates against the
manifest targets and re-counts inside the transaction:

```
Project        Drawings  Released  NotRel  NotYetNo  Conflicts  ACC-only  ActualDates
POARR-RES         11403     11235     168       813         41         0            0
POARR-T08          1524      1149     375       549         66         0            0
POARR-T09          1499      1404      95         0          5         5         1404
TOTAL             14426     13788     638      1362        112         5         1404
Historical snapshot rows: 18517
```

Rules it applies:

* One drawing per **project + drawing number**. A re-issue in another batch is
  the same drawing; every listing is kept in `drawing_snapshots`.
* Planned drawings without a number are imported as **Not yet numbered**. When a
  number is assigned (by a user or later by the source) the same record is
  updated — never duplicated.
* Same number with different titles, and ACC numbers missing from the register,
  are **held back** in `drawing_conflicts` for an Admin to resolve. Nothing is
  merged silently.
* Released drawings whose source gives no date are RELEASED with **no actual
  date** and a `release_evidence` text such as “Issued before 01-Jan-2026”.
  Dates are never invented; “Released this week / month” counts real dates only.
* T09 release status and actual dates come from the ACC export's *Date of
  Release*, never from *Created at* (a bulk-upload time).
* Phase comes only from the explicit location → phase map in the manifest;
  a location that cannot be mapped gets no phase and an
  `UNMAPPED_DRAWING_LOCATION` issue.
* A field a user edited is never overwritten by a re-import
  (`FIELD_PROTECTED_USER_EDIT`), a baseline is set once, released drawings are
  never moved, and revisions are only ever added.
* `Design Deliverables PoaRR.xlsx` is not imported (work items, not drawings).
* **Base DFS** (hierarchy, packages, billing scope) comes from the *Design Fee*
  sheets named in the manifest (`designFees`). Reading down the sheet, a stack
  follows the source outline: each heading ("GFC | Tower—01",
  "GFC | Individual Homes", "2.4 GFC | Independent Subgrade Structure—Block 04")
  becomes a WBS node under its parent (outline "2.4" nests under "9"; a
  "Phase …" heading, where a DFS has one, sits above them), and each coded row
  (`T01-01`, `BB01-1`, `V40-01`) becomes a package under the heading it sits
  beneath, with its AR / ST / MEP / LS fee. Node types come from rules
  (`dfsHierarchy.nodeTypes`, then Tower / Block / Villa / Product / Phase words,
  else Group); the stage prefix in `dfsHierarchy.labelPrefix` is dropped from
  names and the source label kept. Headings that hold no package (design
  concepts, post-construction) are not nodes. A repeated code is reported
  (`DUPLICATE_PACKAGE_CODE`) and not imported.
* **Drawing → package**: the manifest's explicit batch rule (`AR-BB01-1` →
  `BB01-1`); only when the batch names no DFS package, the drawing-list heading
  the drawing sits under, if it names exactly one package by code or location
  token (logged `BATCH_RESOLVED_BY_DFS_HEADING`). A batch marked `-NA`, a heading
  naming several packages (`DRAWING_PACKAGE_AMBIGUOUS`) or no match
  (`BATCH_WITHOUT_FEE_PACKAGE`) leaves the drawing *not mapped* — nothing is
  guessed. A package or NA set by a user is never overwritten by a re-import,
  and a re-import updates the same WBS rows (keyed on the source path).

Every expected-date change — the Reschedule dialog, an edit, a bulk update or a
changed source plan — goes through the reschedule engine and leaves a
`reschedule_history` row and a `RESCHEDULE_DRAWING` audit entry.

---

### Import (upload a workbook)

**Import** in the menu — Administrators and Managers only (hidden from other
roles; the API refuses them). One screen for every workbook type:

| File type | What it brings in |
|---|---|
| Base DFS / Design Fee sheet | headings and packages (the DFS hierarchy) and their design fees; existing drawings are re-linked to packages by batch code |
| Drawing register / 03-Year Plan | drawings (numbered and not yet numbered), revisions, release status and dates, plan history, and the workbook's Design Fee sheet |
| Autodesk Construction Cloud release export | release dates for drawings already in the project, matched by drawing number |
| Project List | full display names and the parent → child project hierarchy |

1. Upload an **.xlsx** (up to 40 MB). Macro-enabled or macro-carrying
   workbooks are refused.
2. The file type is recognised from the sheets (it can be changed). Choose the
   project, or create one (full name, optional short code, optional parent).
3. Check the column mapping for each sheet, with sample rows; correct any
   column. The mapping used is remembered for that project and file type.
4. **Run a dry run** — counts to create / update / unchanged, conflicts,
   ambiguous and skipped rows, and every row that needs a person (workbook,
   sheet, row, value, reason). Nothing is written.
5. Tick the confirmation and **Import**. Everything is written in one
   transaction and audited.
6. **Import history** lists every run (who, when, file, counts, status).
   **Undo this import** on the latest run removes what it created and puts back
   the values it changed — except anything edited since, which is kept and
   listed.

Imports never overwrite a manual edit, a rescheduled date or a baseline, never
make up a date or a number, and running the same file twice changes nothing.
Blank templates for each type are on the same screen.

From the command line (the same code):

```bash
npm run projects:import                 # dry run of data/project-sources/project-list.xlsx
npm run projects:import -- --apply
npm run drawings:import -- --manifest data/drawing-sources/violet-hill.json --apply
```

### Project heading, "Updated On" and formula text

- **Projects and towers.** A drawing manifest lists the projects its source
  implies (`"projects"`: a group project such as *Pursuit of a Radical
  Rhapsody* and the display name and parent of each register's project). The
  drawing import creates the group when it is missing and fills only empty
  names and parents — a Project List import always wins. Any number of
  levels and children. The DFS top rows are the real projects; choosing a
  project includes the towers / products below it, and filtering to a tower
  keeps its project as the heading.
- **Updated On** (DFS drawing list, Drawing list, drawing page, exports):
  the date and time of the last change in Drawing Control; otherwise the date
  the source gives (actual issue / release date, date of receipt, Autodesk
  Construction Cloud release date, or a revision-date column); otherwise the
  period the source gives, as given ("Quarter 2, 2026", "Before
  01-Jan-2026"); otherwise "—". The time an import ran is never used. Edit
  times are shown in `APP_TIME_ZONE`. The Drawing list can sort and filter by
  it.
- **Dates on any computer.** Excel dates are read as the date typed in the
  cell, whatever the computer's time zone (India read 17-Aug-2026 as
  16-Aug-2026 before).
- **Formula text.** A formula cell gives its value; a formula typed into a
  Text cell (`=CONCATENATE(B26,"-",C26,"-",D26)`) is worked out from the cells
  it refers to; one that cannot be worked out is left empty and reported as
  *FORMULA_NOT_EVALUATED* in the dry run. Text starting with "=" is never
  stored.
- **One-time data repair.** `npm run data:repair` (run by the launcher,
  after its database backup, when pending) applies the bundled Project List
  and re-imports every manifest with the corrected readers. It keeps every
  drawing id, revision, history row, release and user edit, writes a report
  to `import-reports/`, and runs once per database (`-- --check`,
  `-- --force`).

## 5a. If you are coming from the SQLite pilot

The application now requires PostgreSQL. If you have an older checkout:

```bash
npm uninstall better-sqlite3 @types/better-sqlite3
npm install pg
npm install -D @types/pg
rm -rf drizzle            # the old SQLite migration cannot run on PostgreSQL
npm run db:generate       # regenerate for PostgreSQL
```

Set `DATABASE_URL` to a PostgreSQL connection string, then
`npm run db:setup && npm run migrate:excel`.

There is no data migration path from the old `.db` file, and none is needed:
the database is rebuilt from the workbooks in about fifteen seconds, and the
import is idempotent. If you had already recorded updates in the pilot
database, export them first (**Export Excel** on each register) before
switching.

---

## 6. Running locally

For everyday use, double-click `START-PROJECT-DRAWING-STATUS.bat` (section 0). The
commands below are the developer equivalents.

```bash
npm run dev        # http://localhost:3000  (hot reload, for development)
```

Production mode — what the launcher uses, because it is faster for normal
users and does not recompile pages on first visit:

```bash
npm run build
npm start          # http://localhost:3000
```

The launcher runs `next build` only when `.next-prod/BUILD_ID` is missing, when
the previous build did not finish, or when something under `src/`, `drizzle/` or
the config files is newer than the last completed build. After changing code,
just start it again — it notices and rebuilds once.

`npm run dev` and `START-PROJECT-DRAWING-STATUS.bat` can be running at the same time:
they use different build folders and, if port 3000 is taken, different ports.

---

## 7. Tests

```bash
npm test           # automated tests (Vitest)
```

The suite builds a throwaway database from the real workbooks, so the
migration itself is under test. It covers: database creation, migration,
idempotency, duplicate prevention, goal/deliverable/drawing CRUD, completion
updates, date calculations, rescheduling, dependency calculations, RAG,
plan vs actual, audit log, export, backup, filtering and role permissions.

The mandatory end-to-end scenario runs against a **live server**:

```bash
# terminal 1
npm run dev
# terminal 2
npm run e2e
```

It drives the running application over HTTP through all 19 required steps
(dashboard → Violet Hill → deliverable → binary completion → save → verify
database → verify dashboard → verify audit → reschedule → verify baseline
preserved → verify current expected changed → verify history → verify
dependency recalculation → verify dashboard metrics → verify completed work not
shifted → verify export) and restores the records it touched afterwards.

---

## 8. Build

```bash
npm run build      # type-checks and produces .next/
```

The build fails on a TypeScript error, so a broken model cannot ship.

---

## 9. Deploying to a company server

The application is localhost-first but production-shaped. Nothing about the
business logic changes when it moves.

### 9.1 Application server

```bash
git clone <internal-repo>  &&  cd design-control
npm ci
copy .env.example .env      # set DATABASE_URL, PORT, BACKUP_DIR, PG_BIN_DIR
npm run db:setup
npm run migrate:excel       # once, to seed from the existing workbooks
npm run build
npm start
```

Put it behind IIS (URL Rewrite / ARR), nginx or Apache as a reverse proxy on
`https://design-control.company.local`, and run it as a service:

* Windows — `nssm install DesignControl` or a Scheduled Task at startup
* Linux — a `systemd` unit running `npm start`

### 9.2 Database server

Point `DATABASE_URL` at the central PostgreSQL instance. Nothing else changes —
the same build runs against a local database or a central one.

Recommended for a shared instance:

* a dedicated database (`design_control`) and a dedicated login, not `postgres`
* `DB_SSL=true` for a managed service or any connection that leaves the host
* `DB_POOL_MAX` sized to your instance: roughly
  `max_connections ÷ (application processes + headroom)`; the default 10 is
  right for one process on a small instance
* the company's normal PostgreSQL backup job, with `npm run backup` as an
  additional on-demand snapshot rather than the only protection

Multiple application processes (or multiple servers behind a load balancer) can
share one database — that is the point of moving off an embedded engine. No
application state is held in memory between requests.

### 9.3 Container

```dockerfile
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV PORT=3000
CMD ["npm","start"]
```

`postgresql-client` is only needed if you want backup/restore from inside the
container. Mount a volume for `BACKUP_DIR`.

### 9.4 Upgrading: migrations, backup, health

1. `npm run backup -- before-upgrade` (a restorable `pg_dump`).
2. Replace the application files, `npm ci`, `npm run build`.
3. `npm run db:setup` — applies any new migrations in `drizzle/` in order
   (they only add tables, columns and indexes, or reword stored text) and
   re-seeds reference data without touching existing rows.
4. Start the service and check `GET /api/health` — it returns `status`,
   the database it reached and its record counts, and fails with HTTP 503 when
   the database cannot be reached. Point the load balancer or monitor at it.
5. If anything is wrong: `npm run restore -- --latest`.
6. When a release includes a one-time data repair, `npm run data:repair`
   applies it (the launcher does this itself after its backup).

### 9.5 Sign-in

Project Drawing Status has one way in: the sign-in screen (Viewer, Admin,
Super Admin — see the section at the top). There is no header-based or
default user. On a shared server, serve it over HTTPS (the session cookie is
then marked Secure) and keep `SESSION_SECRET` private.

### 9.6 What NOT to do

* Do **not** put the database on a OneDrive/SharePoint synced folder or a
  network share intended for documents. PostgreSQL needs local, durable storage.
* Do **not** treat an exported Excel file as the live data.
* Do **not** share one application `.env` between the working and test
  databases — `npm test` drops its schema.

SharePoint is still the right place for project documents, Excel archives and a
portal link to `https://design-control.company.local`.

---

## 10. Backup and restore

```bash
npm run backup                 # pg_dump custom format — safe while the app is running
npm run backup -- before-q3    # with a label
npm run restore -- --latest    # restore the newest dump
npm run restore -- design-control-2026-09-11T10-00-00-000Z.dump
```

Backups use `pg_dump --format=custom`, which takes a single consistent snapshot
and compresses it. Restore uses `pg_restore --clean --single-transaction`, so a
failed restore rolls back rather than leaving a half-restored database.

* **`restore` takes a fresh backup of the current state first**, so a mistaken
  restore is recoverable.
* **`restore` refuses a non-local database without `--force`.**
* Backups also run from **Settings → Backup** in the UI, which tells you up
  front if `pg_dump` cannot be found rather than failing when you press the
  button. If it is missing, set `PG_BIN_DIR` in `.env`.

For scheduled backups: a Windows Scheduled Task or a cron entry running
`npm run backup` in the project folder works. On a shared server, prefer the
company's existing PostgreSQL backup job and keep this as the on-demand
snapshot before a risky change.

---

## 11. Architecture overview

```
Excel workbooks ──(one-off / repeatable migration)──►   PostgreSQL
                                                            │
                                    ┌───────────────────────┴──────────────────────┐
                                    │            src/lib/services/*                 │
                                    │  metrics · schedule · reschedule · reporting  │
                                    └───────────────────────┬──────────────────────┘
                                                            │
                        ┌───────────────────────────────────┼─────────────────────────────┐
                        │                                    │                             │
                Next.js UI (server                  /api/* route handlers        /api/reporting/*
                components + small                  (CRUD, bulk, reschedule,     (weekly PPT feed,
                client islands)                      export, backup, audit)       project KPIs)
                                                                                          │
                                                                          existing Node.js weekly
                                                                            PowerPoint automation
```

* `src/db` — schema and client (the only database-specific code)
* `src/lib` — domain rules: periods, schedule status, RAG, metrics, rescheduling,
  audit, RBAC, validation, config
* `src/lib/import` — the Excel migration utility
* `src/lib/services` — queries, dashboards, updates, export, backup, reporting
* `src/app` — pages and API routes
* `scripts` — CLI entry points (`db-setup`, `migrate-excel`, `backup`, `restore`, `e2e-check`)
* `tests` — Vitest suite

Full detail in `ARCHITECTURE.md`; the rescheduling engine is documented in
`SCHEDULING.md`; the workbook mapping in `DATA-MAPPING.md`.

---

## 12. The rules the application enforces

These are not conventions — they are enforced in the schema, the validation
layer and the write paths:

1. An individual drawing or design deliverable is **COMPLETED or NOT
   COMPLETED**. There is no "In Progress", no percentage column, and the API
   rejects both.
2. Percentages are **derived** at aggregate level only.
3. **Baseline dates are immutable.** `updateEntity` refuses to write them, and
   the reschedule engine only ever writes the *current expected* column.
4. Completion status and schedule status are **separate axes** —
   `NOT_COMPLETED + DELAYED` and `COMPLETED + COMPLETED_LATE` are both normal.
5. No date moves without a **preview and an explicit confirmation**.
6. **Completed work is never moved automatically** by a cascade.
7. Every material change writes an **audit row**; every reschedule also writes a
   **reschedule history row** with its reason.
8. No dashboard number is stored. Nothing was copied from Excel.
9. There is **no project-specific logic**: a project is data. A test walks
   `src/` and fails the build if a project name or code is ever compared to a
   literal in business logic.

---

## 13. Roles

| Role | Can |
|---|---|
| **Administrator** | everything, including imports and user management |
| **Manager** | view and edit operational data, reschedule, override the status colour, run imports (Import), backups and reporting |
| **Editor** | update permitted operational data — completion, dates, revisions, remarks, bulk updates |
| **Viewer** | view and export; controls that change data are not shown and are refused by the API |

Drawings:

| Permission | Viewer | Editor | Manager | Admin |
|---|:-:|:-:|:-:|:-:|
| `drawing.read` — DFS (all tabs) | ✓ | ✓ | ✓ | ✓ |
| `drawing.write` — Drawing Control: add, edit, revisions, dependencies | | ✓ | ✓ | ✓ |
| `drawing.complete` — Mark as Released | | ✓ | ✓ | ✓ |
| `drawing.reschedule` — reschedule drawings (no `schedule.reschedule` needed) | | ✓ | ✓ | ✓ |
| `drawing.admin` — command-line import, conflicts, withdraw a release, delete, mark a package Not Applicable | | | | ✓ |
| `import.centre` — Import (upload, dry run, import, undo) | | | ✓ | ✓ |

Sign-in is described in §9.5; authorization is separate (`src/lib/rbac.ts`).
