import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceDocument, projectCanonicalChange } from '../src/components/Editor/sourceDocument';

function edit(raw: string, canonical: string, next: string): string {
  const result = projectCanonicalChange(createSourceDocument(raw, canonical, { type: 'doc' }), next, {
    type: 'doc',
    edited: true,
  });
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  return result.rawMarkdown;
}

test('pristine documents retain exact source bytes even when canonical serialization differs', () => {
  const source = '  \\[[literal]] and [[active]]  \r\n';
  const result = projectCanonicalChange(
    createSourceDocument(source, '[[literal]] and [[active]]\n', { doc: 1 }),
    '[[literal]] and [[active]]\n',
    { doc: 1 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.rawMarkdown, source);
});

test('projects first and last text insertions between source-only edge whitespace and preserves CRLF', () => {
  const raw = '  lead  \r\n\r\n  tail  \r\n';
  const canonical = 'lead\n\ntail\n';
  assert.equal(edit(raw, canonical, 'Xlead\n\ntail\n'), '  Xlead  \r\n\r\n  tail  \r\n');
  assert.equal(edit(raw, canonical, 'lead\n\ntailX\n'), '  lead  \r\n\r\n  tailX  \r\n');
});

test('projects an ordinary insertion without rewriting escaped and active repeated spellings', () => {
  const raw = '\\[[same]] and [[same]]; [[same]]';
  const canonical = '[[same]] and [[same]]; [[same]]';
  assert.equal(edit(raw, canonical, '[[same]] and X[[same]]; [[same]]'), '\\[[same]] and X[[same]]; [[same]]');
});

test('projects syntax additions and deletions while retaining untouched raw-only prefixes/suffixes', () => {
  assert.equal(edit('  plain  ', 'plain', 'plain #tag'), '  plain #tag  ');
  assert.equal(
    edit('\\[[literal]] and [[active]]', '[[literal]] and [[active]]', '[[literal]] and active'),
    '\\[[literal]] and active',
  );
});

test('canonical no-op retains doc-state delta and exact source', () => {
  const source = createSourceDocument('  paragraph  ', 'paragraph', { children: 1 });
  const result = projectCanonicalChange(source, 'paragraph', { children: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.rawMarkdown, '  paragraph  ');
  assert.deepEqual(result.document.priorDocument, { children: 2 });
});

test('ambiguous insertion beside an escaped spelling fails closed with source and diff intact', () => {
  const raw = String.fromCharCode(92) + '#tag';
  const source = createSourceDocument(raw, '#tag\n', { doc: 1 });
  const result = projectCanonicalChange(source, 'X#tag\n', { doc: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.rawMarkdown, raw);
  assert.ok(result.actualDiff.includes('X'));
});

test('projection reports bounded failure with original draft intact', () => {
  const source = createSourceDocument('source', 'other', { type: 'doc' });
  const result = projectCanonicalChange(source, 'new', { type: 'doc' });
  assert.equal(result.ok, false);
  assert.equal(result.rawMarkdown, 'source');
  assert.notEqual(result.actualDiff, '');
});
