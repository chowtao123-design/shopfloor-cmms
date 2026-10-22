# Shopfloor CMMS v3: Service Orders, Statistics, People, Files, AI Assistant (Spec)

**Role:** project manager / spec author · **Status:** v3.0, ready to build · **Date:** 2026-10-21
**Baseline:** v2.1 (SPEC.md, SPEC-v2.md incl. section 15) is built. Everything there still applies
unless this document changes it: no npm dependencies, Node 24 built-ins only, vanilla JS client,
no CDN, no innerHTML with user text, no alert/confirm/prompt, offline-first sync, last-save-wins
with history, server-set `updated_by`, tests with `node:test`.

Reference look: the client likes the Atlas CMMS desktop layout (dark left sidebar, table-first
pages, slide-over forms). Take the layout ideas, **not** its name, logo, colours or wording.
Keep our safety-orange accent and shop-floor wording.

## 1. Renames and naming

- "Jobs" / "Work orders" → **Service Orders** everywhere in the UI, Help and README
  (routes stay `#/jobs...` and store stays `workOrders` to avoid a data migration).
- "PM" tab/heading → **Preventive Maintenance** (short label "Prev. Maint." allowed only in the
  phone bottom bar).
- Default app name **Shopfloor CMMS** (admin can change it, section 8).

## 2. Service order data (store `workOrders`, all fields optional unless stated)

| Field | Type | Notes |
|---|---|---|
| `number` | integer | **server-assigned** sequential number on first save, shown as `SO-0001`; offline-created orders show "SO-pending" until synced; clients may not set or change it |
| `priority` | enum | `none`, `low`, `medium`, `high`, `urgent` (default `medium`). Legacy `normal` is read as `medium`; server accepts `normal` and stores `medium` |
| `category` | enum | `mechanical`, `electrical`, `pneumatic`, `facility`, `safety`, `cleaning`, `other` |
| `dueDate` | ISO date or null | |
| `requestedBy` | string ≤ 80 | free text (operator name, supervisor) |
| `assignees` | array ≤ 10 of `{kind: 'user'|'coworker'|'contractor', id}` | |
| `labour` | array ≤ 200 of `{id, kind, personId, date, hours (0.25–24, step 0.25), note ≤ 200}` | who worked how long; drives contractor/coworker hours statistics. Replaces `minutesSpent` for new entries; old `minutesSpent` stays readable and counts as one labour entry by the creator |
| `checklist` | array ≤ 50 of `{id, text ≤ 200, done: boolean}` | |
| `attachments` | array ≤ 20 of `{fileId, name, mime, size}` | photos, manuals, reports (section 6) |

Existing fields (title, machineId, kind, status, problem, actionTaken, partsUsed, downtimeMinutes,
reportedAt, completedAt, pmTaskId) are unchanged. Server validation in `server/records.js` must
match exactly; unknown fields are still rejected.

## 3. Service Orders page (desktop ≥ 1024 px)

1. **Toolbar:** view switch **List · Board · Calendar**, search box, filter button, "+ Service order".
2. **Filters** (chips above the table, removable; open a filter panel for the rest): status
   (multi), priority (multi), category, machine type, machine, assignee (coworker / contractor /
   user), kind (breakdown / PM / facility / install / other), due (overdue · due this week · no due
   date), created date range. Default: status not Done. Filter state is kept per device in
   localStorage and reflected in a "Clear all" link.
3. **List:** sortable table: Number, Status, Title, Priority (coloured badge + text), Machine,
   Category, Assigned to (initials avatars + names in `title`), Due date (red when overdue),
   Age (days), Labour hours, Edited by. Pagination 25/50/100 rows.
4. **Board:** columns per status (Open, In progress, Waiting parts, Waiting tech, Done last 7
   days); cards show number, title, priority, machine, assignee avatars, due date. Move a card
   with drag and drop **and** with a "Move to…" menu on each card (keyboard/touch alternative).
5. **Calendar:** month grid by due date; each day lists service orders (overflow "+3 more");
   previous/next month; clicking opens the order.
6. **Form:** a **right slide-over drawer** (desktop) with sections: Basics (title, machine,
   kind, category, priority, status, due date, requested by), Problem, Assign (coworkers,
   contractors, users), Checklist (add/reorder/tick), Labour (add entry: person, date, hours,
   note; total shown), Parts used, Attachments (section 6), Action taken. Phone: same sections
   as a full page. Esc closes the drawer after an in-page "Discard changes?" check when dirty.
