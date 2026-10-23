// Floor map view (V5-M2, SPEC-v5.md section 2): inline SVG of the imported
// layout with live machine state from logic-map.js, toolbar (search, filter
// chips, zoom −/+/Fit, Show names), pan & zoom, the station panel (desktop
// side drawer, phone bottom sheet), the off-map station list and the empty
// state that explains the admin import (section 4). The edit canvas is the
// V5-M3 half (SPEC section 3) further down in this module.
//
// Pure view-box math, the filter predicate and the legend counts are
// exported for tests/v5m2.test.js; the editor's enter/undo/save guards and
// its pure geometry come from logic-map.js (tests/v5m3.test.js). Nothing
// DOM-shaped runs at import time so the module also loads under node --test.
// The DOM helpers (h, field, toast, can, …) come in through the render
// context app.js passes to renderMapPage(); every SVG node is created with
// createElementNS (never innerHTML with user text), and every node the phone
// sheet adds to the page is removed again on close.

import {
  BOX_SLOTS_MAX,
  clampMapNumber,
  createShapeFromRect,
  defaultShapeRect,
  FIT_CHAR_WIDTH,
  fitText,
  hitTest,
  MAP_COORD_MAX,
  MAP_COORD_MIN,
  moveShape,
  newBoxId,
  nudgeShape,
  offMapStationIds,
  popUndoSnapshot,
  pushUndoSnapshot,
  rectIntersectsShape,
  resizeShape,
  roundMapNumber,
  rubberBandRect,
  sanitizeMapForSave,
  searchStations,
  SHAPE_MIN_SIZE,
  slotRects,
  snap,
  RESIZE_HANDLES,
  stationState,
  UNDO_LIMIT,
  wrapWords,
} from './logic-map.js';
import { LABELS } from './logic.js';
import * as sync from './sync.js';

export const SVG_NS = 'http://www.w3.org/2000/svg';
/** Zoom range (SPEC-v5.md section 2: 0.5×–8× relative to the whole map). */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 8;
/** One −/+ press. Wheel notches and double-click use their own steps. */
export const ZOOM_STEP = 1.4;
export const WHEEL_STEP = 1.15;
export const DBLCLICK_STEP = 1.8;
/** A drag further than this many px is a pan, not a station click. */
export const CLICK_SLOP_PX = 5;
/** Waiting out a double-click before a station click opens the panel. */
export const CLICK_DELAY_MS = 250;

/** Toolbar filter chips (SPEC-v5.md section 2). */
export const MAP_FILTERS = Object.freeze([
  { key: 'all', label: 'All' },
  { key: 'down', label: 'Down' },
  { key: 'open', label: 'Open orders' },
  { key: 'unlinked', label: 'Unlinked' },
  { key: 'vacant', label: 'Vacant' },
]);

const CORRIDOR_FILL = '#9dc3e6';
const BOX_BORDER = '#2b3242';
const DOWN_FILL = '#f6c9cb';
const DOWN_BORDER = '#bb2d3f';
const BADGE_FILL = '#e8710a';
const DOT_FILL = '#e0b400';

// ---------------------------------------------------------------------------
// Pure view-box math. A view is {x, y, w, h} in drawing units; `fit` is the
// whole map (0 0 width height). Zooming in shrinks w; the zoom level is
// fit.w / view.w, clamped to 0.5×–8×.
// ---------------------------------------------------------------------------

/**
 * The viewBox that shows the whole map (the "Fit" state).
 * @param {{width?: number, height?: number}} map
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function fitViewBox(map) {
  const w = Math.max(1, Number(map && map.width) || 1);
  const h = Math.max(1, Number(map && map.height) || 1);
  const drawn = drawingBounds(map);
  return drawn || { x: 0, y: 0, w, h };
}

/**
 * The rectangle around everything drawn (boxes, corridors, patches) plus a
 * small margin, inside the page; null for an empty map. Fit and the PDF use
 * it so the empty paper margins of the imported plan do not shrink the map.
 */
export function drawingBounds(map) {
  const shapes = [];
  for (const box of (map && Array.isArray(map.boxes) ? map.boxes : [])) if (box) shapes.push(box);
  for (const list of [map && map.corridors, map && map.fills]) {
    for (const item of Array.isArray(list) ? list : []) if (item) shapes.push(item);
  }
  const rects = shapes.filter((r) => [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(Number(v))));
  if (rects.length === 0) return null;
  const pad = 4;
  const w = Math.max(1, Number(map.width) || 1);
  const h = Math.max(1, Number(map.height) || 1);
  const x0 = Math.max(0, Math.min(...rects.map((r) => Number(r.x))) - pad);
  const y0 = Math.max(0, Math.min(...rects.map((r) => Number(r.y))) - pad);
  const x1 = Math.min(w, Math.max(...rects.map((r) => Number(r.x) + Number(r.w))) + pad);
  const y1 = Math.min(h, Math.max(...rects.map((r) => Number(r.y) + Number(r.h))) + pad);
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function isView(view) {
  return (
    view !== null &&
    typeof view === 'object' &&
    [view.x, view.y, view.w, view.h].every((value) => typeof value === 'number' && Number.isFinite(value)) &&
    view.w > 0 &&
    view.h > 0
  );
}

/**
 * Zoom `view` by `factor` (> 1 zooms in) keeping the point at fractions
 * (`fx`, `fy`) of the view (0.5/0.5 = the centre; the pointer for wheel,
 * pinch and double-click) anchored in place. The zoom level relative to
 * `fit` stays within 0.5×–8×. Invalid input returns the view unchanged; the
 * w/h ratio is preserved.
 * @param {{x: number, y: number, w: number, h: number}} view current view
 * @param {number} fitW the whole map's width
 * @param {number} fitH the whole map's height
 * @param {number} factor zoom multiplier
 * @param {number} [fx=0.5] anchor across the view, 0–1
 * @param {number} [fy=0.5] anchor down the view, 0–1
 * @returns {{x: number, y: number, w: number, h: number}}
 */
export function zoomViewBox(view, fitW, fitH, factor, fx = 0.5, fy = 0.5) {
  if (!isView(view)) return view;
  const whole = Math.max(1, Number(fitW) || 1);
  const raw = typeof factor === 'number' && Number.isFinite(factor) && factor > 0 ? factor : 1;
  // Clamp the resulting zoom level, not the step, so −/+ keeps working at the ends.
  const level = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (whole / view.w) * raw));
  const nextW = whole / level;
  const nextH = nextW * (view.h / view.w);
  const ax = Math.min(1, Math.max(0, fx));
  const ay = Math.min(1, Math.max(0, fy));
  const anchorX = view.x + view.w * ax;
  const anchorY = view.y + view.h * ay;
  return { x: anchorX - nextW * ax, y: anchorY - nextH * ay, w: nextW, h: nextH };
}

/**
 * Pan by a screen-pixel drag: units per pixel follow the current view so
 * the map sticks to the pointer. Non-finite input (or a view-sized 0
 * client) returns the view unchanged.
 * @param {{x: number, y: number, w: number, h: number}} view
 * @param {number} dxPx horizontal drag in screen pixels (right = positive)
 * @param {number} dyPx vertical drag in screen pixels
 * @param {number} clientW the rendered svg width in pixels
 */
export function panViewBox(view, dxPx, dyPx, clientW) {
  if (!isView(view)) return view;
  const dx = Number(dxPx);
  const dy = Number(dyPx);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return view;
  // Without a real pixel width there is no honest conversion: keep the view
  // rather than invent a 1-px client (a giant jump).
  const client = Number(clientW);
  if (!Number.isFinite(client) || client <= 0) return view;
  const unitsPerPx = view.w / client;
  return { x: view.x - dx * unitsPerPx, y: view.y - dy * unitsPerPx, w: view.w, h: view.h };
}

/**
 * Keep `view` inside the map (SPEC section 2 pan & zoom): the map edges are
 * the hard stops; a view larger than the map centres on it.
 * @param {{x: number, y: number, w: number, h: number}} view
 * @param {number} mapW
 * @param {number} mapH
 */
export function clampViewBox(view, mapW, mapH) {
  if (!isView(view)) return view;
  const w = Number(mapW) || 0;
  const h = Number(mapH) || 0;
  const clamp = (value, size, span) => {
    if (!(span > 0) || span >= size) return (size - span) / 2;
    return Math.min(size - span, Math.max(0, value));
  };
  return { x: clamp(view.x, w, view.w), y: clamp(view.y, h, view.h), w: view.w, h: view.h };
}

/**
 * Slide the view (same zoom) so the drawing-unit rectangle `rect` sits in
 * the middle — search "first one centred" and Show-on-map. Clamping to the
 * map edges is the caller's job (clampViewBox).
 * @param {{x: number, y: number, w: number, h: number}} view
 * @param {{x: number, y: number, w: number, h: number}} rect
 */
export function centreViewBoxOnRect(view, rect) {
  if (!isView(view) || rect === null || typeof rect !== 'object') return view;
  const r = rect;
  if (![r.x, r.y, r.w, r.h].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return view;
  }
  return {
    x: r.x + r.w / 2 - view.w / 2,
    y: r.y + r.h / 2 - view.h / 2,
    w: view.w,
    h: view.h,
  };
}

// ---------------------------------------------------------------------------
// Pure filter + legend math.
// ---------------------------------------------------------------------------

/**
 * Does the station pass a toolbar filter chip? `chip` is one of the
 * MAP_FILTERS keys; unknown keys behave like 'all'. `live` is the station's
 * stationState() result.
 * @param {object} station
 * @param {{down?: boolean, openOrders?: number, pmOverdue?: boolean}} live
 * @param {string} chip
 * @returns {boolean}
 */
export function stationMatchesChip(station, live, chip) {
  const st = station === null || typeof station !== 'object' ? {} : station;
  const li = live === null || typeof live !== 'object' ? {} : live;
  switch (chip) {
    case 'down':
      return li.down === true;
    case 'open':
      return Number(li.openOrders) > 0;
    case 'unlinked':
      return !st.machineId;
    case 'vacant':
      return st.vacant === true;
    default:
      return true;
  }
}

/**
 * Legend counts: how many stations are down, have open service orders and
 * are PM overdue — the numbers next to the legend swatches.
 * @param {Array<{down: boolean, openOrders: number, pmOverdue: boolean}>} liveStates
 * @returns {{down: number, openOrders: number, pmOverdue: number}}
 */
export function legendCounts(liveStates) {
  const list = Array.isArray(liveStates)
    ? liveStates.filter((entry) => entry && typeof entry === 'object')
    : [];
  return {
    down: list.filter((entry) => entry.down === true).length,
    openOrders: list.filter((entry) => Number(entry.openOrders) > 0).length,
    pmOverdue: list.filter((entry) => entry.pmOverdue === true).length,
  };
}

/**
 * The station that links to this machine, for the "Show on map" buttons on
 * the machine and service order detail pages. The first match wins.
 * @param {string|null} machineId
 * @param {Array<object>} stations local floorStations records
 * @returns {object|null}
 */
export function stationForMachine(machineId, stations = []) {
  if (!machineId) return null;
  const list = Array.isArray(stations) ? stations : [];
  return list.find((station) => station && station.mapId && station.machineId === machineId) ?? null;
}

// ---------------------------------------------------------------------------
// Module-level view state: the zoom/pan, search text, filter chip, floor
// choice and pick-a-slot mode survive data re-renders (SPEC section 2
// "keeps the zoom while data refreshes").
// ---------------------------------------------------------------------------

const mapView = {
  mapId: null,
  viewBox: null,
  names: true,
  // 1 = Auto: the largest size that shows all text inside its slot.
  textScale: 1,
  search: '',
  filter: 'all',
  pickStationId: null,
  lastAutoStation: null,
};

// ---------------------------------------------------------------------------
// Small SVG helpers. createElementNS everywhere; visible text goes through
// the 'text' key (text nodes), so a station label or staff name is never
// parsed as HTML.
// ---------------------------------------------------------------------------

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of (children ?? []).flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function viewBoxString(view) {
  return `${round2(view.x)} ${round2(view.y)} ${round2(view.w)} ${round2(view.h)}`;
}

/**
 * The `<text>` lines inside one slot: the station code (bold) then the staff
 * name, each wrapped and shrunk by fitText() so text never overflows the
 * box (SPEC section 2). The name lines carry the fm-name class; Show names
 * off hides them via one class on the svg.
 * @param {{x: number, y: number, w: number, h: number}} rect the slot
 * @param {string|null} code @param {string|null} name
 * @returns {Array<SVGElement>}
 */
