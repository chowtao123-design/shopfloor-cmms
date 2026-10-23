'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ApiError, UUID_RE } from './records.js';

/**
 * Uploaded photos, manuals and reports (SPEC-v3.md section 6; PDF limits
 * raised in SPEC-v4.md section 4.2).
 *
 * POST /api/files sends the raw file as the request body with `Content-Type`
 * and a URL-encoded `X-File-Name` header. Only jpeg/png/webp/pdf are allowed,
 * and the magic bytes must match the declared type. Images are at most
 * 15 MB (buffered); PDFs stream to a temp file at up to 50 MB. Bytes are
 * stored as DATA_DIR/files/<uuid> plus a `files` table row; GET /api/files/:id
 * streams them with nosniff, a sandbox CSP and an inline disposition. Ids are
 * UUIDs only; there is no directory listing.
 */

export const FILE_MAX_BYTES = 15 * 1024 * 1024;
// v4 (SPEC-v4.md section 4.2): PDFs (manuals) may be 50 MB; images stay 15 MB.
export const PDF_MAX_BYTES = 50 * 1024 * 1024;
export const ALLOWED_FILE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
export const MAX_FILE_NAME_CHARS = 200;

/** Security headers for streamed file responses (CSP is `sandbox` here). */
export const FILE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': 'sandbox',
};

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Content-Type without parameters, lowercased, or null when absent. */
export function parseContentType(header) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  return header.split(';')[0].trim().toLowerCase();
}

const startsWith = (buf, bytes, offset = 0) => bytes.every((byte, index) => buf[offset + index] === byte);

/** True when the buffer's magic bytes match the declared MIME type. */
export function matchesMime(buffer, mime) {
  if (!Buffer.isBuffer(buffer)) return false;
  switch (mime) {
    case 'image/jpeg':
      return buffer.length >= 3 && startsWith(buffer, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return (
        buffer.length >= 8 &&
        startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    case 'image/webp':
      // RIFF....WEBP
      return (
        buffer.length >= 12 &&
        startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case 'application/pdf':
      // %PDF-
      return buffer.length >= 5 && startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    default:
      return false;
  }
}

/**
 * Read the whole request body as a Buffer, rejecting anything above
 * `limitBytes` with 413 (draining the oversized body we are refusing).
 */
export function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limitBytes) {
      req.resume();
      reject(
        new ApiError(413, 'payload_too_large', `Request body exceeds the ${formatBytes(limitBytes)} limit`)
      );
      return;
    }
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limitBytes) {
        fail(new ApiError(413, 'payload_too_large', `Request body exceeds the ${formatBytes(limitBytes)} limit`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(err));
  });
}