7. **Phone (< 768 px):** cards with number, priority badge, status, machine, due; a "Filters"
   button opens a bottom sheet with the same filters.

## 4. Preventive Maintenance

- PM task form becomes the same slide-over drawer with: title, machine, interval days,
  **priority**, **estimated hours**, **category**, **assigned to** (coworker/contractor/user),
  **checklist template**, instructions, attachments (manual pages, photos).
- "Mark done" creates a Done service order that copies priority, category, assignees and the
  checklist (all ticked), and prompts for labour hours (optional).
- PM list shows priority, assignee and estimated hours columns on desktop.

## 5. People: Coworkers and Outside Contractors

Two new synced stores with the same versioning/history/last-save-wins rules as other records.

- `coworkers`: `name` (required ≤ 80), `role` (≤ 60, e.g. "Line supervisor", "Mechanic"),
  `phone`, `email`, `shift` (`day`, `evening`, `night`, `rotating`, `other`), `skills` (≤ 200),
  `linkedUserId` (optional login account), `active` (default true), `notes`.
- `contractors`: `company` (required ≤ 80), `trade` (≤ 60, e.g. "Juki service", "HVAC",
  "Electrician"), `contactName`, `phone`, `email`, `hourlyRate` (number ≥ 0, optional, **only
  admins see and edit it**; the server omits it for non-admins in changes/history responses),
  `machineIds` (machines they service), `active`, `notes`.
- Pages **Coworkers** and **Outside Contractors** under a "People" group in the sidebar: table on
  desktop, cards on phone, search, active/inactive filter, add/edit in the drawer. Phone numbers
  and emails render as `tel:` / `mailto:` links **plus** a copy button.
- Contractor detail shows: contact card, machines serviced, service orders they worked on, total
  hours (last 30 / 90 / 365 days) and cost when a rate is set (admins only).

## 6. Photos, manuals and files

- Server: `POST /api/files` with the raw file as the request body, headers `Content-Type` and
  `X-File-Name` (URL-encoded). Allowed types: `image/jpeg`, `image/png`, `image/webp`,
  `application/pdf`; max 15 MB (413 above). Check the magic bytes match the declared type (415 if
  not). Store as `DATA_DIR/files/<uuid>` plus a `files` table row (`id, name, mime, size,
  sha256, uploaded_by, uploaded_at`). Response `{fileId, name, mime, size}`.
- `GET /api/files/:id` (signed-in users): stream with the stored mime, `X-Content-Type-Options:
  nosniff`, `Content-Security-Policy: sandbox`, `Content-Disposition: inline` for images and PDF
  with a safe filename. Unknown id → 404. No directory listing; ids must be UUIDs.
- Client: images are downscaled in the browser before upload (longest side 1600 px, JPEG quality
  0.82) using canvas; PDFs upload as-is. Thumbnails in a grid; tap opens full size; PDFs open in a
  new tab. Uploading needs a connection to the server (show a clear message offline); the record
  itself still saves offline.
- Where: service orders (photos of the fault, reports), machines (**photos and manuals**, with a
  "Manuals" section on the machine detail), PM tasks (manual pages, photos).
- Backups (SPEC-v2 §12) must include the `files` table; the `files/` folder is copied next to each
  backup as `<backup-name>.files/` (hard links where possible, plain copies otherwise).

## 7. Statistics page and Status monitor

New sidebar item **Statistics** with two tabs. All numbers are computed client-side from synced
data by pure functions in `logic-stats.js` (unit-tested); charts are hand-written SVG (no chart
library), coloured from theme tokens, each with a text table toggle for accessibility.

**Status monitor tab (live, refreshes after every sync):**
- Machine status tiles: Running · Down · In storage · Retired (counts, click filters the list).
- "Down now" table: machine, type, down since (time of the oldest open breakdown order), open
  service order number/title, assignee, hours down so far. Longest first.
- Today strip: service orders opened today, closed today, overdue now, PM due today.

