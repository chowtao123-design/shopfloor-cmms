// WPFI safety inspections (Google Form → Google Sheet). The server downloads
// the sheet's CSV export once a week (and on "Refresh now"), keeps it in
// DATA_DIR/wpfi.json, and serves it to floor-map readers. The sheet link is
// private (local-config.json wpfiCsvUrl, or the WPFI_CSV_URL variable). Each sheet row is
// one finding: a worker who failed the check, with what was wrong.

import fs from 'node:fs';
import path from 'node:path';


export const WPFI_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const MAX_BYTES = 5 * 1024 * 1024;

const cacheFile = (dataDir) => path.join(dataDir, 'wpfi.json');

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** "2026/1/15" or "2026/1/15 下午 3:55:24" → "2026-01-15"; anything else → null. */
export function isoDate(value) {
  const match = /^\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(value ?? ''));
  if (!match) return null;
  const [, y, m, d] = match;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * Sheet rows → findings. Columns are found by header text so a reordered
 * form still works: timestamp, Date (back-filled), Station No., Worker ID,
 * Worker Name, Improvement Areas, Inspector's Name. Empty rows are dropped;
 * the inspection date is the Date column, else the timestamp's day.
 */
export function wpfiRecords(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const header = rows[0].map((cell) => String(cell).toLowerCase());
  const col = (...needles) => header.findIndex((cell) => needles.some((needle) => cell.includes(needle)));
  const c = {
    stamp: 0,
    date: col('date'),
    station: col('station'),
    workerId: col('worker id'),
    workerName: col('worker name'),
    issue: col('improvement', 'remove'),
    inspector: col('inspector'),
  };
  const get = (row, index) => (index >= 0 ? String(row[index] ?? '').trim() : '');
  const out = [];
  for (const row of rows.slice(1)) {
    const date = isoDate(get(row, c.date)) || isoDate(get(row, c.stamp));
    const record = {
      date,
      station: get(row, c.station),
      workerId: get(row, c.workerId),
      workerName: get(row, c.workerName),
      issue: get(row, c.issue),
      inspector: get(row, c.inspector),
    };
    if (!date || (!record.workerId && !record.station && !record.workerName)) continue;
    out.push(record);
  }
  return out;
}

/** The cached download, or an empty list before the first one. */
export function readWpfi(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(dataDir), 'utf8'));
  } catch {
    return { fetchedAt: null, records: [], error: null };
  }
}

/**
 * Download the sheet now and replace the cache. A failed download keeps the
 * last good records and notes the error, so the page never goes blank.
 */
export async function refreshWpfi(dataDir, url, fetchImpl = fetch) {
  const previous = readWpfi(dataDir);
  let next;
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error('the sheet is larger than 5 MB');
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw new Error('got a web page instead of CSV: is the sheet shared as "Anyone with the link"?');
    }
    next = { fetchedAt: new Date().toISOString(), records: wpfiRecords(parseCsv(text)), error: null };
  } catch (error) {
    next = { ...previous, error: `${new Date().toISOString()}: ${error.message}` };
    console.error(`[wpfi] sheet download failed: ${error.message}`);
  }
  const file = cacheFile(dataDir);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
  fs.renameSync(`${file}.tmp`, file);
  return next;
}

/** Weekly refresh: at start when the cache is a week old (or missing), then checked hourly. */
export function startWpfiSchedule({ dataDir, url }) {
  if (!url) {
    console.log('[wpfi] no sheet link set (local-config.json wpfiCsvUrl): the Safety (WPFI) page stays empty');
    return { stop: () => {} };
  }
  const due = () => {
    const { fetchedAt } = readWpfi(dataDir);
    return !fetchedAt || Date.now() - Date.parse(fetchedAt) >= WPFI_REFRESH_MS;
  };
  const tick = () => {
    if (due()) refreshWpfi(dataDir, url).catch((error) => console.error('[wpfi]', error));
  };
  tick();
  const timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
