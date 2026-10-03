import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { sanitizeUnsafeAnchorHrefs } from '../src/helpers/timelineHtml';

test('removes navigable hrefs with executable or data schemes from rendered memo links', () => {
  const anchors = [
    new FakeAnchor('javascript:alert(1)'),
    new FakeAnchor('JaVaScRiPt:alert(1)'),
    new FakeAnchor('data:text/html,<script>alert(1)</script>'),
    new FakeAnchor('https://example.com/note'),
    new FakeAnchor('../note'),
    new FakeAnchor('ftp://example.com/file'),
  ];

  sanitizeUnsafeAnchorHrefs(anchors);

  assert.deepEqual(
    anchors.map((anchor) => anchor.href),
    [undefined, undefined, undefined, 'https://example.com/note', '../note', 'ftp://example.com/file'],
  );
});

test('removes injected event-handler attributes while preserving safe link attributes', () => {
  const anchor = new FakeAnchor("https://example.com/' onmouseover='alert(1)");
  anchor.attributes.set('class', 'link');
  anchor.attributes.set('target', '_blank');
  anchor.attributes.set('onmouseover', 'alert(1)');

  sanitizeUnsafeAnchorHrefs([anchor]);

  assert.equal(anchor.href, "https://example.com/' onmouseover='alert(1)");
  assert.equal(anchor.attributes.has('onmouseover'), false);
  assert.equal(anchor.attributes.get('target'), '_blank');
});

test('sanitizes internal links even when an injected attribute removes their href', () => {
  const anchor = new FakeAnchor(undefined);
  anchor.attributes.set('onmouseover', 'alert(1)');

  sanitizeUnsafeAnchorHrefs([anchor]);

  assert.equal(anchor.attributes.has('onmouseover'), false);
});

test('Timeline sanitizer selects anchors without requiring an href', () => {
  const timelineSource = readFileSync(new URL('../src/helpers/timelineHtml.ts', import.meta.url), 'utf8');
  assert.match(timelineSource, /querySelectorAll\(['"]a['"]\)/u);
});

class FakeAnchor {
  constructor(public href: string | undefined) {
    if (href !== undefined) this.attributes.set('href', href);
  }

  attributes = new Map<string, string>();

  getAttributeNames(): string[] {
    return [...this.attributes.keys()];
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === 'href') this.href = undefined;
  }
}
