# DFS, Drawing Control, DFS Summary and billing: master implementation report

Date: 28-Sep-2026. The stack is unchanged (Next.js 15, TypeScript, Drizzle, PostgreSQL 16, existing RBAC and audit). Design Goals FY26 was not touched. This report supersedes `DFS-IMPLEMENTATION-REPORT.md`.

## Result

| Check | Result |
|---|---|
| TypeScript (`tsc --noEmit`, strict) | Clean |
| Automated tests (`npm test`) | **228 / 228 passed**. `drawings-e-dfs.test.ts` now has 39 tests. |
| Production build (`next build`) | Compiled successfully |
| End-to-end check (`npm run e2e`, live server) | **125 / 125 passed** |
| Acceptance, spec §39–45 (real browser plus API) | **28 / 28 passed** |
| Lint | The project has no ESLint configuration. Strict type-checking and the build's own checks stand in for it. |

The working database was backed up before each step, and was restored after the e2e and acceptance runs. What it keeps is migration 0004 and the corrected re-import.

## 1. Root cause of the V40 hierarchy problem

The importer never read the hierarchy of the base DFS. It placed packages using drawing codes instead.

- **Phases came from location codes.** A package's phase was worked out from its location code, through the drawing location → phase map (built from the Goals workbook's project "phases": `Res`, `T1`–`T7`, `T4_Stepped`, `V40` …).
  - V40 therefore became a **Phase** of its own.
  - Its sibling products (C20, L30, L45, V50, R11, R22 and the P variants) fell into phase `Res`.
  - Towers became phases (T1, T2 …). Tower—2S, 3V-5V, 3S-5S and 6S had "no phase".
- **The groups were read but not kept.** The Design Fee sheet's own group headings (`GFC | Tower—01`, `GFC | Individual Homes`, `GFC | Independent Subgrade Structure—Block 04` …) were only kept as a single "heading" string and never stored.
  - The Block sub-headings (outline 2.1–2.12) were not recognised at all.
  - `packages.package_group` held only the section name ("CONSTRUCTION DOCUMENTS").
- **The tree was flat.** The DFS tree was a generic *Project → Phase → Discipline → Package*.
- **Unmatched batches became generic "Batch" rows.** A drawing whose batch code did not match a DFS package appeared as a "Batch — no fee package" row. This happened for five V40 MEP drawings that the source mis-batched as `MEP-V41-1` … `MEP-V45-1`. They sit under the drawing-list heading "Individual Home V40", and their numbers are `ELE-V40-…`.

## 2. How the parser was corrected

The fix is generic. There is no V40-, tower- or project-specific code.

1. **Headings become WBS nodes** (`src/lib/import/drawing-register/design-fee.ts`).
   - Reading down the Design Fee sheet, a **stack follows the source outline**.
   - A heading row is a label with an outline number or its own group code before it (`9`, `2.4`, `BB01`, `PD`), or a roll-up row carrying fees.
   - It becomes a node under the open heading one level up: outline `2.4` nests under `9`; a "Phase …" heading, where a DFS has one, sits above everything.
   - A section row (`CONSTRUCTION DOCUMENTS`, `POST-CONSTRUCTION`, `MAJOR REWORKS`) closes the open groups.
2. **Packages hang under their heading.** Each coded row becomes a package under the heading it sits beneath, keeping its position number (`ordinal`).
3. **Node types come from rules.** The manifest's `dfsHierarchy.nodeTypes` rules apply first, then plain construction words (Phase, Tower, Block, Villa, Individual Homes / Product), else Group.
4. **Names and traceability.**
   - The stage prefix in `dfsHierarchy.labelPrefix` (`GFC | `) is dropped from the node name.
   - The source label is kept, along with workbook, sheet, row and import batch.
5. **Only real headings are kept.** Headings that hold no package (design-concept stages, post-construction) are not nodes. A heading that repeats at the same level is logged (`WBS_DUPLICATE_HEADING`).
6. **Drawing → package** (`plan.ts`):
   - **Batch rule first.** The explicit batch rule (`AR-T01-1` → `T01-01`, `BB01-2` → `BB01-2`) is unchanged.
   - **Heading as fallback.** Only when the batch names no DFS package, the drawing-list heading the drawing sits under is used: `parse.ts` now keeps each row's last four heading rows.
     - It links **only if the heading names exactly one package**, by full code or by a location token of 3+ characters as a whole word.
     - Each link is logged as `BATCH_RESOLVED_BY_DFS_HEADING`.
   - **Otherwise the drawing stays unmapped, with an issue.** This applies to a batch marked `-NA`, to a heading naming several packages (`DRAWING_PACKAGE_AMBIGUOUS`), and to no match at all (`BATCH_WITHOUT_FEE_PACKAGE`).
