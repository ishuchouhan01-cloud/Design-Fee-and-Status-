# Drawing Register & Drawing Control — Stage 2 Report

Status: **implemented and validated.** 189/189 tests · E2E 94/94 · production build OK.

## 1. What was built

| Module | Route | Who |
|---|---|---|
| Drawing Register (read-only) | `/drawings`, `/drawings/[id]` | `drawing.read`: every role |
| Drawing Control | `/drawing-control`, `/drawing-control/[id]` | `drawing.write` and above |

- **Drawing Control tabs:**
  - Drawings: + Add Drawing, Edit, Mark as Released, Add Revision, Reschedule, View History.
  - Two-week look-ahead: Overdue / This week / Next week.
  - Admin-only tabs: Import conflicts, Import, and Location → phase map.
- **Detail page sections:** Overview, Release, Schedule, Dependencies, Revision history, Reschedule history, Audit history, Source information.
- **Register KPIs:** Total, Released, Not released, Due soon, Delayed, Released this week, Released this month.
  - The week and month counts use real actual dates only.
- **Register filters:** project, phase, discipline, package, batch, release status, schedule status, responsible, number status, release-date recorded, and a date range on expected / actual / baseline.
  - Search is case-insensitive.
- The existing `drawings` table was extended rather than rebuilt. It uses the existing RBAC, audit, reschedule engine and authentication.

## 2. Migration: `drizzle/0002_parched_sentinel.sql` (additive only)

- **New tables (7):**
  - `drawing_revisions`
  - `drawing_dependencies`
  - `drawing_snapshots`
  - `drawing_conflicts`
  - `drawing_location_phase_map`
  - `drawing_import_batches`
  - `drawing_import_issues`
- **Changes to `drawings` (additive):** 20 new columns, 2 FKs on those new columns, and 6 new indexes.
  - Identity is now enforced by `drawings_project_code_uq (project_id, drawing_code)`.
  - The old `drawings_uq` index is kept.
- **Gate:** no DROP, TRUNCATE, DELETE, RENAME or ALTER COLUMN.
- **Verified:** the backup was taken first, and the row counts of every existing table were unchanged after `db:setup`.

## 3. Import — `npm run drawings:import` (preview) / `-- --apply`

The importer is driven by a manifest: `data/drawing-sources/poarr.json` plus the 9 workbooks in `data/drawing-sources/poarr/`.

| Project | Drawings | Released | Not released | Not yet numbered | Conflicts | Actual dates |
|---|---:|---:|---:|---:|---:|---:|
| POARR-RES | 11,403 | 11,235 | 168 | 813 | 41 | 0 |
| POARR-T08 | 1,524 | 1,149 | 375 | 549 | 66 | 0 |
| POARR-T09 | 1,499 | 1,404 | 95 | 0 | 5 (+5 ACC-only) | 1,404 |
| **Total** | **14,426** | **13,788** | **638** | **1,362** | **112 (+5)** | **1,404** |

**Snapshots**

- Historical snapshot rows: **18,517**
  - RES 2024: 3,284
  - RES 2025: 11,699
  - T08 2024: 1,528
  - T08 2025: 1,434
  - Commercial: 572
- Current snapshot rows: 16,784.

**History recorded**

- Revision rows: 13,967.
- Plan moves between snapshots: 742 `reschedule_history` rows, across 555 drawings.

**Safety**

- The import runs in one transaction and re-counts inside it.
- It is refused unless every target matches.
- It is idempotent: a second run creates 0, updates 0 and leaves 14,426 unchanged.
- A failure part-way rolls back everything (tested with a trigger fault).

**Import issues**

