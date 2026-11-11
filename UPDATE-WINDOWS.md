# Updating the Windows copy (v6, November 2026)

Use this on the Windows PC that runs the CMMS, from inside the CMMS folder (e.g. `C:\shopfloor-cmms`).
It can be pasted into opencode as-is. It updates the **code**, then runs a one-time **setup** that adds
the v6 Supervisor role and the agreed floor zones to the live database (preview first, backup first).

The `data` folder (database, manuals, photos, tokens) is never in git or in the zip, and must never be
replaced, deleted or committed.

## Rules for the agent

- Do not edit, move or delete anything in `data\` except the backup copy in step 2.
- Do not commit or push from this PC. GitHub is updated from the build machine only.
- Stop and report if any step fails; do not try to "fix" it by resetting data.
- Do not print staff names, tokens or passwords in the chat.

## Steps (PowerShell, in the CMMS folder)

1. **Stop the CMMS server** (close its window, or Ctrl+C in it). Check nothing listens on 8080:
   `Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue` (no output = stopped).
2. **Back up the data folder**:
   `Copy-Item -Recurse data ("data-backup-" + (Get-Date -Format yyyyMMdd-HHmm))`
3. **Update the code** — either way:
   - **From GitHub**: `git status`, then set local edits aside (they are all included in v6, including
     the floor-map id fix): `git stash push --include-untracked -m "windows-local-before-v6"`, then
     `git pull --ff-only origin master`. Then copy **`local-config.json`** from the zip into the CMMS
     folder (it holds the private WPFI sheet / form links and is not in git).
   - **From the zip** (`shopfloor-cmms-v6-*.zip`): extract it to a temporary folder and copy **everything
     in it** over the CMMS folder (Explorer: "Replace the files in the destination"). The zip has no
     `data` folder, so the database is not touched.
4. **Test** (optional, takes ~30 s): `npm test`. Everything should pass except, on Windows,
   `tests/is-main.test.js` (symlink permission `EPERM`), which is known and harmless.
5. **One-time v6 setup — preview**: `node server\setup-v6.js`
   It prints what it would change and changes nothing: the *Supervisor* role (if missing) and the floor
   zones (main sewing section → Line A, except QC / BD; DF → Down fill; TRIM / BLOW / PAC / SP / SNAP /
   Q1–Q4 → Packing and special machine). Read the list.
6. **One-time v6 setup — apply**: `node server\setup-v6.js --apply`
   It saves `data\backups\before-v6-setup-<time>.db` first, then makes the changes (each station's
   History shows "v6 setup"). Running it again later changes nothing.
7. **Start the server**: double-click `start-server.cmd` (or `node server\server.js`). On first start the
   database gets the new tables (worker profiles, QC records) automatically; nothing is deleted. The
   server also downloads the WPFI Google sheet (needs internet) and re-reads PDF manuals that could not
   be read before (encrypted ones).
8. **In the browser** (Ctrl+Shift+R; phones: reload twice):
   - Admin → Users: give the supervisor the **Supervisor** role.
   - Admin → Roles: check the Supervisor column and its *Hidden pages* (Machines, Edit map). The AI
     assistant is on for the Supervisor (skill ratings); set it to *None* to hide the chat.
   - Shop floor → Floor map, Name table, Skill map, Workers & skills, QC records, Safety (WPFI) and
     Inspect should all open.
9. Report: `git log -1 --oneline` (or "zip"), the test summary, and the setup output.

## Optional

- **Contractor map page** (Outside Contractors → *Copy map link*): contractors open it on their own
  phones, so the server must be reachable from the internet over HTTPS, e.g. **Tailscale Funnel**
  (`tailscale funnel 8080`). Open the app through that public address before copying a link — the link
  uses the address you are on. Revoke a link when the job is finished.
- **AI web search** goes to DuckDuckGo. Turn it off with `set AI_WEB=off` before starting the server.
- **WPFI sheet and form**: their links are in `local-config.json` (private, not in git; template:
  `local-config.example.json`). The sheet must stay shared as "Anyone with the link can view". If someone
  changes the Google Form's questions, update `wpfiForm` there and restart the server.

## If something goes wrong

- Code from git: `git reset --hard <the commit printed in step 3>` and `git stash pop` puts the old code back.
- Code from zip: copy the previous program files back (the `data-backup-*` folder holds only data).
- Data: stop the server, rename `data` to `data-broken`, copy the backup from step 2 back to `data`.
  The setup also left `data\backups\before-v6-setup-*.db` (restore with
  `node server\admin.js restore <file> --yes`).
