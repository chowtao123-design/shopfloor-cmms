# Shopfloor CMMS v4: Parts Requests, Repair Library, AI Repair Help (Spec)

**Role:** project manager / spec author · **Status:** v4.0, ready to build · **Date:** 2026-10-22
**Baseline:** v3 + the agent update (commit 34fc62b: Bearer tokens, AI proposals, shop totals).
Everything in SPEC.md, SPEC-v2.md and SPEC-v3.md still applies unless this document changes it:
no npm dependencies, Node 24 built-ins only, vanilla JS client, no CDN, no innerHTML with user
text, no alert/confirm/prompt, offline-first sync, last-save-wins with history, server-set
`updated_by`, tests with `node:test`, flat error shape `{error, message}`, builtin roles stay
exactly Administrator/Technician/Viewer, bump `sw.js` `CACHE_VERSION` when a shell file changes.

## 0. What the client actually needs

| Client said | What we build |
|---|---|
| "Gather enough parts before I send the request to the accountant" | A **Parts Request** that stays a *Draft* for days while lines are added from anywhere (part, low-stock list, service order, free text, or Muse through the API). When it is complete: **Send** → a clean numbered price table to print/PDF or paste into an email. |
| Table: Item #, description, price per unit, unit, total; subtotal before HST, HST, grand total | The **request sheet** (section 3.4). We add **Qty** (needed for the line total). |
| "Most of the time I will connect Muse to update the list" | Requests are normal records: Muse reads them with `GET /api/changes` and writes with `PUT /api/records/purchaseRequests/:id`. The OpenAPI document describes the request shape so Muse knows it. |
| Received: "just mark it done" | Status **Received**. Stock quantities are **not** changed. |
| A library for machine manuals and the methods I use for repair | **Library** page: *Manuals* (PDF uploads) and *Repair methods* (symptom → cause → steps), linked to a machine type, model numbers and/or specific machines. |
| The AI agent can read them and help me repair | The AI context gets the matching repair methods, **text extracted from manual PDFs**, and the machine's past fixes, with sources cited. The AI can propose saving a new repair method (Apply flow). |

Out of scope for v4: emailing from the server, accountant logins, stock changes on receipt,
OCR of scanned PDFs, supplier price lists.

## 1. Permissions (`permissions.js`, `server/permissions.js` if separate)

Add two areas to `AREAS` (after `parts`):

| key | label | Administrator | Technician | Viewer |
|---|---|---|---|---|
| `purchasing` | Parts requests | write | write | read |
| `library` | Library (manuals & repair methods) | write | write | read |

- `STORE_AREAS`: `purchaseRequests → purchasing`, `libraryItems → library`.
- Existing roles in a live database have no value for the new keys: `normalizePermissions` must
  give missing keys the builtin default above for builtin roles and `none` for custom roles.
  Add a migration test with a role row saved before v4.
- **Muse Agent** role (`server/apiTokens.js`): `purchasing: write`, `library: read`.
  **AI Assistant** role (`server/ai.js`): `purchasing: read`, `library: write`.
  `ensureAgentUser` / `ensureAiAssistantUser` must **add missing keys to an existing role** (the
  live DB already has both roles), never remove or lower keys an admin changed.
- Phone More sheet and desktop sidebar: **Parts requests** (after Parts) and **Library** (after
  Machines), each hidden when its area is `none`.

## 2. Parts request data (store `purchaseRequests`)

| Field | Type | Notes |
|---|---|---|
| `number` | integer | server-assigned like service orders (same transaction pattern, own sequence), shown **`PR-0001`**; "PR-pending" before first sync; clients cannot set it |
| `title` | string 1–120, required | e.g. "Juki needles + belts, Nov" |
| `status` | enum | `draft` (default), `sent`, `received`, `cancelled` |
| `supplier` | string ≤ 120 | default supplier for the whole request (optional) |
| `neededBy` | ISO date or null | |
| `requestedBy` | string ≤ 80 | defaults to the creator's display name in the form |
| `hstRate` | number 0–30, max 2 decimals | percent, default **13** |
| `notes` | string ≤ 2000 | printed under the table |
| `sentAt`, `receivedAt` | ISO datetime or null | set by the client when status changes |
| `lines` | array ≤ 100 | see below |

