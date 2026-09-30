# DATA-MAPPING

How the two supplied workbooks were read, classified and normalised.

Format of each mapping line:

```
WORKBOOK → SHEET → SOURCE FIELD → TARGET TABLE → TARGET FIELD → BUSINESS MEANING
```

Nothing is silently discarded. Every row that is not imported is either
(a) a recomputable summary, or (b) written to the import log with a reason,
visible on **Settings → Import history**.

---

## 1. Workbook A — `Design Goals FY26-27 trial.xlsx`

43 sheets, 34 of them hidden. They fall into three groups.

### 1.1 Sheet classification

| Sheet | Class | Decision |
|---|---|---|
| `Prj List` (hidden) | **MASTER** | the project register → `projects` |
| `Goals 2026` | **MASTER** | calendar-year goal lines with a quarterly split |
| `Goals FY 26-27Q1` | **MASTER** | FY26-27 Q1 plan + actuals + team |
| `Goals FY 26-27Q2` | **MASTER** | FY26-27 Q2 plan + actuals + team |
| `Goals FY 2026Q2 (Revised Plan)` (hidden) | **MASTER (revision)** | revised FY plan → `goal_revisions` + updated plan |
| `Goals, Actuals 2026 Q1` (hidden) | **MASTER (actuals)** | CY2026 Q1 actual packages and billing |
| `Goals, Actuals 2026 Q1 (Remark)` (hidden) | **MASTER (actuals + remarks)** | same rows plus per-goal sub-item notes |
| `Prj Crtcl rqrmnt` (hidden) | **MASTER** | critical requirement per project |
| `Notes` (hidden) | **MASTER** | free-text notes keyed by project |
| `ID Goals FY 26-27Q2` | **MASTER** | interior-design unit register with real GFC target dates |
| `Smry`, `Pivot`, `FY 26-27 Q2 Pivot`, `Revised Plan PIVOT`, `One liner`, `Goal Summary 25Q4`, `Breakup-MP+MEP+LS`, `26Q1 Actuals Smry`, `Data sheet`, `Sheet1`, `Sheet2` | **DERIVED** | summaries / pivots / scratch. Not imported — the dashboard recomputes all of them from the master rows. |
| `Goals FY 26-27Q2 Cijey`, `… Saji`, `… OP`, `… Naveen Y`, `… Manik`, `… Gagan`, `… Navneet`, `… Shweta V`, `… Prakash C`, `… Atul P`, ` FY26-27Q2 Cijey`, ` FY26-27Q2 Saji`, `26Q1 Cijey M`, `26Q1 Saji A`, `26Q1 Naveen Y`, `26Q1 Om Prakash`, `26Q1 Manik G`, `26Q1 Atul L`, `26Q1 Prakash C`, `26Q1 Gaganjit S`, `26Q1 Navneet K`, `26Q1 Leaderwise` | **LEADER VIEW** | 23 sheets that are filtered copies of the same goal rows, one per design lead. Importing them would create one record per quarter per leader — exactly what "one record exists once" forbids. **Not imported.** The Goals screen reproduces them with a Design Lead filter, and the dashboard reproduces `Smry` by grouping. |

### 1.2 `Prj List` → `projects`

| Source | Target | Meaning |
|---|---|---|
| col A (`Ongoing`, `New Prj`, `DsgnBld`, `HPL`, `CSR`) | `projects.portfolio` | portfolio section; carried down until the next section header |
| col B | `projects.projectName` | project name |
| derived `codeify(name)` | `projects.projectCode` | stable natural key (`AtR` → `ATR`, `Violet hill` → `VIOLET-HILL`) |
| col C = 1 | `projects.active` | in the active list |
| col D contains "hold" | `projects.onHold` | on-hold marker |
| col E (`New`) | `projects.description` | retained as a note |

62 projects. 13 more were created from goal rows (see 1.7).

### 1.3 `Goals 2026` → `goals`

