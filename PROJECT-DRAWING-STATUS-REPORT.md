# Project Drawing Status — delivery report (30-Sep-2026)

## 1. What was copied, and where it runs

| | Original | Copy |
|---|---|---|
| Folder | `design-control-system\design-control` (unchanged) | `design-control-system\project-drawing-status` |
| Start | `START-DESIGN-CONTROL.bat` | `START-PROJECT-DRAWING-STATUS.bat` |
| Address | http://localhost:3000 | http://localhost:3100 |
| Database | `design_control` | `project_drawing_status` |
| `.env`, session secret | its own | its own; `SESSION_SECRET` written by the launcher |
| Versions / rollback | `.versions`, `ROLLBACK.bat`, git | its own `.versions`, `ROLLBACK.bat`, git |

**What was copied.** The whole application was copied, including Dashboard, Projects, Goals, Design Delivery, Design Goals FY 2026–27, Drawing Control, Update Centre, Schedule / Reschedule, Audit and the Import Centre. The code, reschedule engine, permission checks, audit trail and importers are the same code, not a second drawing system.

**What differs.** Only three things change:
- the sign-in;
- the menus and routes for each role;
- the Project Drawing Status screen.

**The copy's database.** On its first start the launcher:
1. clones `design_control` into `project_drawing_status` using `pg_dump` and then `pg_restore`, reading `CLONE_FROM_DATABASE_URL`;
2. backs up the new database;
3. applies migration 0009;
4. stores the two passwords as hashes.

The original database is only read, never written.

## 2. Schema and migration (0009, additive only)

| Change | Purpose |
|---|---|
| `login_accounts (role, password_hash)` | bcrypt hashes of the Admin and Super Admin passwords |
| `login_sessions` | Stores signed-in sessions. Each row holds the token's SHA-256, the role, the user, Edit Mode, the expiry and the sign-out time. |
| `login_attempts` | failed and successful password attempts, used for rate limiting |
| `packages.responsible_user_id`, `packages.responsible_text` | Responsible Person on a package: a linked user when the name matches, otherwise the name as given. (Drawings already had these two columns.) |
| `packages.source_code` | the code the source gave, so an import still finds a package after its code is edited |
| `packages.user_edited_fields` | fields a person changed; an import keeps them |
| `archived_at`, `archived_by_label` on `drawings`, `packages`, `projects` | archive (soft delete): hidden everywhere, never removed |
| `package_dependencies` | dependencies under a package, using the same fields as drawing dependencies |

**Billing.** No new columns were needed:
- Total is the design fee (`package_fees.fee_value`).
- Billed is the amount billed to date (`package_fees.billed_to_date_value`).
- Unbilled is Total − Billed.

An edited amount is protected from a later import through `package_fees.user_edited_fields`.

## 3. Roles and permissions

| | Viewer | Admin | Super Admin |
|---|---|---|---|
| Password | none | `ADMIN_PASSWORD` | `SUPER_ADMIN_PASSWORD` |
| Acts as the existing role | Viewer | Manager, plus billing and release withdrawal | Administrator |
| Project Drawing Status | read only, full screen, slim top bar | yes | yes |
| Billing columns and Billing menu | — | yes | yes |
| Edit Mode (off at every sign-in) | — | yes | yes |
| Import, template download, new-project import | — | yes | yes |
| Export to Excel / CSV of the filtered view | — | yes (with billing) | yes (with billing) |
| DFS Summary, Year / Quarter, Drawing list tabs | — | — | yes |
| Dashboard, Projects, Goals, Design Delivery, Design Goals – FY 2026–27, Drawing Control, Update Centre, Schedule / Reschedule, Audit | — | — | yes |
| Settings | Switch User | Switch User | full, plus Switch User |

**How passwords are checked.** Passwords are checked on the server with bcrypt, cost 12. They are not in the code or the repository; a test scans the repository for them.

**The session cookie.**
- It is `pds_session`, marked httpOnly and SameSite=Lax.
- It is marked Secure over HTTPS.
- It is signed with HMAC-SHA-256 and expires after `SESSION_HOURS` (12).

**Rate limiting.** Sign-in is locked for 15 minutes after 5 wrong passwords from one address, or 20 wrong passwords from all addresses together.

**Switch User.** Ends the session in the database, removes the cookie and turns Edit Mode off.

**Where access is enforced.** Access is checked on every page and every API route, first by the middleware and then by the server against the session in the database. The existing permission checks still apply after that. For a Viewer:
- every write, billing, import and export endpoint, and every other screen, returns 403;
- status responses contain no billing fields.

**Other changes to permissions.**
- The DFS Summary and Year / Quarter APIs now need billing permission.
- All Edit Mode endpoints (`/api/status/*`) also need Edit Mode switched on.

## 4. Project Drawing Status

**Layout.**
- The "Reporting period" bar is gone.
- The page uses the full width and height of the browser.
- The table scrolls inside itself, with a sticky header and a sticky Name column.
- The sidebar folds to icons, and there is a Full Screen button.

**Columns.** Name | Responsible Person | Package Status | Release Date | Packages Complete | Drawings Released | Total · Billed · Unbilled (Admin only)
- Group headers: Status, Schedule, Progress and Billing (₹ Cr).
- Column widths are fixed and every column has a divider.
- Text is left-aligned; numbers are right-aligned with tabular figures.
- One font throughout.
- Levels are shown by indentation guides and a background tint, with a highlight on hover.
- Chips are consistent: Complete (green), Pending (amber), Not Applicable (grey).
- Drawings use the same column grid, under their own small header: Drawing Name · Number | Responsible Person | Release Status | Updated On | Revision | Discipline.

