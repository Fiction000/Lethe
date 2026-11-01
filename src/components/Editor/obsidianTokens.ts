export type SyntaxKind = 'wiki' | 'embed' | 'tag' | 'callout' | 'literal';
export type SyntaxSpan = { from: number; to: number; kind: SyntaxKind };
export type SyntaxContext = { blockquoteStart?: boolean };
const tokenPattern = /\\?(?:!?\[\[[^\]\n]+\]\]|\[![a-zA-Z][\w-]*\][+-]?|#[\p{L}\p{N}_/-]+)/gu;

export function syntaxSpans(text: string, context: SyntaxContext = {}): SyntaxSpan[] {
  const result: SyntaxSpan[] = [];
  for (const match of text.matchAll(tokenPattern)) {
    const raw = match[0];
    const from = match.index ?? 0;
    const active = raw.startsWith('\\') ? raw.slice(1) : raw;
    if (active.startsWith('#')) {
      if (/^[#\d/]+$/.test(active)) continue;
      if (from > 0 && /[\p{L}\p{N}_/\\#]/u.test(text[from - 1])) continue;
    }
    const kind: SyntaxKind = raw.startsWith('\\')
      ? 'literal'
      : active.startsWith('![[')
      ? 'embed'
      : active.startsWith('[[')
      ? 'wiki'
      : active.startsWith('#')
      ? 'tag'
      : 'callout';
    if (kind === 'callout' && (!context.blockquoteStart || from !== 0)) continue;
    result.push({ from, to: from + raw.length, kind });
  }
  return result;
}
