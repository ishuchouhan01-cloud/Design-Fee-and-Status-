# Design Fee Schedule (DFS) — delivery report

29-Sep-2026. The existing app has been extended, not rebuilt. It keeps Next.js 15, PostgreSQL 16, Drizzle, the RBAC and the reschedule engine. The Design Goals – Financial Year 2026–27 module and its tables are untouched.

## Results

| Check | Result |
|---|---|
| Typecheck (`npm run typecheck`) | no errors |
| Lint (`npm run lint`; ESLint and `next/core-web-vitals` newly configured) | no warnings or errors |
| Unit and import tests (`npm test`) | **18 files, 248 tests passed** |
| Production build (`npm run build`) | passed |
| End-to-end check (`npm run e2e`, against the production build) | **150 of 150 passed** (includes a wording scan of 17 screens) |
| Browser check (Chromium; 1366 × 768, 1920 × 1080, tablet 820 × 1180) | **32 of 32 passed**, no console errors, no horizontal page scroll |

## Reconciliation (live database)

| Row | Drawings released | Packages complete |
|---|---|---|
| Pursuit of a Radical Rhapsody | 13,788 of 14,426 (638 not released) | 121 of 174 (plus 1 Not Applicable) |
| · Residential | 11,235 of 11,403 | 105 of 116 |
| · Tower 08 | 1,149 of 1,524 | 7 of 31 (plus 1 Not Applicable) |
| · Tower 09 | 1,404 of 1,499 | 9 of 27 |
| Violet Hill | 88 of 88 | 5 of 24 |

- Parent = sum of its children at every level. Tests check this against the live SQL counts; no figure is hard-coded.
- The manifests' validation targets match exactly.

## Violet Hill root cause (88 of 88 released, but 8 of 84 packages complete)

Two causes:

1. **The "84" counted package × discipline lines, not packages.** Most fee lines have no drawings, and those counted as Pending.
2. **Master Planning drawings were not counted under Architecture.** The "MP & AR" sheet gives these drawings the discipline Master Planning, while the design fee is booked under Architecture. So the Master Planning lines were complete but had no fee, and the Architecture fee lines had no drawings and stayed Pending.

Fixes:

- Discipline grouping now comes from data: a new column, `disciplines.dfs_group`, maps Master Planning and Urban Design → Architecture, and Public Health Engineering, Electrical and Integrated Building Management System → Mechanical, Electrical & Plumbing.
- A package is **Complete** when it has at least one drawing and every drawing is released.
- Packages with no drawings stay **Pending** and show "no drawings yet".
- Counts are of package records.

Result: every Violet Hill package that has drawings is Complete (5). The other 19 have no drawings yet.

## 1. Hierarchy

- **Schema (migration 0005, additive):**
  - `projects.display_name`, `parent_project_id` and `display_order`.
  - `created_import_batch_id` on the imported tables.
  - `drawing_import_batches.file_type`, `file_names`, `project_id`, `undone_at` and `undone_by_label`.
  - New tables: `import_run_changes` and `import_mappings`.
  - `disciplines.dfs_group`.
- **Project List:** `data/project-sources/project-list.xlsx` was imported.
  - Pursuit of a Radical Rhapsody was created as the parent.
  - Residential, Tower 08 and Tower 09 were **re-parented in place**, keeping the same ids and all their data.
  - Violet Hill got its full name.
  - Nothing about Pursuit of a Radical Rhapsody is in code.
- **Tree:** Project → child project (Tower / Product) → base-DFS headings (Phase / Tower / Product / Block / Villa / Group) → Package → Discipline → Drawing.
  - A level with no record is not shown.
  - A project with no package definition shows Discipline → Drawings directly.
  - The Project filter lists only top-level projects, by full name.