Header row is located by matching `Project / Phase / Discipline / Design Lead /
Description`, so a shifted sheet still imports. The sheet is hierarchical:
portfolio section headers, project+phase subtotals, project+phase+discipline
subtotals, then leaf rows. **Only leaf rows are imported** — a leaf row is one
that carries both a Design Lead and a Description. Every subtotal is recomputed.

| Source | Target | Meaning |
|---|---|---|
| col B | `goals.projectId` (matched) | project |
| col C | `project_phases.code` → `goals.phaseId` | phase ("Ph 1, 2a, 2b, 2c", "Vdrhl-Cmrcl", "PID") |
| col D | `disciplines.code` → `goals.disciplineId` | discipline, via the alias table in §3 |
| col E | `users` → `goals.designLeadId` | design lead, created as a user row |
| col F | `goals.goalDescription` | what the goal is |
| `Billing [Cr.]` total (col G) | — | recomputed; used only when no quarter split exists |
| `Billing [Cr.]` Q1–Q4 (cols H–K) | `goals.plannedValue` | one goal record **per quarter with a value or quantity** |
| `Pkgs` total (col L) | — | recomputed |
| `Pkgs` Q1–Q4 (cols M–P) | `goals.plannedQuantity` | planned package count for that quarter |
| col R (`T` marker) | `goals.remarks` | kept when it is not a flag character |
| derived | `goals.fiscalYear = "CY2026"`, `goals.quarter` | calendar-year period |
| derived | `goals.periodStart` / `periodEnd` | quarter boundaries |
| derived | `goals.baselineTargetDate = periodEnd` | **the baseline. Never rewritten afterwards.** |
| derived | `goals.currentExpectedDate = periodEnd` | initial forecast, moved only by a reschedule |
| derived | `goals.goalCode` | `G-<projectCode>-<period>Q<n>-<hash of phase|discipline|lead|description>` — the natural key that makes re-import idempotent |

A leaf row with a year total but no quarter allocation is attributed to Q4 and
logged (`GOAL_NO_QUARTER_SPLIT`) rather than dropped.

### 1.4 `Goals FY 26-27Q1` / `Q2` → `goals` + `team_assignments`

Same leaf-row rule. Column positions are found by header label because the two
sheets do not start on the same row.

| Source | Target | Meaning |
|---|---|---|
| `Plan - Billing [Cr.]` | `goals.plannedValue` | planned billing, Cr. |
| `Plan - Pkgs` | `goals.plannedQuantity` | planned packages |
| `Actuals - Billing [Cr.]` | `goals.reportedActualValue` | delivered billing as reported in the workbook |
| `Actuals - Pkgs` | `goals.reportedActualQuantity` | delivered packages |
| `Lead`, `Person 1..3`, `Draftperson` | `team_assignments.personName` + `roleOnGoal` | the team on that goal; each person also becomes a `users` row |
| `Remarks` | `goals.remarks` | |
| derived | `goals.fiscalYear = "FY26-27"`, `quarter = 1 \| 2` | fiscal period (April start) |

**Goal completion rule:** a goal is `COMPLETED` when
`reportedActualQuantity >= plannedQuantity` and `plannedQuantity > 0`. Nothing
stores a goal percentage; the Goals screen derives it.

### 1.5 `Goals FY 2026Q2 (Revised Plan)` → `goal_revisions`

Matched against the existing FY26-27 Q1 goal by the same natural key. Where the
planned quantity or value differs, a `goal_revisions` row records
previous → new for both, with the reason "Revised plan issued in the FY26-27
goals workbook", and the goal is flagged `isBaselineRevision`. The **original
commitment is retained** on the goal's baseline columns and in the revision row.
94 revisions were recorded.

### 1.6 `Goals, Actuals 2026 Q1` and `… (Remark)` → `goals`

| Source | Target | Meaning |
|---|---|---|
| `Plan 26Q1` → Billing / Pkgs | `goals.plannedValue` / `plannedQuantity` | used only when the goal did not already exist |
| `Actual 26Q1` → Billing / Pkgs | `goals.reportedActualValue` / `reportedActualQuantity` | delivered position |
| rows carrying only a Description (the `(Remark)` variant) | appended to `goals.remarks` | the sub-item list under a goal ("Auditorium Drawings", "STP-2 Drawings", …) |

