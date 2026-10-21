import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../server/is-main.js';

test('isMainModule matches the started script, also through a symlink and Windows drive-letter case', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'is-main-'));
  try {
    const file = path.join(dir, 'server.js');
    fs.writeFileSync(file, '');
    const url = pathToFileURL(file).href;
    assert.equal(isMainModule(url, file), true);
    assert.equal(isMainModule(url, path.join(dir, 'other.js')), false);
    assert.equal(isMainModule(url, undefined), false);
    const link = path.join(dir, 'link.js');
    fs.symlinkSync(file, link);
    assert.equal(isMainModule(url, link), true);
    // Windows compares case-insensitively (C:\ vs c:\); other platforms do not.
    assert.equal(isMainModule(url, file.toUpperCase(), 'win32'), true);
    assert.equal(isMainModule(url, file.toUpperCase(), 'linux'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
