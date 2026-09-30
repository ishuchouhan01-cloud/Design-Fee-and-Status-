# DESIGN GOALS FY 26 — Stage 1 Inspection Report

**Status:** inspection only. No code, schema, or data has been changed.
**Source:** `f9e29640-0057_SftW_FY26Q3_Design_Goals.zip`, extracted to `data/fy26/` (17 files).
**Date:** 23 September 2026

---

## 1. Volume

| Measure | Count |
|---|---|
| Workbooks | **17** |
| Sheets across all workbooks | **430** |
| Visible sheets | **41** |
| Hidden sheets | **389** (legacy FY25/FY26-Q1/Q2 copies, per-design-lead tabs, pivots — none relevant) |
| Visible **Goals** sheets (the hierarchy source) | **18** |
| Visible **Pkgs Summary (Status)** sheets (the completion matrix) | **23** |

Every workbook follows the same convention: a small number of visible working sheets, and a large tail of hidden historical sheets. **Only the visible sheets are in scope.** Nine of the seventeen workbooks carry an identical 30–38-sheet hidden archive that is byte-for-byte the same across files (`26Q1 Actuals Smry`, `Goal Summary 25Q4`, `Breakup-MP+MEP+LS`, `Prj List`, the `Goals FY 26-27Q2 <name>` per-lead tabs, `Pivot`, `One liner`, `Notes`, …). Importing any of them would multiply the same stale data 9×.

---

## 2. Row classification — the headline numbers

Every row in the 18 visible Goals sheets was classified. Totals:

| Row class | Count | Becomes |
|---|---|---|
| Title / banner rows | 38 | nothing |
| Header rows | 18 | column map only |
| **Project summary rows** | 24 | `DesignGoalFY26` parent (rollup, derived) |
| **Phase rows** | 25 | phase level of the hierarchy |
| **Discipline rows** | 139 | discipline level of the hierarchy |
| **Package rows (the FY26 goal rows)** | **463** → **435 after de-duplication** | `DesignGoalFY26` record |
| **Dependency / task rows** | **932 total** | see breakdown below |
| Spacer (fully blank) rows | 255 | nothing |
| Unclassified | 2 | see §5.1 — these are real data, not junk |

### Dependency rows — the critical breakdown

| Sub-class | Count | Import? |
|---|---|---|
| **Real dependency/task rows** | **272** | **YES — these become `DesignGoalDependency` records** |
| Template placeholder rows (`Task description 1` / `User 1`) | 650 (595 after de-dup) | **NO** — Excel template boilerplate, never filled in |
| Empty `Step N` rows (marker present, every other cell blank) | 10 | **NO** — but recorded as an import issue |
| — of which carry **no value in column B at all** | 65 | **YES, these are real** — see §2.1 |

**Of the 932 dependency-shaped rows, 272 are genuine and must be imported.** The rest are unfilled template rows that Excel copies down with every new package.

### 2.1 The blank-column-B rows — the trap you warned about

65 dependency rows have **nothing in column B** (no `Step N` marker) but carry a real description, date, owner and remark. They are continuations of the step list above them. Examples:

```
0059 PoaRR  row 8   B=(blank)  C=Glazing Details - Skylight, Car Parking Canopy  D=2026-09-24  E=Gokul
0059 PoaRR  row 48  B=(blank)  C=Electrical layouts   D=2026-10-30  E=Hareesha  F=Electrical layout & schedule required
0057 SftW   row 36  B=(blank)  C=Service Block - SSL01  D=2027-01-31  E=Satish, Alwin, Raghav
0063 ITQE   row 19  B=(blank)  C=Cafe portal Steel structure  D=2026-10-30  E=Satish, Alwin
```

A naive "skip rows where column B is empty" importer would silently lose **65 of the 272 real dependencies (24%)**. The classifier below handles them by attaching any row with no B value but content in C/D/E/F to the preceding package.

### Per-workbook detail