- **Pursuit of a Radical Rhapsody packages:** these are the source's own groupings, taken from each tower's Design Fee sheet.
  - Tower 09 uses the Commercial 03-Year Plan (2023) Design Fee sheet, its only package definition: 27 packages under 6 headings.
  - Its register batches `…-ISS-n` / `…-MP-n` have no heading. They link by the rule "location = initials of exactly one Design Fee group, n = the package's position in it", and every link is logged (18 issues). All 1,499 Tower 09 drawings are linked.
  - Residential links 10,953 drawings to packages; 450 are not linked. Tower 08 links 1,522; 2 are not linked. Each gap is an admin import issue (see Unresolved).
- **Re-imports:** a later Base DFS import rebuilds packages and re-links drawings by stable key. Edits, rescheduled dates and baselines are kept (tested).

## 2. Wording

- **Removed:** every listed phrase — the sidebar tag line, the top-bar Excel note, the page subtitle, the "no base DFS" text, the helper line, the bottom banner, "Release date: Not recorded" and "with its evidence".
  - The sidebar header is now "Design Goals & Delivery Control System".
  - The subtitle is now "Design Fee Schedule (DFS): package and drawing status by project."
  - A released drawing without a date shows "—". Its evidence appears only in the drawing detail panel (in full words) and on the data-quality pages.
- **Stored wording:** migrations 0006 and 0007 reword import-log text only.
- **Checks:**
  - `tests/wording.test.ts` fails on any banned phrase in application source.
  - `scripts/page-scan.ts`, also run in e2e, fetches every screen and fails on a banned phrase or an unexplained abbreviation in the screen's own wording. All screens are clean.

## 3. Full forms

- `src/lib/labels.ts` is the one label dictionary, used by the screens and exports. It covers navigation, DFS columns, statuses, disciplines, Financial Year / Calendar Year / Quarter, Status (Green / Amber / Red), Autodesk Construction Cloud, Revision, Complete / Pending and role names.
- The sidebar reads "Design Goals – Financial Year 2026–27"; route slugs are unchanged.
- Codes are not shown as project labels anywhere.

## 4. DFS table

- **Service:** `src/lib/services/dfs.ts` was rewritten. It counts in SQL (grouped by project, package and discipline group), with no cache.
- **Screen:** `src/components/dfs-tree.tsx`.
  - Columns: **Name · Package Status · Release Date · Packages Complete · Drawings Released**.
  - Rows load on expand (`GET /api/dfs?parent=`). **Expand to Packages** uses `expand=packages`.
  - Drawings are paged 50 at a time (`/api/dfs/unit-drawings`).
  - The drawing list shows Drawing Name, Drawing Number, Revision, Discipline, Updated On and Status.
  - Keyboard: Enter / Space / → / ←, with `aria-expanded`.
- **Filters:** Search (drawing number, name, package, project), Project, Discipline, Package Status, Drawing Release and Schedule Status.
  - They run on the server, keep the ancestor rows, and the counts follow the filters.
- **Exports:** `GET /api/dfs/export?format=xlsx|csv` exports the filtered view with hierarchy columns and full labels.
- **Summary and Year / Quarter:** the DFS Summary and Year / Quarter use the same rules and full labels (₹ Cr, Financial Year 2026–27, Quarter 1).

## 5. Cross-checks

- **a)** Violet Hill: see above.
- **b)** Totals reconcile, as in the table above.
- **c)** Only package records are counted as packages, which a test enforces.
- **d)** Status is binary and comes from drawings only.
- **e)** A Drawing Control release or withdrawal changes the DFS and the DFS Summary on the next request (tested and in e2e).
- **f)** The earlier drawing fixes still pass their tests:
  - expected-date PATCH goes through the reschedule engine;
  - bulk-update permissions;
  - a goal reschedule is refused for drawings;
  - imports keep edits;
  - the schedule filter runs before pagination;
  - a Viewer sees no edit controls.

## 6. Import (Administrator and Manager)

