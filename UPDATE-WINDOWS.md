# Updating the Windows copy from GitHub

Paste this file into opencode on the Windows PC that runs the CMMS, from inside the CMMS folder.
It updates the **code only**. The `data` folder (database, uploaded manuals and photos) is not in git
and must never be changed, deleted or committed.

## Rules for the agent

- Do not edit, move or delete anything in `data\` except the backup copy in step 2.
- Do not commit or push from this PC. GitHub is updated from the build machine only.
- Stop and report if any step fails; do not try to "fix" it by resetting data.
- Do not print staff names, tokens or passwords in the chat.

## Steps (PowerShell, in the CMMS folder)

1. **Stop the CMMS server** (close its window or Ctrl+C in it). Check nothing listens on 8080:
   `Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue` (no output = stopped).
2. **Back up the data folder**:
   `Copy-Item -Recurse data ("data-backup-" + (Get-Date -Format yyyyMMdd-HHmm))`
3. **Look at local changes**: `git status` and `git log -1 --oneline`.
   This copy has the 2026-10-22 agent update applied by hand (server/apiTokens.js, server/openapi.js,
   tests/tokens.test.js and edits to app.js, chat.js, server/*.js...). Those changes are already
   included in the GitHub version, so set them aside instead of merging:
   `git stash push --include-untracked -m "windows-local-before-v5"`
   (`data\` is ignored by git and is not touched by this.)
4. **Update**: `git pull --ff-only origin master`
5. **Test**: `npm test`. Everything should pass except, on Windows, `tests/is-main.test.js`
   (symlink permission `EPERM`), which is known and harmless.
6. **Start the server**: `node server/server.js`, then check `http://localhost:8080/health`
   answers `{"ok":true,...}`. On first start the database is upgraded automatically (new tables
   and permission areas); nothing is deleted.
7. **Import the floor map once** (skip if Floor map already shows your map). Use the folder that
   holds the map export (`layout.json` and `stations.json` from the factory-floor-system `data` folder):
   `node server/admin.js import-floor-map "<path>\layout.json" "<path>\stations.json" --name "Main floor"`
   It prints counts only. Stations whose code equals a machine name are linked automatically; the
   rest are linked by tapping the station on the map.
8. **Check in the browser** (Ctrl+Shift+R to load the new version): Parts requests, Library,
   Floor map appear in the sidebar; a service order made today is numbered like `SO-261022-1`.
9. Report: `git log -1 --oneline`, the test summary, and the import counts.

## If something goes wrong

- Code: `git reset --hard <the commit printed in step 3>` and `git stash pop` puts the old code back.
- Data: stop the server, rename `data` to `data-broken`, copy the backup from step 2 back to `data`.
