# DFS + SNK Billing + Drawing Control — implementation report

Date: 25-Sep-2026 · Stack unchanged (Next.js 15 / TypeScript / Drizzle / PostgreSQL 16) · FY26 module untouched.

## Result

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`, strict) | clean |
| Automated tests (`npm test`) | **217 / 217 passed** (16 files; 28 new in `drawings-e-dfs.test.ts`) |
| Production build (`next build`) | compiled successfully, all routes built (incl. `/dfs`, `/api/dfs/*`) |
| End-to-end (`npm run e2e`, live server) | **122 / 122 passed** (28 new DFS / SNK checks) |
| Acceptance workflow (§22, driven in a real browser) | **23 / 23 passed** |
| Lint | the project has no ESLint configuration; type-checking plus the build's checks stand in for it |

The working database was backed up first, and restored from that backup after the e2e and acceptance runs. The only data kept is migration 0003 and the fee-package import.

## Database changes — `drizzle/0003_fearless_praxagora.sql`

Additive only. It has 11 `ALTER TABLE … ADD COLUMN` statements, with no drops, no renames and no FY26 table. The SQL was inspected before it was applied, a backup was taken, and row counts were the same afterwards.

- `package_fees` gains:
  - `billed_to_date_value` (source billing, reconciliation only)
  - `applicability` (`APPLICABLE` | `NA`, default `APPLICABLE`)
  - `source_workbook`, `source_sheet`, `source_row`
  - `user_edited_fields`
  - `updated_at`
- `packages` gains `source_workbook`, `source_sheet`, `source_row` and `import_batch_id`.

No new tables were added. Packages and fees use the existing `packages` and `package_fees` tables, and drawings link through the existing `drawings.package_id`. There is no Actual column and no billing-date column: Actual is always derived.

## Business rules implemented

1. **One source of truth.** DFS, DFS Summary, SNK Billing and the year/quarter spread are all computed at request time from `drawings`, `packages` and `package_fees` in `src/lib/services/dfs.ts`. Nothing is keyed in by hand. The only setting that is not derived is an Admin marking a package × discipline NA, which is audited.
2. **Hierarchy:** Project → Phase → Discipline (Architecture / Structural / MEP / Landscape) → Package → Drawings.
   - MEP includes PHE, ELE and IBMS. Any other discipline code (e.g. Violet Hill `MP`) is shown under its own name.
   - A package takes the phase of its location code. A package that spans phases is shown under "Multiple phases".
3. **Package completion (per package × discipline, a "DFS unit"):**
   - ✓ Complete when every drawing is RELEASED; otherwise ✕ Not complete.
   - There is no IN_PROGRESS state and no percentage on a package.
   - NA applies only when explicitly not applicable. NA ≠ Complete, and NA carries no Scope.
   - A fee row with no drawings is ✕ Not complete (flag "no drawings in register").
   - At package level, a package counts once. It is complete when all its applicable disciplines are complete.
4. **Billing:**
   - Scope = the Design Fee (`package_fees.fee_value`).
   - Actual = Scope when the unit is complete, 0 otherwise. Billing can never run ahead of the package, completion never writes to the fee rows, and Scope is never overwritten.
   - The source workbook's billed-to-date is reconciliation only (flag "billed in source · not complete").
   - There is no billing date.
5. **Release without a date:**
   - The drawing is RELEASED and its actual date stays NULL. The evidence is shown (e.g. "Not recorded · Issued before 01-Jan-2026").
   - Period reporting uses the evidenced period: "Issued 2026 Q1" goes to that quarter, and "Issued before 01-Jan-2026" goes to its own *Before* column.
   - No quarter-end or other date is invented.
6. **Year / Q1–Q4:**
   - Aggregation only.
   - Two bases: calendar year (the drawing-plan convention, the default) or fiscal year (April start, the existing `fiscalQuarterOf`).
   - Planned = the quarter of a unit's latest current-expected date. Complete = the quarter of its last release.
7. **Filters:**
   - Drawing-level filters (release, schedule, number, search, dates) decide which packages are listed.
   - Status, Scope and Actual are always computed over the whole package, so totals are not distorted.
8. **Status display:**
   - Drawings show RELEASED / NOT RELEASED.
   - Schedule status (Delayed, Due soon, …) is a separate column and filter.
9. **Preserved rules and the fixes for the 8 earlier defects:**
   - One drawing per project + number.
   - Not-yet-numbered drawings are updated in place.
   - Conflicts are held back, not merged.
   - The baseline is set once.
   - Released drawings are never moved.
   - All date changes go through the reschedule engine, with history and audit.
   - User edits are protected on re-import. This now also covers `packageId` and NA.

## Fee packages (import)

Sources are the *Design Fee* sheets of the RES and T08 fee workbooks, named in `data/drawing-sources/poarr.json`.

- **What is imported.** Coded rows (`BB01-1`, `SS0-04`, …) become packages, with their AR / ST / MEP / LS fee, %, billed-to-date and source row. The import validates the expected counts: **RES 116 / T08 32** packages, and **10,948 / 1,513** drawings linked.
- **Linking rule.** Explicit and written in the manifest: `AR-BB01-1` → `BB01-1`. A drawing's package can also be set in Drawing Control → Edit. A package from another project is refused.
- **Reconciliation.** Package fees + duplicate-code fees + fees outside packages = the sheet total (±0.0002 Cr.), otherwise the import is refused.

| | AR | ST | MEP | LS |
|---|---:|---:|---:|---:|
| RES Scope (Cr.) | 28.7972 | 6.6586 | 3.1271 | 0.7340 |
| T08 Scope (Cr.) | 11.4450 | 3.4042 | 1.0633 | 0.1572 |

- **Duplicate codes.** A code that repeats in a sheet is reported (`DUPLICATE_PACKAGE_CODE` ×24) and not imported. In RES this covers ST 0.7535 Cr.
- **Stage fees.** Design-concept and post-construction fees are not drawing packages. They are reported and reconciled, not imported.
- **Other issues.**
  - `BATCH_WITHOUT_FEE_PACKAGE` ×24: these drawings stay grouped by batch.
  - `UNMAPPED_PACKAGE_PHASE` ×4: these packages have no phase.
- **Working DB import.** Applied: 0 created, 12,474 updated, 1,952 unchanged. The drawing validation totals are unchanged (14,426 / 13,788 / 638 / 1,362 / 112 + 5 / 1,404). The plan-move count is **738**; the Stage 2 report's 742 came from a run before the historical-conflict fix.

## Current DFS figures (working database)

| Project | Drawings | Released | Not rel. | Packages ✓ / all | Units ✓ / ✕ / NA | Scope (Cr.) | Actual (Cr.) | Billed in source, not complete |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| POARR-RES | 11,403 | 11,235 | 168 | 99 / 156 | 238 / 68 / 198 | 39.3169 | 33.0688 | 53 |
| POARR-T08 | 1,524 | 1,149 | 375 | 10 / 35 | 29 / 52 / 52 | 16.0697 | 4.6783 | 0 |
| POARR-T09 | 1,499 | 1,404 | 95 | 29 / 42 (batches) | 29 / 13 / 0 | — | — | — |
| VIOLET-HILL | 88 | 88 | 0 | 0 / 24 | 8 / 76 / 0 | 3.7489 | 0.1347 | 0 |
| **Total** | **14,514** | **13,876** | **638** | **138 / 257** | **304 / 209 / 250** | **59.1356** | **37.8818** | **53** |

The server builds the whole tree in about 0.26 s.

## API (new, all under the existing RBAC)

| Route | Permission | Purpose |
|---|---|---|
| `GET /api/dfs` | `drawing.read` | The tree with roll-ups (the same filters as the page) |
| `GET /api/dfs?view=periods&basis=CY\|FY` | `drawing.read` | Year / quarter spread per discipline |
| `GET /api/dfs/unit-drawings?key=…` | `drawing.read` | Paged drawings of one package × discipline (≤200 per page) |
| `POST /api/dfs/applicability` | `drawing.admin` | Mark a package × discipline NA or applicable, with a reason. Audited. |

Changed: `PATCH /api/drawings/[id]` now accepts `packageId`, which must belong to the drawing's project. Existing routes are otherwise unchanged.

## UI

- **DFS** is at `/drawings`, with `/dfs` redirecting to it. The nav item "Drawing Register" is renamed to **DFS**. Tabs:
  - **DFS:** the expandable tree. Package rows show Pkg code, name, ✓ / ✕ / NA, the release (date, evidence or expected date), counts, Scope and Actual. Drawings load on demand: Dwg no., Dwg name, Revision, RELEASED / NOT RELEASED, actual release, expected release, phase.
  - **DFS Summary**
  - **SNK Billing Summary:** Scope, Actual, Balance, Actual/Scope, packages complete, billed in source.
  - **Year / Quarter**
  - **Drawing list:** the former flat register.
- **Filters:** project, phase, discipline, package, package status, drawing release, schedule status, number, billing check.
- **Viewer:** no edit controls. "Open Drawing Control" is shown only with `drawing.write`. Admins get an inline Mark NA control with a reason.
- **Drawing Control** is unchanged apart from a *Package (DFS / billing)* field in Edit and "DFS" wording.

## Files

- **New:**
  - `drizzle/0003_fearless_praxagora.sql` and `drizzle/meta/0003_snapshot.json`
  - `src/lib/import/drawing-register/design-fee.ts`
  - `src/lib/services/dfs.ts` and `src/lib/services/dfs-admin.ts`
  - `src/app/api/dfs/route.ts`, `src/app/api/dfs/unit-drawings/route.ts` and `src/app/api/dfs/applicability/route.ts`
  - `src/app/dfs/page.tsx`
  - `src/components/dfs-tree.tsx`, `src/components/dfs/dfs-views.tsx` and `src/components/dfs/drawing-list-view.tsx`
  - `tests/drawings-e-dfs.test.ts`
  - this report
- **Changed:**
  - `src/db/schema.ts` and `drizzle/meta/_journal.json`
  - `data/drawing-sources/poarr.json`
  - `src/lib/import/drawing-register/{manifest,parse,plan,apply,index}.ts`
  - `src/lib/services/drawing-register.ts` and `src/lib/services/drawing-control.ts`
  - `src/app/drawings/page.tsx`, `src/app/drawings/[id]/page.tsx`, `src/app/drawing-control/page.tsx`, `src/app/drawing-control/[id]/page.tsx`, `src/app/update-centre/page.tsx` and `src/app/api/drawings/route.ts`
  - `src/components/{nav,drawing-actions,drawing-detail}.tsx`
  - `scripts/e2e-check.ts`
  - `README.md`
- **Not touched:** every FY26 file, table and test, and the reschedule engine, audit, auth and RBAC.

## Tests added (`tests/drawings-e-dfs.test.ts`, 28)

| Area | What is tested |
|---|---|
| A | Completion flips on withdraw / release; a package completes only on its last release; NA is never complete; all-NA packages are not counted |
| B | Actual = Scope only when complete and stays 0 while any drawing is open; source billing never completes a package |
| C–E | Discipline → phase → project → all totals are sums of their children; Scope reconciles to the Design Fee sheet; filters do not change unit status or totals |
| F | Fee rows are unchanged by completion; there is no actual or billing-date column |
| G | Every unit sits under its own nodes; keys are unique; every drawing is in exactly one unit; packages 116 / 32 |
| H | Viewer reads the tree, periods and unit drawings; Viewer / Editor / Manager get 403 on NA and Admin gets 200; an unknown user is a Viewer |
| I | Released-without-date drawing: RELEASED, NULL actual, evidence kept; evidence buckets; FY basis and cells equal totals |
| J / K | Reschedule moves the package plan, not the baseline, status or Scope; baseline unchanged on release |
| L | A re-import keeps a user-set package and an Admin NA |
| M | 0003 is ADD COLUMN on package tables only; FY26 row counts are unchanged |

Pure rules are also tested: discipline grouping, period parsing, CY / FY buckets and unit keys. The e2e script adds the DFS / SNK checks and uses the DFS wording.

## Fixes made while verifying

- **Actual matching Scope.** Unit Actual was rounded to 4 dp while Scope was not, so they could differ in the last digits. Money is now summed unrounded and rounded once, so Actual equals Scope exactly and the period totals reconcile.
- **Tree re-opening.** After choosing a project in the filter, the tree kept its old collapsed state. It now re-opens to the new selection.

## Remaining issues

1. **POARR-RES: 53 package × discipline units are billed in the source workbook but not complete in DFS.** SNK Actual (33.0688 Cr.) is therefore lower than the source's billed-to-date (35.1865 Cr.) for those units. These units are flagged, not changed. Use *Billing check → Billed in source, not complete* to list them.
2. **Violet Hill: 76 fee units have no drawings in the register.** They show ✕ Not complete ("no drawings in register") until drawings are added or an Admin marks them NA.
3. **POARR-T09 has no current fee packages.** Its drawings are grouped by batch with no Scope or Actual.
4. **24 duplicate package codes** in the RES / T08 fee sheets need correcting at source; their fees are reported, not billed. **4 packages** have a location with no phase mapping.
5. **Legacy `packages.actual_release_date`** is kept and not synchronised with DFS completion. When it conflicts, the API returns the unit flag `LEGACY_PACKAGE_DATE_WITHOUT_DFS_COMPLETION`; DFS completion always wins.
6. **Page size.** The all-projects DFS page is about 0.6–0.7 MB of HTML. Selecting a project keeps it small; drawings are never sent to the browser in bulk.

## Assumptions

- **Scope source.** Scope is the Design Fee sheet's per-package discipline fee. "Billed YTD" is reconciliation only and is never Actual.
- **What NA means.** A fee cell with neither fee nor % and no drawings is NA. Anything else is applicable until an Admin says otherwise.
- **What is billed.** Design-concept and post-construction fees are not drawing packages and are not billed through DFS.
- **MEP grouping.** PHE, ELE and IBMS roll into MEP.
- **Period basis.** The default basis is the calendar year, because the drawing plan's quarters are calendar quarters. The fiscal basis (April start) uses the existing convention.

## On your computer

1. Set `PG_BIN_DIR` (as before), then run `npm run backup`.
2. Run `npm run db:setup`, which applies 0003 (additive).
3. Run `npm run drawings:import` to preview. Check that the summary shows the fee-package section and `valid: true`.
4. Run `npm run drawings:import -- --apply`.
5. Restart the app (`START-DESIGN-CONTROL.bat`) and open **DFS**.
