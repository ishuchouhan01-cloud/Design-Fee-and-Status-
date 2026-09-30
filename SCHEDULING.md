# SCHEDULING

The rescheduling engine, in full. Everything here lives in
`src/lib/reschedule.ts`, `src/lib/schedule.ts` and `src/lib/periods.ts`, and is
covered by `tests/reschedule.test.ts` and `tests/schedule.test.ts`.

---

## 1. What it borrows from Asta Powerproject, and what it does not

**Borrowed, because design delivery needs it**

* a baseline that is never overwritten, so slippage stays measurable
* a current/forecast date that moves, always with a recorded reason
* links between items — Finish-to-Start, Start-to-Start, Finish-to-Finish, with
  positive or negative lag
* progressed work is protected: completed items are not moved
* an impact preview before anything is committed
* a movement history you can read back

**Deliberately not built**

* critical-path analysis, float, or a full CPM solve
* resource levelling and histograms
* working calendars, shifts, non-working days
* multiple named baselines
* hammocks, WBS roll-up bars, cost loading

A design-delivery control tool needs to answer "what moved, why, and what did it
push?" — not to replace a planning suite.

---

## 2. The three dates

| Date | Moves when | Never moves when |
|---|---|---|
| **Baseline** (`baselineTargetDate` / `baselineReleaseDate`) | never after it is set | anything |
| **Current expected** (`currentExpectedDate` / `currentExpectedReleaseDate`) | a reschedule, or an explicit date change | — |
| **Actual** (`actualCompletionDate` / `actualReleaseDate`) | an item is marked completed | a reschedule (a released drawing keeps the date it was released) |

Worked example from the specification:

```
Original release        15-Sep-2026     ← baseline, immutable
Current expected        30-Sep-2026     ← after a reschedule
Actual release          (blank)
Completion              NOT COMPLETED

… released on 27-Sep:

Original release        15-Sep-2026     ← unchanged
Current expected        30-Sep-2026     ← unchanged
Actual release          27-Sep-2026
Completion              COMPLETED
Schedule status         COMPLETED LATE  ← 12 days after the BASELINE
```

"Completed late" is measured against the **baseline**, not the rescheduled date.
Rescheduling something does not make it on time.

---

## 3. Completion and schedule are independent

Two separate axes, never mixed:

| Completion | Schedule status |
|---|---|
| `COMPLETED` | `COMPLETED_ON_TIME`, `COMPLETED_LATE` |
| `NOT_COMPLETED` | `ON_TRACK`, `DUE_SOON`, `RESCHEDULED`, `DELAYED`, `NOT_SCHEDULED` |

So `NOT_COMPLETED + RESCHEDULED`, `NOT_COMPLETED + DELAYED` and
`COMPLETED + COMPLETED_LATE` are all normal, expected combinations.

`assessSchedule()` decides, in this order:

1. **completed** → compare actual with baseline → `COMPLETED_LATE` if the actual
   is after the baseline, otherwise `COMPLETED_ON_TIME`
2. **no expected date** → `NOT_SCHEDULED`
3. **expected date in the past** → `DELAYED` (overdue)
4. **expected date ≠ baseline, or reschedule count > 0** → `RESCHEDULED`
5. **due within `DUE_SOON_DAYS`** (default 14) → `DUE_SOON`
6. otherwise → `ON_TRACK`

It also returns `slipDays` (expected − baseline), `varianceDays`
(actual − baseline, once complete) and `daysToDue`.

---

## 4. Scope

A reschedule can address:

| Scope | Resolves to |
|---|---|
| `ITEM` | the one record you picked |
| `SELECTION` | the rows you ticked in the Update Centre |
| `PACKAGE` | every **incomplete** item in that package |
| `DISCIPLINE` | every incomplete item of that discipline in that project |
| `GOAL` | every incomplete item under that goal |
| `PROJECT` | every incomplete item in the project |

Scope resolution (`resolveScopeIds`) filters to `NOT_COMPLETED` on the way in,
so completed work is out of the picture before the engine even starts.

A scope wider than a single item must use a **uniform shift in days**, not one
shared date: moving 200 drawings to one identical date is almost always a
mistake, so the API refuses it and the dialog disables that mode.

---

## 5. Dependencies

`dependencies` links any two schedulable records — `GOAL`, `DELIVERABLE`,
`DRAWING` or `PACKAGE` — in any combination.

Each record has a finish (its current expected date) and a start
(finish − duration; deliverables and drawings have duration 0, packages carry
their planned duration).

| Type | Constraint |
|---|---|
| `FS` Finish → Start | successor finish ≥ predecessor finish + lag + successor duration + 1 day |
| `SS` Start → Start | successor finish ≥ predecessor start + lag + successor duration |
| `FF` Finish → Finish | successor finish ≥ predecessor finish + lag |

Lag may be zero, positive or negative.

### 5.1 The rule that matters: links push, they do not pull

A successor moves **only when its link is actually violated**. Pulling a
predecessor earlier does not drag its successors backwards, because in design
delivery an earlier predecessor is an opportunity, not an instruction.

Worked example from `tests/reschedule.test.ts` — four deliverables chained
`A →FS→ B →FS→ C →FS→ D`, ten days apart:

```
before      A = 01-Oct   B = 11-Oct   C = 21-Oct   D = 31-Oct

A moves 5 days EARLIER  →  A = 26-Sep
                           nothing else moves  (0 cascaded)

A moves 30 days LATER   →  A = 26-Oct
                           B violated  → 27-Oct
                           C violated  → 28-Oct
                           D satisfied → 31-Oct, unchanged  (2 cascaded)
```

