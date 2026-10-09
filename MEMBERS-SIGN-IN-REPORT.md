# Personal sign-in (Settings → Members) and security upgrade (09-Oct-2026)

**Scope.** The copy only (`project-drawing-status`, port 3100, database `project_drawing_status`). The original app in `..\design-control` was not touched. No Forma / APS code was written (the Forma API connection stays parked; only Forma's *Members export file* can be imported).

**Version control.**
- Git tags:
  - `v2026-10-09-before-members` (before any change);
  - `v2026-10-09-pds-security-upgrade` (Step 0);
  - `v2026-10-09-pds-members` (Step 1).
- Database backups, both in `backups/`:
  - `design-control-2026-10-09T06-18-36-213Z.dump`, before Step 0;
  - `design-control-2026-10-09T07-33-57-489Z.dump`, before migration 0011 was applied.
- The launcher still saves each update as a version (`.versions`, `ROLLBACK.bat`). Migration 0011 only adds tables and columns, so rolling back the code leaves a database the older code still runs on.

**Checks.**

| Check | Result |
|---|---|
| `npm test` | **353 / 353** (323 existing + 30 new in `tests/z-pds-e-members.test.ts`) |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | clean |
| Browser check | Account Admin, a Project Admin of one project and a Member with Billing off, on a second instance against the *test* database. No check accounts are in the working data. |

---

## Step 0: security upgrade (commit 8a8047c)

| Package | Before | After |
|---|---|---|
| next / eslint-config-next | 15.x | **15.5.27** |
| react / react-dom (+ types) | 19.x | **19.3.0** |
| xlsx (SheetJS) | 0.18.5 (npm, unmaintained) | **0.20.3** from the official tarball `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` |

SheetJS 0.20 changed four behaviours. Each one was handled in code:
- **Dense sheets.** Rows now sit in `ws['!data']`; `drawing-register/read.ts` reads them from there.
- **Text cells with a date format** became Dates. `workbook.ts` drops the format on text cells.
- **Time zone.** `sheet_to_json` now runs with `UTC: true`; without it, 17-Aug read as 16-Aug in India.
- **Writing files** in tests needs `XLSX.set_fs(fs)`, added in `tests/setup-auth.ts`.

Verification: the 12-workbook diagnostic is identical before and after, and all 22,548 drawings compare field by field.

---

## Step 1: personal sign-in

### Migration (additive only)

`drizzle/0011_members.sql` (journal idx 11). Nothing was dropped or renamed.

| Table / column | What |
|---|---|
| `companies`, `job_roles` | Named lists (unique by lower-case name). |
| `members` | Name, email (lower-case, unique), phone, company, role, status `invited/active/deactivated`, bcrypt `password_hash`, `is_account_admin`, last sign-in, `user_id` (the user record the member acts as, for the audit trail). |
| `project_members` | Member × project, access level `project_admin/member`, switches `sw_billing`, `sw_edit`, `sw_import_export`, `sw_planning`. Unique per member and project. A grant on a project covers the towers / products below it. |
| `member_invites` | Only the **SHA-256 of the token**, expiry, used-at. |
| `login_sessions.member_id`, `login_sessions.emergency` | The member of a session; break-glass sessions. |
| `login_attempts.email` | Lockout counted per email. |

Applied to the working database on 09-Oct. 37,062 drawings were unchanged, and there are 0 members until the first Account Admin is created (see below).

### One rule: `can(principal, action, projectId?)`

`src/lib/members/policy.ts` is a pure module. The same rule is used by:
- the middleware (Node runtime; it reads the session from the database);
- the layout and every page;
- `lib/api.ts context()` and every API;
- the data services, which take the person's project list (`scopeProjectIds`).

Menus are built from the same rule, so they only hide what the server already refuses.

### Access matrix

**Project Admin** below means "on their own projects", and a **Member** has only the switches that are on for them. "Planning (every project)" means the person needs Planning switched on for every project (see the open items).

| Action | Account Admin | Project Admin | Member |
|---|---|---|---|
| Drawing Status (tree, drill-down, drawing detail) | all projects | yes | always on |
| Billing columns, Billing view, billing totals | all | yes (locked on) | **Billing** switch, per row's project |
| Edit Mode and every write (status, packages, drawings, release, dependencies, reschedule) | all | yes (locked on) | **Edit** switch, per row's project |
| Import Centre, DFS export, Export | all | yes (locked on) | **Import / Export** switch; export holds only their projects |
| DFS Summary, Year / Quarter | all | yes | **Planning** switch, plus Billing on every project in view |
| Dashboard, Goals, Design Delivery, FY26, Drawing Control, Update Centre, Schedule, Projects | all | Planning on every project | Planning on every project |
| Settings → Members on a project | all projects | own projects | no |
| Add an Account Admin, merge companies / roles, Audit, backups | yes | no | no |
| Deactivate / reset password | anyone except themselves; the last active Account Admin is protected | members who belong only to their projects | no |

The guards:
- nobody can grant a level or a switch above their own;
- a Project Admin cannot touch projects they do not run (403, also by guessing ids);
- the last active Account Admin cannot be deactivated or demoted (409);
- nobody can deactivate themselves (409);
- a new-project import makes the importer its Project Admin.

**Shared role sign-ins (legacy).** While `LEGACY_ROLE_LOGINS` is on, they keep their exact old matrix:
- Super Admin works as an Account Admin;
- Admin gets Drawing Status, Billing, Edit and Import / Export;
- Viewer gets Drawing Status.

### Sign-in and sessions

| Rule | Implementation |
|---|---|
| Invite | One-time link, valid 72 h. Only its SHA-256 is stored; a new link cancels the old one; it is used up on success (a racing second request is refused). |
| Password | At least 12 characters, not the email or its name part, not a common password. Stored as bcrypt (cost 12). |
| Sign-in | Email + password, with one generic error ("The email or password is not correct.") for a wrong password, an unknown email, no password yet, or a deactivated account. Unknown emails are compared against a real dummy hash, so the timing is the same. |
| Lockout | 5 failures per email + address, or 20 per email, within 15 minutes. |
| Session | 12 h absolute; ended after 60 min idle. Edit Mode is off at every sign-in and after 30 min idle. |
| Deactivate / reset | Every session of that member ends at once. |
| Emergency | `/login?emergency=1` (not linked anywhere) uses the Super Admin password hash. It is rate-limited and audited (`EMERGENCY_SIGN_IN` with the address). Account Admins see a banner for 14 days after each use. It keeps working when the legacy sign-ins are off. |
| Audit | Every member change, and every data change made by a member, carries "Name <email>". |

### Screens (screenshots in `docs/members-2026-10-09/`)

The screenshots come from the check instance (test database, made-up `@example.test` people).

| # | Screen |
|---|---|
| 01 | Invite link → set password (`/invite/<token>`) |
| 02 | Settings → Members, All projects (Account Admin), with the emergency banner |
| 03 | Add members ▾ → Add one: Project Admin, switches locked on |
| 05 | One project: access level and Billing / Edit / Import-Export / Planning switches per row |
| 06 | Project Admin of Violet Hill: only that project; Billing, Import, Members |
| 07 | Project Admin's Members screen: their project only |
| 08 | Member with Billing off: no billing columns, no export, no Edit Mode; menu = Drawing Status + Settings |
| 09 | After the Account Admin deactivated them, the member's open session is sent back to sign-in |
| 10 | Member detail: profile, projects and switches, sessions (End session), audit trail |
| 11 | Companies list (Roles list is the same, with rename and merge) |
| 12 | Emergency sign-in (hidden page) |

Screenshot 04 (the invite link dialog) is left out because it shows a token.

Also checked in the browser:
- a Project Admin asking for another project's data, its members or FY26 gets 403;
- a deactivated member trying to sign in gets the generic error.

The Members screen also has:
- Add members ▾ → Import from Excel / CSV (dry run first) and Copy members from another project;
- Export, search, filters (company, role, access level, status, switch), paging 20 / 50 / 100;
- a ⋮ menu: edit details, copy invite link / resend, reset password, copy access to other projects, remove from project, deactivate / reactivate, make / remove Account Admin, open details.

The sign-in page shows email + password and the line "First time? Use the invite link from your admin." The shared role cards are shown only while `LEGACY_ROLE_LOGINS` is on. The side bar shows the person's initials, name, level and Sign out. The project picker on Project Drawing Status is remembered per person.

### Import of members

The import accepts our template (`/api/members/template`) or **Forma's Members export**:
- headers are found by name (Name, or First / Last name; Email; Phone; Company; Role; Access level; optionally Billing / Edit Mode / Import / Export / Planning as Yes / No);
- "Project Admin" becomes Project Admin; anything else becomes Member;
- unknown companies and roles are created;
- it always runs as a dry run first (new / updated / skipped / errors), then applies;
- each new member gets an invite link;
- the file must be .xlsx or .csv, at most 5 MB, with no macros.

### New and changed files

| Area | Files |
|---|---|
| New: core | `src/lib/members/`: `policy.ts` (can, route needs, password rules), `principal.ts`, `auth.ts` (invites, sign-in, lockout, emergency), `gate.ts`, `service.ts` (members, guards, import / export), `setup.ts`, `api-ctx.ts`; `src/lib/nav-items.ts` |
| New: API | `src/app/api/members/**` (list / add, detail, access, actions, copy, sessions, export, template, import), `api/companies`, `api/job-roles`, `api/auth/invite` |
| New: screens | `src/app/settings/members/page.tsx`, `settings/members/[id]/page.tsx`, `src/app/invite/[token]/page.tsx`, `components/members-screen.tsx`, `member-login.tsx`, `member-detail-actions.tsx`, `status/remember-project.tsx` |
| New: scripts, tests | `scripts/members.ts` (`members:invite`, `members:migrate`), `tests/z-pds-e-members.test.ts` |
| Changed: sign-in | `middleware.ts` (Node runtime, one gate), `lib/auth.ts`, `lib/login.ts` (idle, Edit-Mode idle, legacy switch), `lib/access.ts`, `lib/api.ts` (`requireProject`, `requireEntity`, `scopeOf`, `billingFor`) |
| Changed: data | `lib/services/dfs.ts`, `dfs-export.ts`, `drawing-register.ts`, `lib/import/centre.ts` (project scope) |
| Changed: screens | `app/layout.tsx`, `components/nav.tsx`, `status-screen.tsx`, `drawings/page.tsx`, `login/page.tsx`, `settings/page.tsx`, the planning pages |
| Changed: APIs | the `/api/status/*`, `/api/drawings/*`, `/api/dfs*`, `/api/reschedule` and `/api/import-centre/*` routes now check the row's project |
| Changed: other | `db/schema.ts`, `lib/domain.ts` (audit actions), `lib/labels.ts`, `scripts/launcher.mjs`, `.env.example`, `package.json` |
| Tests | `tests/setup-auth.ts`. `tests/z-pds-b-status.test.ts` picked "any" fee line and sometimes landed on a Not Applicable one; it now picks an applicable line the same way every time. |

### New tests (`tests/z-pds-e-members.test.ts`, 30)

| Group | What is tested |
|---|---|
| Invite | Hash only; single use; expiry; a new link replaces the old one; a made-up token is refused. |
| Passwords | The rules, both fields must match, and a refusal does not use up the link. |
| Sign-in | Success; one generic error (four cases); lockout per email + address (another address still works); lockout per email; unlock after the window. |
| Sessions | Idle 60 min; absolute expiry; Edit Mode off after 30 min idle. |
| Deactivation | Every live session ends; the generic error afterwards; the audit names the Account Admin. |
| Emergency | Wrong password refused; right password gives an audited Account Admin session and the banner list. |
| Scoping | A cannot read B (tree, drill-down, drawing by id); unfiltered shows only A; totals = A's totals; no writes to B (drawing, package); export holds only A and asking for B is refused; import history shows only A. |
| Switches | Billing off: no billing field in the payload. Edit Mode refused without Edit. Import / Export refused without its switch (API and page). Planning screens refused without Planning, and opened by Planning on every project. |
| Guards | A member cannot manage members. A Project Admin cannot touch another project, make an Account Admin, or deactivate a member who is also on another project. Nobody deactivates themselves. The last Account Admin is protected, also from the emergency sign-in. |
| Forma import | Fixture built in the test: header detection, levels, a dry run that writes nothing, then the import; a company is created; a member cannot import. |
| Legacy | Shared sign-ins work while on. When off they are refused and their sessions end, while members and the emergency sign-in still work. |
| Audit | Member changes carry the actor's name and email. |

---

## How to create the first Account Admin

The working database has no members yet. Choose one way:

1. **Command line**:
   `npm run members:invite -- --email you@company.com --name "Your Name" --account-admin`
   It prints a one-time link (72 h). Open it and set your password.
2. **Launcher**: put `INITIAL_ACCOUNT_ADMIN_EMAIL=` (and optionally `INITIAL_ACCOUNT_ADMIN_NAME=`) in `.env`, then start with `START-PROJECT-DRAWING-STATUS.bat`. If no Account Admin exists, the launcher adds one once and shows the link.
3. **Migrate**: `npm run members:migrate` does the same from `.env`. It also adds the Responsible Persons of drawings, packages and FY26 packages as **Invited** members, with Member access (Drawing Status only) on their projects. No links are sent.

Today all 8 Responsible Persons in the working data have addresses the importer made up (`…@….local`). Their email can be corrected on the Members screen (⋮ → Edit details; allowed until the member sets a password) before you send their link.

Links are shown to the admin to pass on (there is no mail service). Invite links use the address the admin is using; the command line uses `APP_BASE_URL`.

## How to switch the shared sign-ins off

When everyone signs in with their own email, set `LEGACY_ROLE_LOGINS=false` in `.env` and restart. Then:
- the Viewer / Admin / Super Admin cards disappear from the sign-in page;
- their logins are refused, and any open shared session ends at its next request;
- the Super Admin password remains usable only as the emergency sign-in at `/login?emergency=1`.

To undo, set it back to `true`.

---

## Open items

1. **Planning screens are not yet cut down per project.** Dashboard, Goals, Design Delivery, FY26, Drawing Control, Update Centre, Schedule and Projects list every project, so for a member they need Planning on every top-level project. Planning on some projects opens only the per-project planning views (DFS Summary, Year / Quarter, drawing changes and deletion). Per-project lists in those modules would need project filters in their services (Goals, FY26 via `legacy_project_id`, reporting, Gantt).
2. **Create the first Account Admin** (above), and decide when to run `members:migrate` on the working data.
3. **Remaining `npm audit` items**:
   - drizzle-orm < 0.45.2 (identifier escaping; the fix is a breaking major upgrade, not done here);
   - the postcss 8.4.31 bundled inside Next.js (fixed upstream only);
   - dev-only esbuild / vitest / braces advisories (not shipped).
4. **The Members table is wide.** Below about 1,440 px the switch columns need a horizontal scroll.
5. **No email sending.** Invite and reset links are copied by the admin and passed on.
6. `CLAUDE-CODE-PROMPT-*.md` stay untracked, as before.
