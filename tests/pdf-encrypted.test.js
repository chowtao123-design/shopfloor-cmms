// Owner-password (empty user password) encrypted manuals: the standard
// security handler with AES-128 (V4/R4). The fixture is encrypted here with
// node's own AES, following PDF 1.7 section 7.6.3 step by step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { extractPdfText } from '../server/pdfText.js';

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...parts) => parts.reduce((h, p) => h.update(p), crypto.createHash('md5')).digest();

function encryptedPdf(lines) {
  const O = crypto.randomBytes(32);
  const fileId = crypto.randomBytes(16);
  const P = Buffer.alloc(4);
  P.writeInt32LE(-1340);
  let key = md5(PAD, O, P, fileId).subarray(0, 16);
  for (let i = 0; i < 50; i += 1) key = md5(key).subarray(0, 16);
  const content = Buffer.from(`BT /F1 12 Tf 72 700 Td\n${lines.map((l) => `(${l}) Tj T*`).join('\n')}\nET`, 'latin1');
  const objKey = md5(key, Buffer.from([4, 0, 0, 0, 0]), Buffer.from('sAlT')).subarray(0, 16);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', objKey, iv);
  const data = Buffer.concat([iv, cipher.update(content), cipher.final()]);
  const hex = (b) => `<${b.toString('hex')}>`;
  const head = Buffer.from(
    '%PDF-1.6\n' +
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n' +
      `4 0 obj\n<< /Length ${data.length} >>\nstream\n`,
    'latin1'
  );
  const tail = Buffer.from(
    '\nendstream\nendobj\n' +
      '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n' +
      `6 0 obj\n<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O ${hex(O)} /U ${hex(crypto.randomBytes(32))} /P -1340 >>\nendobj\n` +
      `trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [${hex(fileId)} ${hex(fileId)}] >>\n%%EOF\n`,
    'latin1'
  );
  return Buffer.concat([head, data, tail]);
}

test('encrypted manual (AES-128, no open password) is read like a plain one', () => {
  const lines = [
    'Encrypted manual: needle bar height 12.5 mm at rest.',
    'Thread trimmer solenoid stroke must be checked before the knife.',
    'Use DBx1 number 14 needles and replace them every morning.',
    'Bobbin case tension: the bobbin drops slowly under its own weight.',
  ];
  const result = extractPdfText(encryptedPdf(lines));
  assert.equal(result.status, 'ok');
  for (const line of lines) assert.ok(result.pages[0].includes(line), line);
});

test('a wrong key never crashes: corrupted encrypted data reads as no text', () => {
  const pdf = encryptedPdf(['x'.repeat(250)]);
  pdf.write('0000', pdf.indexOf('/O <') + 4, 'latin1'); // change the owner key: a different decryption key
  const result = extractPdfText(pdf);
  assert.ok(['no_text', 'error'].includes(result.status));
});