Rows with no matching plan goal create the goal from the actuals sheet (which
also carries the plan figures) and log `GOAL_CREATED_FROM_ACTUALS` — 20 rows.
Nothing is dropped.

### 1.7 Project-name resolution

Project labels are written many ways. Matching walks from strict to loose:
exact code → normalised name (brackets and trailing phase text stripped) →
longest project name that is a prefix of the label → containment. An
unambiguous alias table handles the rest:

| Label in the workbook | Project |
|---|---|
| `Svknhli` | Savakanahalli |
| `Tmk33a` | Tumkur 33a |
| `NH30a MH` | NH 30a - Madakuhosahalli |
| `NH37a` | NH37a - Acharalahalli |
| `TR Mills` | TR Mills Chamarajpet |
| `Jhanjh Lake` / `Mayfair` | Jhanjh Lake [Mayfair] |
| `Sarjapur Road [South Block-Resi]` | Srjp - Res |
| `Sarjapur - C (South Block)` | Srjp - C - SB |
| `Sarjapur - C (North Block)` | Srjp - C - NB |
| `ItQE-Ph3a [T10-12 & 31 Villas]` | ITQE-Ph2c |

Anything still unmatched becomes **its own project**, tagged with the portfolio
section it appeared under, and logged as `PROJECT_CREATED_FROM_GOAL_ROW`. This
kept 348 goal rows that would otherwise have been dropped. 13 projects were
created this way, including the interior-design work streams that the workbook
lists in the Project column (`Product Launch`, `Personalised Customisation`,
`Experience Homes`, `Product Development`, `Fabric Craft`) and the Sarjapur
scope splits.

### 1.8 `Prj Crtcl rqrmnt` and `Notes` → `critical_requirements`

Imported **after** the goal sheets so that projects created from goal rows are
available to match. `Prj Crtcl rqrmnt` column A is the project label (kept in
`phaseLabel` because it carries the phase), column B the requirement, columns
C–E appended when present. `Notes` uses a project heading followed by free-text
lines, each stored with `phaseLabel = 'Note'`.

### 1.9 `ID Goals FY 26-27Q2` → `design_deliverables`

The only sheet in workbook A with real per-item dates, so it becomes
deliverables rather than goals.

| Source | Target | Meaning |
|---|---|---|
| `Project`, `Phase` | `projectId`, `phaseId` | |
| `Unit no`, `Product` | `deliverableDescription` | "Interior design GFC — Unit 48 (V45)" |
| `GFC Target` (fallback `Signoff Quarter`) | `baselineReleaseDate` + `currentExpectedReleaseDate` | the committed GFC date |
| `Architect` | `ownerId` | |
| `Status` matching released/issued/complete | `completionStatus` | otherwise `NOT_COMPLETED` |
| `Remarks` | `remarks` | |
| derived | `deliverableCode` = `D-<projectCode>-ID-<unit>-<hash>` | idempotent natural key |
| discipline | `Interior Design` | |

Rows without a usable date are logged (`ID_UNIT_NO_DATE`) rather than given an
invented one. Commercial columns on this sheet (`ID Revenue`, `Billing`,
`Expected ID Revenue`) are recomputable from the goal rows and are not
duplicated here.

---

## 2. Workbook B — `0118_Violet Hill_ 03YPlan_01012026 - Ph 1 trail.xlsx`

Read by a **generic project-plan mapper**. The project is identified from cell
B1 of the drawing-list sheets (`0118 Violet Hill`) and from the file name; the
plan start date is parsed from the `_01012026` element of the file name (or
`PLAN_START_DATE`). There is no Violet-Hill-specific code.

### 2.1 `Design Fee` → `packages` + `package_fees`