- **Code:** screen `/import-centre`, service `src/lib/import/centre.ts`, API under `/api/import-centre/*`, and a new `import.centre` permission.
- **Upload:** .xlsx only. The extension, content type, size (40 MB) and zip signature are checked, and macro projects are refused.
- **File types:** Base DFS / Design Fee sheet, Drawing register / 03-Year Plan, Autodesk Construction Cloud release export and Project List. The type is detected from the file and can be changed.
- **Flow:**
  - Choose a project or create one (full name, optional short code, optional parent).
  - The column mapping preview shows sample rows and can be corrected; it is remembered per project.
  - A dry run gives counts to create, update and leave unchanged, plus conflicts, ambiguous rows and skipped rows (workbook / sheet / row / value / reason).
  - Import runs only after a confirmation.
  - The screen shows import history.
- **Undo this import** works on the latest run:
  - It removes what that run created and puts back the values it recorded.
  - A record edited since the run is kept and listed.
- **Templates:** one per file type.
- **Tested with:**
  - the Residential, Tower 08 and Tower 09 workbooks;
  - the Violet Hill 03-Year Plan (it adopts the 88 existing drawings with no duplicates);
  - a synthetic register of a different shape for a new project (dry run → import → an idempotent re-run → undo keeps an edited drawing);
  - an Autodesk Construction Cloud export (release → undo).
- **Command line (same code):** `npm run projects:import` and `npm run drawings:import -- --manifest data/drawing-sources/violet-hill.json`.

## 7. Delivery readiness

- **Sign-in** (`src/lib/auth.ts`):
  - `proxy` for a shared server behind a sign-in proxy (Azure App Service Authentication with Microsoft Entra ID, oauth2-proxy). It trusts the header named in `AUTH_PROXY_HEADER`; first-time users are Viewers unless listed in `AUTH_ADMIN_EMAILS`.
  - `local` for a single computer; the launcher now uses it.
  - `dev` (the `x-user-email` header) is **refused when NODE_ENV=production**.
- **Error handling:**
  - Error boundaries and loading skeletons are on the DFS, Drawing Control, Import and Design Goals screens.
  - Server errors show a plain message; database errors are logged and never shown as they are.
  - `/api/health` returns 503 when the database cannot be reached.
- **Layout:** the menu collapses below 1024 px, and text and tables were checked at 1366, 1920 and tablet widths.
- **Formatting:** one formatting utility, `src/lib/format.ts`.
- **Documentation:** the README now covers environment variables, the DFS rules, Import, and upgrade steps (backup → migrate → health check), plus sign-in (§9.5). `.env.example` is updated.
- **Clean-up:** scratch scripts removed; no `console.log` or TODO left in `src`.

## Unresolved

- **Full names:** 71 older projects (from Design Goals, with no drawings) are not in the Project List. They show their source name, and each is logged (`PROJECT_FULL_NAME_MISSING`). Add them to `project-list.xlsx` and import it.
- **Pursuit of a Radical Rhapsody package gaps** (drawings shown under "Drawings not assigned to a package", logged as admin import issues):
  - Residential, 450 drawings. Combined-tower Mechanical, Electrical & Plumbing batches (MEP-T2S-6S, MEP-T2V-6V, MEP-T01-07), structural batches SS4–SS9 and S10–S12, Landscape V01 / V03, and batches marked "-NA". None of these has a package in the Design Fee sheet.
  - Tower 08, 2 drawings.
  - The source needs these packages, or the batches corrected, before they can be linked. Nothing was guessed.
- **Tower 09's package definition** is the 2023 Commercial plan's Design Fee sheet. A current Tower 09 Design Fee sheet, when there is one, can be imported through Import.
- **Company sign-in** needs one deployment decision: publish the server behind Azure App Service Authentication (or another sign-in proxy) and set `AUTH_PROVIDER=proxy`. A built-in Microsoft Entra ID login would need the tenant ID, client ID, secret and redirect URI registered by IT.
- **After copying the update**, on your computer:
  1. Start the launcher. It rebuilds and applies migrations 0005–0007 by itself.
  2. Bring in the new data, from Import or from the command line:
     ```
     npm run drawings:import -- --apply
     npm run drawings:import -- --manifest data/drawing-sources/violet-hill.json --apply
     npm run projects:import -- --apply
     ```
     These add the Tower 09 packages, re-read Violet Hill with its base DFS, and create Pursuit of a Radical Rhapsody above its towers.
  3. Run `npm install` only if you want to run `npm run lint`. It adds ESLint, a development tool the application does not need to run.

