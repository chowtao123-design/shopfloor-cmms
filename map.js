// Floor map view (V5-M2, SPEC-v5.md section 2): inline SVG of the imported
// layout with live machine state from logic-map.js, toolbar (search, filter
// chips, zoom −/+/Fit, Show names), pan & zoom, the station panel (desktop
// side drawer, phone bottom sheet), the off-map station list and the empty
// state that explains the admin import (section 4). The edit canvas is
// V5-M3 and is not part of this view.
//
// Pure view-box math, the filter predicate and the legend counts are
// exported for tests/v5m2.test.js; nothing DOM-shaped runs at import time so
// the module also loads under node --test. The DOM helpers (h, field, toast,
// can, …) come in through the render context app.js passes to
// renderMapPage(); every SVG node is created with createElementNS (never
// innerHTML with user text), and every node the phone sheet adds to the
// page is removed again on close.

import { fitText, searchStations, slotRects, stationState } from './logic-map.js';
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
  return { x: 0, y: 0, w, h };
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
function slotTextNodes(rect, code, name) {
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
    const fit = fitText(text, innerW, budget);
    const size = Math.max(1, fit.fontSize);
    for (const line of fit.lines) {
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

  const map = activeMap(maps, route);
  if (mapView.mapId !== map.id) {
    // New floor: the zoom of another map means nothing here.
    mapView.mapId = map.id;
    mapView.viewBox = fitViewBox(map);
    mapView.pickStationId = null;
  }
  if (!mapView.viewBox) mapView.viewBox = fitViewBox(map);

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
        layers.append(emptySlotNode(rect, box.id, rect.slot, Boolean(mapView.pickStationId)));
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
    if (!station) return;
    event.preventDefault();
    cancelClick();
    showStationPanel(ctx, station);
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

  const svgWrap = h('div', { class: 'fm-svg-wrap' }, svg);

  return ctx.page(
    ctx.pageHead('Floor map'),
    h(
      'div',
      { class: 'fm-toolbar' },
      searchInput,
      searchStatus,
      chipBar,
      h('div', { class: 'fm-zoom' }, zoomOut, zoomIn, zoomFit),
      namesToggle,
      mapSelect,
    ),
    hintBar,
    legend,
    svgWrap,
    offMapList,
  );
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

/** An empty slot: faint, dashed, clickable only in pick mode. */
function emptySlotNode(rect, boxId, slot, picking) {
  return svgEl('g', {
    class: `fm-slot-empty${picking ? ' fm-slot-pick' : ''}`,
    'data-box': boxId,
    'data-slot': String(slot),
    'aria-hidden': 'true',
  }, [
    svgEl('rect', {
      class: 'fm-slot-empty-rect',
      x: round2(rect.x),
      y: round2(rect.y),
      width: round2(rect.w),
      height: round2(rect.h),
    }),
  ]);
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

/** Show the station panel: drawer on desktop, bottom sheet on the phone. */
function showStationPanel(ctx, station) {
  if (!station) return;
  const { body } = stationPanelBody(ctx, station);
  if (ctx.desktopMedia.matches) {
    ctx.openDrawer({ title: station.code || 'Station', content: body });
  } else {
    openStationSheet(ctx, station, body);
  }
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