| Code | Count | Meaning |
|---|---:|---|
| MULTI_BATCH_DRAWING | 241 | Re-issue in another batch: one drawing, every listing kept as a snapshot |
| NUMBER_TITLE_CONFLICT | 112 | Held back in `drawing_conflicts` for an admin |
| NUMBER_TITLE_CONFLICT_HISTORICAL | 49 | Same number with different titles inside a historical file, e.g. A-T9-4804 D02A/D02C in the Commercial plan. The current register row is the drawing; the other row is kept unlinked |
| DUPLICATE_ROW_COLLAPSED | 42 | Identical rows |
| ACC_VERSION_MISMATCH | 25 | Register revision ≠ ACC versions − 1 |
| REVISION_REGRESSION | 16 | The current revision is lower than an earlier one; the current revision is imported and both are kept |
| UNMAPPED_DRAWING_LOCATION | 7 locations | See §4 |
| ACC_ONLY_NUMBER | 5 | Held back (likely typos, e.g. `5-T09-BM1204`) |

## 4. Phase mapping (explicit map, no fuzzy matching)

- **T08:** all 1,524 drawings → T08.
- **T09:** no phase. The project has none.
- **RES:** 9,323 drawings mapped:

| Phase | Drawings |
|---|---:|
| Res | 4,834 |
| T1 | 576 |
| T2 | 796 |
| T3 | 719 |
| T4 | 605 |
| T4_Stepped | 5 |
| T5 | 656 |
| T5_Stepped | 5 |
| T6 | 645 |
| T7 | 340 |
| V40 | 142 |

- **How RES was mapped:**
  - Towers map by exact location code.
  - The TXV / TXS locations (Towers 3V–5V and 3S–5S) are split by the tower token in the drawing number, e.g. `S-T4V-…` → T4.
  - Villas, individual homes, ISS, master plan and amenities → Res. The Design Goals file places those in phase Res.
- **RES left with no phase (2,080 drawings), each with an `UNMAPPED_DRAWING_LOCATION` issue:**

| Location | Drawings | Reason |
|---|---:|---|
| T2S | 760 | No T2 stepped phase exists |
| T6S | 456 | No T6 stepped phase exists |
| TXS | 456 | Shared or T3S drawings |
| T2V-6V | 142 | Multi-tower MEP drawings |
| T2S-6S | 109 | Multi-tower MEP drawings |
| TXV | 104 | Shared drawings |
| T01-07 | 53 | Multi-tower MEP drawings |

- Adding T2_Stepped / T6_Stepped phases to POARR-RES, then one line each in the manifest, would map 1,216 more.

## 5. Rules enforced

- **Identity** is project + drawing number. Batch history lives in snapshots.
- **Not-yet-numbered drawings.** Assigning a number updates the same record and keeps its import key. A later source number promotes it; it is never duplicated.
- **Released with no source date:** COMPLETED, actual date NULL, `release_evidence` recorded, e.g. "Issued before 01-Jan-2026". Schedule status is null, and the UI shows "Release date: Not recorded".
  - This applies to 12,384 drawings.
  - No new schedule-status value was added.
- **T09 actual dates** equal the ACC *Date of Release* for every one of the 1,404. *Created at* is stored as `acc_created_at` only.
- **One path for expected dates.** Every expected-date change goes through the reschedule engine's `writeRescheduleChange` (history + `RESCHEDULE_DRAWING` audit + count). This covers the dialog, PATCH, bulk, and a changed source plan on re-import.
  - The baseline is never written after creation.
  - Released drawings are skipped, including as FS/SS/FF successors.
- **Edit protection.** User-edited fields are recorded in `user_edited_fields`. Re-imports keep them and log `FIELD_PROTECTED_USER_EDIT`. This applies to both the PoaRR importer and the Violet Hill importer.
- **Revisions** are only ever added.
  - Mark as Released stamps the revision row with actual date, released by, released at and remarks.
  - Releasing a newer revision of a released drawing keeps the drawing's first actual date.
- **Two dependency tables, kept separate:**
  - Department/task dependencies (`drawing_dependencies`: department, owner, description, target, closure, OPEN/CLOSED, remarks, manual, source).
  - FS/SS/FF scheduling links stay in `dependencies`.