| Workbook | Goals sheet | Packages | Real deps | Template deps | Empty steps | Blank-B deps |
|---|---|---:|---:|---:|---:|---:|
| 0052 Imagine | `0052 Imagine FY26-27Q3` | 6 | 0 | 12 | 0 | 0 |
| 0057 SftW | `Goals FY 26-27Q2` | 14 | 11 | 17 | 0 | 2 |
| 0059 PoaRR | `0059 PoaRR FY 26-27Q3` | 38 | 15 | 62 | 0 | 10 |
| 0063 ITQE | `Goals FY 26-27Q3` | 36 | 43 | 23 | 3 | 1 |
| 0072 AtR | `Goals FY 26-27Q3` | 46 | 3 | 80 | 0 | 0 |
| 0076 Indiranagar Res | `Goals FY 26-27Q2` | 7 | 0 | 14 | 0 | 0 |
| 0082 OTR | `Goals FY 26-27Q3` | 19 | 18 | 12 | 2 | 0 |
| 0093 DBTW | `Goals FY 26-27Q3` | 45 | 42 | 38 | 4 | 33 |
| 0095 TuiG | `Goals FY 26-27Q3` | 10 | 2 | 4 | 0 | 2 |
| 0099 OTF & 0098 BiG | `0099 OTF & 0098 BiG FY 26-27Q3` | 44 | 34 | 54 | 0 | 2 |
| 0106 SftH | `Goals FY 26-27Q2` | 43 | 60 | 40 | 1 | 15 |
| 0116 MSRes / 0131 NHHS | `0116MS Res,0131NHHS FY26Q3` | 28 | 2 | 49 | 0 | 0 |
| 0117 Poinciana | `Goals FY 26-27Q3` | 16 | 0 | 36 | 0 | 0 |
| 0118 Violet Hill | `Goals FY 26-27Q3` | 26 | 0 | 54 | 0 | 0 |
| 72P5 AtR-C | `Goals FY 26-27Q3` | 11 | 41 | 10 | 0 | 0 |
| LGCE & Uma Kush | `Goals FY 26-27Q2` | 18 | 0 | 36 | 0 | 0 |
| New projects | `New Projects - Goals FY 26- (2)` | 28 | 1 | 54 | 0 | 0 |
| New projects | `New Projects - Goals FY 26-27Q3` ⚠ | 28 | 0 | 55 | 0 | 0 |
| **TOTAL (as-is)** | | **463** | **272** | **650** | **10** | **65** |
| **TOTAL (de-duplicated)** | | **435** | **272** | **595** | **10** | **65** |

---

## 3. The hierarchy, and how each level is identified

The Goals sheets are a five-level outline flattened into rows. Excel's own outline levels and fill colours are applied inconsistently and **cannot be relied on**; classification must be content-based.

```
PROJECT            B = "ITQE"                 C = blank, or "Package Release"; carries rollup totals
  PHASE            B = "ITQE-Ph1"             C = "Package Release"
    DISCIPLINE     B = "Architecture"         C = "Complete the project" / "Package Release [Complete LoD 200]"
      PACKAGE      B = "ITQE-Ph1"             C = real description, D = release date, E = responsible, billing + qty
        DEPENDENCY B = "Step 1" | (blank)     C = task text, D = task date, E = people, F = remark
```

### Classifier (evaluated in this order, per row, after the header row)

1. Every cell empty → **SPACER** (discard)
2. `B` matches `/^Step\s*\d+\b/i` → **DEPENDENCY**
3. `B` empty **and** any of `C`/`D`/`E`/`F` non-empty → **DEPENDENCY** (continuation — §2.1)
4. `B` ∈ {Architecture, Structure, Structural, MEP, Landscape, Master Planning, Interiors, ID} → **DISCIPLINE**
5. `C` starts with `Package Release` or `Complete the project` → **PROJECT** (first such row / no phase suffix) or **PHASE**
6. `B` non-empty, `C` empty, rollup numbers present → **PROJECT** summary
7. `B` and `C` both non-empty → **PACKAGE**
8. anything else → **AMBIGUOUS** — log as an import issue, do not import

Vocabularies observed: **7 discipline labels** (`Architecture`, `Structural`, `Structure`, `MEP`, `Landscape`, `Master Planning`, `Master planning` — note the two case variants), **17 step markers** (`Step 1` … `Step 17`; `Step 1` ×424 and `Step 2` ×392 dominate).

### The Pkgs Summary (Status) sheets — a separate artifact

The 23 `Pkgs Summary` sheets are **not** part of the goal hierarchy. They are a package-milestone × discipline **binary completion matrix**:

