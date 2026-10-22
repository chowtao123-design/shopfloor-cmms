'use strict';

import { ApiError } from './records.js';
import {
  ALLOWED_FILE_MIME,
  createFileRecord,
  findFileById,
  matchesMime,
  parseContentType,
  readRawBody,
  removeFileRecord,
} from './files.js';

/**
 * Branding settings (SPEC-v3.md sections 1 and 8): admin-settable app name
 * (1–40 chars) and logo, both stored server-side in the `settings` table.
 * GET /api/branding is public (the login screen needs it before sign-in) and
 * returns {name, logoUrl, version}; the logo is stored like an uploaded file
 * (SPEC-v3.md section 6) and served from /api/branding/logo. Only
 * PNG/JPEG/WebP are allowed (no SVG), at most 512 KB.
 */

export const DEFAULT_BRAND_NAME = 'Shopfloor CMMS';
export const BRAND_NAME_MIN = 1;
export const BRAND_NAME_MAX = 40;
export const LOGO_MAX_BYTES = 512 * 1024;
export const ALLOWED_LOGO_MIME = ALLOWED_FILE_MIME.filter((mime) => mime !== 'application/pdf');
export const BRAND_NAME_KEY = 'branding.name';
export const BRAND_LOGO_KEY = 'branding.logoFileId';

const LOGO_EXTENSION = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/** Current branding payload; `version` is the server version. */
export function brandingPayload(store, version) {
  const stored = store.getSetting(BRAND_NAME_KEY);
  const name = stored === null ? DEFAULT_BRAND_NAME : stored;
  const logoFileId = store.getSetting(BRAND_LOGO_KEY);
  return {
    name,
    // The file id in the query makes each new upload a new URL, so browsers never show a cached old logo.
    logoUrl: logoFileId === null ? null : `/api/branding/logo?v=${encodeURIComponent(logoFileId)}`,
    version,
  };
}

/** Validate an admin-provided app name (1–40 characters, trimmed). */
export function checkBrandName(value) {
  if (typeof value !== 'string') {
    throw new ApiError(400, 'bad_request', 'name must be a string');
  }
  const name = value.trim();
  if (name.length < BRAND_NAME_MIN || name.length > BRAND_NAME_MAX) {
    throw new ApiError(400, 'bad_request', `name must be ${BRAND_NAME_MIN}–${BRAND_NAME_MAX} characters`);
  }
  if (CONTROL_CHARS_RE.test(name)) {
    throw new ApiError(400, 'bad_request', 'name may not contain control characters');
  }
  return name;
}

/** PUT /api/branding {name} (admin): set the app name. */
export function setBrandingName(store, value, version) {
  const name = checkBrandName(value);
  store.setSetting(BRAND_NAME_KEY, name);
  return brandingPayload(store, version);
}

/** Read the raw logo body: image types only (no SVG), ≤ 512 KB, magic bytes checked. */
async function readLogoBody(req) {
  const mime = parseContentType(req.headers['content-type']);
  if (mime === null || !ALLOWED_LOGO_MIME.includes(mime)) {
    throw new ApiError(
      415,
      'unsupported_media_type',
      `Content-Type must be one of ${ALLOWED_LOGO_MIME.join(', ')} (no SVG)`
    );
  }
  const buffer = await readRawBody(req, LOGO_MAX_BYTES);
  if (!matchesMime(buffer, mime)) {
    throw new ApiError(
      415,
      'unsupported_media_type',
      'The logo contents do not match the declared Content-Type'
    );
  }
  return { mime, buffer };
}

/** POST /api/branding/logo (admin): store the logo, replacing any previous one. */
export async function setBrandingLogo(store, dataDir, req, { version, uploadedBy = null }) {
  const logo = await readLogoBody(req);
  const previousId = store.getSetting(BRAND_LOGO_KEY);
  const file = createFileRecord(store, dataDir, {
    name: `logo.${LOGO_EXTENSION[logo.mime] ?? 'img'}`,
    mime: logo.mime,
    buffer: logo.buffer,
    uploadedBy,
  });
  store.setSetting(BRAND_LOGO_KEY, file.fileId);
  if (previousId !== null) removeFileRecord(store, dataDir, previousId);
  return brandingPayload(store, version);
}

/** DELETE /api/branding/logo (admin): reset to no logo. */
export function clearBrandingLogo(store, dataDir, version) {
  const previousId = store.getSetting(BRAND_LOGO_KEY);
  if (previousId !== null) {
    store.deleteSetting(BRAND_LOGO_KEY);
    removeFileRecord(store, dataDir, previousId);
  }
  return brandingPayload(store, version);
}

/** The stored logo file row, or null (the caller answers 404). */
export function getBrandingLogoFile(store) {
  const fileId = store.getSetting(BRAND_LOGO_KEY);
  if (fileId === null) return null;
  return findFileById(store, fileId);
}