- **Design Deliverables PoaRR.xlsx** is not imported, and no links were fabricated.

## 6. Permissions

| | Viewer | Editor | Manager | Admin |
|---|:-:|:-:|:-:|:-:|
| drawing.read | ✓ | ✓ | ✓ | ✓ |
| drawing.write | | ✓ | ✓ | ✓ |
| drawing.complete | | ✓ | ✓ | ✓ |
| drawing.reschedule (new) | | ✓ | ✓ | ✓ |
| drawing.admin (new): import, conflicts, withdraw release, delete manual never-released drawings | | | | ✓ |

- `/api/reschedule` checks `drawing.reschedule` for drawings. `schedule.reschedule` is still required for other entities.
- Controls are rendered only for the permission they need, and the API checks the same permission again.

**Audit actions:** CREATE_DRAWING, UPDATE_DRAWING, RELEASE_DRAWING, UNRELEASE_DRAWING, DELETE_DRAWING, CREATE_REVISION, UPDATE_REVISION, ADD_DEPENDENCY, UPDATE_DEPENDENCY, DELETE_DEPENDENCY, RESCHEDULE_DRAWING, RESOLVE_CONFLICT.

## 7. The 8 Stage-1 defects — all fixed

1. **Expected date via PATCH / bulk.** Now goes through the reschedule engine, and a reason is required.
2. **`/api/bulk` permissions.** Now requires the per-entity/action permission as well as `bulk.update`. Drawing release, withdrawal and revision in bulk go through the Drawing Control service.
3. **GOAL scope on drawings.** Now rejected with a clear error, and the dialog no longer offers GOAL for drawings.
4. **Violet Hill importer.** Honours `user_edited_fields`, logs FIELD_PROTECTED_USER_EDIT, and matches on project + number.
5. **Schedule-status filter.** Now applied in SQL before paging; a test holds the SQL and TypeScript logic together.
6. **Drawing number display.** Shows the full number, with "Not yet numbered" and the sheet number for unnumbered drawings. Phase is shown; the export is corrected.
7. **Viewer controls.** Viewers see no edit, release or reschedule controls on the register, detail page, Update Centre or Drawing Control.
8. **`quality.ts` drawing findings.** Now carry drawing-specific codes: `DRAWING_RELEASED_DATE_NOT_RECORDED` (INFO, has evidence), `DRAWING_RELEASED_NO_DATE_NO_EVIDENCE` (WARNING) and `DRAWING_ACTUAL_DATE_WITHOUT_RELEASE`.

## 8. Verification

- **Tests:** 189/189 pass — 147 existing plus 42 new drawing tests across 4 files (import, control, RBAC through the real route handlers, and rollback).
  - One existing assertion was updated by name: the completion-column table list now includes `drawing_revisions`.
  - `vitest.config.ts` now runs files alphabetically; the FY26 tests already assumed that order.
- **E2E:** 94/94 checks pass, including 31 new drawing checks.
  - Legacy check 17 now verifies that the percentage is re-derived from the counts. With about 15,000 items, one completion moves it by less than 0.1%.
- **Build:** production build (`.next-prod`) OK.
- **FY26:** unchanged, with no FY26 files modified. The FY26 tests (54) and E2E checks (29) pass.

## 9. On your machine

1. Set `PG_BIN_DIR` in `.env`. It is still empty from the FY26 step.
2. `npm run backup`
3. `npm run db:setup` — this applies 0001 (FY26) and 0002 (drawings) if they have not been applied yet. The launcher also auto-applies them, so back up before launching.
4. If not done yet: `npm run fy26:import -- --preview`, then `-- --apply`.
5. `npm run drawings:import`, which previews and must print "all targets matched".
6. `npm run drawings:import -- --apply`
7. Optional: `npm test` and `npm run e2e`. Run e2e on a restorable database: it leaves one "A-T8-E2E-…" drawing with a withdrawn release, which cannot be deleted by design.
