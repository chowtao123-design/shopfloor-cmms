# Shop Maintenance Log v2: Shared Team Log (Spec)

**Author:** Senior project engineer · **Status:** v2.0, ready to build · **Date:** 2026-10-20
**Baseline:** v1.1 (SPEC.md sections 1–13) is built. Everything there still applies unless this
document changes it. Read SPEC.md sections 4–8 and 13 for UI, data model and constraints.

## 1. Goal

Several technicians on the same company network share **one** maintenance log hosted on one
company computer. Each person logs in, sees everyone's records, keeps working offline on the
shop floor, and syncs when back on the network. Every record shows who last edited it. Every
change is kept in a history. Anyone logged in can make a one-click backup saved on the server.

## 2. Hard constraints

- **Server:** Node.js ≥ 22.5 (target 24) using only built-ins: `node:http`, `node:https`,
  `node:sqlite` (`DatabaseSync`, `backup`), `node:crypto`, `node:fs`, `node:path`, `node:url`.
  **No npm dependencies**, no Express, no ORM, no build step. `package.json` has scripts only.
- **Client:** same rules as v1 (vanilla JS ES modules, no CDN, no innerHTML with user text, no
  alert/confirm/prompt). The client talks only to its own origin (`/api/...`).
- **Tests:** `node --test` covers server and pure client sync logic. Server tests start the
  server on an ephemeral port with a temp data dir and make real HTTP requests with `fetch`.
- One SQLite file is the source of truth. All writes go through the API.

## 3. Layout

```
maint-log/
  index.html, app.js, logic.js, help.js, db.js, styles.css, sw.js, seed.js, icons/  (client, existing)
  sync.js                 NEW client: outbox, pull, push, conflict notices (pure logic split into logic-sync.js)
  logic-sync.js           NEW pure functions for sync (unit-tested)
  login.js                NEW client: login screen, session check, logout
  server/
    server.js             entry: config, http(s) server, static files, routing
    store.js              SQLite schema, migrations, queries
    auth.js               password hashing, sessions, cookie handling, rate limit
    api.js                JSON API handlers
    backup.js             one-click + scheduled backups, retention, list
    admin.js              CLI: create-user, reset-password, disable-user, list-users, restore
  data/                   (git-ignored) maint.db, backups/
  tests/                  existing logic tests + server.test.js, sync.test.js
  README.md               add "Team server (v2)" deployment section
```

**Static serving:** the server serves only an explicit allow-list of client files
(`/`, `/index.html`, `*.js` at repo root, `styles.css`, `manifest.webmanifest`, `icons/*`).
Never serve `server/`, `data/`, `tests/`, `.git/`, `.tmp/`, `*.md`, logs or dotfiles. Reject path
traversal (`..`, encoded variants) with 404.

## 4. Configuration (environment variables, with defaults)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | bind address (LAN) |
| `DATA_DIR` | `./data` | SQLite file + backups |
| `TLS_CERT`, `TLS_KEY` | unset | if both set, serve HTTPS (see §10) |
| `SESSION_DAYS` | `14` | session lifetime (sliding) |
| `BACKUP_KEEP` | `30` | number of backups kept |
| `BACKUP_DAILY_AT` | `02:00` | local time for automatic daily backup; `off` disables |

## 5. Database schema (SQLite)

All timestamps are ISO strings (UTC, `new Date().toISOString()`). `PRAGMA journal_mode=WAL`,
`foreign_keys=ON`. A `meta` table holds `schema_version`.

- `users(id TEXT PK, username TEXT UNIQUE NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT CHECK(role IN ('admin','tech')) NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`
- `sessions(token_hash TEXT PK, user_id TEXT NOT NULL REFERENCES users, created_at TEXT, expires_at TEXT, last_seen_at TEXT)`
  Store only SHA-256 of the session token, never the raw token.