7. **Phase and re-imports.**
   - A package's phase now comes only from a PHASE heading of its DFS. The location → phase inference for packages is gone, so `UNMAPPED_PACKAGE_PHASE` no longer occurs.
   - The import validates the node count per project (`expected.wbsNodes`).
   - On re-import, a node is updated in place, keyed on its source path.

## 3. How the WBS hierarchy is represented

- `dfs_wbs_nodes` holds one row per base-DFS heading:
  - `parent_id` (self-reference) preserves the source tree.
  - `node_type` is PHASE | TOWER | PRODUCT | BLOCK | VILLA | GROUP.
  - The row also holds `name`, `code`, `source_label`, `node_key` (the stable source path), `sequence`, the source workbook / sheet / row, `import_batch_id` and `user_edited_fields`.
- `packages.wbs_node_id` places each package under its node.
- Disciplines and drawings hang off the existing package: `package_fees` holds the per-discipline scope, and `drawings.package_id` / `discipline_id` place the drawings. Nothing is duplicated.

The result in the working database:

- **POARR-RES — 19 nodes**
  - Tower—01, Tower—2V, Tower—2S, Tower—3V-5V, Tower—3S-5S, Tower—6V, Tower—6S, Tower—07
  - Independent Subgrade Structure [Tower 1-7], with Block 01, 02, 03, 04 and 09 nested under it
  - Villas—Cluster 1 & 2 and Villas—Cluster 3
  - Individual Homes: C20-01, L30-01, L45-01, V50-01, **V40-01**, R11-01, R22-01, C20P-01, L30P-01, L45P-01
  - Master Plan
  - Amenities & Facilities
- **POARR-T08 — 5 nodes**
  - BB01 Tower—08
  - BB02 Independent Subgrade Structure - Tower 8
  - PD Individual Homes: R25-1, L20-1 (which holds the L20B drawings), D35-1, L22-1 and the P variants
  - MP Master Plan
  - AM Amenities & Facilities

## 4. Database / schema changes

Migration `drizzle/0004_silent_red_ghost.sql` is additive. The SQL was inspected before applying, and the migration test asserts its contents:

- `CREATE TABLE dfs_wbs_nodes`, with its foreign keys to projects (cascade) and to itself (set null), a unique index on (project_id, node_key), and indexes on parent and project.
- `ALTER TABLE packages ADD COLUMN wbs_node_id`, with a foreign key (set null) and an index.

No table was dropped or renamed. No FY26 table was touched, and FY26 row counts are unchanged (tested).

## 5. DFS UI

- `/drawings` (and `/dfs`) opens the tree: **Project → [Phase] → Tower / Product / Block / Villa / Group → Package → Discipline → Drawings**.
  - Every level can be expanded and collapsed, and "Expand to packages" and "Collapse all" are available.
  - Each node shows its source name and a type badge; T08 nodes also show their code.
- **Package rows** show the code, the source name, ✓ Complete / Pending / NA, and the release: the actual date, the source evidence, or the expected date.
- **Counts:** discipline packages complete / applicable, and drawings released / total.
- **Drawings the DFS does not place** are shown under **"Not mapped to the base DFS"**, with no generic "Batch" labels.
- **Filters:** project, tower / group (a WBS node), discipline, package status, drawing release and schedule status.
  - The tabs are **DFS · DFS Summary · Year / Quarter · Drawing list**.
  - The drawing KPIs (total, released, due soon, delayed, released this week / month) now appear only on the Drawing list tab.

## 6. Drawing-level UI

When a discipline is expanded, its drawings load (100 at a time) as a compact register. The columns are:

- Drawing name
- Drawing code / number
- Revision
- Discipline
- Updated on
- Status (RELEASED / NOT RELEASED)
- Release date: the actual date, or "Not recorded · <evidence>"

