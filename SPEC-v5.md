# Shopfloor CMMS v5: Floor Map (Spec)

**Role:** project manager / spec author · **Status:** v5.0, ready to build · **Date:** 2026-10-22
**Baseline:** v4 (SPEC-v4.md incl. the 2026-10-22 changes: item list, links, delete, daily numbers).
All earlier rules still apply: no npm dependencies, Node 24 built-ins, vanilla JS, no CDN, no
innerHTML with user text, no alert/confirm/prompt, offline-first sync, last-save-wins with history,
flat errors, builtin roles exactly Administrator/Technician/Viewer, bump `sw.js` CACHE_VERSION.

## 0. What the client needs

| Client said | What we build |
|---|---|
| "Only maps and a canvas for the map" | A **Floor Map** page (view) and an **Edit map** mode (drawing canvas). No separate Python server; it lives in the CMMS. |
| "Each machine can link to the machine list" | Every **station** on the map can be linked to one CMMS machine. |
| "When a work order comes up you can see it on the map" | Stations show their machine's state live: **down = red**, **open service orders = orange badge with the count**, PM overdue = yellow dot. |
| "Keep staff name and employee ID in the list and allow to edit" | Each station keeps **code, staff name, Chinese name, employee ID, vacant, remark**, editable on the map. Nothing else (no phone, emergency contact, join date). |
| Future: a sign for sewers to request repair | Not in v5. Stations get stable ids and a machine link now, so a later "Request repair" page per station (e.g. a QR sign) can create a service order with the station and machine filled in. |

Source data: the client's existing map export (`layout.json` = geometry, `stations.json` = roster),
imported once with an admin command (section 4). **The data never goes into the git repo** (the repo
is public; the roster holds names): it is imported into the database only.

## 1. Data

### 1.1 Store `floorMaps` (one record per floor; usually one)

| Field | Type | Notes |
|---|---|---|
| `name` | string 1–80, required | e.g. "Main floor" |
| `width`, `height` | number 10–10000 | drawing units (the import uses PDF points) |
| `boxes` | array ≤ 1500 of `{id (≤40), x, y, w (≥2), h (≥2), slots (int 1–12, default 1), fill (#rrggbb or null), label (≤60, optional)}` | a box holds `slots` stations stacked top to bottom in equal parts |
| `corridors` | array ≤ 800 of `{x, y, w, h}` | blue aisles |
| `fills` | array ≤ 200 of `{x, y, w, h, color (#rrggbb)}` | grey/yellow floor patches |

Numbers: finite, −10000…20000, max 2 decimals. Unknown fields rejected. A map record is ~80 KB.

### 1.2 Store `floorStations`

| Field | Type | Notes |
|---|---|---|
| `mapId` | string, required | the floorMaps record |
| `boxId` | string or null | null = **off-map** (its box was deleted); still listed, flagged |
| `slot` | int 0–11 | position inside the box |
| `code` | string ≤ 40 | station label printed on the map, e.g. "SP14", "PAC 1" |
| `zone` | string ≤ 60 | e.g. "SP MACHINES" |
| `name`, `nameCn` | string ≤ 80 | staff name (English / Chinese) |
| `empId` | string ≤ 20 | employee ID |
| `vacant` | boolean | |
| `remark` | string ≤ 200 | |
| `machineId` | string or null | linked CMMS machine |

### 1.3 Permissions
New area `floorMap` (label "Floor map & stations") after `machines`: Administrator write,
Technician write, Viewer read. `STORE_AREAS`: floorMaps and floorStations → floorMap.
**Muse Agent and AI Assistant roles get `floorMap: none`** (add the key as none to existing roles),
and `server/ai.js` never puts floorMaps/floorStations in the AI context. Staff names must not reach
any AI provider.

## 2. Floor Map page `#/map` (sidebar "Floor map" after Machines; More sheet on phone)

- Inline **SVG** (`viewBox` = map size), not an image: corridors (blue `#9dc3e6`), fills, boxes
  (white or their fill, thin dark border), and in each slot the station code (bold) and staff name
  (toggle **Show names**, default on; employee ID shown in the panel only). Text wraps inside the
  slot and shrinks to fit; never overflows the box.
- **Live state** per station from its linked machine (from synced state, re-rendered on every sync):
  machine `down` → slot filled red-tinted with a red border; open service orders (status ≠ done) →
  orange badge top-right with the count; PM overdue → small yellow dot. Unlinked stations look
  plain. Legend under the toolbar.
