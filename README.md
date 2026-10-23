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
admins add every other account later in the app on the **Admin page (Users
tab)** or with the same command without `--admin`.

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
- In the app, roles are managed on the **Admin page** (sidebar "Admin", only
  for roles with *Users & roles → Write*): a **Users** tab (role select with
  an Undo toast, enable/disable, reset password, add user) and a **Roles &
  permissions** tab (the matrix with a locked Administrator column, Save /
  Discard for unsaved changes, per-role History). Every other page follows
  your own role: None hides the area, Read shows a "View only" badge and no
  create/edit controls, and a change someone no longer has permission for
  lands in the Settings failed list as "You no longer have permission to
  change …".
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

## AI assistant (v3)

Admins configure the assistant in Settings → **AI assistant** (the chat button
is hidden when no provider is configured). Providers:

- **openai-compatible** – base URL + API key + model id; works with OpenAI,
  vLLM, Ollama, LM Studio.
- **opencode** – run `opencode serve` **on the same machine**, bound to
  `127.0.0.1`, set `OPENCODE_SERVER_PASSWORD` and use it as the server
  password here, and start it in an **empty dedicated folder** (opencode can
  read and edit the folder it runs in; an empty one gives it nothing to touch).

### Setup steps — opencode

1. On the machine that runs the maint-log server, create a new **empty folder**
   (opencode can read and edit the folder it runs in; keep it dedicated).
2. Start opencode there, bound to localhost, with a password:

   ```
   OPENCODE_SERVER_PASSWORD=choose-a-long-password opencode serve --port 4096
   ```

3. In Settings → **AI assistant** pick provider **opencode** and fill in:
   Server URL `http://127.0.0.1:4096`, Server password (the value from step 2),
   Provider ID and Model ID of the model your opencode uses.
4. Press **Save**, then **Test connection**.

### Setup steps — an OpenAI-compatible server (for example vLLM)