**Status rules.**
- Project and tower rows show only "x complete · y pending".
- Not Applicable appears only on discipline rows, or on a package marked so, and is not counted in "of y": 121 + 53 = 174.
- "No drawings yet" is removed; a package without drawings shows Pending.

**Billing.**
- Amounts roll up package → discipline → tower → project, with each package counted once.
- Each line is rounded to 4 decimals, so every parent shows exactly the sum of its children.
- A pending package shows "Eligible to bill after completion".
- A Billed amount on a pending package shows a warning (⚠). The value itself is not changed.

**Edit Mode.** Admin and Super Admin. It is the same screen with editing enabled, marked by an "Editing enabled" indicator. You click a cell, then Save or Cancel.
- **Inline:**
  - Responsible Person;
  - package code and name;
  - drawing name, number, revision, discipline and release status;
  - billing Total and Billed, on the Billing view.
- **From a row's ⋯ menu:**
  - add a Tower / Product, Package, Discipline or Drawing;
  - move an expected date through the reschedule engine, with a reason (the baseline is kept and history recorded);
  - dependencies, using an empty row to add one;
  - mark a discipline Not Applicable or Applicable;
  - archive, with a reason.
- **After each save:** the open part of the table reloads, so status, roll-ups and billing are recomputed at once.
- **Leaving with unsaved changes:** a prompt appears when you turn Edit Mode off, move to another screen, switch user or close the tab.

## 5. Checks run

| Check | Result |
|---|---|
| Test suites (existing + new `z-pds-a-login`, `z-pds-b-status`) | 285 / 285 passed |
| — sign-in | right and wrong passwords, Viewer without a password, httpOnly / SameSite / expiring cookie, expired and forged cookies, Switch User resets Edit Mode, rate limit per address and per role, hashes only |
| — authorization | Viewer 403 on 21 write / billing / import / export / admin endpoints (handlers and middleware) and on every admin screen; no billing fields in Viewer payloads; Admin 403 on Super Admin screens |
| — roll-ups | every parent = sum of children for packages, drawings and billing; each package once; the total equals the fee lines in SQL |
| — status | Not Applicable only at discipline level; denominators exclude it; no "no drawings yet" |
| — Edit Mode | a release completes the discipline and moves the totals; a Billed amount recomputes billing and raises the warning; package and drawing date moves create reschedule history with the baseline kept; add tower, package, discipline and drawing, dependencies, archive; audit entries |
| — re-import | package name, code and Responsible Person, a fee amount, a drawing name and a drawing's Responsible Person all survive a re-import; nothing is duplicated |
| Typecheck, lint, production build | clean |
| End-to-end check against the running copy (as the three roles) | 152 / 152 |
| Page scan (Super Admin, Admin, Viewer) | no banned wording, no project codes and no formula text on any screen |
| Browser check (Viewer, Admin, Super Admin; 1366 / 1920 / tablet) | 65 / 65 |

**Browser check, by role.**
- **Viewer:** only Project Drawing Status; no billing, no Edit Mode, no Export; the table fills the screen; opened PoRR → Tower 08 → package → discipline → drawings.
- **Admin:** menu of Project Drawing Status, Billing, Import and Settings; the Responsible Person column; billing columns and totals; Edit Mode with an inline edit saved; export downloads; Import with templates; Audit 403.
- **Super Admin:** the full menu; all 16 original screens open.

## 6. Unresolved and assumptions

- **Responsible Person is not in the source workbooks.** None of the current registers or Design Fee sheets has a Responsible, Design lead or Owner column; the only "Responsible" columns are in a BOQ cost sheet and in the excluded Design Deliverables list. So 0 of 14,514 drawings and 0 of 198 packages have one; each shows "—" until it is set in Edit Mode. Future uploads with such a column fill it automatically.
- **"Billed" is now the amount billed to date.** It comes from the Design Fee sheet's Billed YTD and can be edited. Earlier it was reconciliation only, and "Billed" in the DFS Summary tab (Super Admin) is still the completion-based figure (the design fee of complete disciplines). The two can differ.
- **Billing to review.** Billed amounts sit on 80 discipline lines in 34 pending packages; they are flagged, not changed. 71 pending packages show "Eligible to bill after completion".
- **Tower 09 has no current fee packages,** so it has no billing.
- **Totals.**
  - Total ₹ 64.9237 Cr, Billed ₹ 45.6085 Cr, Unbilled ₹ 19.3152 Cr.
  - Pursuit of a Radical Rhapsody: 61.1748 / 45.6085 / 15.5663.
  - Violet Hill: 3.7489 / 0 / 3.7489.
- **Group headers.** Only three were asked for: Status, Schedule and Billing. Status spans Package Status and Schedule spans Release Date. Packages Complete and Drawings Released sit under a fourth header, "Progress".
- **Archive** covers drawings, packages (with their drawings) and towers / products. A top-level project and a discipline are not archived here; a discipline is marked Not Applicable instead.
- **The two passwords are plain text in the copy's `.env`.** They are read once at first start and stored as hashes; delete those two lines afterwards. `npm run logins:set -- --role ADMIN` sets a new password.