- **Toolbar**: search (code, staff name, employee ID, machine name → matching stations highlighted
  and the first one centred), filter chips **All · Down · Open orders · Unlinked · Vacant**,
  zoom − / + / Fit, Show names, **Edit map** (floorMap write, desktop ≥ 1024 px only).
- **Pan & zoom**: drag to pan, wheel / pinch to zoom (0.5×–8×), double-click zooms in; keeps the
  zoom while data refreshes.
- **Station panel** (click/tap a station; desktop side panel, phone bottom sheet that removes every
  node on close):
  - Code, zone, staff name, Chinese name, employee ID, vacant, remark — editable inline with
    floorMap write (save on change, like the PM form; read-only otherwise).
  - **Machine**: linked machine with status pill and "Open machine", or a select "Link to machine"
    (searchable list of all machines) and "Unlink".
  - **Open service orders** for that machine (number, title, status, link) and
    **+ New service order** (opens the normal form with the machine filled in).
- Machine detail page: **Show on map** button when a station links to it (opens `#/map?station=<id>`,
  centred and highlighted). Service order detail: same, for its machine.
- Off-map stations: a collapsible list "Off-map stations (N)" under the map, each openable in the
  panel; with write access a "Place on map" action puts it into an empty slot the user then clicks.

## 3. Edit map (canvas) — desktop only, floorMap write

- Enter with **Edit map**; a top bar shows **Save map**, **Cancel**, Undo (Ctrl+Z, 50 steps),
  Snap (2-unit grid, on by default), and the tools: **Select**, **+ Box**, **+ Corridor**,
  **+ Patch** (fill).
- Select: click selects (Shift+click adds), drag moves, 8 handles resize, arrow keys nudge 1 unit
  (Shift = 10). Selection panel: X, Y, W, H, slots (1–12), fill colour, label, **Duplicate**,
  **Delete**. Rubber-band select by dragging empty floor.
- + Box / + Corridor / + Patch: drag a rectangle to create; a plain click drops a default size
  (box 45 × 28, corridor 5 × 60).
- Deleting a box (or lowering its slots) never deletes stations: they become off-map (boxId null).
- A new box's slots show "+ Add station" in the station panel after saving.
- Save writes the whole floorMaps record (normal record PUT; last save wins, history kept).
  Leaving with unsaved changes asks first (showConfirm).
- Stations are edited in the station panel (section 2), not in the canvas.

## 4. Import (one time, admin CLI)

`node server/admin.js import-floor-map <layout.json> <stations.json> [--name "Main floor"]`
- Creates one floorMaps record and its floorStations (refuses if a map with that name exists
  unless `--replace`).
- Geometry from layout.json: `page.w/h`, `corridors` (arrays `[x,y,w,h]`), `fills`
  (`[x,y,w,h,color]`), `boxes` (`x,y,w,h,fill,id`; `slots` = `box.slots.length`).
  **Ignore `box.slots[].lines` completely** (they contain staff names; the map must not store them).
- Stations from stations.json: `id`, `box`, `slot`, `zone`, `code`, `emp`→`empId`, `en`→`name`,
  `cn`→`nameCn`, `vac`→`vacant`, `rem`→`remark`. **Drop every other field** (phone, emg, join,
  shift…). A station whose box does not exist becomes off-map.
- Auto-link: a station whose code equals a machine name (case/space/dash-insensitive) gets that
  machineId; print how many were linked and list the rest.
- Prints counts; never prints staff names.

## 5. Tests and checks
- Server: validation of both stores (limits, unknown fields, numbers), permissions incl. role
  upgrades (Muse/AI none), changes feed hides both stores from a Viewer-less/none role, AI context
  never contains a station name, import (fixture JSON written in the test: lines ignored, extra
  fields dropped, off-map, auto-link, `--replace`).
- Logic (pure helpers, `logic-map.js`): slot rectangles from a box, station state (down / open
  orders / PM overdue) from records, search, text fitting (lines + font size), snap, hit-testing.
- Browser (PM): import the client's real map, 1280 and 390 px, colours and badges after setting a
  machine down and opening an SO, panel edits persist, link/unlink, new SO from a station, edit
  mode move/resize/add/delete/undo/save, no leftover backdrops, no console errors.

## 6. Milestones (one GLM run each; PM verifies in a browser before the next)
1. **V5-M1 Server + import:** stores, validation, permissions + role upgrades, AI exclusion,
   `import-floor-map`, `logic-map.js` helpers + tests.
2. **V5-M2 Map view:** page, SVG rendering, live state, toolbar, search/filters, pan/zoom, station
   panel (staff edit, machine link, open SOs, new SO), Show on map links, off-map list, Help.
3. **V5-M3 Edit map:** canvas editing as section 3, Help.
