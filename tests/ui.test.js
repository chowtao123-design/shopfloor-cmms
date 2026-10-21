import test from 'node:test';
import assert from 'node:assert/strict';

import { compactSyncLabel, initialsOf } from '../logic.js';
import { renderHelp } from '../help.js';

/* V21b UI polish (SPEC-v2.md 15.4): the phone header helpers and the Help
   glossary additions are pure, so they can be checked without a DOM. */

test('initialsOf: two letters from a display name', () => {
  assert.equal(initialsOf('Jane Cruz'), 'JC');
  assert.equal(initialsOf('jane cruz'), 'JC');
  assert.equal(initialsOf('  Jane   Cruz '), 'JC');
  assert.equal(initialsOf('Åsa Öberg'), 'ÅÖ');
  assert.equal(initialsOf('Juki 8700 line'), 'J8');
});

test('initialsOf: single word uses its first two letters', () => {
  assert.equal(initialsOf('Madeleine'), 'MA');
  assert.equal(initialsOf('juki'), 'JU');
  assert.equal(initialsOf('J'), 'J');
});

test('initialsOf: empty names give an empty avatar string', () => {
  assert.equal(initialsOf(''), '');
  assert.equal(initialsOf(null), '');
  assert.equal(initialsOf(undefined), '');
  assert.equal(initialsOf('   '), '');
});

test('compactSyncLabel: short pill text for every sync state', () => {
  assert.equal(compactSyncLabel({ online: true, pending: 0 }), 'Synced');
  assert.equal(compactSyncLabel({}), 'Synced');
  assert.equal(compactSyncLabel({ online: true, pending: 3 }), 'Saving 3');
  assert.equal(compactSyncLabel({ online: true, pending: 1 }), 'Saving 1');
  assert.equal(compactSyncLabel({ online: false, pending: 2 }), 'Offline 2');
  assert.equal(compactSyncLabel({ online: false, pending: 0 }), 'Offline');
  assert.equal(compactSyncLabel({ needsLogin: true, pending: 4, online: true }), 'Sign in');
  assert.equal(compactSyncLabel({ online: true, failed: 2 }), 'Failed');
  assert.equal(compactSyncLabel({ online: true, failed: 1 }), 'Failed');
});

test('compactSyncLabel: count only while pending, never says Synced early', () => {
  assert.notEqual(compactSyncLabel({ online: false, pending: 7 }), 'Synced');
  assert.doesNotMatch(compactSyncLabel({ online: false, pending: 0 }), /\d/);
  assert.doesNotMatch(compactSyncLabel({ online: true, failed: 2 }), /\d/);
  assert.doesNotMatch(compactSyncLabel({ needsLogin: true, pending: 4 }), /\d/);
});

/* --- Help glossary (SPEC-v2.md 15.4 / V21b) ------------------------------- */

function stubH() {
  return (tag, attrs = {}, ...children) => ({
    tag,
    attrs: attrs || {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  });
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  return (node.children || []).map(textOf).join('');
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAll(child, predicate, out);
  return out;
}

function glossaryTerms() {
  const rendered = renderHelp(stubH());
  const [glossary] = findAll(
    rendered,
    (node) => node.tag === 'dl' && String(node.attrs.class || '').includes('help-glossary'),
  );
  assert.ok(glossary, 'the glossary <dl> should render');
  const terms = new Map();
  let term = '';
  for (const child of glossary.children) {
    if (child.tag === 'dt') term = textOf(child);
    else if (child.tag === 'dd') terms.set(term, textOf(child));
  }
  return terms;
}

test('help glossary: keeps the core entries', () => {
  const terms = glossaryTerms();
  for (const term of [
    'Work order / job',
    'Breakdown',
    'PM (preventive maintenance)',
    'PM interval',
    'Overdue',
    'Due soon',
    'Downtime',
    'Labour minutes',
    'Building item',
  ]) {
    assert.ok(terms.has(term), `glossary should still define "${term}"`);
  }
  assert.ok(terms.size >= 18, 'glossary should not have lost entries');
});

test('help glossary: defines machine type, In storage and Paused PM (V21b)', () => {
  const terms = glossaryTerms();
  assert.ok(terms.has('Machine type'), 'glossary should define "Machine type"');
  assert.match(terms.get('Machine type'), /Other \(type your own\)/);

  assert.ok(terms.has('In storage'), 'glossary should define "In storage"');
  assert.match(terms.get('In storage'), /paus/i);

  assert.ok(terms.has('Paused PM'), 'glossary should define "Paused PM"');
  assert.match(terms.get('Paused PM'), /In storage or Retired/i);
  assert.match(terms.get('Paused PM'), /due dates unchanged/i);
});