/** Decode and check the URL-encoded X-File-Name header. */
export function readFileName(header) {
  if (header === undefined || header === '') {
    throw new ApiError(400, 'bad_request', 'The X-File-Name header is required (URL-encoded)');
  }
  if (typeof header !== 'string') {
    throw new ApiError(400, 'bad_request', 'The X-File-Name header must be a string');
  }
  let decoded;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    throw new ApiError(400, 'bad_request', 'The X-File-Name header is not valid URL encoding');
  }
  decoded = decoded.trim();
  if (decoded === '') {
    throw new ApiError(400, 'bad_request', 'The X-File-Name header must not be empty');
  }
  if (decoded.length > MAX_FILE_NAME_CHARS) {
    throw new ApiError(400, 'bad_request', `The X-File-Name header must be at most ${MAX_FILE_NAME_CHARS} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(decoded) || /[\\/]/.test(decoded)) {
    throw new ApiError(
      400,
      'bad_request',
      'The X-File-Name header may not contain path separators or control characters'
    );
  }
  return decoded;
}

/**
 * Validate and store one uploaded file (SPEC-v3.md section 6): check the
 * declared Content-Type against `allowedMimes`, read at most `limitBytes`,
 * check the magic bytes, then store the bytes as DATA_DIR/files/&lt;uuid&gt;
 * with a `files` table row. Returns the API shape {fileId, name, mime, size}.
 *
 * v4 (SPEC-v4.md section 4.2): `application/pdf` streams to a temp file under
 * DATA_DIR/files with the raised 50 MB PDF limit (the magic bytes come from
 * the first chunk), so a manual is never buffered whole in memory; on any
 * error the temp file is deleted. Images keep the buffered 15 MB path.
 */
export async function createUploadedFile(
  store,
  dataDir,
  req,
  { uploadedBy = null, limitBytes = FILE_MAX_BYTES, allowedMimes = ALLOWED_FILE_MIME } = {}
) {
  const mime = parseContentType(req.headers['content-type']);
  if (mime === null || !allowedMimes.includes(mime)) {
    throw new ApiError(
      415,
      'unsupported_media_type',
      `Content-Type must be one of ${allowedMimes.join(', ')}`
    );
  }
  const name = readFileName(req.headers['x-file-name']);
  if (mime === 'application/pdf') {
    return streamPdfToDisk(store, dataDir, req, { name, mime, uploadedBy, limitBytes });
  }
  const buffer = await readRawBody(req, Math.min(limitBytes, PDF_MAX_BYTES));
  if (!matchesMime(buffer, mime)) {
    throw new ApiError(
      415,
      'unsupported_media_type',
      'The file contents do not match the declared Content-Type'
    );
  }
  return createFileRecord(store, dataDir, { name, mime, buffer, uploadedBy });
}

/**
 * Stream one PDF upload to DATA_DIR/files/.tmp-&lt;uuid&gt;: bytes are counted
 * (413 past the limit), hashed and written incrementally, the magic bytes
 * come from the first chunk, and the temp file is renamed into place on
 * success. Any error (limit, magic, stream, disk) deletes the temp file.
 */
function streamPdfToDisk(store, dataDir, req, { name, mime, uploadedBy, limitBytes }) {
  // Default the PDF limit to the raised 50 MB (SPEC-v4.md 4.2); an explicitly
  // tighter caller limit still wins.
  const limit = limitBytes < FILE_MAX_BYTES ? limitBytes : PDF_MAX_BYTES;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(
        new ApiError(413, 'payload_too_large', `Request body exceeds the ${formatBytes(limit)} limit`)
      );
      return;
    }
    const id = crypto.randomUUID();
    const filesDir = path.join(dataDir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    const tempPath = path.join(filesDir, `.tmp-${id}`);
    const finalPath = path.join(filesDir, id);
    const hash = crypto.createHash('sha256');
    let fd = null;
    let total = 0;
    let head = Buffer.alloc(0);
    let done = false;
    const settleError = (err) => {
      if (done) return;
      done = true;
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
        fd = null;
      }
      try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
      reject(err);
    };
    try {
      fd = fs.openSync(tempPath, 'wx', 0o600);
    } catch (err) {
      settleError(err);
      return;
    }
    req.on('data', (chunk) => {
      if (done) return;
      try {
        if (head.length < 5) {
          head = Buffer.concat([head, chunk.subarray(0, 5 - head.length)]);
          if (head.length === 5 && !matchesMime(head, mime)) {
            throw new ApiError(
              415,
              'unsupported_media_type',
              'The file contents do not match the declared Content-Type'
            );
          }
        }
        total += chunk.length;
        if (total > limit) {
          throw new ApiError(
            413,
            'payload_too_large',
            `Request body exceeds the ${formatBytes(limit)} limit`
          );
        }
        hash.update(chunk);
        fs.writeSync(fd, chunk);
      } catch (err) {
        settleError(err);
      }
    });
    req.on('end', () => {
      if (done) return;
      try {
        if (!matchesMime(head, mime)) {
          throw new ApiError(
            415,
            'unsupported_media_type',
            'The file contents do not match the declared Content-Type'
          );
        }
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tempPath, finalPath);
        done = true;
        try {
          const row = store.insertFile({
            id,
            name,
            mime,
            size: total,
            sha256: hash.digest('hex'),
            uploadedBy,
            uploadedAt: new Date().toISOString(),
          });
          resolve({ fileId: row.id, name: row.name, mime: row.mime, size: Number(row.size) });
        } catch (err) {
          // The bytes landed but the row did not: leave no half upload.
          try { fs.rmSync(finalPath, { force: true }); } catch { /* best effort */ }
          throw err;
        }
      } catch (err) {
        settleError(err);
      }
    });
    req.on('error', (err) => settleError(err));
  });
}

/** Write the bytes and insert the `files` row; returns {fileId, name, mime, size}. */
export function createFileRecord(store, dataDir, { name, mime, buffer, uploadedBy = null }) {
  const id = crypto.randomUUID();
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.writeFileSync(path.join(filesDir, id), buffer);
  const row = store.insertFile({
    id,
    name,
    mime,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    uploadedBy,
    uploadedAt: new Date().toISOString(),
  });
  return { fileId: row.id, name: row.name, mime: row.mime, size: Number(row.size) };
}

/** One `files` row for an id that must be a UUID, or null. */
export function findFileById(store, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return store.getFileById(id);
}

/** Delete a file's row and (best-effort, logged) its bytes. */
export function removeFileRecord(store, dataDir, fileId) {
  store.deleteFileById(fileId);
  try {
    fs.rmSync(path.join(dataDir, 'files', fileId), { force: true });
  } catch (err) {
    console.error(`[maint-log] could not delete stored file ${fileId}:`, err && err.message ? err.message : err);
  }
}

/** Printable, quote-free, path-free fallback-safe filename for dispositions. */
export function safeFileName(name) {
  const base = String(name === null || name === undefined ? '' : name).split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\;]/g, '')
    .trim();
  return cleaned === '' ? 'file' : cleaned;
}

/**
 * Stream one stored file: stored mime, nosniff, CSP sandbox, inline
 * Content-Disposition with a safe filename (SPEC-v3.md section 6).
 */
export function streamStoredFile(req, res, row, dataDir) {
  const filePath = path.join(dataDir, 'files', row.id);
  let stat = null;
  try {
    const checked = fs.statSync(filePath);
    if (checked.isFile()) stat = checked;
  } catch {
    stat = null;
  }
  if (stat === null) {
    throw new ApiError(404, 'not_found', 'No such file');
  }
  res.writeHead(200, {
    ...FILE_HEADERS,
    'Content-Type': row.mime,
    'Content-Length': String(stat.size),
    'Content-Disposition': `inline; filename="${safeFileName(row.name)}"`,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const source = fs.createReadStream(filePath);
  source.on('error', (err) => res.destroy(err));
  source.pipe(res);
}