1. Run your model server on the same machine (or anywhere the maint-log
   server can reach it), for example with vLLM:

   ```
   vllm serve Qwen/Qwen2.5-7B-Instruct --port 8000
   ```

   Ollama and LM Studio work the same way (Ollama's default port is 11434).
2. In Settings → **AI assistant** pick provider **OpenAI-compatible** and fill
   in: Base URL `http://127.0.0.1:8000/v1` (append `/v1`; for Ollama use
   `http://127.0.0.1:11434/v1`), the API key the server expects (any value
   when it does not check), and the exact model id the server serves (vLLM
   prints it at startup).
3. Press **Save**, then **Test connection**.

Always use the **Test connection** button after changing settings. Secrets (the
API key, the opencode password) are stored server-side only and are never sent
back to the browser (the API answers `{configured: true}` style booleans).

### Using the chat

Signed-in users whose role has the **AI assistant** permission (Read or Write)
get a round chat button fixed at the bottom right of every page. It opens the
assistant panel: questions and answers, "Clear history" (your own chats only),
and a one-line privacy notice. The assistant may suggest a **draft service
order**; "Open as new service order" opens the normal form pre-filled and
nothing is saved until you press Save there.

How it behaves:

- The server, not the browser, talks to the provider. Each question sends a
  short explanation of the app plus a **read-only** snapshot: open and overdue
  service orders, down machines, PM due within 7 days, low-stock parts and up
  to 20 records matching the question — but only the areas your role can Read
  (a machine you cannot read shows as "a machine"; contractor hourly rates and
  costs need the *Contractor rates & costs* permission). The assistant is told
  which areas are hidden from you, so it answers "you do not have access to X"
  instead of guessing. Other people's chats stay out, and the assistant cannot
  change any data.
- It may propose a **draft service order** as a JSON block; nothing is saved
  until you review it and press Save.
- Limit: 20 messages per minute per user (then a short cool-down).
- Chat history is stored per user (`GET /api/ai/history`) and everyone can
  clear only their own (`DELETE /api/ai/history`).
- If the provider is down or times out (60 s), the chat shows a friendly
  error; the server logs the failure without secrets.

## Parts requests with Muse (v4)

Parts requests are normal records, so the Muse agent (an admin-created API
token user with the *Parts requests* permission) updates the shopping list
through the existing routes — no dedicated API:

- Read the current requests with `GET /api/changes` (all stores in one
  call) or `/api/records/purchaseRequests` to find the draft to add to.
- Add or change lines with `PUT /api/records/purchaseRequests/:id`. The PUT
  **replaces the whole record**: read it first, then send it back with all
  the lines (old and new) — a line you leave out is deleted.
- The request `number` (`261022001`, shown `PR-261022-1`: day + that day's count) is assigned by the server on first save
  and ignored on write, just like service order numbers; new requests start
  as `draft` with the HST rate defaulting to 13.
- A request that was already sent stays editable (prices often change after
  the accountant calls the supplier); marking it received is a normal status
  change and never touches stock quantities.

The OpenAPI document (`GET /api/openapi.json`) describes the whole record
shape, including every line field.

## Library & AI repair help (v4)

The **Library** page keeps machine manuals (PDF uploads) and your own repair
methods (symptom → cause → steps), each linked to a machine type, model
numbers or specific machines. Making a manual readable by the AI:

- Upload a text PDF (up to 50 MB). After the upload the server extracts the
  text in the background; the badge on the manual then reads **“AI can read ·
  N pages”** — those pages are what the chat can quote, with page numbers.
- **Scanned PDFs have no text to extract** (badge “Scanned — AI can’t
  read”): type the key specs — needle charts, timing marks, settings — into
  the manual’s *Text for the AI* box; the assistant uses that text instead.

In the chat, name the machine (name, model, serial or a service order
number) and the assistant builds the answer from the matching repair
methods, manual excerpts and the machine’s last completed fixes, citing
where each fact came from. When a fix works, ask it to save the steps: it
proposes a repair method that you save with one Apply button.

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

- **Home** – counters and a "Needs attention" list (overdue PM, urgent service
  orders, low stock), plus a reminder chip when the last backup is 7+ days old.
- **Service Orders** – the log. Search, filters (status, priority, category,
  machine, assignee, kind, due date, created range) with removable chips, a
  sortable table with pagination, and **List · Board · Calendar** views on
  desktop. Board cards move by drag and drop or with a **Move to…** menu; the
  calendar shows the month by due date. Phones get compact cards and the same
  filters in a bottom sheet, and the **+ Service order** form covers
  assignments, checklist, labour hours and photo/PDF attachments.
- **Machines** – asset register; each machine shows full repair history, its PM
  tasks and the parts that fit it (open service orders are counted in the
  "Open orders" column).
- **Parts** – searchable inventory with a low-stock filter, +1/−1 stock buttons
  and "used on service orders" per part. Parts used on a service order are
  deducted from stock when it is marked **Done** (exactly once, even if it is
  reopened and closed again).
- **PM** – grouped Overdue / Due soon / Upcoming; **Mark done** logs a completed
  PM service order and reschedules the task.

## Decisions

Choices made where SPEC.md was silent or ambiguous:

1. **Service order default filter** is "Not done" (everything not done); the
   Home "Waiting" link combines `waiting-parts` and `waiting-tech`. Filter
   state is stored per device and "Clear all" returns to the default.
2. **Quick-log machine picker** is a type-to-search input (datalist) with
   recently-used machines first, rather than a plain `<select>` — faster with
   one hand. An exact or unique partial match is accepted.
3. **Sample data labelling**: `seed.js` is headed "EXAMPLE DATA ONLY" and every
   load path says "example data" in the confirm/toast. Record names themselves
   are realistic and not prefixed, so the trial feels like a real shop; loading
   twice is safe (fixed ids just overwrite).
4. **Done-order stock edits**: stock is deducted exactly once per spec rule 4
   (flagged with `stockDeducted`). Editing `partsUsed` on a service order that
   is already done does not re-adjust stock; reopen it once if the quantities
   need to be redone.
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