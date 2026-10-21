import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realPath = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};

/**
 * True when the module at `metaUrl` is the script Node was started with.
 * Comparing file URLs directly fails on Windows when the drive-letter case differs
 * (C: vs c:) and anywhere the path goes through a symlink, so compare real paths.
 */
export function isMainModule(metaUrl, argv1 = process.argv[1], platform = process.platform) {
  if (argv1 === undefined) return false;
  const self = realPath(fileURLToPath(metaUrl));
  const started = realPath(path.resolve(argv1));
  return platform === 'win32' ? self.toLowerCase() === started.toLowerCase() : self === started;
}
