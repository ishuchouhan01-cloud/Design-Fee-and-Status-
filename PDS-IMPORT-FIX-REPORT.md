# Project Drawing Status: packages not linking, data not accurate (05-Oct-2026)

**Scope.** The copy only (`project-drawing-status`, port 3100, database `project_drawing_status`). The original app in `..\design-control` was not touched.

**Version control.**
- Git tags: `v2026-10-05-before-pds-import-fix` before the work, `v2026-10-05-pds-import-fix` after it.
- The launcher saved the update as version `v20261005-184828` (`.versions`, `ROLLBACK.bat`).
- Database backups were taken before every step that changed data (`backups/design-control-2026-10-05T*.dump`).

**Detailed reports** are in `import-reports/` (kept out of git):
- `import-diagnose-2026-10-05-before.md` and `-after.md`: the dry-run diagnostic.
- `import-centre-dry-run-*.txt` and `import-centre-apply-*.txt`: the Import Centre runs.
- `reconciliation-2026-10-05.md`: Excel ⇄ database ⇄ screen.
- `screen-rules-2026-10-05.md`: rows hidden and billing left out.
- `db-snapshot-*` and `porr-vh-plan-fingerprint-*`: before/after evidence for PoRR and Violet Hill.

## 1. Root causes and fixes

### 1. The second Design Fee layout was not understood

**Cause.** These sheets carry the package code with the sheet's department prefix (`AR-BB26-2`). The parser only accepted a bare code (`BB26-2`), so every real package row was dropped. Each heading row instead became a "package" through the rule that a coded heading with a fee and nothing below it is a package: `BB26 | GFC | Villa Block 26`, `MP | GFC | Master Plan` and so on.

**Fix (`design-fee.ts`).**
- A new layout, **PACKAGE_TOTAL**, is found from its header labels, never from fixed columns. It needs a `Balance` column with a `Total Fee` / `Total` / `Fee` column before it, both left of any discipline block.
- Package rows may carry a discipline prefix: `AR-BB26-2` becomes package `BB26-2`. The source line code is kept for traceability.
- In this layout headings stay headings. Spaced codes such as "DC 01" are design-stage lines, not packages.
- The sheet's own total row ("Design Fee(s)", or the unlabelled second row under the header) gives Total and Billed.
- **Billed** is the "Billed / Billing till Dec'yy" column when the sheet has one; the till-date column is then kept as **Released Till Date**. Without such a column, the till-date column is Billed.

**Important finding.** Most of these 12 sheets also carry per-discipline blocks to the right (AR · ST · MEP · LS, each with Fee / Billing YTD). In 9 of the 12 those blocks add up to the package fee. Their "Billing YTD" is the released value, not "Billed till Dec'25".

PoRR's own sheets have the same Total / Balance column set. Tower 08's header is identical to AtR Phase 2c's, so no label rule can separate them. The layout is therefore an explicit choice:
- **AUTO** (the default): one fee per package whenever the column set exists. This is your rule, and all 12 workbooks use it.
- **PoRR / Violet Hill:** the committed manifests (`data/drawing-sources/*.json`, which are data, not code) pin `"layout": "DISCIPLINE_BLOCKS"`.
- **Import Centre:** a project whose fees are already stored per discipline keeps that layout on re-import. The user can choose either layout on the screen, which also shows whether the discipline blocks add up.

### 2. Batch → package linking stripped the prefix on one side only

**Fix (`design-fee.ts` `packageCodeForBatch`).**
- The discipline or department prefix (AR, ST, MEP, LS, LDS, UD, SR, PHE, ELE, IBMS, ID, INFRA) is removed on both sides, so `ST-BB26-2`, `MEP-MP-1`, `UD-MP-2` and `AR-PDV30-1` all link.
- The existing rules stay: number padding, the heading fallback, the group-ordinal rule.
- New: location padding, used only when exactly one package matches (`T09-3` → `T9-3`).
- Every unmatched batch is logged with its count (`BATCH_WITHOUT_FEE_PACKAGE`).