| Source | Target | Meaning |
|---|---|---|
| col C matching `^[A-Z]{2} \d{2}$` (`DC 01`, `MP 01`, `AM 01`) or a 2–3 letter stage code (`MA`) | `packages.packageCode` | package / stage code |
| col D | `packages.packageName` | package description |
| upper-case heading rows in col C (`DESIGN CONCEPT`, `CONSTRUCTION DOCUMENTS`, `POST-CONSTRUCTION`) | `packages.packageGroup` | stage group |
| row order | `packages.sequence` | the order the batches run in |
| cols E/F (AR), G/H (ST), I/J (MEP), K/L (LS) | `package_fees.feePercent` / `feeValue` | share of the discipline fee for that package, in % and Cr. |

24 packages, 95 fee weightings.

### 2.2 `Packages deliverables` → `packages` (durations) + `design_deliverables`

A matrix: rows are batches, columns are disciplines paired with a
"Released Status" column.

| Source | Target | Meaning |
|---|---|---|
| col A on a batch header row (`30`, `15`, `15 -Std`) | `packages.durationDays` | planned duration in days |
| col B (`Batch 01`…`Batch 12`) | matched to the `Design Fee` package with the same description | `Batch 01 — Infra - Grading` **is** `MP 01 — Infra - Grading`, so one package row serves both |
| col C | package description | used for that match |
| col B heading that owns deliverables directly (`Master Planning - Schematic`) | a package of its own, group `DESIGN CONCEPT` | detected by looking ahead for deliverable cells before the next heading |
| col D (Master Planning), F (Infra Consultants), H (PHE), J (ELE), L (IBMS), N (Structural), P (Landscape) | `design_deliverables.deliverableDescription` + `disciplineId` | one deliverable per non-empty cell |
| cols E, G, I, K, M, O, Q ("Released Status") | `completionStatus`; otherwise kept in `remarks` | released/issued/yes/1 → `COMPLETED` |
| derived | `deliverableCode` = `D-<projectCode>-B<nn>-<disciplineCode>-<hash>` | idempotent natural key |

210 deliverables for Violet Hill.

### 2.3 `Drawing list | MP & AR` / `| ST` / `| MEP` → `drawings`

| Source | Target | Meaning |
|---|---|---|
| col A | `drawings.stageCode` | drawing-set stage (`UD`) |
| col B | `disciplines` → `disciplineId` | `MP`, `S`, `ELE`, `PHE`, `IBMS` |
| col C | `areaOfWorks` | `000`, `GR`, `RDS`, `SC1`, `TEM`, … |
| col D | `drawingNumber` | sheet number |
| col E | `drawingCode` | full drawing number (`MP-000-0001`) |
| col F | `drawingName` | |
| col G | `location` | |
| col H | `batchCode` | numeric batch → resolves the package |
| col I | `batch` | concatenated batch label (`UD-MP-1`) |
| col J (`Till Dec'25` = 1) | `completionStatus = COMPLETED` | already issued before the plan window |
| col K (`Date of receipt`) | `actualReleaseDate` | **treated as authoritative for the actual date** |
| col L | `revision` | `R0`, `R2`, … |
| `P26` block, cols N–Q | `baselineReleaseDate` = end of that calendar quarter; `planPeriodLabel` | planned issue quarter, 2026 |
| `P27` block, cols Y–AB | as above for 2027 | |
| `A26` block, cols S–V / `A27` cols AD–AG | `completionStatus = COMPLETED` | flagged actual issue quarter |
| section header rows (col D, e.g. `GFC \| INFRA - GRADING`) | `issueType` + `remarks`, and a package fallback match | issue type and the package the block belongs to |
| row 1 / 2 totals | — | recomputed |

88 drawings.

**A real inconsistency in the source, handled explicitly:** for 23 drawings the
flagged actual-issue quarter does not agree with the quarter implied by the date
of receipt (e.g. `MP-000-0001` is flagged Q2 but received 10-Aug-2026). The date
of receipt is treated as authoritative and every disagreement is logged as
`ISSUE_QUARTER_MISMATCH`, visible in the import log and counted on the data
quality panel. Nothing was quietly corrected.

### 2.4 `Assumption Cost`, `BOQ cost` → `app_settings`

