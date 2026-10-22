# Shop Maintenance Log

A mobile-first, offline-capable maintenance log for a garment factory: work
orders, machines, parts inventory and preventive maintenance. Plain HTML + CSS
+ vanilla JavaScript ES modules. No build step, no framework, no dependencies.

Two ways to run it:

- **Team server (v2)** — one shared log on one company computer, everyone
  signs in and syncs, edits queue while offline. See the next section.
- **Standalone** — one device, no server; the data stays in that browser.
  See *Run locally* below.

## Install on Windows (10 / 11)

These steps set up the **team server** on a Windows PC. Use **PowerShell** or
**Command Prompt** (not Git Bash, whose terminal cannot hide the password prompt).

1. **Install Node.js 24 LTS** (the only requirement, no npm packages are needed):
   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```
   or download the installer from <https://nodejs.org>. Close and reopen the
   terminal, then check `node --version` shows **v22.5 or newer** (v24 recommended).
2. **Get the code**: on GitHub click **Code → Download ZIP** and extract it to
   `C:\shopfloor-cmms`, or:
   ```powershell
   git clone https://github.com/chowtao123-design/shopfloor-cmms.git C:\shopfloor-cmms
   ```
3. **Create the first admin** (asks for a password, at least 6 characters):
   ```powershell
   cd C:\shopfloor-cmms
   node server\admin.js create-user --admin <username> "<Your Name>"
   ```
4. **Start the server**: double-click **`start-server.cmd`**, or run `npm start`.
   When Windows Firewall asks, allow access on **Private networks** only.
   Keep the window open; closing it stops the server.
5. **Open the app**: on this PC go to <http://localhost:8080>. Other devices on
   the same network use `http://<this-PC-IP>:8080`; find the IP with `ipconfig`
   (the "IPv4 Address" line, e.g. `192.168.1.50`).

**Firewall rule by hand** (if no prompt appeared; run PowerShell as Administrator):
```powershell
New-NetFirewallRule -DisplayName "Shopfloor CMMS" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
```

**Different port**: PowerShell `$env:PORT=8090; npm start` · Command Prompt `set PORT=8090 && npm start`.

**Start automatically when the PC boots** (PowerShell as Administrator; adjust the path):
```powershell
$action  = New-ScheduledTaskAction -Execute "C:\shopfloor-cmms\start-server.cmd"
$trigger = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "Shopfloor CMMS" -Action $action -Trigger $trigger -User "SYSTEM" -RunLevel Highest
```
Remove it again with `Unregister-ScheduledTask -TaskName "Shopfloor CMMS"`.

**Where the data is**: `C:\shopfloor-cmms\data\` (database) and
`C:\shopfloor-cmms\data\backups\` (one-click and daily backups). Copy the
`backups` folder to another drive or network share regularly. To restore, stop the
server, then run `node server\admin.js restore <backup-file.db> --yes`.

**HTTPS on Windows** (needed for phones to install the app and open it offline):
```powershell
winget install FiloSottile.mkcert
mkcert -install
mkcert 192.168.1.50 localhost        # use your PC's IP
$env:TLS_CERT="C:\shopfloor-cmms\192.168.1.50+1.pem"; $env:TLS_KEY="C:\shopfloor-cmms\192.168.1.50+1-key.pem"; npm start
```
Then install mkcert's root certificate on each phone (see [HTTPS](#https-needed-to-installopen-the-app-offline-on-phones) below).

> These Windows steps follow standard Windows 10/11 tools. The server itself is
> tested on Linux; if a step does not work on your PC, please open an issue.

## Team server (v2)

Several technicians share **one** log hosted on one company computer: each
person signs in, sees everyone's records, keeps working offline on the shop
floor, and syncs when back on the network. Every record shows who last edited
it, every change is kept in a per-record History, and anyone signed in can
make a one-click backup saved on the server.

> **Get IT approval before running a server on a company computer.** A server
> the shop relies on should run on a machine that stays on, gets backed up,
> and that IT knows about (port, firewall, HTTPS certificate, backups).

### Requirements

- Node.js 24 (anything ≥ 22.5 works; the server uses `node:sqlite` from
  22.5). Check with `node -v`.
- No npm packages — the server uses only Node built-ins.

### First admin

```
node server/admin.js create-user --admin <username> "<Display Name>"
```

It prompts on the terminal (hidden input) for the password; add
`--password-stdin` to read it from stdin instead. There is no self sign-up:
admins add every other account later on the Settings screen (Users card) or
with the same command without `--admin`.

### Start

```
npm start
```

The server binds `0.0.0.0:8080`, serves the app itself, and keeps all data in
`./data/` (a SQLite file plus `backups/`; git-ignored). Open
`http://<that-computer>:8080/` from any device on the network and sign in.