### 3. Fee sheet selection

The Design Fee sheet is now chosen deterministically (`feeSheetCandidates` / `chooseFeeSheet`). The order is:
1. a sheet that reads and has package rows;
2. a visible sheet before a hidden one;
3. the latest "Billed till Dec'yy" year;
4. the highest revision ("R (3)" > "R (2)" > "R" > "Design Fee");
5. the name.

**Deviation from your rule (highest R (n) first), on purpose.** In SFTW, "Design Fee R (3)" is hidden and billed till Dec'23, and "Design Fee R (2)" is an old rupee layout. The visible "Design Fee" (billed till Dec'25) is the current sheet. In TUIG, the hidden "Design Fee" (Dec'24) loses to the visible "Design Fees" (Dec'25).

The dry run and the Import Centre show the sheet used and the alternatives, and the user can pick another (remembered per project). A sheet that cannot be read is reported as `DESIGN_FEE_LAYOUT_NOT_READ`; the drawings still import. SFTW imports.

### 4. Disciplines

- `SR` is now a discipline token, and migration 0010 adds the discipline **SR "Services"** with `dfs_group` MEP. In AtR's "Drawing List | SR" sheets the rows say MEP, and the batches are `MEP-…`.
- UD maps to AR, and PHE / ELE / IBMS to MEP, as before.

### 5. Billing for the one-fee layout

**Migration 0010 (additive).** New columns `packages.fee_value`, `billed_to_date_value`, `released_to_date_value` and `balance_value`.
- Total is Total Fee; Billed is Billed till Dec'yy; Released Till Date and Balance are kept as source values.
- The fee is never split over disciplines. It shows on the package row; its discipline rows show no amount.
- Edit Mode (Billing view) edits it on the package row, audited, and a later import keeps the edit.
- Roll-ups stay "each package once". The DFS Summary (Super Admin) shows a "Whole package (one fee)" line.

### 6. Project names and hierarchy

- **Import Centre:** the sheet title ("0072 | After the Rain Phase 2c") is the default full name of a new project. Choosing "Part of" shortens it ("After the Rain" + "After the Rain Phase 2c" becomes "Phase 2c").
- **Live database:** names and parents were set with a Project List, `data/project-sources/project-list-dfs-2026.xlsx`, imported through the Import Centre service. It only fills names and parents and creates the missing projects. The resulting tree:

| Project | Phases under "Part of" |
|---|---|
| After the Rain | Phase 1, 2A & 2B · Phase 2c · Phase 03 · Commercial |
| In That Quiet Earth | Phase 1 · Phase 2A · Phase 2B · Phase 2C |
| Over the Rainbow | Phase 1 |
| Songs From The Wood | (none) |
| Down By The Water | (none) |
| Tangled up in Green | (none) |

**Files changed.**
- Import: `src/lib/import/drawing-register/{design-fee,parse,plan,apply,manifest}.ts`, `src/lib/import/centre.ts`, new `src/lib/import/centre-manifest.ts`.
- Screen and API: `src/components/import-centre.tsx`, `src/app/api/import-centre/{inspect,run}`.
- Database: `src/db/schema.ts`, `src/lib/seed.ts`, `drizzle/0010_package_fee_line.sql`.
- Data: `data/drawing-sources/{poarr,violet-hill}.json` (layout pinned), `data/drawing-sources/dfs-2026-import.json` (the run list), `data/project-sources/project-list-dfs-2026.xlsx`.
- Scripts: `scripts/import-diagnose.ts`, `import-centre-run.ts`, `import-reconcile.ts`.
- Tests: `tests/drawings-h-fee-layouts.test.ts`.

## 2. Per workbook, before → after (dry run, same workbooks)