function slotTextNodes(rect, code, name, scale = mapView.textScale) {
  const pad = 1.6;
  const innerW = Math.max(0, rect.w - pad * 2);
  const innerH = Math.max(0, rect.h - pad * 2);
  const cleanCode = String(code ?? '').trim();
  const cleanName = String(name ?? '').trim();
  if (!innerW || innerH <= 4 || !cleanCode) return [];
  // The code takes the first ~55% of the slot, the name the rest; without a
  // name the code may use the whole height.
  const codeBudget = cleanName ? innerH * 0.55 : innerH;
  const nameBudget = cleanName ? innerH * 0.45 : 0;
  const nodes = [];
  let cursorY = rect.y + pad;
  for (const [text, budget, className] of [
    [cleanCode, codeBudget, 'fm-code'],
    [cleanName, nameBudget, 'fm-name'],
  ]) {
    if (!text || budget <= 0) continue;
    // The station code is always Auto (fully shown). The Text size control
    // scales the staff name only: it re-wraps to the slot width and lines
    // past the bottom of the slot are dropped, the last one ending in "…".
    const k = className === 'fm-name' && Number(scale) > 0 ? Number(scale) : 1;
    const fit = fitText(text, innerW, budget);
    const size = Math.max(0.5, fit.fontSize * k);
    if (k !== 1 && fit.lines.length > 0) {
      fit.lines = wrapWords(text, Math.max(1, Math.floor(innerW / (size * FIT_CHAR_WIDTH))));
    }
    const bottom = rect.y + rect.h - pad / 2;
    for (const [index, raw] of fit.lines.entries()) {
      if (cursorY + size > bottom + 0.01) {
        // A larger text size than fits: mark what was left out.
        const last = nodes.at(-1);
        if (last && index > 0) last.lastChild.textContent = `${last.lastChild.textContent.replace(/…$/, '')}…`;
        break;
      }
      const line = raw;
      cursorY += size;
      nodes.push(
        svgEl(
          'text',
          { class: className, x: round2(rect.x + pad), y: round2(cursorY), 'font-size': round2(size) },
          [svgEl('tspan', { text: line })],
        ),
      );
      cursorY += size * 1.2 - size;
    }
  }
  return nodes;
}

/** Stations of one map. */
function stationsOfMap(stations, mapId) {
  return (Array.isArray(stations) ? stations : []).filter((station) => station && station.mapId === mapId);
}

/** A station is off-map when its box vanished (boxId null or deleted). */
function isOffMapStation(map, station) {
  if (!station) return true;
  if (!station.boxId) return true;
  const boxes = Array.isArray(map.boxes) ? map.boxes : [];
  return !boxes.some((box) => box && box.id === station.boxId);
}

/** Which floor is shown: the ?map= URL wins, then the last one used. */
function activeMap(maps, route) {
  const wanted = route && route.params ? route.params.get('map') : null;
  if (wanted) {
    const found = maps.find((map) => map.id === wanted);
    if (found) return found;
  }
  if (mapView.mapId) {
    const found = maps.find((map) => map.id === mapView.mapId);
    if (found) return found;
  }
  return maps[0];
}

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

/**
 * Render the Floor map page (`#/map`, optional `?station=<id>` centring and
 * highlighting that station). The router gates the route on can('floorMap')
 * before calling this (SPEC-v5.md sections 1.3 and 2).
 * @param {object} ctx the app.js render context (DOM helpers, state, sync)
 * @param {{segments: string[], params: URLSearchParams}} route
 */