```
row 2   C = "0118 | Violet Hill (21.76a)"   F=AR  G=ST  H=MEP  I=LS      K=1  L=Completed   ← legend
row 3   D = Scope                            F=23  G=18  H=19   I=20      K=-1 L=Pending
row 4   D = Actuals                          F=6   G=4   H=3    I=2            L=NA
row 7   C = DESIGN CONCEPT                                                  ← section banner
row 9   B=2  C=2  D=Schematic Concept        F=1   G=1   H=1    I=1         ← milestone row
row 16  B=MP-01 C=1 D=Infra - Grading        F=1   G=1                      ← item row
```

Cell values are **`1` = Completed, `-1` = Pending, blank = not applicable**. This maps exactly onto the existing binary `COMPLETED` / `NOT_COMPLETED` rule with no percentage anywhere — it is a natural fit for the existing Design Delivery model and introduces no new completion state.

Two column layouts exist: disciplines at **F, G, H, I** (Violet Hill, Poinciana, Imagine, MSRes, NHHS — "N231"/"P49" shape) and at **F, H, J, L** with merged pairs (ITQE, OTR, SftW, PoaRR, SftH, OTF, BiG, AtR-C — "Z"/"O" shape). Column positions must be resolved from the AR/ST/MEP/LS labels, never hard-coded.

---

## 4. Field mapping

### 4.1 Two column layouts in the Goals sheets

Column letters **differ between workbooks** and must be resolved by header text.

| Field | Layout A (16 of 18 sheets) | Layout B (ITQE 0063, OTR 0082) |
|---|---|---|
| Project / scope | B | B |
| Description | C | C |
| Release date | D | D |
| Responsible | E | E |
| Remarks | F | F |
| Plan – Billing [Cr.] | **J** | **H** |
| Plan – Pkgs | **K** | **I** |
| Actuals – Billing [Cr.] | **L** | **J** |
| Actuals – Pkgs | **M** | **K** |
| Phase | *(absent)* | **L** |
| Discipline | *(absent)* | **M** |
| Design Lead | Q | N (and a duplicate at R) |
| Lead | R | S |
| Person 1 / 2 / 3 | S / T / U | T / U / V |
| Draftperson | V | W |
| Remarks (team) | W | X |

Header rows sit at **row 3** in most sheets, **row 4** in TuiG and Violet Hill. Columns G, H, I are empty spacers in Layout A. Layout B inserts explicit `Phase` and `Discipline` columns, shifting billing two columns left; in Layout A phase and discipline are implied by the outline position only.

### 4.2 Proposed mapping to the data model

| Excel | Target | Notes |
|---|---|---|
| Project summary row `B` | `projects` (existing, matched by name/alias) | 23 of 52 scope labels match an existing project exactly; 29 need aliases (§5.3) |
| Phase row `B` | `project_phases` (existing) | 25 phase rows, 20 distinct |
| Discipline row `B` | `disciplines` (existing) | all 7 labels map onto existing AR / ST / MEP / LS / MP / ID |
| Package row `C` | `DesignGoalFY26.packageDescription` | |
| Package row `D` | `DesignGoalFY26.baselineReleaseDate` **and** `currentExpectedReleaseDate` on first import | baseline immutable thereafter |
| Package row `E` | `DesignGoalFY26.responsibleUserId` | 8 of 11 resolve to existing users; 3 need aliases |
| Package row `F` | `DesignGoalFY26.remarks` | |
| Plan – Billing [Cr.] | `DesignGoalFY26.plannedBillingAmount` | 385 packages carry a value; total 184.85 Cr (un-deduplicated) |
| Plan – Pkgs | `DesignGoalFY26.plannedPackageQuantity` | 425 packages carry a value; total 431 |
| Actuals – Billing / Pkgs | `DesignGoalFY26.reportedActualBilling` / `reportedActualQuantity` | totals 0.9168 Cr and 8 — FY26 Q3 has barely started |
| Design Lead / Lead / Person 1–3 / Draftperson | `team_assignments` (existing pattern) | 9 distinct design leads, 8 resolve to existing users |
| Dependency row `C` | `DesignGoalDependency.description` | |
| Dependency row `D` | `DesignGoalDependency.targetDate` | 403 of 932 dependency rows have a date; after stripping template rows, most real ones do |
| Dependency row `E` | `DesignGoalDependency.responsibleText` — **free text, not a user FK** | 66 distinct values, **all 66 are multi-person strings** (`"Satish, Alwin, Raghav"`, `"Hareesha /Praveen/ Rinu/Vallivel"`). These cannot be resolved to a single user. |
| Dependency row `F` | `DesignGoalDependency.remarks` | 104 real dependencies carry a remark, often a genuine blocker (`"Dependancy: Awaiting Service block layout"`) |
| Pkgs Summary `1` / `-1` / blank | `COMPLETED` / `NOT_COMPLETED` / no record | binary, no new state introduced |
| Source workbook / sheet / row / batch | `DesignGoalFY26.sourceWorkbook`, `sourceSheet`, `sourceRow`, `importBatchId` | full traceability as specified |

