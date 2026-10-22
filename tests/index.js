// `node --test tests/` runs this file, so load every *.test.js here automatically:
// a new test file can never be silently skipped because nobody registered it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.test.js')).sort()) {
  await import(pathToFileURL(path.join(dir, name)).href);
}