export function renderMapPage(ctx, route) {
  const { h } = ctx;
  ctx.setTitle('Floor map');
  const maps = (ctx.state.floorMaps || [])
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  if (maps.length === 0) return emptyMapPage(ctx);

  // --- V5-M3 edit session (SPEC-v5.md section 3) ---------------------------
  // Once Edit map is on, the whole page is the canvas, driven by the working
  // COPY in module state (a sync re-render never clobbers it). The session
  // only starts through the toolbar button (desktop ≥ 1024 px + write), but
  // the role can change mid-edit: if write is gone or the map vanished, the
  // copy cannot be saved any more, so it is thrown away (nothing was written).
  const editSessionMap = mapEdit.active
    ? maps.find((entry) => entry && entry.id === mapEdit.mapId) || null
    : null;
  if (mapEdit.active && (!editSessionMap || !ctx.can('floorMap', 'write'))) {
    discardEditSession();
  }
  if (mapEdit.active && editSessionMap) {
    return renderMapEditor(ctx, editSessionMap);
  }

  const map = activeMap(maps, route);
  if (mapView.mapId !== map.id) {
    // New floor: the zoom of another map means nothing here.
    mapView.mapId = map.id;
    mapView.viewBox = fitViewBox(map);
    mapView.pickStationId = null;
  }
  if (!mapView.viewBox) mapView.viewBox = fitViewBox(map);

  // Writers can put NEW stations into empty slots ("+ Add station",
  // SPEC-v5.md section 3); viewers just see the empty slot.
  const canWrite = ctx.can('floorMap', 'write');
  const allStations = ctx.state.floorStations || [];
  const stations = stationsOfMap(allStations, map.id);
  const machines = ctx.state.machines || [];
  const workOrders = ctx.state.workOrders || [];
  const pmTasks = ctx.state.pmTasks || [];

  // Live state per station (SPEC section 2), from the synced local records.
  const liveFor = (station) =>
    stationState(station, { machines, workOrders, pmTasks, today: ctx.todayISO() });

  // Geometry: the drawing-unit rectangle of every on-map station.
  const rectByStationId = new Map();
  for (const box of (map.boxes || [])) {
    if (!box) continue;
    const taken = new Map();
    for (const station of stations) {
      if (station.boxId === box.id) taken.set(Number(station.slot) || 0, station);
    }
    for (const rect of slotRects(box)) {
      const occupant = taken.get(rect.slot);
      if (occupant) rectByStationId.set(occupant.id, rect);
    }
  }

  // --- svg ---------------------------------------------------------------
  const svg = svgEl('svg', {
    class: 'fm-svg',
    viewBox: viewBoxString(mapView.viewBox),
    preserveAspectRatio: 'xMidYMid meet',
    'aria-label': `Floor map: ${map.name || 'map'}`,
  });
  if (!mapView.names) svg.classList.add('fm-hide-names');
  if (mapView.pickStationId) svg.classList.add('fm-picking');
  const layers = svgEl('g', {});
  svg.append(layers);

  for (const fill of (map.fills || [])) {
    if (!fill) continue;
    layers.append(
      svgEl('rect', {
        x: round2(fill.x),
        y: round2(fill.y),
        width: round2(fill.w),
        height: round2(fill.h),
        fill: typeof fill.color === 'string' && fill.color !== '' ? fill.color : '#e5e7ec',
        'aria-hidden': 'true',
      }),
    );
  }
  for (const corridor of (map.corridors || [])) {
    if (!corridor) continue;
    layers.append(
      svgEl('rect', {
        x: round2(corridor.x),
        y: round2(corridor.y),
        width: round2(corridor.w),
        height: round2(corridor.h),
        fill: CORRIDOR_FILL,
        'aria-hidden': 'true',
      }),
    );
  }

  const slotNodes = []; // {station, node}
  for (const box of (map.boxes || [])) {
    if (!box) continue;
    layers.append(
      svgEl('rect', {
        x: round2(box.x),
        y: round2(box.y),
        width: round2(box.w),
        height: round2(box.h),
        fill: typeof box.fill === 'string' && box.fill !== '' ? box.fill : '#ffffff',
        stroke: BOX_BORDER,
        'stroke-width': '0.8',
        'aria-hidden': 'true',
      }),
    );
    const labelFit = fitText(box.label || '', Math.max(0, box.w - 4), Math.max(0, Math.min(10, box.h)));
    let labelY = round2(box.y);
    for (const line of labelFit.lines) {
      labelY = round2(labelY + labelFit.fontSize);
      layers.append(
        svgEl(
          'text',
          { class: 'fm-box-label', x: round2(box.x + 2), y: labelY, 'font-size': round2(labelFit.fontSize) },
          [svgEl('tspan', { text: line })],
        ),
      );
    }
    const taken = new Map();
    for (const station of stations) {
      if (station.boxId === box.id) taken.set(Number(station.slot) || 0, station);
    }
    for (const rect of slotRects(box)) {
      const station = taken.get(rect.slot);
      if (station) {
        const node = stationNode(ctx, station, rect, liveFor(station), machines);
        slotNodes.push({ station, node });
        layers.append(node);
      } else {
        layers.append(
          emptySlotNode(rect, box.id, rect.slot, Boolean(mapView.pickStationId), canWrite),
        );
      }
    }
  }

  // --- search highlight / chip dim --------------------------------------
  const searchStatus = h('span', { class: 'field-hint fm-search-status', role: 'status' }, '');

  function applyHighlight() {
    const query = mapView.search;
    const matches = query ? searchStations(stations, query, machines) : null;
    const matchIds = new Set(matches ? matches.map((station) => station.id) : []);
    let visible = 0;
    for (const { station, node } of slotNodes) {
      node.classList.toggle(
        'fm-hit',
        Boolean(query) && matchIds.has(station.id),
      );
      const passes = stationMatchesChip(station, liveFor(station), mapView.filter);
      node.classList.toggle('fm-dim', !passes);
      if (passes) visible += 1;
    }
    searchStatus.textContent = query
      ? matches && matches.length > 0
        ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
        : 'No match'
      : `${visible} of ${stations.length} stations`;
    return matches;
  }

  function centreOnStation(station) {
    const rect = rectByStationId.get(station.id);
    if (!rect) return;
    mapView.viewBox = clampViewBox(
      centreViewBoxOnRect(mapView.viewBox, rect),
      map.width,
      map.height,
    );
    applyView();
  }

  const searchInput = ctx.searchBox('Search station, staff or machine', (value) => {
    mapView.search = value;
    const matches = applyHighlight();
    if (matches && matches.length > 0) centreOnStation(matches[0]);
  });
  searchInput.querySelector('input').value = mapView.search;

  const chipBar = h(
    'div',
    { class: 'chips fm-chips', role: 'group', 'aria-label': 'Filter stations' },
    ...MAP_FILTERS.map((chip) =>
      h(
        'button',
        {
          class: `chip${mapView.filter === chip.key ? ' is-active' : ''}`,
          type: 'button',
          'aria-pressed': mapView.filter === chip.key ? 'true' : 'false',
          dataset: { chip: chip.key },
          onclick: () => {
            mapView.filter = chip.key;
            for (const other of chipBar.querySelectorAll('.chip')) {
              const active = other.dataset.chip === chip.key;
              other.classList.toggle('is-active', active);
              other.setAttribute('aria-pressed', String(active));
            }
            applyHighlight();
          },
        },
        chip.label,
      ),
    ),
  );

  // --- pan & zoom ---------------------------------------------------------
  function applyView() {
    svg.setAttribute('viewBox', viewBoxString(mapView.viewBox));
  }

  function zoomAtClient(clientX, clientY, factor) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    mapView.viewBox = clampViewBox(
      zoomViewBox(mapView.viewBox, map.width, map.height, factor, fx, fy),
      map.width,
      map.height,
    );
    applyView();
  }

  function zoomAtCentre(factor) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      mapView.viewBox = clampViewBox(
        zoomViewBox(mapView.viewBox, map.width, map.height, factor, 0.5, 0.5),
        map.width,
        map.height,
      );
      applyView();
      return;
    }
    zoomAtClient(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  const pointers = new Map();
  let dragStart = null; // {x, y} px + dragStartView snapshot
  let dragStartView = null;
  let pinchBase = null; // {dist, midX, midY, rectW, view}
  let movedPx = 0;
  let pressTarget = null;
  let clickTimer = null;

  function cancelClick() {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
  }

  function scheduleClick(action) {
    cancelClick();
    // A double-click on the same spot cancels this and only zooms in.
    clickTimer = setTimeout(() => {
      clickTimer = null;
      action();
    }, CLICK_DELAY_MS);
  }

  function stationFromElement(target) {
    const group = target && typeof target.closest === 'function' ? target.closest('g.fm-station') : null;
    if (!group) return null;
    const id = group.getAttribute('data-station');
    return stations.find((station) => station.id === id) ?? null;
  }

  function emptySlotFromElement(target) {
    const group =
      target && typeof target.closest === 'function' ? target.closest('g.fm-slot-empty') : null;
    if (!group) return null;
    const boxId = group.getAttribute('data-box');
    const slot = Number(group.getAttribute('data-slot'));
    const box = (map.boxes || []).find((entry) => entry && entry.id === boxId);
    if (!box) return null;
    return { box, slot: Number.isInteger(slot) ? slot : 0 };
  }

  function pinchNow() {
    const [a, b] = [...pointers.values()];
    if (!a || !b) return null;
    const rect = svg.getBoundingClientRect();
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      rectW: rect.width,
      rectH: rect.height,
      left: rect.left,
      top: rect.top,
    };
  }

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pressTarget = event.target;
    movedPx = 0;
    if (pointers.size === 1) {
      dragStart = { x: event.clientX, y: event.clientY };
      dragStartView = { ...mapView.viewBox };
      try {
        svg.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a nicety; the listeners below still work without it.
      }
    } else {
      dragStart = null;
      dragStartView = null;
      pressTarget = null;
      const now = pinchNow();
      pinchBase = now ? { ...now, view: { ...mapView.viewBox } } : null;
      cancelClick();
    }
  });

  svg.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2 && pinchBase) {
      // Pinch: absolute from the gesture start — pan the snapshot by the
      // midpoint movement, then zoom around the new midpoint, so the fingers
      // stay glued to the map.
      const now = pinchNow();
      if (!now || !now.rectW || !now.rectH) return;
      const factor = pinchBase.dist > 0 ? now.dist / pinchBase.dist : 1;
      let nextView = panViewBox(
        pinchBase.view,
        now.midX - pinchBase.midX,
        now.midY - pinchBase.midY,
        now.rectW,
      );
      const fx = (now.midX - now.left) / now.rectW;
      const fy = (now.midY - now.top) / now.rectH;
      nextView = zoomViewBox(nextView, map.width, map.height, factor || 1, fx, fy);
      mapView.viewBox = clampViewBox(nextView, map.width, map.height);
      applyView();
      movedPx = CLICK_SLOP_PX + 1;
      return;
    }
    if (pointers.size === 1 && dragStart && dragStartView) {
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      const distance = Math.abs(dx) + Math.abs(dy);
      if (distance > movedPx) movedPx = distance;
      if (movedPx > CLICK_SLOP_PX) {
        pressTarget = null;
        cancelClick();
        svg.classList.add('fm-panning');
        const rect = svg.getBoundingClientRect();
        mapView.viewBox = clampViewBox(
          panViewBox(dragStartView, dx, dy, rect.width),
          map.width,
          map.height,
        );
        applyView();
      }
    }
  });

  async function placeStationInSlot(box, slot) {
    const station = allStations.find((entry) => entry && entry.id === mapView.pickStationId);
    mapView.pickStationId = null;
    if (!station || !box) return;
    try {
      const next = { ...station, boxId: box.id, slot, updatedAt: ctx.nowISO() };
      delete next.pendingSync;
      await sync.saveRecord('floorStations', next, station.version);
      await ctx.refreshState();
      ctx.toast(`Placed on the map${box.label ? ` (${box.label})` : ''}.`);
    } catch (error) {
      console.error(error);
      await ctx.refreshState();
      ctx.toast('Could not place the station. Please try again.', 'warn');
    }
    ctx.render();
    showStationPanel(ctx, stationById(ctx, station.id));
  }

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchBase = null;
    if (pointers.size === 0) {
      svg.classList.remove('fm-panning');
      if (movedPx <= CLICK_SLOP_PX && pressTarget) {
        const station = stationFromElement(pressTarget);
        if (station && !mapView.pickStationId) {
          scheduleClick(() => showStationPanel(ctx, station));
        } else {
          const empty = emptySlotFromElement(pressTarget);
          if (empty && mapView.pickStationId) {
            scheduleClick(() => placeStationInSlot(empty.box, empty.slot));
          } else if (empty && canWrite) {
            // An empty slot opens the "+ Add station" panel (V5-M3).
            scheduleClick(() => showNewStationPanel(ctx, map.id, empty.box, empty.slot));
          }
        }
      }
      pressTarget = null;
      dragStart = null;
      dragStartView = null;
    } else if (pointers.size === 1) {
      // One finger lifted from a pinch: fall back to a plain pan drag.
      const [only] = [...pointers.values()];
      dragStart = { x: only.x, y: only.y };
      dragStartView = { ...mapView.viewBox };
      pressTarget = null;
      movedPx = CLICK_SLOP_PX + 1;
    }
  }

  svg.addEventListener('pointerup', endPointer);
  svg.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId);
    pinchBase = null;
    if (pointers.size === 0) {
      svg.classList.remove('fm-panning');
      pressTarget = null;
      dragStart = null;
      dragStartView = null;
    } else if (pointers.size === 1) {
      const [only] = [...pointers.values()];
      dragStart = { x: only.x, y: only.y };
      dragStartView = { ...mapView.viewBox };
      movedPx = CLICK_SLOP_PX + 1;
    }
  });

  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoomAtClient(event.clientX, event.clientY, event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP);
    },
    { passive: false },
  );

  svg.addEventListener('dblclick', (event) => {
    // The pending station click is cancelled: a double-click only zooms.
    cancelClick();
    zoomAtClient(event.clientX, event.clientY, DBLCLICK_STEP);
  });

  svg.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const station = stationFromElement(event.target);
    if (station) {
      event.preventDefault();
      cancelClick();
      showStationPanel(ctx, station);
      return;
    }
    const empty = emptySlotFromElement(event.target);
    if (empty && canWrite && !mapView.pickStationId) {
      event.preventDefault();
      cancelClick();
      showNewStationPanel(ctx, map.id, empty.box, empty.slot);
    }
  });

  // --- toolbar buttons ----------------------------------------------------
  const zoomIn = h(
    'button',
    { class: 'btn btn-small', type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomAtCentre(ZOOM_STEP) },
    '+',
  );
  const zoomOut = h(
    'button',
    { class: 'btn btn-small', type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomAtCentre(1 / ZOOM_STEP) },
    '−',
  );
  const zoomFit = h(
    'button',
    {
      class: 'btn btn-small',
      type: 'button',
      onclick: () => {
        mapView.viewBox = fitViewBox(map);
        applyView();
      },
    },
    'Fit',
  );
  const namesToggle = h(
    'button',
    {
      class: `btn btn-small${mapView.names ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': mapView.names ? 'true' : 'false',
      onclick: () => {
        mapView.names = !mapView.names;
        namesToggle.classList.toggle('is-active', mapView.names);
        namesToggle.setAttribute('aria-pressed', String(mapView.names));
        svg.classList.toggle('fm-hide-names', !mapView.names);
      },
    },
    'Show names',
  );

  // V5-M3 (SPEC-v5.md section 2 + 3): Edit map opens the canvas. Desktop
  // (≥ 1024 px) and floorMap write only — a phone never shows this button.
  const editButton =
    canWrite && ctx.desktopMedia.matches
      ? h(
          'button',
          {
            class: 'btn btn-small fm-edit-open',
            type: 'button',
            'aria-label': 'Edit the floor layout',
            onclick: () => startEditSession(ctx, map),
          },
          'Edit map',
        )
      : null;

  // Several floors: pick which map is shown (usually there is just one).
  let mapSelect = null;
  if (maps.length > 1) {
    const select = ctx.selectFrom(
      maps.map((entry) => entry.id),
      map.id,
      (id) => {
        const found = maps.find((entry) => entry.id === id);
        return found ? found.name || 'Floor' : 'Floor';
      },
    );
    select.setAttribute('aria-label', 'Floor');
    select.addEventListener('change', () => {
      ctx.navigate(`#/map?map=${encodeURIComponent(select.value)}`);
    });
    mapSelect = ctx.field('Floor', select);
  }

  // --- pick-mode hint bar -------------------------------------------------
  const pickStation = mapView.pickStationId
    ? allStations.find((entry) => entry && entry.id === mapView.pickStationId)
    : null;
  const hintBar = pickStation
    ? h(
        'div',
        { class: 'fm-hint-bar', role: 'status' },
        h('span', {}, `Placing ${pickStation.code || 'a station'}: click an empty slot on the map`),
        h(
          'button',
          {
            class: 'btn btn-small',
            type: 'button',
            onclick: () => {
              mapView.pickStationId = null;
              ctx.render();
            },
          },
          'Cancel',
        ),
      )
    : null;

  // --- ?station=<id>: centre + highlight + open the panel once ------------
  const focusId = route && route.params ? route.params.get('station') : null;
  const focusStation = focusId ? stations.find((station) => station.id === focusId) || null : null;
  if (focusStation) {
    const rect = rectByStationId.get(focusStation.id) || {
      x: 0,
      y: 0,
      w: map.width,
      h: map.height,
    };
    mapView.viewBox = clampViewBox(centreViewBoxOnRect(mapView.viewBox, rect), map.width, map.height);
    // Open the panel once per station param, not on every sync re-render.
    if (mapView.lastAutoStation !== focusStation.id) {
      mapView.lastAutoStation = focusStation.id;
      requestAnimationFrame(() => showStationPanel(ctx, focusStation));
    }
  } else if (mapView.lastAutoStation !== null) {
    mapView.lastAutoStation = null;
  }
  for (const { station, node } of slotNodes) {
    node.classList.toggle('fm-selected', Boolean(focusStation && station.id === focusStation.id));
  }

  // --- legend ---------------------------------------------------------------
  const counts = legendCounts(stations.map(liveFor));
  const legend = h(
    'div',
    { class: 'fm-legend', 'aria-label': 'Map legend' },
    legendItem(h, 'fm-swatch fm-swatch-down', 'Machine down', counts.down),
    legendItem(h, 'fm-swatch fm-swatch-badge', 'Open orders', counts.openOrders),
    legendItem(h, 'fm-swatch fm-swatch-dot', 'PM overdue', counts.pmOverdue),
    legendItem(h, 'fm-swatch fm-swatch-plain', 'Stations', stations.length),
  );

  // --- off-map stations ------------------------------------------------------
  const offMap = stations.filter((station) => isOffMapStation(map, station));
  const offMapList = h(
    'details',
    { class: 'more fm-offmap' },
    h('summary', {}, `Off-map stations (${offMap.length})`),
    offMap.length
      ? h(
          'div',
          { class: 'list' },
          ...offMap.map((station) =>
            h(
              'button',
              {
                class: 'row fm-offmap-row',
                type: 'button',
                onclick: () => showStationPanel(ctx, station),
              },
              h(
                'div',
                { class: 'row-main' },
                h('div', { class: 'row-title' }, station.code || 'Untitled station'),
                h('div', { class: 'row-sub' }, station.zone || 'No zone'),
              ),
              h('span', { class: 'row-chevron', 'aria-hidden': 'true' }, '›'),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'Every station has a place on the map.'),
  );

  applyView();
  applyHighlight();
  attachMiddlePan(svg, applyView, (view) => clampViewBox(view, map.width, map.height));

  // Shown only on paper/PDF (Print / PDF button).
  const printHead = h(
    'div',
    { class: 'fm-print-head' },
    h('strong', {}, map.name || 'Floor map'),
    h('span', {}, ` · printed ${ctx.todayISO()}`),
  );
  const svgWrap = h('div', { class: 'fm-svg-wrap fm-print-area' }, printHead, svg);
  const printButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', title: 'Letter-size page; choose “Save as PDF” as the printer for a PDF', onclick: () => printMap(svg, map) },
    'Print / PDF',
  );

  return ctx.page(
    ctx.pageHead('Floor map'),
    h(
      'div',
      { class: 'fm-toolbar' },
      searchInput,
      searchStatus,
      chipBar,
      h('div', { class: 'fm-zoom' }, zoomOut, zoomIn, zoomFit),
      textSizeControl(ctx),
      namesToggle,
      printButton,
      editButton,
      mapSelect,
    ),
    hintBar,
    legend,
    svgWrap,
    offMapList,
  );
}