Line: `{id (string ≤ 40), description (string 1–200, required), qty (number > 0, ≤ 100000, max 2
decimals), unit (string ≤ 20, default "pcs"), unitPrice (number ≥ 0, ≤ 1000000, max 2 decimals,
or null = "price unknown"), partId?, partNumber? (≤ 60), supplier? (≤ 120), machineId?,
workOrderId?, link? (http/https URL ≤ 500), note? (≤ 200)}`.

Rules (server `server/records.js` and client must match; unknown fields rejected):
- Money is calculated in **integer cents** in `logic.js` (`requestTotals(request)` →
  `{lines: [{lineTotalCents}], subtotalCents, hstCents, totalCents, unpricedCount}`);
  `lineTotal = round(qty × unitPrice × 100)`, `hst = round(subtotal × hstRate / 100)`. Lines with
  `unitPrice: null` count as 0 and are reported in `unpricedCount`. Totals are **never stored**.
- Format money as `$1,234.50` (CAD). Unit tests: rounding (0.1 + 0.2 cases), 13% HST on
  $0.01/$99.99/$1,000.00, unpriced lines, 0 lines, qty with decimals.
- Only `draft` requests can have lines added from other pages (section 3.3). A `sent` request is
  still editable in its own form (prices often change after the accountant calls the supplier).

## 3. Parts requests UI

### 3.1 List page `#/requests`
- Desktop table: Number, Title, Status chip, Lines, Total, Needed by, Updated. Phone: cards.
- Filter chips: Draft (default) · Sent · Received · All. Search on title, number, line text.
- **New request** button (purchasing write).

### 3.2 Request page (changed 2026-10-22 at the client's request)
- **New request** asks only for the details (title optional, default "Parts request <date>"; supplier,
  needed by, requested by, HST %, notes), then opens the request page. "Edit details" reopens that form.