These are fee-calculation worksheets, not delivery records, so they are not
forced into the delivery model. The `Total` row is captured as project settings:

```
project.VIOLET-HILL.AssumptionCost.constructionCost.total
project.VIOLET-HILL.AssumptionCost.constructionCost.architectural | structural | mep | landscaping
project.VIOLET-HILL.AssumptionCost.designFee.architectural | structural | mep | landscaping
project.VIOLET-HILL.BOQcost.…
```

Visible on **Settings → Application settings**. The full captured set is also in
the import log payload.

### 2.5 Package scheduling and derived links

The workbook gives batch **durations** and a batch **sequence**, and the drawing
register gives planned **quarters**. Package dates are resolved in that order:

1. A package containing dated drawings takes the latest of their baseline dates.
2. A package with no dated drawings is chained from the plan start date using
   its planned duration (default 15 days when the source has none). Logged as
   part of `PACKAGE_SCHEDULE`.
3. Deliverables inherit their package's baseline and current expected dates,
   because the source gives them no dates of their own.

Both results are written to the **baseline** columns, so any later movement
shows up as slippage instead of quietly redefining the plan.

**Derived dependencies** (`IMPORT_DERIVE_PACKAGE_LINKS=true`, 218 links): within
a package group, `PACKAGE(n-1) →FS→ PACKAGE(n)` in code order, and
`PACKAGE(n-1) →FS→ each DELIVERABLE of PACKAGE(n)`. This is the only
relationship the source actually expresses (numbered batches with durations).
They are logged as `DERIVED_DEPENDENCIES`, described in the UI as editable
defaults rather than source data, and can be switched off with the environment
variable.

---

## 3. Discipline normalisation

Eleven canonical disciplines (`disciplines` table) with an alias table so the
many spellings across both workbooks collapse onto one record each:

| Canonical | Aliases seen in the workbooks |
|---|---|
| `AR` Architecture | Architecture, Architectural, AR |
| `ST` Structural | Structural, Structure, Structures, STR, ST, S |
| `MEP` MEP | MEP |
| `LS` Landscape | Landscape, Landscaping, LDS, LS |
| `ID` Interior Design | Interior Design, Interiors, ID |
| `MP` Master Planning | Master Planning, Master Plan, MP |
| `INFRA` Infra Consultants | Infra Consultants, Infra |
| `PHE` PHE | PHE |
| `ELE` Electrical | ELE, Electrical |
| `IBMS` IBMS | IBMS |
| `UD` Urban Design | UD |

Unrecognised values are logged as `DISCIPLINE_UNMATCHED` and the record is kept
with no discipline rather than being guessed or dropped.

---

## 4. What is deliberately NOT modelled

| Source content | Why not | Where it went instead |
|---|---|---|
| 23 per-design-lead goal sheets | duplicate records per leader | Design Lead filter on the Goals screen |
| 10 pivot / summary sheets | recomputable | calculated on every dashboard request |
| Row and column totals inside master sheets | recomputable | calculated |
| Deliverable-level rows for projects that never enumerated them | would be invented data | goals carry the planned/delivered **quantities**; deliverable records exist only where the source enumerates them (Violet Hill packages and drawings, the interior-design unit register) |
| Fee-calculation intermediate rows | commercial working, not delivery control | `Total` row captured as project settings |

---

## 5. Import result on the supplied files

```
projects        75      (62 from the project master list, 13 created from goal rows)
packages        26
goals         2,181     (CY2026 Q1–Q4 and FY26-27 Q1–Q2)
deliverables    330     (210 Violet Hill packages, 120 interior-design units)
drawings         88
dependencies    218     (derived from the batch sequence)
users           168     (design leads and team members)
team members  2,170     assignments
goal revisions   94
critical reqs    39

Warnings 36   Errors 0   Notes 170
  13 × PROJECT_CREATED_FROM_GOAL_ROW   scope not on the project master list
  23 × ISSUE_QUARTER_MISMATCH          source flag disagrees with the date of receipt
```

Both warning classes are findings about the source data, not import defects.
Re-running the migration produces identical totals.