## Addendum — start-up failure fixed; versions and rollback

- **Why the application did not start.** The type check picked up the moved-aside file `_to_delete/scripts/_check.ts`, because the project type-checked every `.ts` file under its folder. The fix has two parts:
  - The `_to_delete` folder was moved out of the application folder.
  - `tsconfig.json` now excludes `_to_delete`, `backups`, `data`, `import`, `import-reports` and `.versions`.
- **Version history, built in (`scripts/versions.mjs`; no extra software).**
  - Every new set of application files is saved as a version when the launcher starts.
  - A version is marked *worked* once the application runs, or *failed to prepare* if the build fails.
  - The database is backed up before updates are applied, and the backup is recorded with the version.
- **Safe updates.**
  - The last working build is kept aside while a new one is prepared.
  - If preparing fails, that build is put back and started, so a bad update never leaves you without the application.
- **ROLLBACK.bat** lists the versions, puts the chosen one back and can also restore the matching database backup. It saves the current state first, so a rollback can be undone.
- **Git.** The application folder is also a git repository, with one commit per delivered update.
- **Tested.** All three cases were tested here: a normal update, a broken update (the last working version was started automatically), and a rollback followed by a restart.
- **Limit.** Version history starts with this update. The files as they were before today's update were overwritten when it was copied in, so there is no earlier version to return to.

## Addendum — project heading, "Updated On" dates, formula text (30-Sep-2026)

### Root causes

| Defect | Root cause | Fix at the source |
|---|---|---|
| Towers shown as top-level projects (PoaRR-Res, PoaRR-T08, PoaRR-T09); "Violet hill" in lower case | The hierarchy and the full names lived only in the Project List import, a separate step (`npm run projects:import -- --apply`) that had never been run on this database. The DFS tree follows `projects.parent_project_id`, which was empty. | Each drawing manifest now lists the projects its source implies (`"projects"`). Every drawing import applies it: it creates the group project if missing and fills only empty names and parents. The launcher runs a one-time data repair after its backup. The repair applies the bundled Project List and re-imports each manifest. No project-specific code. |
| Release date one day early ("16-Aug-2026" for 17-Aug-2026) | SheetJS turned date cells into JavaScript dates in the computer's time zone (India, UTC+5:30), which is the previous day in UTC. A later import then kept the stored date. | Dates are read from the serial number without a time zone (`src/lib/import/cells.ts`). A date an import stored is replaced by the source's date unless a person set it in Drawing Control. |
| "Updated On" showed the import time ("16-Sep-2026") | The column showed `updated_at`, which every import sets. | New columns (migration 0008): `source_date`, `source_period_label/start/end` and `edited_at`. "Updated On" shows, in order: the Drawing Control edit (date and time), the source date, the source period, or "—". |
| "=CONCATENATE(B26,"-",C26,"-",D26)" as a drawing number | The formula was typed into a cell formatted as Text. SheetJS gives it as plain text with no cached value, and the importer took it as the number. | A formula uses its cached value, or is worked out from the cells it refers to. Otherwise the cell is left empty and reported as FORMULA_NOT_EVALUATED. Text starting with "=" is never stored. This applies to every field and every importer. |

### Files

- **New**
  - `src/lib/import/cells.ts`
  - `src/lib/updated-on.ts`
  - `src/lib/import/drawing-register/projects.ts`
  - `scripts/data-repair.ts` (`npm run data:repair`)
  - `drizzle/0008_source_dates.sql` and `drizzle/meta/0008_snapshot.json`
  - `tests/drawings-g-followup.test.ts`