- The request page is where items are gathered: an **add box** (What to buy with catalogue suggestions,
  Qty, Unit, Unit price optional, Add; Enter adds) and a plain numbered **item list** (description, qty,
  unit, price each, part # and machine) with Edit and Remove (confirm). Every add/edit/remove saves the
  request at once; the cursor returns to What to buy. Editable while Draft or Sent.
- **No priced table or totals on this page.** **Generate table** opens the sheet (3.4) with the
  table, HST and grand total.
- Status actions by status: Draft → **Mark sent** (asks to confirm when items have no price); Sent →
  **Mark received**, **Back to draft**; any → **Cancel request**.

### 3.3 Gather lines from other pages
One shared action **"Add to parts request"** that opens a small picker: the open draft requests
(newest first) + "New request…". It appends a line and shows a toast "Added to PR-0007".
- Part detail and part rows: line from the part (qty = `max(minQty − qtyOnHand, 1)`).
- Parts page low-stock filter: **"Add all low-stock to request"** (one line per part, skipping
  parts already on that request by `partId`).
- Service order detail: "Request parts" → opens the request page with the add box marked
  "For SO-0042 · <machine>" and focused; the item keeps `workOrderId` and `machineId`.
- Free-text lines for materials not in the catalogue are just "Add line".

### 3.4 Request sheet (print view) `#/requests/:id/sheet`
A plain white printable page (own `@media print` rules; no sidebar, no buttons in print):

```
<App name / logo>                                   PURCHASE REQUEST  PR-0007
Title · Requested by · Date · Needed by · Supplier
┌────┬──────────────────────────────┬──────┬──────┬────────────┬─────────────┐
│ #  │ Description (part # / machine)│ Qty  │ Unit │ Unit price │ Total price │
├────┼──────────────────────────────┼──────┼──────┼────────────┼─────────────┤
│ 1  │ Needle DBx1 #14 (Juki DDL-1)  │ 100  │ pcs  │     $0.45  │     $45.00  │
└────┴──────────────────────────────┴──────┴──────┴────────────┴─────────────┘
                                     Total before HST           $1,234.50
                                     HST (13%)                    $160.49
                                     Total Grand Amount          $1,394.99
Notes …
```
- Unpriced lines show "—" and a footnote "Price to be confirmed".
- Buttons (screen only): **Print / Save as PDF** (`window.print()`), **Copy table** (writes
  `text/html` *and* `text/plain` (tab-separated) to the clipboard via `ClipboardItem`, so it
  pastes as a real table into Outlook/Gmail/Excel; fallback message if the clipboard API is
  unavailable), **Download CSV** (same columns + the 3 total rows, UTF-8 with BOM for Excel).

### 3.5 Agent API (Muse)
- No new routes: the generic record routes already cover `purchaseRequests`.
- `server/openapi.js`: add a `PurchaseRequest` schema (all fields above, `lines` items) and
  document in the `PUT /api/records/{store}/{id}` description that `store` may be
  `purchaseRequests`, that `number` is server-assigned, and that a PUT **replaces the whole
  record** (read it first from `/api/changes`, then send it back with the new lines).
- Test: a write token creates a request, adds a line with a second PUT, history shows
  "Muse Agent"; a read token gets 403 on PUT.

## 4. Library

### 4.1 Data (store `libraryItems`)

| Field | Type | Notes |
|---|---|---|
| `kind` | enum, required | `manual`, `method` |
| `title` | string 1–160, required | |
| `machineType` | enum `MACHINE_TYPES` or null | applies to all machines of this type when no models/machines given |
| `models` | string array ≤ 20, each ≤ 60 | e.g. `DDL-8700-7`; matched case-insensitively against `machines.model` ignoring spaces and dashes |
| `machineIds` | string array ≤ 50 | specific machines |
| `tags` | string array ≤ 20, each ≤ 40 | e.g. `thread break`, `timing` |
| `attachments` | attachments (existing type, ≤ 20) | PDFs (manuals) and photos |
| `notes` | string ≤ 20000 | "Text for the AI": key pages/specs typed or pasted, used when a PDF has no readable text |
| `symptom` | string ≤ 1000 | method only |
| `cause` | string ≤ 2000 | method only |
| `steps` | array ≤ 60 of `{id, text 1–1000}` | method only |
| `toolsParts` | string ≤ 1000 | method only |
| `safety` | string ≤ 1000 | method only (e.g. lockout points) |
| `sourceWorkOrderId` | string or null | method created from a service order |

`relatedLibraryItems(machine, items)` in `logic.js`: an item matches a machine when the machine
id is in `machineIds`, OR a model matches, OR (`models` and `machineIds` are empty AND
`machineType` equals the machine's type). Unit-tested.

### 4.2 Manual PDF text for the AI (`server/pdfText.js`, new, built-ins only)
- `extractPdfText(buffer) → {status: 'ok'|'no_text'|'error', pages: string[], chars}`.
  Parse indirect objects and page tree; inflate `FlateDecode` streams with `node:zlib`
  (other filters → skip that stream); read text-showing operators `Tj`, `TJ`, `'`, `"` inside
  `BT…ET`, with line breaks on `Td/TD/T*/Tm` y-changes; decode literal and hex strings; use a
  font's `ToUnicode` CMap (`bfchar`, `bfrange`) when present, else WinAnsi/Standard encoding.
  Encrypted PDFs → `error`. Fewer than 200 meaningful characters overall → `no_text`
  (scanned manual). Hard limits: 1,500 pages, 2,000,000 chars, 20 s; never throws to the caller.
- Runs after a PDF upload in the background (do not delay the upload response). Table
  `file_texts (file_id PRIMARY KEY REFERENCES files(id), status, pages_json, chars,
  extracted_at)`. `GET /api/files/:id/text-status` → `{status, chars, pages}` (files read). Backups
  include the table. Startup: extract any PDF that has no `file_texts` row (one at a time).
- Tests with fixture PDFs **generated in the test** (write minimal PDF bytes: one uncompressed
  page, one FlateDecode page with a ToUnicode CMap, one image-only page → `no_text`, one broken
  file → `error`).
- PDF upload limit raised to **50 MB** for `application/pdf` (images stay 15 MB). Upload must
  stream to disk and stop reading at the limit (413) — never buffer 50 MB in memory twice.

### 4.3 Library UI `#/library`
- Tabs **Repair methods** · **Manuals**. Search (title, models, tags, symptom, steps text),
  filters: machine type, model, tag. Desktop table / phone cards.
- Manual card: title, models, PDF list; per PDF a badge **"AI can read"** (ok, with page count),
  **"Scanned — AI can't read"** (no_text, with the hint "Type the key specs into *Text for the
  AI*"), **"Reading…"**, or "Couldn't read" (error).
- Method view: Symptom, Cause, numbered Steps, Tools & parts, Safety (highlighted box), photos,
  linked machines, "From SO-0042" link.
- Method form: steps editor reuses the checklist editor pattern (add, remove, reorder).
- Machine detail gets a **Library** section: matching items (via `relatedLibraryItems`), plus
  "Add repair method" pre-filled with this machine's id and model. Existing machine manuals
  attached to the machine (v3) stay where they are.
- Completed service order detail: **"Save as repair method"** → method form pre-filled: title =
  SO title, symptom = problem, steps = action taken split by line, machineIds, models from the
  machine, `sourceWorkOrderId`.

## 5. AI repair help (`server/ai.js`)

- **Library context**: in `buildContext`, find the machines the question is about (name, model
  or serial mentioned, or the machine of a service order number mentioned). Then add, within a
  **library budget of 7,000 chars**:
  1. matching repair methods (full text, best match first);
  2. manual excerpts: split extracted pages into ~1,200-char chunks, score each chunk by
     word overlap with the question (lower-case, strip punctuation, ignore stopwords and words
     < 3 chars, bonus for model numbers and error codes), take the top chunks;
     each excerpt is labelled `[Manual: <title>, p. <n>]`; library `notes` count as one chunk
     labelled `[Notes: <title>]`;
  3. the last 5 **completed service orders** for those machines (and same-model machines):
     number, date, problem, action taken, parts used.
  Without a machine match, search all library items by the same scoring.
  `CONTEXT_MAX_CHARS` becomes **20,000** (shop totals stay first; library block second).
- Respect permissions: no library context for users without `library` read.
- `SYSTEM_PROMPT` additions: for fault/repair questions, base the answer on the library and past
  fixes first; **cite sources** in the reply (`(Manual: Juki DDL-8700 manual, p. 23)`,
  `(Repair method: Thread breaks at high speed)`, `(SO-0042)`); say plainly when the library has
  nothing for this machine and the answer is general knowledge; give step-by-step checks in
  the order a technician would do them (simple checks first); always mention lockout/power-off
  before guards are removed.
- **Proposals**: add `libraryItems` to the allowed stores (server sanitizer and `chat.js`
  `PROPOSAL_STORES`, card label "Repair method"), create only (`kind: 'method'`; updates to
  existing library items are refused). Typical use: "save what we just did as a repair method".
  Apply checks the user's `library` write and the AI Assistant's `library` write.
- Tests with the fake provider: library text reaches the context for a question naming the
  machine model; budget respected; no library context without `library` read; manual chunk
  ranking picks the page containing the error code; `libraryItems` proposal apply + attribution.

## 6. Phone fix already done (do not redo)
Commit 6e25ca4: the More sheet left its backdrop on screen, blocking every tap until reload.
New sheets/pop-ups in v4 must remove **every** node they add when they close (add a browser
check: open/close each new sheet, then `document.elementFromPoint` at screen centre is not a
backdrop).

## 7. Help, README
Help gets "Parts requests" and "Library & AI repair help" sections (how to gather lines, send,
print/copy; how to make AI-readable manuals; scanned PDFs need *Text for the AI*). README: the
Muse workflow for requests (read via `/api/changes`, PUT the whole record).

## 8. Acceptance criteria

- [ ] `npm test` passes: all existing tests + new tests listed in sections 1, 2, 3.5, 4.1, 4.2, 5.
- [ ] Browser checks at 1280 and 390 px: create a request, add lines from a part, low-stock
      list, a service order and free text; totals and HST correct; Mark sent/received; sheet
      prints on one page for 15 lines; Copy table pastes as a table; Library: upload a text PDF
      (badge "AI can read") and a scanned PDF (badge "Scanned"); method from a service order;
      machine detail Library section; AI chat cites a manual page (fake provider echoes context);
      no horizontal scroll; no console errors; no leftover backdrops.
- [ ] Muse: write token creates and updates a request through the public routes.
- [ ] Live DB upgrade: start v4 on a copy of a v3 database — roles get the new keys, nothing lost.

## 9. Milestones (one GLM run and one commit each; PM verifies in a browser before the next)

1. **V4-M1 Requests server:** store + validation + PR numbering, permissions + role upgrades
   (incl. live-DB migration test), `requestTotals` in `logic.js` + tests, OpenAPI schema, Muse test.
2. **V4-M2 Requests UI:** list, form with lines table, gather actions (3.3), sheet with
   print/copy/CSV, nav entries, Help section.
3. **V4-M3 Library server:** `libraryItems` store, `server/pdfText.js` + `file_texts` + fixture
   tests, background extraction, 50 MB streaming PDF upload, backups.
4. **V4-M4 Library UI:** page, forms, AI-readable badges, machine detail section, "Save as
   repair method", nav entries, Help section.
5. **V4-M5 AI repair help:** library context + chunk ranking, prompt, `libraryItems` proposals,
   tests, README.