| Workbook | Fee sheet used | Packages before → after | Drawings | Linked before → after | Unlinked batches (count) |
|---|---|---|---|---|---|
| AtR Phase 1, 2A & 2B | Design Fee | 30 (headings) → **90** | 4,861 | 0 → **4,838 (99.5 %)** | 16: LS-BB23 ×6, Villa 216 ×3, Villa 106 ×1, HA-V35/V43/V50a-… ×9 (drawing numbers typed as batches), ST-BB26-2 / BB27-2 / BB28-2 / BB29-2 ×1 each (blocks of Phase 2c / 03) |
| AtR Phase 2c | Design Fee | 11 → **33** | 702 | 0 → **702 (100 %)** | none |
| AtR Phase 03 | Design Fee | 11 → **47** | 674 | 0 → **644 (95.5 %)** | UDLS-MP-3 ×29 (the sheet numbers Master Plan MP-1, MP-2, **MP-6**, MP-4: there is no MP-3), AM-CH-3 ×1 |
| AtR Commercial | Design Fee | 3 → **14** | 1,974 | 939 (to headings) → **1,937 (98.1 %)** | AR-BB05-7 ×37 (no BB05 in the Commercial sheet) |
| ITQE Ph 01 | Design Fee R | 0 → **58** | 3,430 | 0 → **3,394 (99.0 %)** | MEP-U20-1 ×18, MEP-H20-1 ×14 (the sheet numbers them U20-2 and H20-3), AR-MA-1 ×4 (archives have no package row) |
| ITQE Ph 02a | Design Fee | 0 → **17** | 616 | 0 → **613 (99.5 %)** | AR / MEP / ST-MA-1 ×1 each |
| ITQE Ph 02b | Design Fee R | 0 → **43** | 2,347 | 0 → **2,280 (97.1 %)** | MEP-EB-3 ×55, MEP-EB-2 ×4, MEP-EB-5 ×4 (no block number), A-MA-1 ×3, MEP-MA-1 ×1 |
| ITQE Ph 02c | Design Fee | 75 (incl. 6 "DC" stage lines) → **69** | 1,144 | 1,110 → **1,144 (100 %)** | none |
| OTR Ph1 | Design Fee | 0 → **25** | 524 | 0 → **520 (99.2 %)** | "AR -MA-1", LS / MEP / ST-MA-1 ×1 each |
| SFTW | Design Fee | **import failed** → **57** | 2,956 | — → **2,956 (100 %)** | none |
| DBTW | Design Fee | 11 (headings) → **77** | 1,753 | 1,006 → **1,752 (99.9 %)** | one drawing without a batch |
| TUIG | Design Fees | 6 → **9** | 1,567 | 0 → **1,566 (99.9 %)** | LS-AM- ×1 (no number) |
| **All** | | 147 → **539** | 22,548 | 4,055 → **22,346 (99.1 %)** | |

Every package row of every fee sheet is read: the database package count equals the number of distinct package codes counted directly on the sheet (check 1 in §4).

## 3. Live database: what was undone and imported

**Import history before.** The two runs made today with the broken importer were:
- `dib_0muv2ge4hp3bqb3kt` (AtR: 4,861 drawings, 30 heading-packages);
- `dib_0muv227ywcypj87y9` (AtR - C: 2,023 drawings, 2,007 of them "not yet numbered", 3 packages).

**Undone.** Both were undone with the Import Centre's undo, latest first. Every drawing, package and fee line they created was removed. Nothing had been edited since, so nothing was kept.

**Project List.** `project-list-dfs-2026.xlsx` was applied: 4 projects created (After the Rain Phase 1, 2A & 2B, Phase 2c, In That Quiet Earth, Over the Rainbow), 11 updated.

**Imports.** All 12 workbooks were imported through the Import Centre service (`npm run import:centre`), dry run first and then the import. Each went into its own project, so drawing ids stay unique per project + number.