- `records(store TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL /* JSON */, version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT, created_by TEXT, updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(store, id))`
  `store` ∈ `machines | parts | workOrders | pmTasks`. `seq` is a global, strictly increasing
  change counter (from a `counters` table, incremented in the same transaction as each write).
  Index on `seq`.
- `history(hid INTEGER PK AUTOINCREMENT, store, record_id, version INTEGER, action TEXT CHECK(action IN
  ('create','update','delete','restore','stock')), user_id TEXT, at TEXT, before TEXT, after TEXT,
  conflict INTEGER NOT NULL DEFAULT 0, note TEXT)` Index on `(store, record_id)`.
- `stock_moves(id TEXT PK /* client-generated, for idempotency */, part_id TEXT, delta INTEGER,
  reason TEXT, work_order_id TEXT, user_id TEXT, at TEXT)`
- `backups(file TEXT PK, created_at TEXT, created_by TEXT /* user id or 'schedule' */, bytes INTEGER, kind TEXT)`
- `login_attempts(key TEXT PK, count INTEGER, window_start TEXT)` for rate limiting.

`data` holds the v1 record fields (SPEC.md §6) **minus** `id`, `createdAt`, `updatedAt`, which
live in columns. Parts' `qtyOnHand` is server-owned (see §7.3).

## 6. Authentication (cookie sessions)

1. **Accounts:** created by an admin (CLI or Users screen). No self sign-up. First admin is
   created with `node server/admin.js create-user --admin <username> "<Display Name>"`, which
   prompts for the password on the terminal (hidden input; also accept `--password-stdin`).
2. **Passwords:** `crypto.scrypt` (N=16384, r=8, p=1, 64-byte key, 16-byte random salt), stored as
   `scrypt$N$r$p$salt_b64$hash_b64`; compare with `crypto.timingSafeEqual`. Minimum length 6 (client decision 2026-10-21; was 8).
3. **Login:** `POST /api/login {username, password}` → on success create a session with a
   32-byte random token (base64url) and set cookie
   `sid=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=<SESSION_DAYS*86400>` plus `Secure`
   when served over HTTPS. Same generic error for unknown user, wrong password or disabled user.
4. **Rate limit:** max 10 failed attempts per username and per IP per 15 minutes → 429 with
   `Retry-After`. Successful login resets the username counter.
5. **Session use:** every `/api/*` route except `POST /api/login` and `GET /api/health` requires a
   valid, unexpired session from a non-disabled user, else 401 `{error:"login_required"}`.
   Sliding expiry: extend `expires_at` at most once per hour on use.
6. **CSRF:** for every non-GET API request require header `X-Requested-With: maint-log` **and**,
   if an `Origin` header is present, that it matches the request host. Otherwise 403.
7. **Logout:** `POST /api/logout` deletes the session and clears the cookie.
8. **Roles:** `tech` can read everything, create/edit/delete records, adjust stock, make backups.
   `admin` additionally manages users, downloads backups, imports v1 data.
   Disabling a user deletes their sessions immediately.
9. **Security headers** on all responses: `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`,
   `Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
   JSON body limit 1 MB (413 above). Never log passwords or tokens.

## 7. API (JSON; errors as `{error: "<code>", message: "<human text>"}`)

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/health` | anyone | `{ok:true, version}` |
| `POST /api/login` / `POST /api/logout` | anyone / user | §6 |
| `GET /api/me` | user | `{id, username, displayName, role}` |
| `GET /api/users` | user | `[{id, displayName, username, role, disabled}]` (for "edited by" names; no hashes) |
| `POST /api/users`, `PATCH /api/users/:id` | admin | create user / rename, role, disable, reset password |
| `GET /api/changes?since=<seq>&limit=500` | user | records with `seq > since`, ordered by seq, incl. tombstones; returns `{records, lastSeq, more}` |
| `PUT /api/records/:store/:id` | user | create or update (body §7.1) |
| `DELETE /api/records/:store/:id?baseVersion=n` | user | soft delete (tombstone) |
| `GET /api/history/:store/:id` | user | history entries newest first with user display names |
| `POST /api/stock-moves` | user | batch of stock deltas (§7.3) |
| `POST /api/backups` | user | one-click backup now → `{file, createdAt, bytes}` |
| `GET /api/backups` | user | list backups (newest first) |
| `GET /api/backups/:file` | admin | download the `.db` file (`Content-Disposition: attachment`) |
| `POST /api/import-v1` | admin | import a v1 JSON backup (§11) |

