# Shop Maintenance Log: Product & Technical Spec

**Owner:** A maintenance technician at a garment factory
**Author:** Senior project engineer (spec), implementation by coding agent
**Status:** v1.0, ready to build
**Date:** 2026-10-20

---

## 1. Problem

The technician maintains a factory building plus its production equipment (industrial sewing machines,
automated quilting systems, down-filling machines, Gerber cutters). Today repairs are logged in
Excel and coordinated by email. There is no single place to:

- record a repair quickly from the shop floor, on a phone
- see which jobs are still open or waiting on parts / an outside technician
- look up a part and whether it is in stock
- see which preventive maintenance (PM) tasks are due or overdue
- see a machine's full repair history

## 2. Goal (v1)

A **mobile-first, offline-capable web app** that one person uses on a phone, with data stored
on that device. Logging a repair must take **under 60 seconds** with one hand.

### In scope (v1)
1. **Work orders** (repair log + job status)
2. **Machines** (asset register + per-machine history)
3. **Parts inventory** (search, stock levels, low-stock alerts)
4. **Preventive maintenance schedule** (recurring tasks, due / overdue)
5. **Backup**: export all data to a JSON file and import it back; export work orders to CSV

### Out of scope (v1), do NOT build
- user accounts, login, multi-user sync, any backend server or database server
- reports/charts dashboards (planned v2: downtime, recurring faults)
- push notifications, email sending
- photo upload (planned v2; leave a `photos: []` field in the schema)
- barcode/QR scanning (v2)

## 3. Users & context

- Single user, Android or iPhone, Chrome/Safari, often gloves/dirty hands, noisy floor,
  intermittent Wi-Fi. Large tap targets (min 44x44 px), high contrast, works offline.
- English UI. Plain trade vocabulary ("Work order", "Parts", "PM due"), no jargon like "entity".

## 4. Tech constraints (mandatory)

- **No build step, no framework, no npm runtime dependencies.** Plain HTML + CSS + vanilla
  JavaScript (ES modules). The app must run by opening it from any static file server.
- **Storage:** IndexedDB via a small hand-written wrapper (`db.js`). No localStorage for records
  (localStorage allowed only for UI prefs like last tab).
- **Offline:** a service worker (`sw.js`) caches the app shell; installable as a PWA
  (`manifest.webmanifest`, 192 and 512 px icons generated as simple SVG→PNG or inline SVG).
- **Dates:** store ISO strings `YYYY-MM-DD` (dates) and full ISO timestamps (`createdAt`).
  All due-date math in pure functions in `logic.js` (no DOM access) so it is unit-testable.
- **Tests:** `node --test` (built into Node 18+) for `logic.js`. No test framework installs.
- **Accessibility:** every input has a `<label>`, visible focus ring, respects
  `prefers-reduced-motion`, light and dark theme via `prefers-color-scheme`.
- **Security:** no external network calls at runtime, no CDN scripts, no analytics.
  Escape all user text before inserting into HTML (no `innerHTML` with raw user input).

## 5. File layout

```
maint-log/
  SPEC.md            (this file, do not edit)
  index.html         app shell, bottom tab bar
  styles.css
  app.js             routing between tabs, rendering
  db.js              IndexedDB wrapper: open, getAll, get, put, delete, clear, per store
  logic.js           pure functions: status rules, PM due dates, low-stock, search, CSV
  sw.js              service worker (cache-first app shell)
  manifest.webmanifest
  icons/             icon-192.png, icon-512.png (or SVG)
  seed.js            optional sample data, loaded only when user taps "Load sample data"
  tests/logic.test.js
  README.md          how to run locally and how to install on a phone
```

## 6. Data model (IndexedDB stores)

All records: `id` (string, `crypto.randomUUID()`), `createdAt`, `updatedAt` (ISO timestamps).

### `machines`
| field | type | notes |
|---|---|---|
| name | string, required | e.g. "Juki DDL-8700 #12" |
| type | enum | `sewing`, `quilting`, `down-filling`, `cutter`, `building`, `other` |
| model | string | |
| serial | string | |
| location | string | e.g. "Line 2", "Roof" |
| status | enum | `running`, `down`, `retired` |
| notes | string | |

`type: building` covers facility items (drains, gutters, lighting) so building work is logged
the same way as machine work.

### `parts`
| field | type | notes |
|---|---|---|
| name | string, required | |
| partNumber | string | searchable |
| qtyOnHand | integer ≥ 0 | |
| minQty | integer ≥ 0 | low-stock threshold |
| unit | string | default `pcs` |
| location | string | shelf/bin |
| supplier | string | |
| supplierContact | string | phone/email shown as selectable text |
| machineIds | string[] | machines this part fits |
| notes | string | |

