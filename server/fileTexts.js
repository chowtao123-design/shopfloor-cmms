'use strict';

import fs from 'node:fs';
import path from 'node:path';

import { extractPdfText } from './pdfText.js';

/**
 * Background PDF text extraction (SPEC-v4.md section 4.2).
 *
 * After a PDF upload and at startup (for PDFs whose file_texts row is
 * missing or still 'pending'), the text is extracted into `file_texts`.
 * Work happens one file at a time inside a per-store queue that runs on
 * `setImmediate` ticks, so no HTTP request ever waits for an extraction,
 * and the upload response always goes out first.
 */

const PDF_MIME = 'application/pdf';
const PENDING = 'pending';

/** Per-store queue state (WeakMap: dies with the store handle). */
const queues = new WeakMap();

function stateFor(store) {
  let state = queues.get(store);
  if (state === undefined) {
    state = { pending: [], running: false, stopped: false };
    queues.set(store, state);
  }
  return state;
}

/** Extract one file's text into file_texts; any failure becomes 'error'. */
function extractOne(store, fileId) {
  const row = store.getFileById(fileId);
  if (row === null || row.mime !== PDF_MIME) return;
  const existing = store.getFileText(fileId);
  if (existing !== null && existing.status !== PENDING) return;
  let result;
  try {
    result = extractPdfText(fs.readFileSync(path.join(store.dataDir, 'files', fileId)));
  } catch {
    result = { status: 'error', pages: [], chars: 0 };
  }
  store.upsertFileText({
    fileId,
    status: result.status,
    pages: result.pages,
    chars: result.chars,
    extractedAt: new Date().toISOString(),
  });
}

function pump(store) {
  const state = stateFor(store);
  if (state.running || state.stopped) return;
  state.running = true;
  const step = () => {
    if (state.stopped) {
      state.running = false;
      state.pending.length = 0;
      return;
    }
    const fileId = state.pending.shift();
    if (fileId === undefined) {
      state.running = false;
      return;
    }
    setImmediate(() => {
      let error = null;
      try {
        extractOne(store, fileId);
      } catch (err) {
        error = err; // a closed store or a bad row never stops the queue
      }
      if (error !== null) {
        console.error('[maint-log] PDF text extraction failed:', error && error.message ? error.message : error);
      }
      step();
    });
  };
  step();
}

function enqueue(store, fileId) {
  const state = stateFor(store);
  if (state.stopped) return;
  if (!state.pending.includes(fileId)) state.pending.push(fileId);
  pump(store);
}

/**
 * Queue one PDF for background extraction right after its upload: a
 * 'pending' row is written (so the status route answers 'pending' and a
 * restart re-queues it), then the file joins the store's queue.
 */
export function scheduleFileTextExtraction(store, fileId) {
  if (typeof fileId !== 'string' || fileId === '') return;
  try {
    const row = store.getFileById(fileId);
    if (row === null || row.mime !== PDF_MIME) return;
    const existing = store.getFileText(fileId);
    if (existing === null) {
      store.upsertFileText({ fileId, status: PENDING, pages: [], chars: 0, extractedAt: null });
    } else if (existing.status !== PENDING) {
      return;
    }
  } catch (err) {
    console.error('[maint-log] could not queue PDF text extraction:', err && err.message ? err.message : err);
    return;
  }
  enqueue(store, fileId);
}

/**
 * Startup sweep (SPEC-v4.md section 4.2): queue every PDF that has no
 * file_texts row yet (or one still 'pending' from an interrupted run),
 * oldest upload first. Returns the handle the server stops on shutdown.
 */
export function startTextExtractionQueue(store) {
  const state = stateFor(store);
  state.stopped = false;
  state.pending.length = 0;
  try {
    for (const row of store.listFilesNeedingText()) {
      if (state.pending.includes(row.id)) continue;
      state.pending.push(row.id);
    }
  } catch (err) {
    console.error('[maint-log] could not list PDFs for text extraction:', err && err.message ? err.message : err);
  }
  pump(store);
  return {
    get stopped() {
      return state.stopped;
    },
    stop() {
      state.stopped = true;
      state.pending.length = 0;
    },
  };
}