### 7.1 Writes and "last save wins"

Request: `{data: {...fields}, baseVersion: <int|null>, clientId, clientTime}`.
Server, in one transaction:
1. Validate `store`, `id` (UUID or `sample-*`), and fields per SPEC.md §6 (types, enums, required).
   Reject unknown stores/fields with 400. Ignore `qtyOnHand` in `parts` updates except on create.
2. Load current row. If none → `create`, `version = 1`.
   Else → `update`, `version = current.version + 1`. **The incoming write always wins** (last
   save wins, ordered by server receipt). If `baseVersion` is not null and `baseVersion !==
   current.version`, mark the history entry `conflict = 1` with `note` naming the overwritten
   version, user and time.
3. Set `updated_at = now`, `updated_by = session user`, new `seq`; write `history` with full
   `before`/`after` JSON.
4. Response: `{record, conflict: null | {overwrittenVersion, overwrittenBy: displayName, overwrittenAt}}`.

Deletes are tombstones (`deleted = 1`, new version and seq, history `delete`); same conflict rule.
Tombstoned records are excluded from the UI but still returned by `/api/changes`.

### 7.2 Work-order "done" and machine status

Keep v1 rules (SPEC.md §7) but **stock effects move to §7.3**: the client no longer edits
`qtyOnHand` directly when closing/reopening a job; it sends stock moves instead.

### 7.3 Stock as deltas (prevents lost updates between users)