const TEXT_SCALES = [0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
const TEXT_SCALE_KEY = 'fm-text-scale';

try {
  const saved = Number(localStorage.getItem(TEXT_SCALE_KEY));
  if (TEXT_SCALES.includes(saved)) mapView.textScale = saved;
} catch {
  // Private mode or blocked storage: Auto it is.
}

/** Text size: A− / A+ step through TEXT_SCALES; the middle button resets to Auto. */
function textSizeControl(ctx) {
  const { h } = ctx;
  const index = Math.max(0, TEXT_SCALES.indexOf(mapView.textScale));
  const set = (value) => {
    mapView.textScale = value;
    try {
      localStorage.setItem(TEXT_SCALE_KEY, String(value));
    } catch {
      // Only a convenience; the choice still applies until reload.
    }
    ctx.render();
  };
  const label = mapView.textScale === 1 ? 'Names: Auto' : `Names: ${Math.round(mapView.textScale * 100)}%`;
  return h(
    'div',
    { class: 'fm-zoom fm-textsize', role: 'group', 'aria-label': 'Text size' },
    h('button', { class: 'btn btn-small', type: 'button', 'aria-label': 'Smaller names', disabled: index === 0, onclick: () => set(TEXT_SCALES[index - 1]) }, 'A−'),
    h(
      'button',
      {
        class: 'btn btn-small',
        type: 'button',
        title: 'Size of the staff names. Auto: the largest that shows every name inside its box. Click to go back to Auto.',
        onclick: () => set(1),
      },
      label,
    ),
    h('button', { class: 'btn btn-small', type: 'button', 'aria-label': 'Larger names', disabled: index === TEXT_SCALES.length - 1, onclick: () => set(TEXT_SCALES[index + 1]) }, 'A+'),
  );
}

/**
 * Wheel click (middle button) drags the map, in the view and in the editor,
 * whatever tool is active. The browser's middle-click autoscroll is blocked.
 */
function attachMiddlePan(svg, applyView, clamp) {
  let start = null;
  svg.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  svg.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 1 || !mapView.viewBox) return;
    event.preventDefault();
    start = { id: event.pointerId, x: event.clientX, y: event.clientY, view: { ...mapView.viewBox } };
    svg.classList.add('fm-panning');
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; the move listener still works without it.
    }
  });
  svg.addEventListener('pointermove', (event) => {
    if (!start || event.pointerId !== start.id) return;
    const width = svg.getBoundingClientRect().width;
    mapView.viewBox = clamp(panViewBox(start.view, event.clientX - start.x, event.clientY - start.y, width));
    applyView();
  });
  const end = (event) => {
    if (!start || event.pointerId !== start.id) return;
    start = null;
    svg.classList.remove('fm-panning');
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

/**
 * Print / PDF on Letter paper: only the map (whole drawing, current names
 * and text size), portrait or landscape by the drawing's shape. The screen
 * view comes back after the print dialog closes.
 */
function printMap(svg, map) {
  const bounds = drawingBounds(map) || fitViewBox(map);
  const style = document.createElement('style');
  style.textContent = `@page { size: letter ${bounds.w > bounds.h ? 'landscape' : 'portrait'}; margin: 0.35in; }`;
  const saved = svg.getAttribute('viewBox');
  svg.setAttribute('viewBox', viewBoxString(bounds));
  document.head.append(style);
  document.body.classList.add('fm-printing');
  const restore = () => {
    window.removeEventListener('afterprint', restore);
    style.remove();
    document.body.classList.remove('fm-printing');
    if (saved) svg.setAttribute('viewBox', saved);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

function legendItem(h, swatchClass, label, count) {
  return h(
    'span',
    { class: 'fm-legend-item' },
    h('span', { class: swatchClass, 'aria-hidden': 'true' }),
    h('span', {}, `${label} ${count}`),
  );
}

/** Not imported yet: the admin CLI hint (SPEC-v5.md section 4). */
function emptyMapPage(ctx) {
  return ctx.page(
    ctx.pageHead('Floor map'),
    ctx.emptyState('No floor map yet', 'An administrator imports the shop layout once, on the server:', [
      ctx.h(
        'div',
        { class: 'card pre fm-import-command' },
        'node server/admin.js import-floor-map <layout.json> <stations.json> --name "Main floor"',
      ),
      ctx.h(
        'p',
        { class: 'field-hint' },
        'The map and its stations then sync to every signed-in device; nothing about the floor roster is stored in this repository.',
      ),
    ]),
  );
}

/** One station's slot group: slot rect, code/name lines, badge, PM dot. */
function stationNode(ctx, station, rect, live, machines) {
  const down = live.down === true;
  const group = svgEl('g', {
    class: down ? 'fm-station fm-station-down' : 'fm-station',
    'data-station': station.id,
    role: 'button',
    tabindex: '0',
  });
  group.append(
    svgEl('rect', {
      class: 'fm-slot-rect',
      x: round2(rect.x),
      y: round2(rect.y),
      width: round2(rect.w),
      height: round2(rect.h),
      fill: down ? DOWN_FILL : '#ffffff',
      stroke: down ? DOWN_BORDER : '#c9cedb',
      'stroke-width': down ? '1.1' : '0.6',
    }),
  );
  for (const text of slotTextNodes(rect, station.code, station.name)) {
    group.append(text);
  }
  if (live.openOrders > 0) {
    const count = Math.min(99, Math.max(1, Number(live.openOrders) || 1));
    const radius = count >= 10 ? 5.6 : 4.4;
    const cx = round2(rect.x + rect.w - radius - 1.5);
    const cy = round2(rect.y + radius + 1.5);
    group.append(
      svgEl('g', { class: 'fm-badge', 'aria-hidden': 'true' }, [
        svgEl('circle', { cx, cy, r: round2(radius), fill: BADGE_FILL }),
        svgEl('text', {
          class: 'fm-badge-text',
          x: cx,
          y: round2(cy + radius * 0.35),
          'font-size': round2(radius * 1.15),
          'text-anchor': 'middle',
          text: String(count),
        }),
      ]),
    );
  }
  if (live.pmOverdue) {
    group.append(
      svgEl('circle', {
        class: 'fm-dot',
        'aria-hidden': 'true',
        cx: round2(rect.x + 4),
        cy: round2(rect.y + 4),
        r: '2.4',
        fill: DOT_FILL,
      }),
    );
  }
  const machine = station.machineId
    ? machines.find((entry) => entry && entry.id === station.machineId)
    : null;
  const bits = [station.code || 'Station'];
  if (station.name) bits.push(station.name);
  if (machine) bits.push(machine.name || 'machine');
  if (down) bits.push('machine down');
  if (live.openOrders > 0) bits.push(`${live.openOrders} open order${live.openOrders === 1 ? '' : 's'}`);
  group.setAttribute('aria-label', bits.join(' · '));
  return group;
}

/**
 * An empty slot: faint, dashed — clickable only in pick mode, or (V5-M3) as a
 * "+ Add station" affordance for writers. The add text fits and shrinks like
 * any slot text and never overflows the box.
 */
function emptySlotNode(rect, boxId, slot, picking, addable = false) {
  const canAdd = addable && !picking;
  const group = svgEl(
    'g',
    {
      class: `fm-slot-empty${picking ? ' fm-slot-pick' : ''}${canAdd ? ' fm-slot-add' : ''}`,
      'data-box': boxId,
      'data-slot': String(slot),
      'aria-hidden': canAdd ? null : 'true',
      role: canAdd ? 'button' : null,
      tabindex: canAdd ? '0' : null,
      'aria-label': canAdd ? 'Add a station in this slot' : null,
    },
    [
      svgEl('rect', {
        class: 'fm-slot-empty-rect',
        x: round2(rect.x),
        y: round2(rect.y),
        width: round2(rect.w),
        height: round2(rect.h),
      }),
    ],
  );
  if (canAdd && rect.w >= 12 && rect.h >= 6) {
    const fit = fitText('+', Math.max(0, rect.w - 2), Math.max(0, Math.min(rect.h - 2, 8)));
    if (fit.fontSize >= 3) {
      let y = round2(rect.y + fit.fontSize + 0.5);
      for (const line of fit.lines) {
        group.append(
          svgEl(
            'text',
            { class: 'fm-slot-add-text', x: round2(rect.x + 1), y, 'font-size': round2(fit.fontSize) },
            [svgEl('tspan', { text: line })],
          ),
        );
        y = round2(y + fit.fontSize * 1.2);
      }
    }
  }
  return group;
}

// ---------------------------------------------------------------------------
// Station panel (SPEC section 2): desktop side drawer (the app's openDrawer),
// phone bottom sheet (this module's own, every added node removed on close).
// ---------------------------------------------------------------------------

let stationSheet = null; // {root, backdrop, previousFocus, ctx}

function stationById(ctx, id) {
  return (ctx.state.floorStations || []).find((entry) => entry && entry.id === id) || null;
}

function closeStationSheet({ refocus = false } = {}) {
  if (!stationSheet) return;
  const { root, backdrop, previousFocus } = stationSheet;
  document.removeEventListener('keydown', onStationSheetKey);
  window.removeEventListener('hashchange', onStationSheetRouteChange);
  root.remove();
  backdrop.remove();
  stationSheet = null;
  if (refocus && previousFocus instanceof HTMLElement && previousFocus.isConnected) {
    previousFocus.focus();
  }
}

// "Open machine" and "+ New service order" leave the map; a sheet left
// behind would cover the next page and block every tap.
function onStationSheetRouteChange() {
  closeStationSheet();
}

function onStationSheetKey(event) {
  if (!stationSheet) return;
  if (event.key === 'Escape') {
    if (stationSheet.ctx.dialogOpen()) return;
    event.preventDefault();
    closeStationSheet({ refocus: true });
  } else if (event.key === 'Tab') {
    stationSheet.ctx.trapTabKey(stationSheet.root, event);
  }
}

function openStationSheet(ctx, station, body) {
  if (stationSheet) closeStationSheet();
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `fm-sheet-title-${Math.random().toString(16).slice(2, 8)}`;
  const closeButton = ctx.h(
    'button',
    { class: 'icon-button fm-sheet-close', type: 'button', 'aria-label': 'Close' },
    ctx.h('span', { 'aria-hidden': 'true' }, '✕'),
  );
  const backdrop = ctx.h('div', { class: 'sheet-backdrop' });
  const root = ctx.h(
    'section',
    { class: 'sheet fm-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    ctx.h(
      'div',
      { class: 'fm-sheet-head' },
      ctx.h('h2', { class: 'sheet-title', id: titleId }, station.code || 'Station'),
      closeButton,
    ),
    ctx.h('div', { class: 'fm-sheet-body' }, body),
  );
  stationSheet = { root, backdrop, previousFocus, ctx };
  closeButton.addEventListener('click', () => closeStationSheet({ refocus: true }));
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) closeStationSheet({ refocus: true });
  });
  document.addEventListener('keydown', onStationSheetKey);
  window.addEventListener('hashchange', onStationSheetRouteChange);
  document.body.append(backdrop, root);
  const first = root.querySelector('button, [href], input, select, textarea');
  if (first) first.focus();
  else root.focus();
}

/** Show a station panel body: drawer on desktop, bottom sheet on the phone. */
function showPanelWithBody(ctx, title, body) {
  if (ctx.desktopMedia.matches) {
    ctx.openDrawer({ title, content: body });
  } else {
    openStationSheet(ctx, { code: title }, body);
  }
}

/** Show the station panel: drawer on desktop, bottom sheet on the phone. */
function showStationPanel(ctx, station) {
  if (!station) return;
  showPanelWithBody(ctx, station.code || 'Station', stationPanelBody(ctx, station).body);
}

/**
 * The "+ Add station" panel (SPEC-v5.md section 3: a new box's empty slots
 * offer a station after saving): the SPEC 1.2 field set, created in that
 * box/slot as one floorStations record. Nothing saves until Add station.
 */
function showNewStationPanel(ctx, mapId, box, slot) {
  const { body } = newStationBody(ctx, mapId, box, slot);
  showPanelWithBody(ctx, `New station (slot ${slot + 1})`, body);
}

/** A station id for the new-station create (client-generated, ≤ 40 chars). */
function newStationId() {
  const random =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `st-${random}`.slice(0, 40);
}

function newStationBody(ctx, mapId, box, slot) {
  const { h } = ctx;
  const body = h('div', { class: 'fm-panel fm-panel-new' });
  if (!ctx.can('floorMap', 'write') || !box) {
    body.append(h('p', { class: 'muted' }, 'You cannot add stations here.'));
    return { body };
  }
  const nextId = newStationId();
  const textInput = (key, label, maxlength) => {
    const input = h('input', { type: 'text', maxlength, 'aria-label': label });
    return { input, field: ctx.field(label, input), key };
  };
  const code = textInput('code', 'Station code', 40);
  const zone = textInput('zone', 'Zone', 60);
  const name = textInput('name', 'Staff name', 80);
  const nameCn = textInput('nameCn', 'Chinese name', 80);
  const empId = textInput('empId', 'Employee ID', 20);
  const vacantInput = h('input', { type: 'checkbox' });
  const remarkInput = h('textarea', { rows: 3, maxlength: 200 });
  const addButton = h(
    'button',
    { class: 'btn btn-primary', type: 'button' },
    'Add station',
  );
  const busyNote = h('p', { class: 'field-hint', role: 'status' }, '');
  let busy = false;

  addButton.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    busyNote.textContent = 'Adding…';
    const record = {
      id: nextId,
      mapId,
      boxId: box.id,
      slot,
      code: code.input.value.trim().slice(0, 40),
      zone: zone.input.value.trim().slice(0, 60),
      name: name.input.value.trim().slice(0, 80),
      nameCn: nameCn.input.value.trim().slice(0, 80),
      empId: empId.input.value.trim().slice(0, 20),
      vacant: vacantInput.checked,
      remark: remarkInput.value.slice(0, 200),
      machineId: null,
    };
    try {
      await sync.saveRecord('floorStations', record);
      await ctx.refreshState();
      ctx.toast('Station added.');
      ctx.render();
      const saved = stationById(ctx, record.id);
      if (!ctx.desktopMedia.matches && stationSheet) closeStationSheet();
      showStationPanel(ctx, saved);
    } catch (error) {
      console.error(error);
      busy = false;
      busyNote.textContent = '';
      await ctx.refreshState();
      ctx.toast('Could not add the station. Please try again.', 'warn');
    }
  });

  body.append(
    h('p', { class: 'field-hint' }, `A new station in box “${box.label || box.id}”, slot ${slot + 1}.`),
    code.field,
    zone.field,
    name.field,
    nameCn.field,
    empId.field,
    ctx.field('Vacant', vacantInput, 'No staff at this station'),
    ctx.field('Remark', remarkInput),
    addButton,
    busyNote,
    h('p', { class: 'field-hint' }, 'Link the machine after adding, from the station panel.'),
  );
  return { body };
}

