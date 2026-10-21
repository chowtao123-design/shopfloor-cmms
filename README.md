# Shop Maintenance Log

A mobile-first, offline-capable maintenance log for one technician in a garment
factory: work orders, machines, parts inventory and preventive maintenance.
Plain HTML + CSS + vanilla JavaScript ES modules. No build step, no framework,
no dependencies, nothing leaves the device.

## Run locally

```
python3 -m http.server 8080
```

Then open <http://localhost:8080>. Any other static file server works too.
Opening `index.html` directly from the file system (`file://…`) is not
supported: IndexedDB and the service worker need a real http(s) origin.

## Run the tests

```
node --test tests/
```

(equivalent: `npm test`). Tests use the Node built-in test runner and cover every
business rule in SPEC.md section 7: PM due dates and states, Mark-done → PM work
order, stock deduction with clamp-to-zero and no double-deduct on
close/reopen/re-close, low stock, machine down/running offers, search, CSV
quoting, backup validation, and the sample-data composition.

## Install on a phone

1. Serve the folder from a computer the phone can reach, e.g.
   `python3 -m http.server 8080` (phone and computer on the same Wi-Fi), then
   open `http://<computer-ip>:8080`.
2. Android Chrome: menu → **Install app** (or "Add to Home screen").
   iPhone Safari: Share → **Add to Home Screen**.
3. Open it from the home screen at least once while online. The service worker
   caches the whole app shell, so it keeps working with no Wi-Fi on the shop
   floor.
4. For a permanent install, host the folder over HTTPS anywhere static (the app
   makes no network calls at runtime, so any dumb file host will do) and repeat
   step 2 from that address.

All data lives in IndexedDB on that phone, in that browser. Nothing is synced
anywhere. Use **Settings → Export backup (JSON)** regularly and keep the file
somewhere safe; **Import backup** on a new phone restores everything.

## App tour

- **Home** – counters and a "Needs attention" list (overdue PM, urgent jobs,
  low stock), plus a reminder chip when the last backup is 7+ days old.
- **Jobs** – the log. Filter chips, search, one-tap status changes, and the
  floating **+ Log repair** button for the under-60-seconds quick form.
- **Machines** – asset register; each machine shows full repair history, its PM
  tasks and the parts that fit it.
- **Parts** – searchable inventory with a low-stock filter, +1/−1 stock buttons
  and "used on work orders" per part. Parts used on a job are deducted from
  stock when the job is marked **Done** (exactly once, even if it is reopened
  and closed again).
- **PM** – grouped Overdue / Due soon / Upcoming; **Mark done** logs a completed
  PM work order and reschedules the task.

## Decisions

Choices made where SPEC.md was silent or ambiguous:

1. **Jobs default filter** is "All open" (everything not done). The "Waiting"
   chip combines `waiting-parts` and `waiting-tech`, matching Home's counter.
2. **Quick-log machine picker** is a type-to-search input (datalist) with
   recently-used machines first, rather than a plain `<select>` — faster with
   one hand. An exact or unique partial match is accepted.
3. **Sample data labelling**: `seed.js` is headed "EXAMPLE DATA ONLY" and every
   load path says "example data" in the confirm/toast. Record names themselves
   are realistic and not prefixed, so the trial feels like a real shop; loading
   twice is safe (fixed ids just overwrite).
4. **Done-job stock edits**: stock is deducted exactly once per spec rule 4
   (flagged with `stockDeducted`). Editing `partsUsed` on a job that is already
   done does not re-adjust stock; reopen the job once if the quantities need to
   be redone.
5. **Backup reminder** also says "No backup yet" the first time the device has
   data but no export, and only once data exists (an empty shop is not nagged).
6. **Deleting a machine** keeps its work orders and PM history in the log; their
   machine shows as "Unknown machine" afterwards.
7. **Icons** are simple generated PNGs (full-bleed orange square, white log
   page), maskable-safe; the generator script lives in `.tmp/gen-icons.js`
   (gitignored scratch).
8. **Service worker cache** is versioned (`maint-log-v1`); bump the version in
   `sw.js` after changing any shell file so installed phones pick up the update.
9. **UI preferences** (last tab, last-used machine, last backup timestamp) are
   the only things kept in `localStorage`; every record lives in IndexedDB.

## Project layout

See SPEC.md section 5. In short: `index.html` + `styles.css` + `app.js` (rendering
and routing), `logic.js` (pure, tested rules), `db.js` (IndexedDB wrapper),
`seed.js` (sample data), `sw.js` + `manifest.webmanifest` + `icons/` (offline
PWA shell), `tests/logic.test.js`.