**Updated By is not shown.** The drawing-level reference screenshot was not attached in this session, so the layout follows the listed fields and the existing design system.

## 7. DFS Summary changes

- **Scope of the page:** KPIs plus two expandable tables. Project ▸ Architecture / Structural / MEP / Landscape is expanded by default when one project is selected.
- **Package summary:** Packages · Complete · Pending · Overall, where Overall = Complete ÷ Packages.
- **Removed:** Description, NA, Release %, Delayed, Release not recorded and all drawing-level metrics.
- **Billing:** Total · Billed · Unbilled, with rows for the project and the four disciplines. There are no package-level rows.
- **Where the old tab went:** the former SNK Billing tab is now this billing section, and `?view=billing` opens the Summary.
- **Current working-database values:**

  | Project | Packages | Complete | Pending | Overall | Total (Cr.) | Billed (Cr.) | Unbilled (Cr.) |
  |---|---:|---:|---:|---:|---:|---:|---:|
  | POARR-RES | 266 | 199 | 67 | 74.8% | 39.3169 | 33.0688 | 6.2481 |
  | POARR-T08 | 76 | 26 | 50 | 34.2% | 16.0697 | 4.6783 | 11.3914 |

## 8. Package completion logic

- A **discipline package** (package × discipline) is COMPLETE when every drawing in it is RELEASED, and PENDING otherwise.
- **NA** applies only when explicitly not applicable. It is never counted as complete.
- A package row's own status is complete when all of its applicable disciplines are.
- **Counting follows the source's own package summary:** discipline packages, each counted once. So Packages = Complete + Pending, a node or project equals the sum of its children, and a project equals the sum of its disciplines.
  - Check against the source's *Pkgs Summary*: Tower—01 has 22 packages in both.
- Unmapped drawings are drawings, not packages.

## 9. Billing logic

- **Total** = Scope, the discipline package's Design Fee (`package_fees.fee_value`).
- **Billed** = Actual: the Total of complete discipline packages, derived and never stored.
- **Unbilled** = Total − Billed.
- Each package contributes exactly once, then rolls up to discipline and project.
- Scope is never overwritten. There is no billing date. The source's own billed-to-date is kept for reconciliation only.

## 10. Drawing Control changes

- Unchanged workflows and RBAC:
  - **Viewer:** `drawing.read`.
  - **Editor / Manager:** read, write, complete, reschedule.
  - **Admin:** all of the above, plus import, conflicts and NA.
- The drawing page now shows its **DFS position**, for example "Individual Homes › V40-01 — V40 Default and it's variants". An unplaced drawing shows "Not mapped to the base DFS".
- Every change appears in DFS automatically, because nothing is cached. This was verified end to end: edit, revision, dependency, reschedule and release (from the Drawing Control UI), then the package completes and the Summary moves by Complete +1 and Billed + that package's Total.
- **The 8 earlier defects remain fixed and tested** (`drawings-b-control`, `drawings-c-rbac` and e2e):
  1. An expected-date PATCH goes through the reschedule engine, with history and audit.
  2. Bulk updates enforce the drawing permissions.
  3. The GOAL reschedule no longer references `drawings.goal_id`.
  4. Import protects user-edited fields; this now also covers package and NA.
  5. The schedule filter is applied in SQL before pagination.
  6. Drawing code, number and phase are labelled separately.
  7. A Viewer sees no edit, complete or reschedule controls.
  8. The quality finding code and message are correct.
- **Filter bar:** "Clear filters" keeps the current tab.

## 11. Migration / re-import performed (working database)

1. Took a backup, then applied 0004. Counts were unchanged: 14,514 drawings, 174 packages, 435 FY26 packages.
2. Previewed the import, then applied it. **Validation: every target matched.** The drawing totals are unchanged at 14,426 / 13,788 / 638 / 1,362 / 112 + 5 / 1,404.
3. Results:
   - 24 WBS nodes created.
   - 148 fee packages attached to their nodes.
   - 14 drawings re-linked through the heading rule, and 0 created:
     - 5 V40 MEP drawings (source batches MEP-V41…V45 → V40-01).
     - 9 T08 drawings (batches BB03-2, BB04-2 and BB05-2 under heading "BB02-2 Foundations & Grade Slab" → BB02-2).
   - Package phases inferred from location codes were cleared.
   - Drawing ids, revisions, releases, audit and reschedule history were all preserved.