/**
 * The station panel content: editable staff fields (SPEC-v5.md 1.2) that
 * save on change with floorMap write, the machine link (status pill, Open
 * machine, a searchable Link-to-machine list, Unlink) and the machine's
 * open service orders with "+ New service order" pre-filled with that
 * machine (the normal `#/jobs/new?machine=<id>` form). Read-only roles see
 * plain disabled fields.
 */
function stationPanelBody(ctx, station) {
  const { h } = ctx;
  const canWrite = ctx.can('floorMap', 'write');
  const readOnly = !canWrite;
  let current = { ...station };

  async function saveFields(changes) {
    const next = { ...current, ...changes, updatedAt: ctx.nowISO() };
    delete next.pendingSync;
    await sync.saveRecord('floorStations', next, current.version);
    current = next;
    await ctx.refreshState();
    ctx.toast('Station saved.');
    ctx.render();
  }

  // Read-only roles get disabled inputs (the server stays the authority).
  function guard(revert) {
    return async (error) => {
      console.error(error);
      revert();
      ctx.toast('Could not save the station. Please try again.', 'warn');
    };
  }

  function textField(key, label, maxlength) {
    const input = h('input', {
      type: 'text',
      value: current[key] || '',
      maxlength,
      disabled: readOnly,
    });
    input.addEventListener('change', async () => {
      if (readOnly) return;
      const value = input.value;
      try {
        await saveFields({ [key]: value });
      } catch (error) {
        await guard(() => {
          input.value = current[key] || '';
        })(error);
      }
    });
    return ctx.field(label, input);
  }

  const fieldsHost = h(
    'div',
    { class: 'fm-fields' },
    textField('code', 'Station code', 40),
    textField('zone', 'Zone', 60),
    textField('name', 'Staff name', 80),
    textField('nameCn', 'Chinese name', 80),
    textField('empId', 'Employee ID', 20),
  );

  const vacantInput = h('input', { type: 'checkbox', disabled: readOnly });
  vacantInput.checked = current.vacant === true;
  vacantInput.addEventListener('change', async () => {
    if (readOnly) return;
    const value = vacantInput.checked;
    try {
      await saveFields({ vacant: value });
    } catch (error) {
      await guard(() => {
        vacantInput.checked = current.vacant === true;
      })(error);
    }
  });
  fieldsHost.append(
    ctx.field('Vacant', vacantInput, 'No staff at this station'),
  );

  const remarkInput = h('textarea', { rows: 3, maxlength: 200, disabled: readOnly });
  remarkInput.value = current.remark || '';
  remarkInput.addEventListener('change', async () => {
    if (readOnly) return;
    const value = remarkInput.value;
    try {
      await saveFields({ remark: value });
    } catch (error) {
      await guard(() => {
        remarkInput.value = current.remark || '';
      })(error);
    }
  });
  fieldsHost.append(ctx.field('Remark', remarkInput));

  // --- machine link --------------------------------------------------------
  const machineHost = h('div', { class: 'fm-panel-machine' });

  function machinesSorted() {
    return (ctx.state.machines || [])
      .filter(Boolean)
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  function openOrdersFor(machineId) {
    return (ctx.state.workOrders || [])
      .filter((order) => order && order.machineId === machineId && order.status !== 'done')
      .sort((a, b) => String(b.reportedAt || '').localeCompare(String(a.reportedAt || '')));
  }

  function linkedMachineNode(machine) {
    const orders = openOrdersFor(machine.id);
    return h(
      'div',
      { class: 'fm-machine-link' },
      h('h4', { class: 'fm-panel-subhead' }, 'Machine'),
      h(
        'div',
        { class: 'fm-machine-linked' },
        ctx.statusPill(machine.status, LABELS.machineStatus),
        h(
          'a',
          { class: 'inline-link', href: `#/machines/${encodeURIComponent(machine.id)}` },
          machine.name || 'Untitled machine',
        ),
        h('a', { class: 'btn btn-small', href: `#/machines/${encodeURIComponent(machine.id)}` }, 'Open machine'),
        canWrite
          ? h(
              'button',
              {
                class: 'btn btn-small',
                type: 'button',
                onclick: async () => {
                  try {
                    await saveFields({ machineId: null });
                  } catch (error) {
                    await guard(() => {})(error);
                    return;
                  }
                  refreshMachineHost();
                },
              },
              'Unlink',
            )
          : null,
      ),
      h('h4', { class: 'fm-panel-subhead' }, 'Open service orders'),
      ctx.can('serviceOrders')
        ? h(
            'div',
            { class: 'list' },
            ...orders.map((order) =>
              h(
                'a',
                { class: 'row', href: `#/jobs/${encodeURIComponent(order.id)}` },
                h(
                  'div',
                  { class: 'row-main' },
                  h('div', { class: 'row-title' }, order.title || 'Untitled'),
                  h('div', { class: 'row-sub' }, ctx.formatOrderNumber(order.number)),
                ),
                ctx.statusPill(order.status, LABELS.status),
              ),
            ),
            orders.length === 0 ? h('p', { class: 'muted' }, 'No open service orders.') : null,
          )
        : null,
      ctx.can('serviceOrders', 'write')
        ? h(
            'a',
            {
              class: 'btn btn-primary btn-small fm-new-order',
              href: `#/jobs/new?machine=${encodeURIComponent(machine.id)}`,
            },
            '+ New service order',
          )
        : null,
    );
  }

  function pickerNode() {
    const machines = machinesSorted();
    // Searchable list (SPEC section 2): a filter box above the select.
    const filterInput = h('input', {
      type: 'search',
      placeholder: 'Filter machines',
      'aria-label': 'Filter machines',
    });
    const select = h('select', {
      'aria-label': 'Link to machine',
      disabled: machines.length === 0,
    });
    select.append(h('option', { value: '' }, 'Pick a machine…'));
    for (const machine of machines) {
      select.append(h('option', { value: machine.id }, machine.name || 'Untitled machine'));
    }
    filterInput.addEventListener('input', () => {
      const needle = String(filterInput.value || '').toLowerCase().trim();
      const previous = select.value;
      select.replaceChildren(
        h('option', { value: '' }, needle ? 'No machine selected' : 'Pick a machine…'),
      );
      for (const machine of machines) {
        if (needle && !String(machine.name || '').toLowerCase().includes(needle)) continue;
        select.append(h('option', { value: machine.id }, machine.name || 'Untitled machine'));
      }
      // Keep the chosen machine selected while narrowing; choosing an option
      // (even the lone survivor) is one explicit click/keypress.
      if ([...select.children].some((option) => option.value === previous && previous !== '')) {
        select.value = previous;
      }
    });
    select.addEventListener('change', async () => {
      if (!select.value || readOnly) return;
      try {
        await saveFields({ machineId: select.value });
      } catch (error) {
        await guard(() => {
          select.value = '';
        })(error);
        return;
      }
      refreshMachineHost();
    });
    return h(
      'div',
      { class: 'fm-machine-link' },
      h('h4', { class: 'fm-panel-subhead' }, 'Machine'),
      h(
        'p',
        { class: 'muted fm-machines-hint' },
        machines.length
          ? 'Not linked. Pick a machine to see its state here.'
          : 'No machines yet.',
      ),
      machines.length ? h('div', { class: 'fm-machine-picker' }, filterInput, select) : null,
    );
  }

  function refreshMachineHost() {
    const machineId = current.machineId || null;
    const machine = machineId
      ? (ctx.state.machines || []).find((entry) => entry && entry.id === machineId)
      : null;
    machineHost.replaceChildren(machine ? linkedMachineNode(machine) : pickerNode());
  }
  refreshMachineHost();

  // --- off-map: place the station -------------------------------------------
  const offMap = isOffMapForPanel(ctx, station);
  const pickActive = mapView.pickStationId === station.id;
  const placeNote = pickActive
    ? h('p', { class: 'field-hint', role: 'status' }, 'Click an empty slot on the map to place this station.')
    : null;
  const placeButton =
    canWrite && offMap && !pickActive
      ? h(
          'button',
          {
            class: 'btn btn-small fm-place-btn',
            type: 'button',
            onclick: () => {
              mapView.pickStationId = station.id;
              mapView.lastAutoStation = null;
              if (stationSheet) closeStationSheet();
              ctx.render();
            },
          },
          'Place on map',
        )
      : null;

  const body = h(
    'div',
    { class: 'fm-panel' },
    readOnly ? h('p', { class: 'field-hint' }, 'View only — your role cannot edit stations.') : null,
    fieldsHost,
    machineHost,
    placeNote,
    placeButton,
    h('p', { class: 'field-hint' }, 'Changes save immediately.'),
  );
  return { body };
}

/** Off-map for the panel: no box, or the box is gone from the geometry. */
function isOffMapForPanel(ctx, station) {
  if (!station) return true;
  if (!station.boxId) return true;
  const map = (ctx.state.floorMaps || []).find((entry) => entry && entry.id === station.mapId);
  if (!map) return true;
  return !((map.boxes || []) || []).some((box) => box && box.id === station.boxId);
}

// ---------------------------------------------------------------------------
// V5-M3: the edit canvas (SPEC-v5.md section 3). Entered with the toolbar
// Edit map button (desktop ≥ 1024 px + floorMap write; phones never see it).
// Everything below edits a working COPY (structuredClone) of the floorMaps
// record so Cancel — or a failed save — throws the changes away without
// ever touching the synced state. The pure geometry lives in logic-map.js;
// here it is wired to the canvas: selection, drag/resize/nudge, the tools,
// rubber banding, the 50-step undo stack and Save (off-map stations get
// boxId null, never deleted).
// ---------------------------------------------------------------------------

const EDIT_TOOLS = Object.freeze([
  { key: 'select', label: 'Select' },
  { key: 'box', label: '+ Box' },
  { key: 'corridor', label: '+ Corridor' },
  { key: 'patch', label: '+ Patch' },
]);

const SHAPE_KIND_LIST = ['box', 'fill', 'corridor'];

/** The fill colours the panel offers (SVG-safe #rrggbb or '' = none). */
const FILL_PALETTE = [
  { value: '', label: 'No fill (white)' },
  { value: '#e5e7ec', label: 'Grey' },
  { value: '#cdd5e1', label: 'Slate' },
  { value: '#f5e6a8', label: 'Yellow' },
  { value: '#cfe6cf', label: 'Green' },
  { value: '#e8dcc3', label: 'Tan' },
];

/** A duplicate lands 10 units away (a multiple of the snap grid). */
const DUPLICATE_OFFSET = 10;
/** A double-click must not create two default shapes in the same spot. */
const CREATE_DOUBLE_MS = 350;

const mapEdit = {
  active: false,
  mapId: null,
  original: null, // the floorMaps record the copy came from (id, version…)
  copy: null, // the working copy: {name, width, height, boxes, corridors, fills}
  baseJson: '', // sanitized geometry at entry: dirty means "JSON differs"
  tool: 'select',
  snap: true,
  selection: [], // [{kind, obj}] into the copy's lists
  undo: [], // up to UNDO_LIMIT snapshots, oldest first
  dirty: false,
  ctx: null, // the render context, for the guards and async actions
};

function editShapesOf(kind) {
  const copy = mapEdit.copy;
  if (!copy) return [];
  if (kind === 'box') return Array.isArray(copy.boxes) ? copy.boxes : [];
  if (kind === 'corridor') return Array.isArray(copy.corridors) ? copy.corridors : [];
  if (kind === 'fill') return Array.isArray(copy.fills) ? copy.fills : [];
  return [];
}

/** Drop refs whose object vanished (deleted, or restored by an undo). */
function resolveEditSelection() {
  if (!Array.isArray(mapEdit.selection)) mapEdit.selection = [];
  if (!mapEdit.copy) {
    mapEdit.selection = [];
    return mapEdit.selection;
  }
  mapEdit.selection = mapEdit.selection.filter(
    (ref) => ref && ref.obj && editShapesOf(ref.kind).includes(ref.obj),
  );
  return mapEdit.selection;
}

function recomputeEditDirty() {
  if (!mapEdit.copy || typeof mapEdit.baseJson !== 'string') {
    mapEdit.dirty = false;
    return;
  }
  mapEdit.dirty = JSON.stringify(sanitizeMapForSave(mapEdit.copy)) !== mapEdit.baseJson;
}

/** A deep snapshot of the working copy for one undo step. */
function snapshotCopy() {
  const copy = mapEdit.copy;
  if (!copy) return null;
  return structuredClone({
    name: copy.name,
    width: copy.width,
    height: copy.height,
    boxes: copy.boxes,
    corridors: copy.corridors,
    fills: copy.fills,
  });
}

/**
 * One discrete edit: push the pre-change snapshot (undo), run the mutation,
 * then re-resolve the selection, recompute dirty and re-render the page.
 * Gestures that push their own snapshot at drag start pass pushUndo: false.
 */
function editMutation(mutator, { pushUndo = true } = {}) {
  if (pushUndo && mapEdit.active) {
    mapEdit.undo = pushUndoSnapshot(mapEdit.undo, snapshotCopy());
  }
  const result = mutator();
  resolveEditSelection();
  recomputeEditDirty();
  if (mapEdit.ctx) mapEdit.ctx.render();
  return result;
}

/** Ctrl+Z: pop the newest snapshot and restore it (selection clears). */
function undoEditChange() {
  if (!mapEdit.active || mapEdit.undo.length === 0) return;
  const { stack, snapshot } = popUndoSnapshot(mapEdit.undo);
  mapEdit.undo = stack;
  if (snapshot === null || typeof snapshot !== 'object') return;
  mapEdit.copy = snapshot;
  mapEdit.selection = [];
  resolveEditSelection();
  recomputeEditDirty();
  if (mapEdit.ctx) mapEdit.ctx.render();
}

/** Arrow keys: exact 1-unit steps (Shift = 10), never grid-snapped. */
function nudgeEditSelection(dx, dy) {
  resolveEditSelection();
  if (mapEdit.selection.length === 0) return;
  editMutation(() => {
    for (const { obj } of mapEdit.selection) {
      const moved = nudgeShape(obj, dx, dy);
      obj.x = moved.x;
      obj.y = moved.y;
    }
  });
}

/** The panel's Delete (and the Delete key): remove the selected shapes. */
function deleteEditSelection() {
  resolveEditSelection();
  if (mapEdit.selection.length === 0) return;
  editMutation(() => {
    for (const { kind, obj } of mapEdit.selection) {
      const list = editShapesOf(kind);
      const index = list.indexOf(obj);
      if (index >= 0) list.splice(index, 1);
    }
    // Deleting a box (or lowering its slots) never deletes stations: at save
    // time the affected ones go off-map instead (saveEditSession).
  });
}

/** The panel's Duplicate: a copy of each selected shape, 10 units over. */
function duplicateEditSelection() {
  resolveEditSelection();
  if (mapEdit.selection.length === 0) return;
  editMutation(() => {
    const added = [];
    for (const { kind, obj } of mapEdit.selection) {
      const clone = structuredClone(obj);
      const moved = moveShape(
        { x: obj.x, y: obj.y },
        DUPLICATE_OFFSET,
        DUPLICATE_OFFSET,
        { snapOn: mapEdit.snap },
      );
      clone.x = moved.x;
      clone.y = moved.y;
      if (kind === 'box') clone.id = newBoxId(editShapesOf('box').map((box) => box && box.id));
      const list = editShapesOf(kind);
      list.push(clone);
      added.push({ kind, obj: clone });
    }
    mapEdit.selection = added;
  });
}

/** Enter edit mode on the working copy of this floorMaps record. */
function startEditSession(ctx, map) {
  if (mapEdit.active || !map) return;
  // Desktop (≥ 1024 px) and floorMap write only — the button is already
  // hidden otherwise; this is the belt to the braces.
  if (!ctx.can('floorMap', 'write') || !ctx.desktopMedia.matches) return;
  mapEdit.active = true;
  mapEdit.mapId = map.id;
  mapEdit.original = map;
  mapEdit.copy = structuredClone({
    name: map.name,
    width: map.width,
    height: map.height,
    boxes: (Array.isArray(map.boxes) ? map.boxes : []).filter(Boolean),
    corridors: (Array.isArray(map.corridors) ? map.corridors : []).filter(Boolean),
    fills: (Array.isArray(map.fills) ? map.fills : []).filter(Boolean),
  });
  mapEdit.baseJson = JSON.stringify(sanitizeMapForSave(mapEdit.copy));
  mapEdit.tool = 'select';
  mapEdit.snap = true;
  mapEdit.selection = [];
  mapEdit.undo = [];
  mapEdit.dirty = false;
  mapEdit.ctx = ctx;
  if (mapView.mapId !== map.id || !mapView.viewBox) mapView.viewBox = fitViewBox(map);
  installEditGuards();
  ctx.render();
}

/**
 * Leave edit mode at once: the working copy is discarded (Cancel semantics),
 * every guard listener comes off, no record was written.
 */
function discardEditSession() {
  if (!mapEdit.active) return;
  uninstallEditGuards();
  mapEdit.active = false;
  mapEdit.mapId = null;
  mapEdit.original = null;
  mapEdit.copy = null;
  mapEdit.baseJson = '';
  mapEdit.tool = 'select';
  mapEdit.selection = [];
  mapEdit.undo = [];
  mapEdit.dirty = false;
  mapEdit.ctx = null;
}

/**
 * Cancel / Escape: leaving edit mode with unsaved changes asks first
 * (SPEC-v5.md section 3). Confirming throws the copy away.
 */
async function confirmLeaveEditSession(ctx) {
  if (!mapEdit.active) return;
  if (!mapEdit.dirty || !ctx || typeof ctx.showConfirm !== 'function') {
    discardEditSession();
    if (ctx) ctx.render();
    return;
  }
  const leave = await ctx.showConfirm({
    title: 'Leave edit mode?',
    message: 'Your map changes are not saved yet. Leave and discard them?',
    confirmText: 'Discard changes',
    cancelText: 'Keep editing',
    danger: true,
  });
  if (!leave || !mapEdit.active) return;
  discardEditSession();
  ctx.render();
}

/**
 * Save map (SPEC-v5.md section 3): validate/round the copy, PUT the whole
 * floorMaps record on the original version (last save wins, history kept),
 * then move the affected stations off-map (boxId null — never deleted) and
 * refresh. A failed map save leaves the session open, copy untouched.
 */
async function saveEditSession(ctx) {
  if (!mapEdit.active) return;
  const data = sanitizeMapForSave(mapEdit.copy);
  const stations = stationsOfMap((ctx.state && ctx.state.floorStations) || [], mapEdit.mapId);
  const offIds = new Set(offMapStationIds(stations, data));
  try {
    await sync.saveRecord(
      'floorMaps',
      { ...data, id: mapEdit.original.id, updatedAt: ctx.nowISO() },
      mapEdit.original.version,
    );
    let movedOff = 0;
    for (const station of stations) {
      if (!offIds.has(station.id)) continue;
      const next = { ...station, boxId: null, updatedAt: ctx.nowISO() };
      delete next.pendingSync;
      try {
        await sync.saveRecord('floorStations', next, station.version);
        movedOff += 1;
      } catch (stationError) {
        // The map is saved; this station still points at a box that no longer
        // exists, which the view already treats as off-map. Keep going.
        console.error(stationError);
      }
    }
    discardEditSession();
    await ctx.refreshState();
    ctx.render();
    ctx.toast(
      movedOff > 0
        ? `Map saved. ${movedOff} station${movedOff === 1 ? '' : 's'} moved off-map (see the off-map list).`
        : 'Map saved.',
    );
  } catch (error) {
    console.error(error);
    await ctx.refreshState();
    ctx.toast('Could not save the map. Please try again.', 'warn');
  }
}

// --- page-leave guards (installed while a session is open) -------------------

function installEditGuards() {
  window.addEventListener('hashchange', onEditRouteChange);
  window.addEventListener('beforeunload', onEditBeforeUnload);
  document.addEventListener('keydown', onEditKeyDown);
}

function uninstallEditGuards() {
  window.removeEventListener('hashchange', onEditRouteChange);
  window.removeEventListener('beforeunload', onEditBeforeUnload);
  document.removeEventListener('keydown', onEditKeyDown);
}

/** Navigating off #/map with unsaved changes asks first; clean exits go silently. */
function onEditRouteChange() {
  if (!mapEdit.active) return;
  const hash = window.location.hash || '';
  if (hash === '' || hash === '#' || hash.startsWith('#/map')) return;
  const ctx = mapEdit.ctx;
  if (!ctx || !mapEdit.dirty) {
    discardEditSession();
    return;
  }
  const backTo = `#/map?map=${encodeURIComponent(mapEdit.mapId)}`;
  Promise.resolve(
    ctx.showConfirm({
      title: 'Leave the floor map?',
      message: 'Your map changes are not saved yet. Leave and discard them?',
      confirmText: 'Discard and leave',
      cancelText: 'Keep editing',
      danger: true,
    }),
  ).then((leave) => {
    if (!mapEdit.active) return;
    if (!leave) {
      // Back onto the map page: the session state is still there, editing
      // continues from the copy.
      window.location.hash = backTo;
      return;
    }
    discardEditSession();
  });
}

/** Closing/reloading the tab with unsaved changes: the browser asks. */
function onEditBeforeUnload(event) {
  if (mapEdit.active && mapEdit.dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
}

/** Ctrl+Z, Delete, arrow nudges and Escape while the canvas is open. */
function onEditKeyDown(event) {
  if (!mapEdit.active) return;
  const ctx = mapEdit.ctx;
  if (ctx && ctx.dialogOpen && ctx.dialogOpen()) return;
  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.closest('input, select, textarea') !== null || target.isContentEditable);
  if (typing) return; // typing in the panel keeps its native keys/undo
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    String(event.key).toLowerCase() === 'z'
  ) {
    event.preventDefault();
    undoEditChange();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (mapEdit.selection.length > 0) {
      event.preventDefault();
      deleteEditSelection();
    }
    return;
  }
  const step = event.shiftKey ? 10 : 1;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    nudgeEditSelection(-step, 0);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    nudgeEditSelection(step, 0);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    nudgeEditSelection(0, -step);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    nudgeEditSelection(0, step);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    confirmLeaveEditSession(ctx);
  }
}