### 5.2 Cascade mechanics

Breadth-first from the items you moved, depth-capped at 25 to make a cyclic link
harmless rather than fatal. Each visited successor keeps the **latest** required
date if several predecessors push it. Completed successors are skipped and
reported. Cascaded history rows record the link type and lag in their reason,
so a movement nobody typed is still explainable:

```
Client information delayed [cascaded via FS +10d lag]
```

---

## 6. Goal rescheduling

Goals are quantity-and-timing targets, and they reschedule too. The original
commitment stays visible, which is the whole point for management reporting:

```
Goal                  FY26-27 Q2 — 30 deliverables
Original target       30-Sep-2026     ← baseline, unchanged
Current forecast      15-Oct-2026
Shift                 +15 days
Reason                Client design information delayed
```

Applying it writes:

* the new `currentExpectedDate` (never the baseline)
* a `reschedule_history` row
* a `goal_revisions` row with previous → new expected date and an impact summary
* an `audit_log` row

A revised plan arriving from Excel takes the same route: `goal_revisions`
records previous → new quantity and value rather than overwriting the plan, so
"what did we originally commit to?" always has an answer.

---

## 7. The workflow

Two requests, and there is no third path that writes.

```
POST /api/reschedule   { …, confirm: false }   → impact preview, writes NOTHING
POST /api/reschedule   { …, confirm: true  }   → applies it
```

The dialog:

```
CURRENT EXPECTED RELEASE   15-Sep-2026
NEW EXPECTED RELEASE       [ 30-Sep-2026 ]     or   SHIFT BY [ +15 ] days
REASON                     [ Client design information delayed ]   (required)
SCOPE                      ( ) selected item   ( ) package
                           ( ) discipline      ( ) project

OPTIONS  [x] Preserve completed dates
         [x] Recalculate dependent dates
         [x] Update forecast
         [x] Record in reschedule history

┌ RESCHEDULE IMPACT ─────────────────────────────────────┐
│ Items moved              1                             │
│ Affected successors      4                             │
│ Affected goals           2                             │
│ Affected packages        1                             │
│ Largest shift            +15 days                      │
│ Project forecast         11-Nov-2026 → 21-Nov-2026 (+10d) │
│ Quarter CY2026 Q3        12 → 4  (−8)                  │
│ Quarter CY2026 Q4         0 → 8  (+8)                  │
│ Not moved                2 (completed, or already on that date) │
└────────────────────────────────────────────────────────┘

Selected item          15-Sep → 30-Sep   +15d   selected
S-204 Storm drain      22-Sep → 01-Oct    +9d   dependency FS
…

                                   [ CANCEL ]  [ APPLY RESCHEDULE ]
```

`APPLY RESCHEDULE` stays disabled until an impact has been calculated. Cancelling
leaves nothing behind, because the preview never wrote anything.

### 7.1 Options

| Option | Effect when off |
|---|---|
| Preserve completed dates | completed items are moved too. Off is for correcting a mis-recorded release; it is on by default and the impact preview lists everything it would touch. |
| Recalculate dependent dates | only the items you selected move; links are left violated (visible on the programme view). |
| Update forecast | the project forecast figures are not refreshed in this preview. |
| Record in reschedule history | no history row is written. The audit row is still written — that one is not optional. |

---

## 8. Forecast

Project and goal forecasts are **derived** from current expected dates and can
never be typed in from a dashboard:

* **forecast completion** = the latest current expected date among incomplete
  goals and delivery items
* **baseline completion** = the latest baseline date among the same records
* **variance** = forecast − baseline, in days
* **reschedule count** = rows in `reschedule_history` for that project

Quarterly forecast counts the packages of goals that are either already complete
or still expected inside the quarter.

---

## 9. RAG

Calculated from record counts, with a reason attached:

| Colour | When |
|---|---|
| **RED** | any critical item overdue, or ≥10% (or ≥10) of records overdue, or ≥25% and ≥3 records behind the expected-by-today position, or a slip of 60 days or more |
| **AMBER** | anything overdue, or ≥10% behind expected, or a slip of 15 days or more |
| **GREEN** | at or ahead of the expected position with nothing overdue |
| **GREY** | nothing planned in that scope — no judgement to make |

"Expected by today" counts records whose **baseline** date has already passed:
the position the plan said we should be in, not the position we have since
rescheduled ourselves into.

A manager can override RAG. The override stores the calculated value, the
reason, the user and the timestamp, and the UI shows both. Removing the override
restores the calculated value; nothing is lost either way.

---

## 10. What is recorded, every time

| Table | Row written |
|---|---|
| the record itself | new `currentExpected*Date`, `rescheduleCount + 1` |
| `reschedule_history` | old date, new date, shift, reason, scope, batch id, cascaded flag, user, impacted count, project |
| `audit_log` | field, old value, new value, reason, user, timestamp |
| `goal_revisions` | goals only: previous/new expected date and an impact summary |

All of it inside one database transaction. `Settings → Import history`,
`Audit`, the project page and `Schedule / Reschedule` all read it back:

```
DATE      ITEM    OLD       NEW       SHIFT  REASON                 USER
08-Sep    S-204   15-Sep    22-Sep    +7     Client information     Design Lead
15-Sep    S-204   22-Sep    30-Sep    +8     Client comment         Design Lead
```