4. A second import updates the same node rows, with the same ids and parents (tested).

**On your computer:**

1. Set `PG_BIN_DIR`, then run `npm run backup`.
2. Run `npm run db:setup` (applies 0004).
3. Run `npm run drawings:import` to preview. Check that it shows `19 WBS headings` for RES, `5` for T08, and `VALIDATION: all targets matched`.
4. Run `npm run drawings:import -- --apply`.
5. Restart the app.

## 12. Tests / results

**New or changed in `tests/drawings-e-dfs.test.ts`:**

- **W (generic parser):** a synthetic new project with a different hierarchy — phases, a tower, villas with a nested type, a block, an empty heading and a repeated code. It checks node types and rules, and the heading resolver's unique / ambiguous / no-match cases.
- **G (hierarchy):**
  - V40-01 sits under Individual Homes with its siblings, and the V41–V45 rows are in V40-01.
  - Tower—01 is a TOWER node with its 10 named packages.
  - The Blocks nest under their group, and the top-level order matches the source.
  - T08 keeps its groups and codes, and L20-1 holds the L20B drawings.
  - No generic batches appear, and disciplines are never promoted to packages.
  - Nodes carry full traceability.
  - Unmapped drawings match the logged issues exactly.
- **C–E and Summary:** node → project → all totals are sums; Packages = Complete + Pending = Σ disciplines; Unbilled = Total − Billed; no package-level rows.
- **Kept, adapted to the new model:** A/B/F (completion ⇄ billing, Scope never written), NA, I (released without a date), J/K (reschedule and baseline), H (RBAC, including the Summary API).
- **L:** the re-import keeps the user package, the NA and identical WBS rows.
- **M:** 0004 is additive only, and FY26 is untouched.

**Other checks:**

- The e2e script was updated for the new tree and Summary: 125 checks.
- The acceptance run covered spec §39–45 in a real browser: 28 / 28.
- Full suite: **228 / 228 passed**.

## 13. Build result

`next build` compiled successfully with every route, including `/drawings`, `/dfs` and `/api/dfs` (`view=tree|summary|periods`). The server builds the whole tree in about 0.2 s.

## 14. Unresolved source-data ambiguity (logged, not guessed)

1. **POARR-RES: 450 drawings are not mapped to the base DFS.** They are shown under "Not mapped to the base DFS" and are never billed:
   - **Combined-tower MEP batches.** The DFS has no package spanning two towers:
     - `MEP-T2V-6V-n` (142)
     - `MEP-T2S-6S-n` (109)
     - `MEP-T01-07-n` (53)
   - **Independent Subgrade Block batches:**
     - `ST-SS4-n` (36): Block 04's packages are coded SS4-02 / SS4-04, so batch number 1 matches no code.
     - `ST-SS9-n` (16).
     - `ST-SS5…SS8` and `ST-S10…S12` (58): Blocks 05–08 and 10–12 in the Design Fee sheet reuse the codes SS1-01 / SS1-02, so they have no package of their own (24 `DUPLICATE_PACKAGE_CODE`).
   - **Landscape villa batches.** `LS-V01-n` (12) and `LS-V03-n` (23) do not match the villa-cluster codes VC1 / VC3.
   - **Explicit NA batch.** `MEP-SDV-NA` (1).
2. **POARR-T08:** 2 drawings in batch `AM-NA` are kept unmapped, because the source marks them NA.
3. **POARR-T09 has no base DFS in the sources** (the Commercial plan is history only). Its 1,499 drawings are listed as not mapped.
4. **14 drawings were linked by heading** (5 RES, 9 T08). They are logged as `BATCH_RESOLVED_BY_DFS_HEADING`, and their batch codes should be corrected in the source.
5. **NA judgement differs from the source in a few cases.** A discipline with no fee but with drawings (e.g. T2S-02 / TXS-02 Architecture) counts as applicable, because it has drawings; the source's Pkgs Summary shows "–". This is why Tower—2S and Tower—3S-5S show 23 packages here against 21 in the source.
6. **Drawing phase is separate from DFS.** A drawing's own `phase_id` (from the approved location map) is kept for the Drawing list and Goals context. DFS no longer uses it.
7. **Missing screenshot.** The drawing-level reference screenshot was not received in this session.