/** Union of two ref lists by object (rubber band on top of a base selection). */
function mergeRefs(base, hits) {
  const out = [];
  const seen = new Set();
  const lists = [
    Array.isArray(base) ? base : [],
    Array.isArray(hits) ? hits : [],
  ];
  for (const ref of lists.flat()) {
    if (!ref || !ref.obj || seen.has(ref.obj)) continue;
    seen.add(ref.obj);
    out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The edit canvas page: top bar (Save/Cancel/Undo/Snap/tools), hint, the SVG
// working copy, and the selection panel (X/Y/W/H, slots, colour, label,
// Duplicate, Delete). Gestures redraw attrs live; every discrete change and
// every gesture end re-renders through ctx.render(), so nothing accumulates.
// ---------------------------------------------------------------------------

function renderMapEditor(ctx, mapRecord) {
  const { h } = ctx;
  const copy = mapEdit.copy;
  const stations = stationsOfMap(ctx.state.floorStations || [], mapEdit.mapId);

  // The zoom carries over from the view (the edit bar keeps −/+/Fit + wheel).
  if (!mapView.viewBox || mapView.mapId !== mapRecord.id) mapView.viewBox = fitViewBox(mapRecord);

  const svg = svgEl('svg', {
    class: `fm-svg fm-editing fm-tool-${mapEdit.tool}`,
    viewBox: viewBoxString(mapView.viewBox),
    preserveAspectRatio: 'xMidYMid meet',
    'aria-label': `Floor map editor: ${mapRecord.name || 'map'}`,
    tabindex: '0',
  });
  const layers = svgEl('g', { class: 'fm-edit-layers' });
  const overlay = svgEl('g', { class: 'fm-edit-overlay', 'aria-hidden': 'true' });
  svg.append(layers, overlay);

  // Occupants per box, for the dimmed station texts on the canvas (SPEC
  // section 3: stations are edited in the panel, not on the canvas — clicks
  // fall through to the box and the live colours are dimmed).
  const occupantsByBox = new Map();
  for (const station of stations) {
    if (!station.boxId) continue;
    const inner = occupantsByBox.get(station.boxId) ?? new Map();
    inner.set(Number(station.slot) || 0, station);
    occupantsByBox.set(station.boxId, inner);
  }

  // --- shape nodes (rebuilt on every render; gestures rewrite attrs) --------
  const entries = [];
  for (const fillItem of copy.fills || []) {
    const rect = svgEl('rect', { class: 'fm-edit-fill-rect' });
    rect.setAttribute(
      'fill',
      typeof fillItem.color === 'string' && fillItem.color !== '' ? fillItem.color : '#e5e7ec',
    );
    entries.push({ kind: 'fill', obj: fillItem, rect });
    layers.append(rect);
  }
  for (const corridor of copy.corridors || []) {
    const rect = svgEl('rect', { class: 'fm-edit-corridor-rect', fill: CORRIDOR_FILL });
    entries.push({ kind: 'corridor', obj: corridor, rect });
    layers.append(rect);
  }
  for (const box of copy.boxes || []) {
    const group = svgEl('g', { class: 'fm-edit-box' });
    const rect = svgEl('rect', {
      class: 'fm-edit-box-rect',
      stroke: BOX_BORDER,
      'stroke-width': '0.8',
      fill: typeof box.fill === 'string' && box.fill !== '' ? box.fill : '#ffffff',
    });
    const count = Math.max(1, Number.isInteger(box.slots) ? box.slots : 1);
    const sepLines = [];
    for (let i = 1; i < count; i += 1) sepLines.push(svgEl('line', { class: 'fm-slot-sep' }));
    const label = svgEl('text', { class: 'fm-box-label' });
    const dim = svgEl('g', { class: 'fm-edit-dim' });
    group.append(rect, ...sepLines, label, dim);
    entries.push({
      kind: 'box',
      obj: box,
      rect,
      sepLines,
      label,
      dim,
      occupants: occupantsByBox.get(box.id) || new Map(),
    });
    layers.append(group);
  }

  function syncEntry(entry) {
    const { obj } = entry;
    entry.rect.setAttribute('x', round2(obj.x));
    entry.rect.setAttribute('y', round2(obj.y));
    entry.rect.setAttribute('width', round2(obj.w));
    entry.rect.setAttribute('height', round2(obj.h));
    if (entry.kind !== 'box') return;
    const count = Math.max(1, Number.isInteger(obj.slots) ? obj.slots : 1);
    if (entry.sepLines.length === count - 1) {
      entry.sepLines.forEach((line, i) => {
        const y = round2(obj.y + (obj.h / count) * (i + 1));
        line.setAttribute('x1', round2(obj.x));
        line.setAttribute('x2', round2(obj.x + obj.w));
        line.setAttribute('y1', y);
        line.setAttribute('y2', y);
      });
    }
    const labelFit = fitText(
      obj.label || '',
      Math.max(0, obj.w - 4),
      Math.max(0, Math.min(10, obj.h)),
    );
    entry.label.replaceChildren(
      ...labelFit.lines.map((line, i) =>
        svgEl('tspan', {
          x: round2(obj.x + 2),
          y: round2(obj.y + labelFit.fontSize * (i + 1)),
          text: line,
        }),
      ),
    );
    entry.label.setAttribute('font-size', round2(labelFit.fontSize));
    const texts = [];
    for (const slot of slotRects(obj)) {
      const station = entry.occupants.get(slot.slot);
      if (station && slot.slot < count) {
        texts.push(...slotTextNodes(slot, station.code, mapView.names ? station.name : null));
      }
    }
    entry.dim.replaceChildren(...texts);
  }

  function redrawShapeNodes() {
    for (const entry of entries) syncEntry(entry);
  }

  redrawShapeNodes();

  // --- view math (preserveAspectRatio-aware client ⇄ units) ---------------
  function viewTransform() {
    const rect = svg.getBoundingClientRect();
    const view = mapView.viewBox;
    if (!rect.width || !rect.height || !view || !(view.w > 0) || !(view.h > 0)) return null;
    const scale = Math.min(rect.width / view.w, rect.height / view.h);
    if (!Number.isFinite(scale) || !(scale > 0)) return null;
    return {
      scale,
      left: rect.left + (rect.width - view.w * scale) / 2,
      top: rect.top + (rect.height - view.h * scale) / 2,
    };
  }

  function toUnits(clientX, clientY) {
    const view = mapView.viewBox;
    const t = viewTransform();
    if (!t) return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
    return { x: view.x + (clientX - t.left) / t.scale, y: view.y + (clientY - t.top) / t.scale };
  }

  /** ~7 px of grab room around a handle, in drawing units (clamped). */
  function handleUnits() {
    const t = viewTransform();
    return Math.max(1, Math.min(24, t ? 7 / t.scale : 8));
  }

  /** The drawn handle square, in drawing units (clamped sane at any zoom). */
  function handleSizeUnits() {
    const t = viewTransform();
    return Math.max(1.2, Math.min(4, t ? 5 / t.scale : 5));
  }

  function handlePoint(shape, handle) {
    const fx = handle.includes('w') ? 0 : handle.includes('e') ? 1 : 0.5;
    const fy = handle.includes('n') ? 0 : handle.includes('s') ? 1 : 0.5;
    return { x: round2(shape.x + shape.w * fx), y: round2(shape.y + shape.h * fy) };
  }

  function hitHandle(u) {
    const sel = resolveEditSelection();
    if (sel.length !== 1) return null;
    const obj = sel[0].obj;
    const threshold = handleUnits();
    let bestHandle = null;
    let bestDist = Infinity;
    for (const handle of RESIZE_HANDLES) {
      const at = handlePoint(obj, handle);
      const dist = Math.hypot(at.x - u.x, at.y - u.y);
      if (dist <= threshold && dist < bestDist) {
        bestHandle = handle;
        bestDist = dist;
      }
    }
    return bestHandle ? { handle: bestHandle, obj } : null;
  }

  // --- overlay: selection outlines, handles, band, create ghost -----------
  function buildOverlayNodes() {
    const nodes = [];
    const sel = resolveEditSelection();
    for (const { kind, obj } of sel) {
      nodes.push(
        svgEl('rect', {
          class: 'fm-selection-rect',
          'data-kind': kind,
          x: round2(obj.x),
          y: round2(obj.y),
          width: round2(obj.w),
          height: round2(obj.h),
        }),
      );
    }
    if (sel.length === 1) {
      const obj = sel[0].obj;
      const hs = handleSizeUnits();
      for (const handle of RESIZE_HANDLES) {
        const at = handlePoint(obj, handle);
        nodes.push(
          svgEl('rect', {
            class: 'fm-handle',
            'data-handle': handle,
            x: round2(at.x - hs / 2),
            y: round2(at.y - hs / 2),
            width: round2(hs),
            height: round2(hs),
          }),
        );
      }
    }
    if (gesture && gesture.type === 'band' && gesture.activated && gesture.rect) {
      nodes.push(
        svgEl('rect', {
          class: 'fm-band-rect',
          x: round2(gesture.rect.x),
          y: round2(gesture.rect.y),
          width: round2(gesture.rect.w),
          height: round2(gesture.rect.h),
        }),
      );
    }
    if (gesture && gesture.type === 'create' && gesture.activated && gesture.rect) {
      nodes.push(
        svgEl('rect', {
          class: 'fm-ghost-rect',
          x: round2(gesture.rect.x),
          y: round2(gesture.rect.y),
          width: round2(gesture.rect.w),
          height: round2(gesture.rect.h),
        }),
      );
    }
    return nodes;
  }

  function refreshOverlay() {
    overlay.replaceChildren(...buildOverlayNodes());
  }

  // --- selection panel ------------------------------------------------------
  const panelHost = h('div', { class: 'fm-edit-panel card', 'aria-label': 'Selected shape' });
  const panelInputs = {};

  function fillOptionsFor(current, { allowNone = true } = {}) {
    const options = allowNone ? [...FILL_PALETTE] : FILL_PALETTE.filter((entry) => entry.value !== '');
    const clean = typeof current === 'string' && current.trim() !== '' ? current.toLowerCase() : '';
    if (clean !== '' && !options.some((entry) => entry.value === clean)) {
      options.unshift({ value: clean, label: clean });
    }
    return options;
  }

  function kindTitle(kind, obj) {
    if (kind === 'box') return `Box ${obj.id || ''}`.trim();
    if (kind === 'corridor') return 'Aisle';
    return 'Floor patch';
  }

  function buildPanelNodes() {
    for (const key of ['x', 'y', 'w', 'h']) panelInputs[key] = null;
    const sel = resolveEditSelection();
    if (sel.length === 0) {
      return [
        h('p', { class: 'muted' }, 'Nothing selected.'),
        h(
          'p',
          { class: 'field-hint' },
          'Click a shape to select it. Shift+click adds to the selection; dragging empty floor selects everything inside the band.',
        ),
      ];
    }
    const actions = h(
      'div',
      { class: 'fm-edit-panel-actions' },
      h(
        'button',
        { class: 'btn btn-small', type: 'button', onclick: () => duplicateEditSelection() },
        'Duplicate',
      ),
      h(
        'button',
        { class: 'btn btn-danger btn-small', type: 'button', onclick: () => deleteEditSelection() },
        'Delete',
      ),
    );
    if (sel.length > 1) {
      return [
        h('h4', { class: 'fm-panel-subhead' }, `${sel.length} shapes selected`),
        actions,
        h(
          'p',
          { class: 'field-hint' },
          'Select a single shape to edit its numbers, colour and label.',
        ),
      ];
    }
    const { kind, obj } = sel[0];
    const nodes = [h('h4', { class: 'fm-panel-subhead' }, kindTitle(kind, obj))];

    const numberInput = (key, min, max) => {
      const input = h('input', {
        type: 'number',
        step: '0.5',
        min,
        max,
        value: String(roundMapNumber(obj[key])),
      });
      input.addEventListener('change', () => {
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) {
          input.value = String(roundMapNumber(obj[key]));
          return;
        }
        const low = key === 'w' || key === 'h' ? SHAPE_MIN_SIZE : min;
        editMutation(() => {
          obj[key] = Math.min(max, Math.max(low, roundMapNumber(parsed)));
        });
      });
      panelInputs[key] = input;
      return ctx.field(key.toUpperCase(), input);
    };
    nodes.push(
      numberInput('x', MAP_COORD_MIN, MAP_COORD_MAX),
      numberInput('y', MAP_COORD_MIN, MAP_COORD_MAX),
      numberInput('w', SHAPE_MIN_SIZE, MAP_COORD_MAX),
      numberInput('h', SHAPE_MIN_SIZE, MAP_COORD_MAX),
    );

    if (kind === 'box') {
      const slots = Math.min(
        BOX_SLOTS_MAX,
        Math.max(1, Number.isInteger(obj.slots) ? obj.slots : 1),
      );
      const slotsSelect = ctx.selectFrom(
        Array.from({ length: BOX_SLOTS_MAX }, (_, i) => i + 1),
        slots,
        (value) => `${value} slot${value === 1 ? '' : 's'}`,
      );
      slotsSelect.setAttribute('aria-label', 'Slots');
      slotsSelect.addEventListener('change', () => {
        const value = Math.min(BOX_SLOTS_MAX, Math.max(1, Number(slotsSelect.value) || 1));
        editMutation(() => {
          obj.slots = value;
        });
      });
      nodes.push(ctx.field('Slots', slotsSelect, 'Stations stacked top to bottom'));

      const fillSelect = h(
        'select',
        { 'aria-label': 'Fill colour' },
        ...fillOptionsFor(obj.fill).map((entry) =>
          h('option', { value: entry.value }, entry.label),
        ),
      );
      fillSelect.value = typeof obj.fill === 'string' && obj.fill !== '' ? obj.fill.toLowerCase() : '';
      fillSelect.addEventListener('change', () => {
        editMutation(() => {
          obj.fill = fillSelect.value === '' ? null : fillSelect.value;
        });
      });
      nodes.push(ctx.field('Fill', fillSelect));

      const labelInput = h('input', { type: 'text', maxlength: 60, value: String(obj.label || '') });
      labelInput.addEventListener('change', () => {
        editMutation(() => {
          obj.label = labelInput.value.slice(0, 60);
        });
      });
      nodes.push(ctx.field('Label', labelInput));
    } else if (kind === 'fill') {
      const colorSelect = h(
        'select',
        { 'aria-label': 'Patch colour' },
        ...fillOptionsFor(obj.color, { allowNone: false }).map((entry) =>
          h('option', { value: entry.value }, entry.label),
        ),
      );
      colorSelect.value = typeof obj.color === 'string' ? obj.color.toLowerCase() : '#e5e7ec';
      colorSelect.addEventListener('change', () => {
        editMutation(() => {
          obj.color = colorSelect.value || '#e5e7ec';
        });
      });
      nodes.push(ctx.field('Colour', colorSelect));
    } else {
      nodes.push(h('p', { class: 'field-hint' }, 'An aisle: always painted corridor blue.'));
    }
    nodes.push(actions);
    return nodes;
  }

  panelHost.append(...buildPanelNodes());

  function refreshPanelNumbers() {
    const sel = resolveEditSelection();
    if (sel.length !== 1) return;
    const { obj } = sel[0];
    for (const key of ['x', 'y', 'w', 'h']) {
      const input = panelInputs[key];
      if (!input || document.activeElement === input) continue;
      input.value = String(roundMapNumber(obj[key]));
    }
  }

  // --- zoom (the edit bar keeps −/+/Fit; the wheel zooms at the pointer) ----
  function applyView() {
    svg.setAttribute('viewBox', viewBoxString(mapView.viewBox));
  }
  attachMiddlePan(svg, applyView, (view) => clampViewBox(view, copy.width, copy.height));

  function zoomAtClient(clientX, clientY, factor) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    mapView.viewBox = clampViewBox(
      zoomViewBox(mapView.viewBox, copy.width, copy.height, factor, fx, fy),
      copy.width,
      copy.height,
    );
    applyView();
  }

  function zoomCentre(factor) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      mapView.viewBox = clampViewBox(
        zoomViewBox(mapView.viewBox, copy.width, copy.height, factor),
        copy.width,
        copy.height,
      );
      applyView();
      return;
    }
    zoomAtClient(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoomAtClient(event.clientX, event.clientY, event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP);
    },
    { passive: false },
  );

  // --- gestures --------------------------------------------------------------
  const pointers = new Set();
  let gesture = null;
  let lastCreate = null;

  function boxIds() {
    return (copy.boxes || []).map((box) => box && box.id);
  }

  function sameSpotCreate(event) {
    return (
      Boolean(lastCreate) &&
      Date.now() - lastCreate.at < CREATE_DOUBLE_MS &&
      Math.hypot(event.clientX - lastCreate.x, event.clientY - lastCreate.y) < 6
    );
  }

  /** The create rectangle between the (snapped) anchor and the pointer. */
  function rectForCreate(startUnits, u) {
    const clean = mapEdit.snap ? snap : roundMapNumber;
    return rubberBandRect(startUnits.x, startUnits.y, clean(u.x), clean(u.y));
  }

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') return;
    if (gesture) return; // one pointer at a time; no pinch in the canvas
    const u = toUnits(event.clientX, event.clientY);
    pointers.add(event.pointerId);
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Capture is a nicety; the listeners below still work without it.
    }
    const startClient = { x: event.clientX, y: event.clientY };
    const tool = mapEdit.tool;

    if (tool === 'select') {
      const grabHandle = hitHandle(u);
      if (grabHandle) {
        const { obj } = grabHandle;
        gesture = {
          type: 'resize',
          pointerId: event.pointerId,
          handle: grabHandle.handle,
          obj,
          starts: { x: obj.x, y: obj.y, w: obj.w, h: obj.h },
          startUnits: u,
          startClient,
          pending: snapshotCopy(),
          activated: false,
        };
        return;
      }
      const hit = hitTest(copy, u.x, u.y);
      if (hit && hit.shape) {
        // Click selects; Shift+click adds (or removes an already-selected one).
        const already = mapEdit.selection.some((ref) => ref && ref.obj === hit.shape);
        if (already && event.shiftKey) {
          mapEdit.selection = mapEdit.selection.filter((ref) => ref.obj !== hit.shape);
        } else if (!already) {
          mapEdit.selection = event.shiftKey
            ? [...mapEdit.selection, { kind: hit.kind, obj: hit.shape }]
            : [{ kind: hit.kind, obj: hit.shape }];
        }
        refreshOverlay();
        gesture = {
          type: 'move',
          pointerId: event.pointerId,
          startUnits: u,
          startClient,
          grabs: mapEdit.selection.map(({ obj }) => ({ obj, x: obj.x, y: obj.y })),
          pending: snapshotCopy(),
          activated: false,
        };
        return;
      }
      // Dragging empty floor rubber-bands (SPEC section 3); Shift keeps the
      // current selection under the band.
      gesture = {
        type: 'band',
        pointerId: event.pointerId,
        startUnits: u,
        startClient,
        base: event.shiftKey ? mapEdit.selection.slice() : [],
        activated: false,
        rect: null,
      };
      return;
    }

    // Create tools: a plain click drops the default size (spec section 3); a
    // double-click must not drop two.
    if (sameSpotCreate(event)) return;
    const start = {
      x: mapEdit.snap ? snap(u.x) : roundMapNumber(u.x),
      y: mapEdit.snap ? snap(u.y) : roundMapNumber(u.y),
    };
    gesture = {
      type: 'create',
      kind: tool,
      pointerId: event.pointerId,
      startUnits: start,
      startClient,
      pending: snapshotCopy(),
      activated: false,
      rect: null,
    };
  });

  svg.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const u = toUnits(event.clientX, event.clientY);
    if (!gesture.activated) {
      const distPx = Math.hypot(
        event.clientX - gesture.startClient.x,
        event.clientY - gesture.startClient.y,
      );
      if (distPx <= CLICK_SLOP_PX) return;
      gesture.activated = true;
      if (gesture.pending) {
        // First real movement: this gesture becomes one undo step.
        mapEdit.undo = pushUndoSnapshot(mapEdit.undo, gesture.pending);
        gesture.pending = null;
      }
    }
    const dxu = u.x - gesture.startUnits.x;
    const dyu = u.y - gesture.startUnits.y;
    if (gesture.type === 'move') {
      // Snap the delta off the anchor grab so a multi-selection keeps its
      // inner layout while the destination lands on the grid.
      const anchor = gesture.grabs[0];
      if (!anchor) return;
      const moved = moveShape({ x: anchor.x, y: anchor.y }, dxu, dyu, { snapOn: mapEdit.snap });
      const dx = moved.x - anchor.x;
      const dy = moved.y - anchor.y;
      for (const grab of gesture.grabs) {
        grab.obj.x = roundMapNumber(grab.x + dx);
        grab.obj.y = roundMapNumber(grab.y + dy);
      }
      redrawShapeNodes();
      refreshOverlay();
      refreshPanelNumbers();
    } else if (gesture.type === 'resize') {
      const next = resizeShape(gesture.starts, gesture.handle, dxu, dyu, {
        snapOn: mapEdit.snap,
      });
      gesture.obj.x = next.x;
      gesture.obj.y = next.y;
      gesture.obj.w = next.w;
      gesture.obj.h = next.h;
      redrawShapeNodes();
      refreshOverlay();
      refreshPanelNumbers();
    } else if (gesture.type === 'band') {
      gesture.rect = rubberBandRect(gesture.startUnits.x, gesture.startUnits.y, u.x, u.y);
      const hits = [];
      for (const kind of SHAPE_KIND_LIST) {
        for (const obj of editShapesOf(kind)) {
          if (rectIntersectsShape(gesture.rect, obj)) hits.push({ kind, obj });
        }
      }
      mapEdit.selection = mergeRefs(gesture.base, hits);
      refreshOverlay();
    } else if (gesture.type === 'create') {
      gesture.rect = rectForCreate(gesture.startUnits, u);
      refreshOverlay();
    }
  });

  svg.addEventListener('pointerup', (event) => {
    pointers.delete(event.pointerId);
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    if (g.type === 'create') {
      if (g.activated && g.rect && g.rect.w >= SHAPE_MIN_SIZE && g.rect.h >= SHAPE_MIN_SIZE) {
        const rect = g.rect;
        // The snapshot pushed at drag start is this step's undo entry.
        editMutation(
          () => {
            const shape = createShapeFromRect(g.kind, rect, boxIds());
            if (shape) {
              editShapesOf(g.kind).push(shape);
              mapEdit.selection = [{ kind: g.kind, obj: shape }];
            }
          },
          { pushUndo: false },
        );
      } else {
        // A plain click drops the default size at the snapped anchor.
        const at = { x: g.startUnits.x, y: g.startUnits.y };
        editMutation(() => {
          const shape = createShapeFromRect(g.kind, defaultShapeRect(g.kind, at.x, at.y), boxIds());
          if (shape) {
            editShapesOf(g.kind).push(shape);
            mapEdit.selection = [{ kind: g.kind, obj: shape }];
          }
        });
        lastCreate = { x: g.startClient.x, y: g.startClient.y, at: Date.now() };
      }
      return;
    }
    // move / resize / band: the undo snapshot went on at drag start; band only
    // previewed the selection. Re-check dirty (or Save stays disabled after a
    // plain move) and re-render so panel and buttons catch up.
    recomputeEditDirty();
    ctx.render();
  });

  svg.addEventListener('pointercancel', (event) => {
    pointers.delete(event.pointerId);
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const g = gesture;
    gesture = null;
    if ((g.type === 'move' || g.type === 'resize') && g.activated) {
      undoEditChange(); // restores the pre-gesture snapshot
      return;
    }
    if (g.type === 'band') {
      mapEdit.selection = g.base.filter(
        (ref) => ref && ref.obj && editShapesOf(ref.kind).includes(ref.obj),
      );
    }
    ctx.render();
  });

  // --- top bar ---------------------------------------------------------------
  const saveButton = h(
    'button',
    {
      class: 'btn btn-primary btn-small',
      type: 'button',
      disabled: !mapEdit.dirty,
      title: mapEdit.dirty ? 'Save the whole floor layout' : 'No changes to save',
      onclick: () => saveEditSession(ctx),
    },
    'Save map',
  );
  const cancelButton = h(
    'button',
    {
      class: 'btn btn-small',
      type: 'button',
      onclick: () => confirmLeaveEditSession(ctx),
    },
    'Cancel',
  );
  const undoButton = h(
    'button',
    {
      class: 'btn btn-small',
      type: 'button',
      disabled: mapEdit.undo.length === 0,
      'aria-label': 'Undo the last step (Ctrl+Z)',
      onclick: () => undoEditChange(),
    },
    `Undo (${mapEdit.undo.length})`,
  );
  const snapButton = h(
    'button',
    {
      class: `btn btn-small${mapEdit.snap ? ' is-active' : ''}`,
      type: 'button',
      'aria-pressed': mapEdit.snap ? 'true' : 'false',
      title: 'Snap to the 2-unit grid while moving and resizing',
      onclick: () => {
        mapEdit.snap = !mapEdit.snap;
        snapButton.classList.toggle('is-active', mapEdit.snap);
        snapButton.setAttribute('aria-pressed', String(mapEdit.snap));
      },
    },
    'Snap',
  );

  function toolHint(tool) {
    if (tool === 'select') {
      return 'Drag to move · drag empty floor to band-select · Shift+click adds · arrows nudge (Shift = 10) · Ctrl+Z undo · Delete removes';
    }
    if (tool === 'box') return 'Drag a rectangle for the new box, or plain-click for the default 45 × 28.';
    if (tool === 'corridor') return 'Drag a rectangle for the new aisle, or plain-click for the default 5 × 60.';
    return 'Drag a rectangle for the floor patch, or plain-click for the default 24 × 24.';
  }

  const hint = h('p', { class: 'field-hint fm-edit-hint', role: 'status' }, toolHint(mapEdit.tool));

  const toolButtons = EDIT_TOOLS.map((tool) =>
    h(
      'button',
      {
        class: `btn btn-small${mapEdit.tool === tool.key ? ' is-active' : ''}`,
        type: 'button',
        'aria-pressed': mapEdit.tool === tool.key ? 'true' : 'false',
        dataset: { tool: tool.key },
        onclick: () => {
          mapEdit.tool = tool.key;
          svg.setAttribute('class', `fm-svg fm-editing fm-tool-${tool.key}`);
          hint.textContent = toolHint(tool.key);
          for (const button of toolButtons) {
            const active = button.dataset.tool === tool.key;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
          }
        },
      },
      tool.label,
    ),
  );

  const zoomButtons = h(
    'div',
    { class: 'fm-zoom' },
    h(
      'button',
      { class: 'btn btn-small', type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomCentre(1 / ZOOM_STEP) },
      '−',
    ),
    h(
      'button',
      { class: 'btn btn-small', type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomCentre(ZOOM_STEP) },
      '+',
    ),
    h(
      'button',
      {
        class: 'btn btn-small',
        type: 'button',
        onclick: () => {
          mapView.viewBox = fitViewBox(copy);
          applyView();
        },
      },
      'Fit',
    ),
  );

  refreshOverlay();
  applyView();

  return ctx.page(
    ctx.pageHead('Floor map'),
    h(
      'div',
      { class: 'fm-edit-topbar' },
      h('span', { class: 'fm-edit-title' }, `Editing ${mapRecord.name || 'this floor'}`),
      saveButton,
      cancelButton,
      undoButton,
      snapButton,
      h(
        'div',
        { class: 'fm-edit-tools', role: 'group', 'aria-label': 'Canvas tools' },
        ...toolButtons,
      ),
      zoomButtons,
    ),
    hint,
    h(
      'div',
      { class: 'fm-edit-wrap' },
      h('div', { class: 'fm-svg-wrap fm-edit-canvas' }, svg),
      panelHost,
    ),
    h(
      'p',
      { class: 'field-hint fm-edit-note' },
      'Deleting a box — or giving it fewer slots than it holds — never deletes stations: they move to the off-map list when you save.',
    ),
  );
}