**Reports tab (range selector: last 30 / 90 / 365 days):**
- KPI tiles: open service orders, overdue, **MTTR** (mean hours from reported to completed for
  breakdowns), **PM compliance** (% of PM tasks completed on or before due date in range), total
  downtime hours, total labour hours.
- Charts: service orders by status (bar); created vs completed per week (two lines); by priority
  (bar); downtime hours by machine type (horizontal bar); top 10 machines by breakdown count
  (horizontal bar, MTBF in the table); **labour hours by outside contractor** (horizontal bar)
  with a table: contractor, trade, service orders, hours, cost (admins, when rate set); labour
  hours by coworker (horizontal bar).
- "Export CSV" for each table.

## 8. Branding (admin)

- Settings → **Branding** (admins only): app name (1–40 chars), logo upload (PNG/JPEG/WebP only,
  ≤ 512 KB, **no SVG**), reset to default.
- Server: `settings` key/value table; `GET /api/branding` is public (needed on the login screen)
  and returns `{name, logoUrl, version}`; `PUT /api/branding` and logo upload are admin-only.
  Logo stored like files (section 6) and served from `/api/branding/logo`.
- Client shows the name and logo in the sidebar, header, login card and `document.title`; cached
  for offline. Manifest name stays "Shopfloor CMMS".

## 9. AI assistant

**Chat button** fixed bottom-right on every page (above the phone tab bar), opening a chat panel
(desktop: 380 × 560 px popover; phone: full-screen sheet). Hidden when no provider is configured.

**Settings → AI assistant** (admins only):
- Provider: `off` (default) · `opencode` (URL of an `opencode serve` instance, server password,
  `providerID`, `modelID`) · `openai-compatible` (base URL, API key, model id; works with vLLM,
  Ollama, LM Studio, OpenAI).
- "Test connection" button. Secrets are stored server-side only and are **never returned** to the
  browser (the API returns `{configured: true}` instead).
- A visible notice: "Questions, and the maintenance records needed to answer them, are sent to the
  configured AI provider."

**Server (`server/ai.js`):**
- `POST /api/ai/chat {conversationId?, message}` (signed-in users; message ≤ 2,000 chars;
  20 messages per minute per user → 429). The server, not the browser, talks to the provider.
- Context: a system prompt describing the app and its vocabulary plus a compact **read-only**
  snapshot built per question: open and overdue service orders, down machines, PM due in 7 days,
  low-stock parts, and up to 20 records matching words in the question (service orders, machines,
  parts, PM tasks, coworkers, contractors; never users' password hashes, sessions, contractor
  rates for non-admins). Keep the context under ~12,000 characters.
- **The assistant cannot change data.** It may return a draft service order as a fenced JSON
  block `{"draftServiceOrder": {...}}`; the client shows it as a card with "Open as new service
  order", which opens the normal form pre-filled. Nothing is saved without the user pressing Save.
- opencode provider: create one opencode session per conversation (`POST /session`), send
  messages with `POST /session/:id/message` using the configured model, the system prompt, and
  **all tools disabled** (`tools` map with every tool set to false) so the agent can only answer
  in text; read the text parts of the reply. README must say: run `opencode serve` on the same
  machine bound to 127.0.0.1, set `OPENCODE_SERVER_PASSWORD`, and start it in an **empty
  dedicated folder**.
- openai-compatible provider: `POST {baseURL}/chat/completions` with `model`, `messages`,
  `temperature: 0.2`, timeout 60 s.
- Store conversations in `ai_messages` (`id, conversation_id, user_id, role, content, at`) so the
  panel reloads history; users can clear their own history. Admins cannot read other users'
  chats in the UI.
- Errors: provider down or timeout → friendly message in the chat, logged server-side without
  secrets.

## 10. Desktop shell redesign (≥ 1024 px)

- **Dark sidebar** (deep slate background, light text, orange active indicator), 248 px, with
  the branding logo + name at top, "+ Service order" primary button, then groups with small
  inline-SVG icons: Service Orders (open count badge), Preventive Maintenance (overdue badge),
  Statistics, Machines, Parts (low-stock badge), People ▸ Coworkers · Outside Contractors,
  Help, Settings. Collapsible to a 64 px icon rail (remembered per device).
- **Top bar:** page title, global search (service orders, machines, parts, people; results
  dropdown), sync pill, user menu.