- **Changed: importers**
  - `src/lib/import/drawing-register/read.ts`, `parse.ts`, `plan.ts`, `apply.ts`, `index.ts`, `manifest.ts`
  - `src/lib/import/workbook.ts`, `index.ts`, `centre.ts`, `upsert.ts`
  - `src/lib/import/design-goals-fy26/read-sheet.ts` (it only reports formula issues; no FY26 data changes)
- **Changed: services**
  - `src/lib/services/drawing-control.ts`, `updates.ts`, `drawing-register.ts`, `dfs.ts`, `export.ts`
  - `src/lib/repo/entities.ts`
- **Changed: screens and API**
  - `src/app/drawings/page.tsx`, `src/app/drawing-control/page.tsx`
  - `src/components/dfs-tree.tsx`, `dfs/drawing-list-view.tsx`, `drawing-detail.tsx`
  - `src/app/api/dfs/unit-drawings/route.ts`
- **Changed: data and scripts**
  - `data/drawing-sources/poarr.json`, `violet-hill.json` (the `"projects"` list)
  - `scripts/launcher.mjs` (the "Checking data" step), `scripts/page-scan.ts`, `package.json`
  - `README.md`, `.env.example`
  - `tests/drawings-e-dfs.test.ts`, `drawings-f-centre.test.ts`
- **Migration 0008** adds columns and one index only. Its backfill sets:
  - `source_date` from actual dates an import recorded;
  - periods from the release evidence;
  - `edited_at` from Drawing Control entries in the audit log.
- **Nothing else changes:** drawing ids, revisions, history, releases, user edits and the FY26 tables stay as they were.

### Counts (test database, same sources)

| | Before | After |
|---|---|---|
| Header | 126 of 198 packages complete · 13,876 of 14,514 drawings released | unchanged |
| Top rows | PoaRR-Res, PoaRR-T08, PoaRR-T09, Violet hill | Pursuit of a Radical Rhapsody (121 of 174 · 13,788 of 14,426), Violet Hill |
| PoRR children | — | Residential 105 of 116 · 11,235 of 11,403; Tower 08 7 of 31 · 1,149 of 1,524; Tower 09 9 of 27 · 1,404 of 1,499 |
| Updated On = source date | 0 | 1,492 |
| Updated On = source period | 0 | 12,384 (Before 01-Jan-2026 12,145; Quarter 1, 2026 174; Quarter 2, 2026 35; Before 01-Jan-2025 30) |
| Updated On = "—" (no date can be determined) | — | **638**, all not released (Residential 168, Tower 08 375, Tower 09 95) |
| Values starting with "=" | Violet Hill: 2 drawings held as not numbered (MP-CO-0001, MP-CO-3001) | 0; both now carry their worked-out numbers |

On your computer the header is 125 of 198. The launcher's one-time repair prints the before and after figures from your own database and saves them in `import-reports/data-repair-*.json`.

### Checks

- **Tests:** 264 of 264 passed. They include:
  - dates read the same under Asia/Kolkata, UTC and America/New_York;
  - formula evaluation;
  - a scan of the database and the API for "=" values;
  - "Updated On": source date, period, "—", never the import time, and an edit that changes only the edit time;
  - the source date correcting a date stored one day early;
  - the PoRR hierarchy, its sums and the project options.
- Typecheck, lint and production build: clean.
- **End-to-end check:** 150 of 150 passed.
- **Page scan:** no banned wording, no project codes and no formula text on any DFS screen.
- **Browser check:** 32 of 32 and 18 of 18 passed. The follow-up check covered:
  - opening PoRR → Tower 08 → heading → package → discipline → drawings;
  - the columns *Drawing Name | Drawing Number | Revision | Discipline | Updated On | Status*;
  - a Drawing Control edit appearing at once as "30-Sep-2026 11:39";
  - the Drawing list and its Excel export showing project names and the same Updated On text.

### After copying the update

1. **Start the launcher.** It does three things:
   - saves this as a new version;
   - backs up the database, then applies migration 0008 and the one-time data repair ("Checking data");
   - prepares and starts the application.
2. **If anything is wrong,** run `ROLLBACK.bat`. It returns the previous version and its database backup.
