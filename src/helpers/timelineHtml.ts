const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'mailto:']);
const ALLOWED_ANCHOR_ATTRIBUTES = new Set([
  'href',
  'class',
  'target',
  'rel',
  'data-href',
  'data-type',
  'data-filepath',
  'data-value',
]);

export function isSafeMemoHref(href: string): boolean {
  try {
    const url = new URL(href.trim(), 'https://lethe.invalid');
    return ALLOWED_LINK_PROTOCOLS.has(url.protocol.toLowerCase());
  } catch {
    return false;
  }
}

export function sanitizeUnsafeAnchorHrefs(
  anchors: Iterable<Pick<HTMLAnchorElement, 'getAttribute' | 'getAttributeNames' | 'removeAttribute'>>,
): void {
  for (const anchor of anchors) {
    for (const name of anchor.getAttributeNames()) {
      if (!ALLOWED_ANCHOR_ATTRIBUTES.has(name)) {
        anchor.removeAttribute(name);
      }
    }
    const href = anchor.getAttribute('href');
    if (href !== null && !isSafeMemoHref(href)) {
      anchor.removeAttribute('href');
    }
  }
}

export function sanitizeTimelineHtml(html: string): string {
  const container = document.createElement('div');
  container.innerHTML = html;
  sanitizeUnsafeAnchorHrefs(container.querySelectorAll('a'));
  return container.innerHTML;
}