### `workOrders`
| field | type | notes |
|---|---|---|
| title | string, required | short fault, e.g. "Needle breaking" |
| machineId | string, required | |
| kind | enum | `breakdown`, `pm`, `facility`, `install`, `other` |
| priority | enum | `low`, `normal`, `urgent` |
| status | enum | `open`, `in-progress`, `waiting-parts`, `waiting-tech`, `done` |
| reportedAt | ISO date | default today |
| completedAt | ISO date or null | set automatically when status → `done`, cleared if reopened |
| problem | string | symptoms, error codes |
| actionTaken | string | what was done |
| partsUsed | `{partId, qty}[]` | |
| minutesSpent | integer | labour time |
| downtimeMinutes | integer | machine out of service time |
| pmTaskId | string or null | set when created from a PM task |
| photos | [] | reserved for v2, always empty |

### `pmTasks`
| field | type | notes |
|---|---|---|
| title | string, required | e.g. "Oil hook and check timing" |
| machineId | string, required | |
| intervalDays | integer ≥ 1 | e.g. 7, 30, 90 |
| lastDoneAt | ISO date or null | |
| instructions | string | checklist text |
| active | boolean | |

## 7. Business rules (implement in `logic.js`, all unit-tested)

1. **PM due date:** `dueDate = lastDoneAt + intervalDays`. If `lastDoneAt` is null, the task is
   due today (counts as due, not overdue).
2. **PM state** given `today`: `overdue` if `dueDate < today`; `due-soon` if within 3 days
   (inclusive) ; otherwise `ok`. Inactive tasks are never due.
3. **Completing a PM:** "Mark done" creates a `workOrder` with `kind: pm`, `status: done`,
   `pmTaskId` set, and sets the task's `lastDoneAt` to the completion date.
4. **Parts deduction:** when a work order is saved as `done`, subtract each `partsUsed.qty` from
   that part's `qtyOnHand`, exactly once. Reopening and re-closing must not deduct twice
   (track `stockDeducted: true` on the work order; reopening restores stock and clears the flag).
   Stock never goes below 0; if it would, save anyway, clamp to 0 and show a warning.
5. **Low stock:** a part is low when `qtyOnHand <= minQty` and `minQty > 0`.
6. **Machine status:** saving an `open`/`in-progress`/`waiting-*` breakdown work order offers
   (checkbox, default on) to set the machine to `down`; closing the last open breakdown on a
   machine offers to set it back to `running`.
7. **Search:** case-insensitive substring across part `name`, `partNumber`, `supplier`, `notes`,
   and machine names the part fits. Same idea for work orders (title, problem, actionTaken,
   machine name).
8. **CSV export:** work orders with columns
   `reportedAt,completedAt,machine,kind,priority,status,title,problem,actionTaken,partsUsed,minutesSpent,downtimeMinutes`;
   proper CSV quoting (fields with comma, quote or newline wrapped in quotes, quotes doubled).

## 8. Screens

Bottom tab bar (always visible, thumb-reachable): **Home · Jobs · Machines · Parts · PM**.
A floating **"+ Log repair"** button on Home and Jobs.

### 8.1 Home (today view)
- Counters as tappable chips: Open jobs · Waiting (parts/tech) · PM overdue · PM due soon · Low stock
- List "Needs attention": overdue PM, urgent open jobs, low-stock parts (max 10, newest first)
- Empty state explains what to do first ("Add your machines, then log your first repair") with a
  "Load sample data" button.

### 8.2 Jobs
- Filter chips by status (default: all not-done), search box.
- Each row: status pill (colour + text, never colour alone), title, machine, reported date, age in days.
- **Quick log form** (the 60-second path): machine (searchable select, recent machines first),
  title, kind, priority, status (default `open`), problem. "More details" expands actionTaken,
  partsUsed (pick part + qty), minutes, downtime.
- Work order detail: edit all fields, one-tap status change buttons, Delete with in-page confirm
  (no `window.confirm`).

### 8.3 Machines
- List with status pill and count of open jobs; search.
- Machine detail: fields, **repair history** (all work orders newest first), PM tasks for this
  machine, parts that fit it.

### 8.4 Parts
- Search box at top (autofocus), low-stock filter chip.
- Row: name, part number, qty (red when low), location.
- Part detail: edit, +1 / −1 quick stock buttons, list of work orders that used it.