Configuration (environment variables):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `HOST` | `0.0.0.0` | bind address (LAN) |
| `DATA_DIR` | `./data` | SQLite file + backups |
| `TLS_CERT`, `TLS_KEY` | unset | if both set, serve HTTPS (see below) |
| `SESSION_DAYS` | `14` | sign-in session lifetime (sliding) |
| `BACKUP_KEEP` | `30` | number of backups kept |
| `BACKUP_DAILY_AT` | `02:00` | local time for the automatic daily backup; `off` disables |

### LAN access and firewall

- Find the computer's LAN address (`ip a`, or `ipconfig` on Windows), e.g.
  `192.168.1.50`. Everyone opens `http://192.168.1.50:8080`.
- Open the port in the firewall if needed: Ubuntu `sudo ufw allow 8080/tcp`,
  Windows Defender Firewall → Inbound Rules → new TCP rule for port 8080.
- Run the server somewhere that survives logouts (tmux, a systemd unit, or
  Windows Task Scheduler) so the nightly backup and sync keep working.

### HTTPS (needed to install/open the app offline on phones)

Offline install (service worker) and offline opening only work over HTTPS or
`localhost`. Over plain HTTP on a LAN IP the app still works online — sign-in,
sync and the offline queue — but it cannot be installed or opened offline, and
Settings shows a note saying so. To serve HTTPS with a certificate that
phones trust:

```
# once: install mkcert (github.com/FiloSottile/mkcert), then:
mkcert -install                                   # trust the CA on this computer
mkcert -cert-file cert.pem -key-file key.pem 0.0.0.0 192.168.1.50 localhost
TLS_CERT=cert.pem TLS_KEY=key.pem npm start
```

- Install that mkcert CA on each phone/PC that will use the app (send them the
  `rootCA.pem` from `mkcert -CAROOT` and have them open/install it), or use a
  certificate your company already issues for internal hosts.
- Keep `cert.pem`/`key.pem` out of git; they are credentials.

### Backups

- **One click:** anyone signed in with *Backups → Write* permission → Settings →
  **Back up now**. The file is written to `DATA_DIR/backups/` and shows up in
  the list right away (listing needs *Backups → Read*).
- **Automatic:** the server backs itself up daily at `BACKUP_DAILY_AT` and
  keeps the newest `BACKUP_KEEP` backups (older files are deleted).
- Downloading a backup file needs *Backups → Write*.
- **Restore** (with the server stopped):
  `node server/admin.js restore <backup-file>` — the current database is
  saved first as `backups/pre-restore-<timestamp>.db`. There is no restore
  over HTTP.

### Roles and permissions

Instead of the fixed admin/tech split, an **Administrator** (a user whose role
has *Users & roles → Write*) defines **roles**, and each role sets a level
**None / Read / Write** for every area of the app (Service Orders, Preventive
Maintenance, Machines, Parts & Stock, Coworkers, Outside Contractors,
Contractor rates & costs, Statistics, Photos & files, Backups, AI assistant,
Branding & AI settings, Users & roles).

- Built-in roles (created automatically, levels per SPEC-v3.md 13.1):
  **Administrator** (everything Write; the role itself cannot be edited or
  deleted), **Technician** (Write on the day-to-day areas, Read on Statistics
  and Backups), **Viewer** (Read on most areas).
- The server checks the signed-in user's role permissions on **every
  request**; a change takes effect on the user's next request. A denied call
  returns `403` with `{error: "forbidden", area, needed}`.
- Safety rails: the last enabled user with *Users & roles → Write* cannot be
  disabled or demoted, and nobody can strip that Write from their own role.
- Manage roles over the API (`GET/POST /api/roles`, `PATCH/DELETE
  /api/roles/:id`, history per role) or on the server:

```
node server/admin.js create-user --admin <username> "<Display Name>"
node server/admin.js create-user --role "Supervisor" <username> "<Display Name>"
node server/admin.js list-users        # shows each user's role name
```

### Importing v1 data

An admin imports a v1 JSON backup (from the old single-device app) on the
Settings screen → **Import v1 data**, or on the server:

```
node server/admin.js import-v1 <file> --as <your-username>
```

Records keep their ids; ids that already exist on the server are skipped
(reported as created/skipped counts). Imported parts set their quantity with
one stock entry of reason `import`.

### Updating the app

Replace the app files (git pull, or copy the folder), restart the server, done.
Records live in `data/maint.db`, not in the app files, so an update does not
touch them. Devices pick up the new app shell on their next reload (the
service-worker cache is versioned and refreshes itself).

## Run locally (standalone, single device)

```
python3 -m http.server 8080
```

Then open <http://localhost:8080>. Any other static file server works too.
Opening `index.html` directly from the file system (`file://…`) is not
supported: IndexedDB and the service worker need a real http(s) origin.
Without the team server this stays the v1 single-device app: no sign-in, no
sync, everything in that browser (use Settings → Export backup to move data).

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

When you run the app standalone like this, all data lives in IndexedDB on
that phone, in that browser, and is not synced anywhere — use
**Settings → Export backup (JSON)** regularly and keep the file somewhere
safe. On the team server there is nothing to move: records live on the server
and every device syncs automatically.

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