### 4.3 Existing entities that will be reused, not rebuilt

`projects`, `project_phases`, `disciplines`, `users`, `audit_log`, `import_runs`, `import_issues`, and the RBAC / Zod / metrics / UI layers. Current database contents: 75 projects, 104 phases, 11 disciplines, 168 users, 2,181 goals, 26 packages, 330 deliverables, 88 drawings.

**One new-table requirement is confirmed:** the existing `dependencies` table is a *scheduling-link* table (`predecessorType`/`predecessorId`/`successorType`/`successorId`/`FS|SS|FF`/`lagDays`) used by the reschedule engine. It cannot hold a task list. FY26 dependency/task rows need their own table.

---

## 5. Ambiguities and decisions needed

### 5.1 Split package rows — package data spilling onto a later row (2 occurrences)

```
0057 SftW row 46:  B=SftW  C=LoD 350 - Clubhouse: Outdoor Spaces and Pool  D=2026-11-30  E=Prakash C
0057 SftW row 47:  B=Step 1  C=Swimming pool & Filtration Room details  D=2026-10-15  E=User 1
0057 SftW row 48:  (B, C, D, E all blank)  J=0.00371  K=1  L=0  Q=Prakash C  R=Satish H  S=Raghavendra  U=Vinay
```

Row 48 carries row 46's billing, quantity and team, orphaned two rows below the package it belongs to. Same pattern at `0063 ITQE` row 133. **Proposed handling:** a row with no B/C/D/E but numeric or team values, following a package, merges upward into that package and is logged as `PACKAGE_ROW_SPLIT`. **Confirm before implementation.**

### 5.2 `New projects` workbook contains two near-identical visible sheets ⚠

`New Projects - Goals FY 26- (2)` and `New Projects - Goals FY 26-27Q3` differ in **exactly one row**:

```
row 12   sheet "(2)"      :  Step 1 | DP Submitted & Scrutiny in progress | Chandan
row 12   sheet "26-27Q3"  :  Step 1 | Task Description                    | User 1
```

The `(2)` sheet is the edited copy; the other still holds the template placeholder. Importing both double-counts **28 packages, 55 dependencies, and ₹18.40 Cr + ₹5.97 Cr of planned billing**. **Proposed handling:** import `New Projects - Goals FY 26- (2)` only, skip the twin, log `DUPLICATE_SHEET_SKIPPED`. **Confirm which sheet is authoritative.**

### 5.3 Scope labels that do not match an existing project (29 of 52)

```
Imagine Campus · ItQE-Ph2c [T9] · ItQE-Ph3a [T10-12 & 31 Villas] · Vaderahalli [Residential]
Vaderahalli [Commercial] · AtR Ph 1, 2a, 2b · AtR Ph 2c · AtR Ph 3 · OTR Oota · OWC · UGT, WTP
STP · OTF [V35] · OTF [V60] · BiG · SftH [South Block-Resi] · SftH - Res · SftH - C (South Block)
SftH - C - SB · SftH - C (North Block) · SftH - C - NB · Violet Hill [21.76a] · Violet Hill [27.08a]
AtR - Commercial · LGCE Campus · TMFT-Ph 3 · TR Mills · Nandi Hills 10a Sultanpete · Misty [Nava Raipur]
```

Most are spelling or suffix variants of projects that already exist (`BiG` → `Blue in Green`, `LGCE Campus` → `LGCE`, `Violet Hill [21.76a]` → `Violet hill`, `TR Mills` → `TR Mills Chamarajpet`, `Nandi Hills 10a Sultanpete` → `NH 10a`, `Misty [Nava Raipur]` → `Nava Raipur`, `AtR - Commercial` → `AtR - C`). A handful (`OWC`, `UGT, WTP`, `STP`) look like *sub-scopes within* a project rather than projects. **Proposed handling:** extend the existing project-alias table, and log every unmatched label as an import issue rather than silently creating a project. **An alias list needs your sign-off before Stage 3.**