### 8.5 PM
- Grouped: Overdue, Due soon, Upcoming. Each row: task, machine, due date, "Mark done" button.
- Create/edit task form.

### 8.6 Settings (gear icon in header)
- Export backup (JSON of all stores + `schemaVersion: 1` + `exportedAt`), triggered as a file
  download via a Blob link.
- Import backup: file picker, validate `schemaVersion`, show counts, in-page confirm, then
  replace all data.
- Export work orders CSV.
- "Load sample data" / "Erase all data" (in-page confirm, type ERASE).
- Show last backup date; Home shows a reminder chip if no backup in 7 days.

## 9. Visual design

- Mobile-first, single column; max content width 720 px on desktop.
- High-contrast, utilitarian "shop-floor" look: neutral greys with one safety-orange accent for
  primary actions; status colours: open = blue, in-progress = amber, waiting = purple,
  done = green, overdue/low = red. Always pair colour with text.
- System font stack; tabular numbers for quantities and dates.
- Tap targets ≥ 44 px; form inputs ≥ 16 px font (prevents iOS zoom).

## 10. Sample data (`seed.js`, only on request)

Clearly labelled as example data. Machines: 3 sewing machines, 1 automated quilting system,
1 down-filling machine, 1 Gerber cutter, 2 building items (roof gutters, main drain).
Parts: needles, bobbin cases, presser feet, cutter blades, load cell, fluorescent tubes; one
part below minQty. 4 PM tasks (one overdue, one due soon). 6 work orders in mixed statuses.

## 11. Acceptance criteria

- [ ] `node --test tests/` passes; tests cover rules 1–5, 7 and 8 including edge cases
      (null lastDoneAt, due-soon boundary at exactly 3 days, double close/reopen stock,
      clamp to 0, CSV quoting of commas/quotes/newlines).
- [ ] Served with `python3 -m http.server 8080` the app loads with no console errors.
- [ ] Works offline after first load (service worker caches shell).
- [ ] Logging a repair from Home takes ≤ 4 taps plus typing the title.
- [ ] Usable at 375 px width with no horizontal scroll.
- [ ] Export → Erase → Import restores identical data.
- [ ] No external network requests (check: no `http` URLs in source except comments/README).
- [ ] All user text rendered safely (no raw `innerHTML` of user input).

## 12. Milestones (build and commit in this order)

1. **M1 Foundation:** `db.js`, `logic.js` + tests passing, app shell with tab bar and routing.
2. **M2 Machines + Work orders:** CRUD, quick log form, status changes, machine history.
3. **M3 Parts:** CRUD, search, low stock, parts used on work orders with stock deduction rules.
4. **M4 PM:** tasks, due states, Mark done → work order.
5. **M5 Home + Settings:** dashboard counters, export/import JSON, CSV export, sample data,
   backup reminder.
6. **M6 PWA + polish:** manifest, icons, service worker, accessibility pass, README.

Commit after each milestone with message `M<n>: <summary>`. Run `node --test tests/` before
every commit; do not commit with failing tests.

---

## 13. v1.1 addendum: Desktop mode + Help page (2026-10-20)

v1.0 is built and committed. This addendum adds two features. Everything in sections 1–12 still
applies (no frameworks, no CDN, no network calls, no innerHTML with user text, no
alert/confirm/prompt, logic in `logic.js` with tests). Do not change data model or business rules.

### 13.1 Desktop mode (responsive layout, not a separate app)

Same pages and routes; layout adapts by viewport width using CSS media queries.

| Width | Layout |
|---|---|
| < 768 px | Unchanged v1.0 phone layout (bottom tab bar, FAB, single column). Must not regress. |
| 768–1023 px (tablet) | Bottom tab bar kept; content max width 960 px; Home counters in 3 columns; forms in 2 columns. |
| ≥ 1024 px (desktop) | **Left sidebar navigation** replaces the bottom tab bar (same items + Help + Settings, with text labels and counts: open jobs, PM overdue, low stock). Content area max width 1200 px. |

Desktop (≥ 1024 px) specifics:
1. **Sidebar:** fixed left, 220–240 px wide, app name at top, nav items, active item highlighted
   with `aria-current="page"`. Bottom tab bar and the floating "+ Log repair" button are hidden;
   a "+ Log repair" primary button sits at the top of the sidebar instead.