- Content area light grey with white cards and tables; tables full-width with sticky header.
- Slide-over drawer component (right side, 560 px, focus trapped, Esc closes, backdrop click
  closes after the dirty check) reused by all forms on desktop.
- Phone and tablet keep the v2.1 layout; the bottom bar becomes: Home · Orders · Prev. Maint. ·
  Machines · More (sheet with Parts, Statistics, Coworkers, Contractors, Help, Settings).

## 11. Acceptance criteria

- [ ] `node --test tests/` passes: all previous tests + new server tests (priority migration,
      SO numbering incl. concurrent creates getting distinct numbers, new field validation,
      coworkers/contractors, hourlyRate hidden for non-admins, files: type/size/magic-byte
      checks, auth, headers, branding admin-only and public GET, AI chat with a fake provider:
      context excludes secrets and rates for non-admins, rate limit, tools disabled in the
      opencode request body, secrets never returned) and logic tests (`logic-stats.js`: MTTR,
      PM compliance, downtime by type, contractor hours, created vs completed buckets; filters).
- [ ] Browser checks at 1280 and 390 px: sidebar and drawer, List/Board/Calendar, filters,
      Coworkers, Contractors, Statistics both tabs, branding change visible on login screen,
      chat panel with a fake provider, photo upload and view, no horizontal scroll, no console
      errors, v2 two-user sync test still passes.
- [ ] No npm dependencies, no external URLs in source, no innerHTML with user text.

## 12. Milestones (one GLM run and one commit each; verify before the next)

1. **V3-M1 Server data:** priorities + legacy mapping, SO fields + numbering, coworkers/
   contractors stores with rate hiding, settings/branding API, files API + backup inclusion, tests.
2. **V3-M2 Shell:** dark sidebar, top bar with global search, drawer component, renames,
   branding display, phone "More" sheet.
3. **V3-M3 Service orders:** list with filters and pagination, board, calendar, drawer form with
   assign/checklist/labour/attachments, phone cards + filter sheet.
4. **V3-M4 PM + machines:** PM drawer fields, Mark done flow, machine photos and manuals.
5. **V3-M5 People:** Coworkers and Outside Contractors pages and contractor detail.
6. **V3-M6 Statistics:** `logic-stats.js` + tests, Status monitor, Reports with SVG charts + CSV.
7. **V3-M7 AI server:** `server/ai.js`, providers, context builder, rate limit, history, Settings
   card, tests with a fake provider.
8. **V3-M8 AI chat UI + docs:** chat button/panel, draft-card flow, Help and README updates.

---

## 13. Roles and permissions (admin dashboard) — client request 2026-10-21