### 5.4 Project-granularity mismatch between Excel and the existing database

The existing database treats `ITQE-Ph1`, `ITQE-Ph2a`, `ITQE-Ph2b`, `ITQE-Ph2c`, `OTR-Ph01`, `OTR-Ph02` as **projects**. The FY26 workbooks treat `ITQE` / `OTR` as the project and `-Ph1` etc. as **phases**. Same for `PoaRR-Res` / `PoaRR-T08`. The two models disagree about where the project/phase boundary sits. **Proposed handling:** map the FY26 phase label to the existing *project* row where one exists (so `ITQE-Ph1` → project `ITQE-PH1`), and keep the FY26 phase level as presentational hierarchy in the new module only. **This needs your decision** — the alternative is to introduce `ITQE` as a parent project and re-parent six existing projects, which is a broader change than this module should make.

### 5.5 Billing Date does not exist in the source ⚠ — spec conflict

The brief requires Billing Date to be *"imported exactly as provided in Excel"*. **There is no Billing Date column in any of the 17 workbooks.** An exhaustive scan of every visible sheet found only:

- `Plan - Billing [Cr.]` — an **amount**, not a date
- `Actuals - Billing [Cr.]` — an **amount**, not a date
- `Release date` — the single date column, which is the package release date
- one incidental `Advance Payment` label in the OTF workbook (row 8, column F)

**Proposed handling:** `billingDate` is created on the entity as nullable, left `NULL` on import, and becomes a user-entered field in the package editor. It is **never** derived from the release date, and changing the release date never touches it — which honours the intent of your rule. **Confirm this is acceptable**, or tell me where billing dates currently live.

### 5.6 Template placeholder rows (650 rows, 70% of all dependency-shaped rows)

`Task description 1` / `Task description 2` with `User 1` / `User 2` and dates of `1900-01-13` (Excel serial 13) are the unfilled template block Excel copies under every new package. Four workbooks (Imagine, Indiranagar, Poinciana, Violet Hill, LGCE) consist **entirely** of these — they have zero real dependencies. **Proposed handling:** detect by exact match on `/^Task description\s*\d*$/i` in the description **or** `/^User\s*\d*$/i` in the responsible, skip, and report the count per workbook in the import preview so nothing disappears silently. **Confirm.**

### 5.7 Smaller items

- **18 dependency rows carry package-level numeric columns** (billing, quantity, phase, discipline) copied down from the package above. These values must be ignored on dependency rows.
- **29 package rows have no release date**, **19 have no responsible**. Import as `NULL`, flag as a data-quality warning; do not invent a date.
- **One release-date cell contains the literal string `"-"`** rather than a date. Treat as `NULL`.
- **`Master Planning` and `Master planning`** appear as two discipline labels. Normalise case-insensitively to the existing `MP` discipline.
- **Release dates span 2025-05-18 to 2027-06-01** across 434 package rows — the FY26 Q3 workbooks carry packages well outside FY26 Q3. The module must not filter to the quarter implicitly.
- **Sheet names disagree with file names**: `0057 SftW FY26Q3` contains a sheet named `Goals FY 26-27Q2`; same for SftH, LGCE, Indiranagar. The **file name** is the reliable period indicator, not the sheet name. Worth confirming that the Q2-named sheets in Q3-named files are genuinely the current Q3 data.
- **`0093 DBTW` has no visible Pkgs Summary sheet** (its `Pkgs Summary (Status)` is hidden); `0059 PoaRR` and `LGCE` have none at all. The completion matrix is not universally available.

---

## 6. What Stage 2 would do (not started)

1. `DesignGoalFY26`, `DesignGoalDependency`, `DesignGoalRevision`, `DesignGoalImportBatch` tables + one Drizzle migration. No changes to existing tables.
2. Importer at `src/lib/import/design-goals-fy26/` reusing `workbook.ts`, `logger.ts`, `upsert.ts`, with preview → review → confirm → apply and a natural key of `(project, phase, discipline, packageDescription)` so re-runs update rather than duplicate and never overwrite a manually edited field.
3. API routes, UI module, nav entry, package + dependency editing, audit and RBAC wiring, tests.

**No code will be written until the decisions in §5.1, §5.2, §5.3, §5.4, §5.5 and §5.6 are settled.**