Concurrent edits to a part's quantity must not overwrite each other. Quantity changes are sent
as deltas: `POST /api/stock-moves {moves: [{id, partId, delta, reason, workOrderId?}]}` where
`id` is a client UUID. The server applies each move once (idempotent by `id`; repeated ids are
ignored and reported as `duplicate`), clamps the resulting quantity at 0 (record the clamp in
history `note`), bumps the part's version/seq, writes history `action='stock'`, and returns the
updated parts. Reasons: `job-done`, `job-reopened`, `manual`, `import`.
Closing a job → negative moves for its parts used; reopening → positive moves (v1 rule 4
semantics, using the work order's `stockDeducted` flag). The +1/−1 buttons on a part send `manual` moves.

## 8. Client sync (offline-first)

- IndexedDB stays the local working copy (v1 `db.js` stores) plus new stores:
  `outbox` (pending writes: `{opId, kind:'put'|'delete'|'stock', store, id, payload, baseVersion, createdAt, attempts}`),
  `meta` (`lastSeq`, `me`, `users` cache).
- Every local save: write IndexedDB immediately (UI updates instantly, record marked
  `pendingSync`), append to `outbox`, then trigger a push.
- **Push:** send outbox entries in order; on success remove the entry and replace the local record
  with the server's (version, updatedBy, updatedAt); on 401 stop and show login; on network error
  keep the entry and retry with backoff (2s, 5s, 15s, 60s max) and on `online` event; on 400 move
  the entry to a "failed" list shown in Settings with the server message (do not retry forever).
- **Pull:** `GET /api/changes?since=lastSeq` on start, after each push, every 30 s while visible,
  and on `online`. Apply server records to IndexedDB unless the same record has a pending outbox
  entry (the pending local edit wins locally until pushed; the server then decides).
- **Conflict notice:** when a push response has `conflict`, show a toast and a banner on the
  record: "You saved over changes by <name> from <time>. See History." Nothing is lost:
  the overwritten version is in history.
- **Status pill** in the header: `Synced` · `Saving… (n)` · `Offline – n changes waiting` ·
  `Sign in needed`. Never claim "Synced" while the outbox is non-empty.
- Pure functions in `logic-sync.js` (tested): outbox ordering/coalescing (several edits to the
  same record while offline coalesce into the latest put, keeping the earliest baseVersion),
  applying a pull batch with pending-edit protection, backoff schedule, status pill text.
- Logout clears the session and, after an in-page confirm that warns about unsynced changes,
  clears local data so the next person on a shared device does not see a stale cache.

## 9. UI changes

1. **Login screen** (`login.js`): username, password, "Sign in" button, error text, shown when
   `/api/me` returns 401. No app data rendered before login.
2. **Last-edited tag on every record block:** every card/row and detail view shows a small tag
   `Edited by <Display Name> · <relative time>` (absolute time in `title` attribute); detail view
   also shows `Created by <name> · <date>`. Pending local edits show `Not synced yet`.
   Desktop tables get an "Edited by" column (hidden in split view).
3. **History** section at the bottom of every detail view: list of versions newest first:
   `v7 · Edited by Ana · Oct 20, 14:03 · changed: status, actionTaken` (field names diffed from
   before/after), conflict entries marked "Overwrote v6 by Ben", stock entries show delta and reason.
   Loaded on demand from `/api/history`.
4. **Header:** sync status pill; user menu with display name and "Sign out".
5. **Settings → Backups:** **"Back up now"** primary button (one click, no extra confirm) → shows
   "Backup saved on server: <file> (<size>)"; list of recent backups (time, who/"Automatic",
   size); admins see "Download" per backup. Keep v1 local JSON/CSV export too.
6. **Settings → Users** (admin only): list, add user (username, display name, role, temporary
   password), disable/enable, reset password.
7. **Settings → Import v1 data** (admin only): pick a v1 JSON backup → shows counts → confirm → import.
8. **Help page:** update "Your data" and FAQ sections for team mode (shared, login, sync,
   offline queue, server backups). Remove "data stays on this device" claims.

## 10. HTTPS, service worker and LAN reality

Browsers only allow service workers (offline app shell) and `Secure` cookies on HTTPS or
`localhost`. So:
- If `TLS_CERT`/`TLS_KEY` are set, serve HTTPS. README documents creating a cert with
  `mkcert` (install its CA on each phone/PC) or the company's internal CA.
- Over plain HTTP on a LAN IP the app still works online with login and sync; the outbox still
  queues edits made while the page is open, but the app cannot be installed or opened offline.
  Show a one-time notice in Settings explaining this when `location.protocol === 'http:'` and
  the host is not `localhost`.
- Service worker: cache only static files, **never** `/api/*` responses. Bump `CACHE_VERSION`.

## 11. Migration from v1

Admin imports a v1 JSON backup (`schemaVersion: 1`) via §9.7 or
`node server/admin.js import-v1 <file> --as <username>`. Records keep their ids; existing ids are
skipped (report counts: created, skipped). Imported records get `created_by/updated_by` = the
importing user and history action `create` with note `imported from v1`. Part quantities are set
directly on import (one `stock` history entry, reason `import`).

## 12. Backups

- **One-click:** `POST /api/backups` uses `node:sqlite` `backup(db, path)` to write
  `DATA_DIR/backups/maint-YYYYMMDD-HHMMSS-<user>.db` (consistent online copy), records it in
  `backups`, returns metadata. At most one backup per 30 s (429 otherwise).
- **Automatic:** daily at `BACKUP_DAILY_AT` server local time (`created_by='schedule'`).
- **Retention:** keep newest `BACKUP_KEEP`; delete older files and rows.
- **Restore** (admin, server stopped): `node server/admin.js restore <file>` copies the chosen
  backup over `maint.db` after first saving the current db as `pre-restore-<timestamp>.db`.
  No restore over HTTP.
- File names are generated by the server only; download/restore reject any name not matching
  `^[A-Za-z0-9._-]+\.db$` or not present in the `backups` table.

## 13. Acceptance criteria

- [ ] `npm test` / `node --test tests/` passes: v1 logic tests + new server and sync tests.
- [ ] Server tests cover: login success/failure, generic error text, rate limit 429, cookie flags
      (HttpOnly, SameSite=Strict, Secure only on HTTPS), 401 without session, 403 without
      `X-Requested-With`, disabled user loses access, create/update/delete with version bumps,
      `updated_by` set from session (client cannot spoof it), conflict flag when baseVersion is
      stale, history entries with before/after, idempotent stock moves, clamp at 0, changes
      feed ordering and tombstones, one-click backup creates a readable SQLite file, retention,
      backup filename validation, static allow-list blocks `server/`, `data/`, `.git/`, `../`.
- [ ] Two browser profiles logged in as two users: user A edits a job, user B sees it after
      pull with "Edited by A"; both edit the same job, the later save wins, a conflict notice is
      shown, and History lists both versions.
- [ ] Offline: with the server stopped, edits queue (status pill shows waiting count); after the
      server restarts they sync without loss.
- [ ] Stock: two users closing different jobs that use the same part both deduct.
- [ ] "Back up now" creates a file under `data/backups/` and it appears in the list.
- [ ] v1 phone/tablet/desktop layouts and Help still work (no regressions in v1.1 checks).
- [ ] No npm dependencies; no external URLs; no innerHTML with user text; no secrets in git.

## 14. Milestones (one commit each, run tests before every commit)

- **S1 Server foundation:** `server/server.js`, `store.js` schema + migrations, static allow-list,
  security headers, `/api/health`, config, test harness. Commit `S1: ...`.
- **S2 Auth:** `auth.js`, users/sessions, login/logout/me, rate limit, CSRF check, `admin.js`
  user commands, tests. Commit `S2: ...`.
- **S3 Records API:** changes feed, PUT/DELETE with versions, last-save-wins + conflict flag,
  history, stock moves, users list, tests. Commit `S3: ...`.
- **S4 Backups:** one-click, daily schedule, retention, list/download, CLI restore, tests. Commit `S4: ...`.
- **S5 Client sync:** `logic-sync.js` + tests, `sync.js` outbox/push/pull, login screen, status
  pill, sign out, stock moves from job close/reopen and ± buttons. Commit `S5: ...`.
- **S6 Client UI:** edited-by tags, History section, conflict banners, Settings backups/users/
  import, Help updates, HTTP notice, SW cache bump, README team-server guide. Commit `S6: ...`.

---

## 15. v2.1 addendum: garment machine types, custom types, "In storage", UI polish (2026-10-21)

Everything in sections 1–14 still applies. Change both client (`logic.js`, `app.js`, `seed.js`,
`help.js`, `styles.css`) and server validation (`server/records.js`) so they agree.

### 15.1 Machine types

Replace the single `sewing` type with garment-specific types. `type` values and labels, grouped
in the form's `<select>` with `<optgroup>`:

| Group | value → label |
|---|---|
| Sewing machines | `single-needle` Single needle lockstitch · `double-needle` Double needle · `binder` Binder · `bartack` Bartack · `buttonhole` Buttonhole · `button-sew` Button sew · `snap-attach` Snap / button attach · `overlock-5` 5-thread overlock (safety stitch) · `overlock-4` 4-thread overlock · `overlock-3` 3-thread overlock · `coverstitch` Coverstitch · `flatlock` Flatlock · `blindstitch` Blind stitch · `feed-off-arm` Feed-off-arm · `zigzag` Zigzag |
| Production equipment | `quilting` Automated quilting · `down-filling` Down filling · `cutter` Cutter (Gerber) · `pressing` Pressing / fusing |
| Facility | `building` Building item (drains, gutters, lighting) |
| Your types | one option per distinct custom type already in use (see 15.2) |
| Other | `other` Other (type your own) |

**Legacy:** `sewing` stays a valid stored value (label "Sewing (general)") so existing records and
v1 imports keep working. It is listed in the select only when the machine being edited already
has it. Default type for a new machine: `single-needle`.

### 15.2 Custom types ("Other")

- New optional machine field `typeLabel` (string, trimmed, 2–40 chars). Required when
  `type === 'other'`; must be absent/empty otherwise (server strips it for other types).
- Choosing **Other (type your own)** reveals a text input "Machine type" directly under the
  select (label, required, maxlength 40, autofocus when revealed).
- Custom types are remembered by being used: "Your types" lists the distinct `typeLabel`
  values of all non-deleted machines (case-insensitive de-duplication, display the most common
  spelling, sorted A–Z). Choosing one sets `type: 'other'` and that `typeLabel`. No separate
  type-management screen in this version.
- Display everywhere (cards, tables, detail, search, CSV): `machineTypeLabel(machine)` in
  `logic.js` returns `typeLabel` for `other`, otherwise the built-in label. Search matches it.
- Unit-test `machineTypeLabel`, `customTypeOptions(machines)` (de-dup, ordering, ignores
  deleted and non-`other` machines) and server validation of `typeLabel`.

### 15.3 Machine status "In storage"

- Add `in-storage` (label "In storage") to machine statuses on client and server. Pill style:
  neutral slate, distinct from Retired.
- Automatic status offers (SPEC.md §7 rule 6) never change a machine that is `in-storage` or
  `retired`.
- **PM is paused** for machines that are `in-storage` or `retired`: their tasks are not counted as
  overdue/due soon on Home, in sidebar counts, or "PM due this week". The PM tab shows them in a
  final group "Paused – machine in storage or retired" (collapsed by default). Implement in
  `logic.js` (`groupPMTasks(tasks, today, machines)` gains a `paused` group; `dashboardCounts`
  respects it) with tests. Changing the machine back to Running resumes them; due dates are
  unchanged (overdue shows immediately if it is past due).
- Machines list filter chips: All · Running · Down · In storage · Retired.

### 15.4 UI polish

1. **User menu (all widths):** the popover is anchored to the user button: right edge aligned
   with the button's right edge, 8 px below it, width 280 px (max `calc(100vw - 32px)`), padding
   16 px. Content: display name (bold), `@username` and role on one muted line, divider, menu items
   as full-width left-aligned rows 44 px tall with a small leading icon (inline SVG or text glyph):
   Help, Settings, divider, **Sign out** (danger colour). `role="menu"`/`menuitem`, Esc and outside
   click close it, Arrow Up/Down move focus, focus returns to the button on close.
2. **Phone header (< 768 px):** user button shows a round initials avatar (e.g. "JC") instead of the
   full name; the sync pill becomes a compact dot + short text (count only when pending); the page
   title gets the remaining space and must not be truncated to a single letter for titles up to
   about 16 characters at 390 px.
3. **Desktop header (≥ 1024 px):** hide the header logo (the sidebar already shows the brand).
4. **Status buttons in job detail:** wrap onto multiple lines (CSS grid, 2 columns on phone, auto
   on wider) instead of a horizontally scrolling strip that cuts labels off.
5. **Machine cards and rows** show a small type badge with `machineTypeLabel`.
6. Keep everything else unchanged; no regressions to sections 13.3 and 14 checks.

### 15.5 Milestones

- **V21a Data:** types, custom types, in-storage, PM paused (logic.js + server/records.js +
  seed.js + machine form/list/detail + tests). Commit `V21a: ...`.
- **V21b UI polish:** 15.4 items 1–5, Help glossary update (machine types, In storage, paused PM),
  SW cache bump. Commit `V21b: ...`.
