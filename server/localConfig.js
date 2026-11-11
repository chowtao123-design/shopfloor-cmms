// Private per-shop settings that must not be in git (the repository is
// public): the WPFI Google sheet link and the WPFI Google Form fields.
// They live in local-config.json next to package.json (see
// local-config.example.json); a missing or broken file means "not set up".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_CONFIG_FILE = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'local-config.json');

export function readLocalConfig(file = LOCAL_CONFIG_FILE) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** The WPFI form settings the Inspect page needs, or null when incomplete. */
export function wpfiFormConfig(config) {
  const f = config && config.wpfiForm;
  if (!f || typeof f !== 'object' || !/^https:\/\/docs\.google\.com\/forms\//.test(String(f.url || ''))) return null;
  const entry = (v) => (/^entry\.\d+$/.test(String(v || '')) ? String(v) : null);
  const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 50) : []);
  return {
    url: String(f.url),
    date: entry(f.date),
    station: entry(f.station),
    workerId: entry(f.workerId),
    workerName: entry(f.workerName),
    issue: entry(f.issue),
    inspector: entry(f.inspector),
    issues: list(f.issues),
    inspectors: list(f.inspectors),
  };
}