2. **Lists become tables** on Jobs, Machines and Parts: sortable by clicking column headers
   (sort is client-side, `aria-sort` set on the active header). Columns:
   - Jobs: Status, Title, Machine, Kind, Priority, Reported, Age (days), Downtime
   - Machines: Name, Type, Location, Status, Open jobs, Next PM due
   - Parts: Name, Part #, Qty, Min, Location, Supplier (low-stock rows marked with text "Low", not colour only)
   Tables sit in an `overflow-x: auto` wrapper. Put sort comparison in `logic.js` (`sortRows(rows, key, dir)`)
   and unit-test it (strings case-insensitive, numbers numeric, empty values last in both directions).
3. **List + detail split view** on Jobs, Machines and Parts: clicking a row opens the detail in a
   right-hand pane (about 45% width) while the list stays visible; the URL still changes to the
   detail route so links and the back button keep working. Below 1024 px, detail stays a full page as today.
4. **Home:** counters in one row of 5; "Needs attention" and "PM due this week" side by side.
5. **Keyboard shortcuts (desktop only, ignored while typing in an input):** `n` new work order,
   `/` focus the page's search box, `g` then `h/j/m/p` go to Home/Jobs/Machines/Parts/PM
   (`g` then `k` for PM). List shortcuts on the Help page.
6. Hover and visible focus states on all rows and buttons.

### 13.2 Help page (`#/help`)

Purpose: someone who receives the link (a coworker, supervisor, recruiter) understands the app
without asking the owner. Plain English, short sections, no jargon without a definition.

Reachable from: a "?" Help icon button in the header (all widths), the sidebar (desktop), a
"New here? Read the guide" link in the Home empty state, and a link at the top of Settings.

Sections (use `<h2>` per section; in-page table of contents with anchor links at the top):
1. **What this app is**: a maintenance log for one technician: repairs, machines, parts and
   preventive maintenance in one place, built for use on a phone on the shop floor.
2. **Your data stays on this device**: no account, no cloud. Sharing the link shares the empty
   app, **not your records**. To hand records to someone, use Settings → Export backup and send
   the file; they use Settings → Import. Clearing browser data erases records, so export regularly.
3. **Quick start (5 steps)**: add machines (or load sample data) → log a repair → update its
   status → add parts and set a minimum quantity → add PM tasks.
4. **Glossary** (definition list `<dl>`): Work order / job, Breakdown, PM (preventive
   maintenance) with an example, PM interval, Overdue / Due soon (within 3 days), each job status
   (Open, In progress, Waiting for parts, Waiting for technician, Done), Downtime, Labour minutes,
   Low stock / minimum quantity, Building item (drains, gutters, lighting logged like a machine).
5. **How to…**: log a repair in under a minute; close a job and deduct parts (stock is deducted
   once when a job is marked Done and restored if reopened); mark a PM done; find a part; see a
   machine's history; export to Excel (CSV); back up and restore.
6. **Install on your phone**: Android Chrome (menu → Add to Home screen / Install app) and iPhone
   Safari (Share → Add to Home Screen). Works offline after the first visit.
7. **Desktop tips**: sidebar, sortable tables, split view, keyboard shortcuts table.
8. **FAQ**: "I shared the link and my coworker sees nothing" (data is per device, send a backup);
   "Will I lose data if I update the app?" (no, updates keep data; still export backups);
   "Can two people use the same log?" (not in this version; planned).

Help content is static text in `help.js` (exported function that builds the page with DOM
helpers, no innerHTML), so it is easy to edit later. Add `help.js` to the service-worker cache list.

### 13.3 Acceptance criteria (v1.1)

- [ ] `node --test tests/` passes, including new `sortRows` tests.
- [ ] At 390 px: identical behaviour to v1.0 (bottom tabs, FAB on Home and Jobs only, no back
      arrow on top-level tabs, no horizontal page scroll). **Regression check required.**
- [ ] At 1280 px: sidebar visible, bottom tab bar and FAB hidden, tables shown, clicking a row
      opens the split detail pane, no horizontal page scroll.
- [ ] At 800 px: tablet layout, no horizontal page scroll.
- [ ] `#/help` renders all 8 sections with working table-of-contents anchors at all widths.
- [ ] Help is reachable from header, sidebar, Home empty state and Settings.
- [ ] Keyboard shortcuts work on desktop and do nothing while typing in a field.
- [ ] Service worker `CACHE_VERSION` bumped; `help.js` cached.
- [ ] No external URLs, no innerHTML/alert/confirm/prompt (same checks as v1.0).

### 13.4 Milestones

- **M7 Help page** (smaller, independent): `help.js`, route, links, SW cache. Commit `M7: ...`.
- **M8 Desktop layout**: sidebar, tablet/desktop breakpoints, tables with `sortRows` + tests,
  split view, Home desktop grid, shortcuts. Commit `M8: ...`.