Replaces the fixed `admin` / `tech` split. An admin defines **roles** and, for each role, the
access level to every function. This also decides contractor rates/costs (section 5 "admins
only" rules become the `contractorRates` permission below).

### 13.1 Model

- Levels per area: **None** (area hidden; server returns nothing), **Read** (view only),
  **Write** (create, edit, delete; implies Read).
- Areas (keys are fixed in code, labels shown in the UI):

| Key | Label | Covers |
|---|---|---|
| `serviceOrders` | Service Orders | workOrders store, labour, checklists, attachments on orders |
| `pm` | Preventive Maintenance | pmTasks store, Mark done (also needs `serviceOrders` Write) |
| `machines` | Machines | machines store, machine photos/manuals |
| `parts` | Parts & Stock | parts store, stock moves (+1/−1, job deductions need `parts` Write **or** come from a Service Order save by a user with `serviceOrders` Write) |
| `coworkers` | Coworkers | coworkers store |
| `contractors` | Outside Contractors | contractors store except rates |
| `contractorRates` | Contractor rates & costs | `hourlyRate` field (Read = see rates and costs in contractor pages and Statistics; Write = edit rates) |
| `statistics` | Statistics | Statistics page (data shown is still limited by the other areas) |
| `files` | Photos & files | upload (Write) and view (Read) attachments |
| `backups` | Backups | Read = list; Write = "Back up now" and download |
| `aiAssistant` | AI assistant | Read or Write = may use the chat (only areas the user can read are put into the AI context) |
| `settings` | Branding & AI settings | Write = change branding and AI provider settings |
| `admin` | Users & roles | Write = this dashboard; **only roles with this permission may manage users, roles and permissions** |

- Built-in roles, created on migration:
  - **Administrator**: every area Write; cannot be edited or deleted.
  - **Technician** (existing `tech` users): Write on serviceOrders, pm, machines, parts, coworkers,
    contractors, contractorRates, files, aiAssistant; Read on statistics, backups; None on
    settings, admin. (Default chosen by the PM; the admin can change it.)
  - **Viewer**: Read on serviceOrders, pm, machines, parts, coworkers, contractors, statistics,
    files; None elsewhere.
- Admins may create custom roles (name 1–40 chars, unique, e.g. "Supervisor", "Contractor"),
  copy an existing role, rename, change levels, and delete a role that no user has.

### 13.2 Server

- Tables: `roles(id, name UNIQUE, builtin INTEGER, permissions TEXT /* JSON {area: level} */,
  created_at, updated_at, updated_by)`; `users.role_id` (migration from the old `role` column:
  admin → Administrator, tech → Technician; keep the old column readable for one version, stop
  writing it). Every role/permission change is written to `history` (store `roles`) with
  before/after, like records.
- One function `can(user, area, level)` used by **every** route; no other place decides access.
  - `GET /api/changes` and `/api/history` return only stores the user can Read; contractor
    `hourlyRate` only with `contractorRates` Read.
  - `PUT/DELETE /api/records/:store/:id` need Write on that store's area; a contractor `PUT`
    without `contractorRates` Write keeps the stored rate.
  - Stock moves, files, backups, branding, AI config, AI chat, users and roles routes: as in the table.
  - 403 body `{error: "forbidden", area, needed: "read"|"write"}`.
- Permissions are read from the database on every request (no caching in the session), so a
  change takes effect on the user's next request.
- Safety rules: the Administrator role cannot be changed or deleted; the last enabled user with
  the `admin` permission cannot be disabled, demoted or deleted (409 with a clear message); a
  user cannot remove `admin` Write from their own role.
- `GET /api/me` adds `{roleId, roleName, permissions}`. New admin routes (need `admin` Write):
  `GET/POST /api/roles`, `PATCH/DELETE /api/roles/:id`, `PATCH /api/users/:id {roleId}`;
  `GET /api/roles/:id/history`.
- `admin.js create-user --admin` assigns Administrator; new `--role "<name>"` option.

### 13.3 Client

- **Admin dashboard** (sidebar "Admin", visible only with `admin` permission), two tabs:
  1. **Users**: table (name, username, role dropdown, status, last sign-in, created), add user,
     disable/enable, reset password; role changes save immediately with an undo toast.
  2. **Roles & permissions**: a matrix, areas as rows, roles as columns, each cell a
     None / Read / Write segmented control; Administrator column locked; "New role", "Copy",
     "Rename", "Delete" (disabled while users have the role); unsaved-changes bar with
     Save / Discard; a per-role "History" drawer.
- Everywhere else the UI follows `permissions` from `/api/me`: hide sidebar items with None,
  disable or hide create/edit/delete buttons with Read, show a "View only" badge on read-only
  pages. The server stays the authority: a 403 on sync moves the change to the failed list with
  "You no longer have permission to change Service Orders".
- After a pull, if an area became None, clear that store from IndexedDB on this device.
- Contractor rates and the cost columns in Statistics appear only with `contractorRates` Read.

### 13.4 Acceptance criteria (add to section 11)

- [ ] Server tests: migration maps old roles; `can()` matrix for each level; each route
      family returns 403 for None/Read where Write is needed; changes feed hides None stores;
      rates hidden without `contractorRates` Read and preserved on PUT without Write; last-admin
      protections (409); self-demotion blocked; Administrator role immutable; role history entries;
      permission change takes effect on the next request without signing out.
- [ ] Browser: as a Viewer the sidebar hides None areas, pages show "View only", no edit buttons;
      as an admin the matrix saves and a second signed-in user sees the change after the next pull.

### 13.5 Milestones (insert before V3-M2 resumes)

- **V3-M1b RBAC server:** roles table + migration, `can()`, route enforcement, me/roles/users
  routes, history, CLI `--role`, tests. Must merge cleanly with `v3-ai` (AI routes use `can()`).
- **V3-M9 Admin dashboard UI + permission-aware client:** after M2 (needs the shell/drawer).