**Issues read in the dry runs.**
- NUMBER_TITLE_CONFLICT: the same number with different titles. These are held as conflicts and not imported. SFTW 92, ITQE Ph 01 39, ITQE Ph 02c 21, Commercial 16, AtR 10, ITQE Ph 02b 10, TUIG 3.
- The unlinked batches above.
- DUPLICATE_PACKAGE_CODE ×4 in ITQE Ph 02c.
- Location → phase notes (there is no phase map).

**PoRR / Violet Hill are unchanged.** Their import plans are byte-identical before and after the fix: drawings, links, packages, fees, headings and issues. Their database rows are identical to the snapshot taken before (drawings, released, linked, packages, headings, fee sums, and an md5 over every drawing's id, status, package and discipline).

What changes on their screens comes only from rules A and B in §5:
- PoRR: 174 → 163 packages counted;
- Violet Hill: 24 → 5;
- billing excludes lines with no released drawing.

## 4. Reconciliation against the Excel (live database, after import)

Check results: all **86 checks OK**.
- Packages in the database = package rows of the fee sheet.
- Drawings and released drawings = the drawing lists.
- Excel Total = fees on packages + fees outside packages.
- Stored = Excel package fees; stored Billed = Excel Billed on packages.
- Stored = shown + left out.
- Every parent = the sum of its children (2,164 rows).
- Header = the sum of the top rows.

Amounts are in ₹ Cr.

| Project | Package rows (Excel) | Packages (DB) | Shown | Drawings (Excel = DB) | Released (Excel = DB) | Excel Total | On packages | Outside packages¹ | Shown Total | Left out² | Excel Billed | Billed on packages | Shown Billed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AtR · Phase 1, 2A & 2B | 90 | 90 | 89 | 4,861 | 4,853 | 24.2189 | 13.7242 | 10.4946 | 13.7238 | 0 | 22.7401 | 12.2455 | 12.2451 |
| AtR · Phase 2c | 33 | 33 | 30 | 702 | 677 | 3.1825 | 1.7860 | 1.3965 | 1.6262 | 0.1595 | 2.8336 | 1.5066 | 1.5063 |
| AtR · Phase 03 | 47 | 47 | 24 | 674 | 313 | 3.8327 | 2.2660 | 1.5668 | 1.0669 | 1.1993 | 0.1208 | 0.0759 | 0.0759 |
| AtR · Commercial | 14 | 14 | 14 | 1,974 | 1,663 | 9.8346 | 5.4026 | 4.4321 | 4.4665 | 0.9361 | 5.9509 | 2.8598 | 2.8599 |
| ITQE · Phase 1 | 58 | 58 | 56 | 3,430 | 3,424 | 37.7390 | 19.4671 | 18.2720 | 18.8457 | 0.6216 | 35.4067 | 19.4432 | 18.8219 |
| ITQE · Phase 2A | 17 | 17 | 14 | 616 | 612 | 5.4175 | 2.4767 | 2.9408 | 2.4767 | 0 | 5.1011 | 2.4767 | 2.4767 |
| ITQE · Phase 2B | 43 | 43 | 43 | 2,347 | 2,190 | 21.2287 | 12.3703 | 8.8584 | 11.0870 | 1.2834 | 14.6217 | 6.4838 | 6.4486 |
| ITQE · Phase 2C | 73 (69 distinct) | 69 | 69 | 1,144 | 26 | 61.2941 | 31.2459 | 30.0482 | 0.2794 | 30.9666 | 0 ³ | 0 | 0 |
| OTR · Phase 1 | 25 | 25 | 10 | 524 | 464 | 4.6886 | 2.4107 | 2.2779 | 2.4107 | 0 | 2.9623 | 1.0236 | 1.0237 |
| Songs From The Wood | 57 | 57 | 44 | 2,956 | 2,733 | 25.0046 | 12.8824 | 12.1222 | 12.3604 | 0.5220 | 0 ⁴ | 10.4585 | 10.4586 |
| Down By The Water | 77 | 77 | 71 | 1,753 | 801 | 49.7771 | 25.8450 | 23.9320 | 17.9011 | 7.9441 | 13.6502 | 0 ³ | 0 |
| Tangled up in Green | 9 | 9 | 9 | 1,567 | 1,301 | 13.5202 | 7.1222 | 6.3981 | 7.1221 | 0 | 9.0540 | 3.3359 | 3.3359 |

¹ Design-stage fees (Contract + Brief, Concept, Approvals, …), archives and rework lines that are not drawing packages, plus repeated codes. They are reported, not imported, as for PoRR.
² Fee lines with no released drawing (rule B). Stored = shown + left out; a difference of ±0.0001–0.0004 comes from per-line rounding to 4 decimals.
³ The sheet's "Billed till Dec'yy" column is older than the plan (ITQE Ph 02c: Dec'23; DBTW: Dec'24) and holds 0 on every package. The Released Till Date is stored (ITQE Ph 02c 11.99, DBTW 11.62).
⁴ SFTW's own top-row "Billing till Dec'25" total is 0, while its package rows add up to 10.4585. This is a source defect, reported.

**Whole view.** 376 of 641 packages complete · 32,933 of 37,062 drawings released · Total ₹ 144.1709 Cr · Billed ₹ 101.8891 Cr · Unbilled ₹ 42.2818 Cr.

**Billing view reconciliation.** Fee lines as stored ₹ 201.9228 Cr = shown ₹ 144.1709 Cr + left out ₹ 57.7519 Cr. Billed: ₹ 105.5184 Cr = ₹ 101.8891 Cr + ₹ 3.6293 Cr.

## 5. Screen changes A–C

**A. Empty verticals hidden.** A discipline, package, heading or project with no drawings is not shown and counts nowhere: status, "x complete · y pending", "of y", Drawings Released, the Project / Discipline filter options and the exports.
- The data stays.
- Edit Mode has a **Show empty rows** switch (off by default). Empty rows then show greyed with "No drawings" and are still not counted.
- Hidden per project:

| Project | Discipline rows | Packages | Headings |
|---|---|---|---|
| PoRR | 369 | 12 | 3 |
| Violet Hill | 87 | 19 | 1 |
| After the Rain | 0 | 27 | 6 |
| In That Quiet Earth | 0 | 5 | 0 |
| Over the Rainbow | 0 | 15 | 4 |
| SFTW | 0 | 13 | 1 |
| DBTW | 0 | 6 | 0 |
| TUIG | 0 | 0 | 0 |

- A Not Applicable discipline has no drawings by definition, so it now appears only with "Show empty rows".

**B. No billing without released drawings.** There is one rule, in `src/lib/services/billing-rollup.ts`, used by the screen, the Billing view and the exports.
- A fee line (a discipline line or a whole-package line) with no released drawing shows "—". It is left out of every parent and the header. Stored values are unchanged.
- **Billing to review** (Billing view, Admin / Super Admin, and a sheet in the Excel export) lists the billed lines left out, with project, package, discipline, Total, Billed and reason "No drawings released". There are 75 lines:

| Project | Lines | Billed (₹ Cr) | Total left out (₹ Cr) |
|---|---|---|---|
| PoRR | 70 | 2.9720 | 11.0728 |
| In That Quiet Earth | 5 | 0.6573 | 32.8716 |
| Violet Hill | 0 | 0 | 3.0465 |
| After the Rain | 0 | 0 | 2.2949 |
| DBTW | 0 | 0 | 7.9441 |
| SFTW | 0 | 0 | 0.5220 |

- "Eligible to bill after completion" stays on pending packages with released drawings.

**C. Expand to.** The control offers Projects · Phases · Towers / Products · Packages · Disciplines · Drawings, plus Collapse All.
- The choice is kept per user (localStorage, guarded with try/catch) and restored on load.
- Each level opens exactly that depth and follows the filters and search. A project without phases goes straight to its towers.
- "Drawings" opens per discipline row (50 at a time). With more than 2,000 drawings it opens to Disciplines and says "Narrow the filter to open all drawings" with the count.
- Every row shows its tag: Project, Phase (or Tower / Product by name), Tower / Block / Villa / Product / Group, Package, Discipline. A single row's ▸ still opens one level.

**Checked in the browser at http://localhost:3100.**
- **Viewer:** no billing anywhere.
- AtR → Phase 2c → Villa Block 26 → Super Structure (BB26-2) is **Complete**, 86 of 86, with drawings listed. Phase 2c's lists have only Structural drawings for BB26-2, so there is no Architecture row.
- **Admin:** billing matches the sheet (Phase 2c ₹ 1.6262 / 1.5063 Cr).
- PoRR → Tower 01 → Penthouse Levels shows Architecture and Structural only. Its billing (₹ 0.1722 Cr) leaves out the MEP line (₹ 0.0239 Cr billed), which is listed under Billing to review.
- "Show empty rows" brings back MEP (Pending, No drawings, —) and Landscape (Not Applicable).
- Each Expand-to level opened to exactly its depth. "Drawings" on the whole view fell back to Disciplines (37,062 drawings); filtered to Phase 2c it opened the drawings.
- **Super Admin:** every module opens (Design Goals FY26, DFS, Import Centre, Schedule, Goals).
- The Import Centre shows SFTW's fee sheet choice with the alternatives.

## 6. Checks

| Check | Result |
|---|---|
| `npm test` (against `project_drawing_status_test`) | **317 of 317 passed**, 23 files |
| New tests | `drawings-h-fee-layouts` (both layouts, prefix linking, padding, sheet choice, unreadable sheet, SR, Import Centre manifest); `z-pds-c-screen-rules` (empty rows hidden and not counted, status ignores them, a 0-released line excluded and listed under review, parent = sum, header = sum, source = shown + left out, every Expand level, Viewer gets no billing) |
| Updated tests | for the new rules (`z-pds-b-status`, `drawings-e-dfs`, `drawings-f-centre`) |
| Pre-existing failure fixed | the `migration.test` "no project-specific code" check had already failed on `src/app/schedule/page.tsx`, which defaulted to `VIOLET-HILL`; it now defaults to the first project |
| `npm run typecheck`, `npm run lint`, `npm run build` | clean |

## 7. Still unresolved in the source workbooks

- **Batches that match nothing** (§2): about 200 drawings in all.
  - The archives batches `…-MA-1` have no package row in ITQE, OTR or AtR Phase 1 / 2A / 2B.
  - ITQE Ph 01 numbers `U20-2` and `H20-3`, while the MEP batches say `-1`.
  - ITQE Ph 02b has `MEP-EB-n` with no block number.
  - AtR Phase 03 has `MP-6` where `MP-3` is expected.
  - AtR Commercial has `AR-BB05-7`.
  - AtR Phase 1 / 2A / 2B has drawing numbers typed as batches (`HA-V…`), plus `ST-BB26..29-2`, which belong to Phase 2c / 03.
  - Nothing was guessed.
- **Duplicate codes:** ITQE Ph 02c repeats `T9-6`, `T10-6`, `T11-6` and `T12-6` ("Habitable Level 21+"). The first row is the package; the repeats (₹ 0.7886 Cr) are reported.
- **Billed columns:** ITQE Ph 02c and DBTW have older "Billed till Dec'yy" columns that are 0, and SFTW's top Billing total is 0 (§4).
- **Same number, different titles:** 191 conflicts across the workbooks, held for an admin to resolve.
- **Not changed (Super Admin):** the Year / Quarter view still counts per-discipline lines only. The whole-package fees appear in the DFS Summary, not in the Year / Quarter spread.
