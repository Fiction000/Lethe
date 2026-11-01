import diff from 'fast-diff';

export type SourceDocument = {
  rawMarkdown: string;
  priorCanonicalMarkdown: string;
  priorDocument: unknown;
};

export type SourceProjection =
  | { ok: true; rawMarkdown: string; document: SourceDocument }
  | { ok: false; rawMarkdown: string; actualDiff: string; reason: string };

const EQUAL = 0;
const DELETE = -1;
const MAX_TEXT = 200_000;

function changes(before: string, after: string): Array<[number, string]> {
  return diff(before, after) as Array<[number, string]>;
}

function boundaryMap(raw: string, canonical: string): number[] | null {
  const map = Array(canonical.length + 1).fill(-1) as number[];
  let ri = 0;
  let ci = 0;
  let matched = 0;
  for (const [op, text] of changes(raw, canonical)) {
    if (op === EQUAL) {
      matched += text.length;
      for (let i = 0; i <= text.length; i++) {
        if (map[ci + i] < 0) map[ci + i] = ri + i;
      }
      ri += text.length;
      ci += text.length;
    } else if (op === DELETE) {
      ri += text.length;
      if (map[ci] < 0) map[ci] = ri;
    } else {
      for (let i = 1; i <= text.length; i++) map[ci + i] = ri;
      ci += text.length;
    }
  }
  if (ri !== raw.length || ci !== canonical.length || matched < 3) return null;
  for (let i = 0; i < map.length; i++) {
    if (map[i] < 0) map[i] = i === 0 ? 0 : map[i - 1];
  }
  map[0] = raw.length === canonical.length ? 0 : map[0];
  map[canonical.length] = raw.length === canonical.length ? raw.length : map[canonical.length];
  return map;
}

function spans(before: string, after: string): Array<{ from: number; to: number; insert: string }> {
  const result: Array<{ from: number; to: number; insert: string }> = [];
  let at = 0;
  let pending: { from: number; to: number; insert: string } | undefined;
  const flush = () => {
    if (pending) result.push(pending);
    pending = undefined;
  };
  for (const [op, text] of changes(before, after)) {
    if (op === EQUAL) {
      flush();
      at += text.length;
    } else {
      pending ??= { from: at, to: at, insert: '' };
      if (op === DELETE) {
        pending.to += text.length;
        at += text.length;
      } else pending.insert += text;
    }
  }
  flush();
  return result;
}

export function createSourceDocument(
  rawMarkdown: string,
  canonicalMarkdown: string,
  priorDocument: unknown,
): SourceDocument {
  return { rawMarkdown, priorCanonicalMarkdown: canonicalMarkdown, priorDocument };
}

export function projectCanonicalChange(
  source: SourceDocument,
  nextCanonicalMarkdown: string,
  nextDocument: unknown,
): SourceProjection {
  const actualDiff = spans(source.priorCanonicalMarkdown, nextCanonicalMarkdown)
    .map((span) => `${span.from}:${span.to}->${JSON.stringify(span.insert)}`)
    .join(', ');
  if (source.priorCanonicalMarkdown === nextCanonicalMarkdown) {
    return {
      ok: true,
      rawMarkdown: source.rawMarkdown,
      document: {
        rawMarkdown: source.rawMarkdown,
        priorCanonicalMarkdown: nextCanonicalMarkdown,
        priorDocument: nextDocument,
      },
    };
  }
  if (source.rawMarkdown.length > MAX_TEXT || nextCanonicalMarkdown.length > MAX_TEXT) {
    return {
      ok: false,
      rawMarkdown: source.rawMarkdown,
      actualDiff,
      reason: 'document exceeds bounded projection size',
    };
  }

  const boundaries = boundaryMap(source.rawMarkdown, source.priorCanonicalMarkdown);
  if (!boundaries)
    return { ok: false, rawMarkdown: source.rawMarkdown, actualDiff, reason: 'canonical-to-source alignment failed' };
  const edits = spans(source.priorCanonicalMarkdown, nextCanonicalMarkdown).map((span) => ({
    from: boundaries[span.from],
    to: boundaries[span.to],
    insert: span.insert,
  }));
  if (
    edits.some(
      (edit) =>
        (source.rawMarkdown[edit.from - 1] === '\\' || source.rawMarkdown[edit.from] === '\\') && edit.from === edit.to,
    )
  ) {
    return {
      ok: false,
      rawMarkdown: source.rawMarkdown,
      actualDiff,
      reason: 'edit boundary touches an escaped source spelling',
    };
  }
  if (edits.some((edit) => edit.from < 0 || edit.to < edit.from || edit.to > source.rawMarkdown.length)) {
    return { ok: false, rawMarkdown: source.rawMarkdown, actualDiff, reason: 'ambiguous source boundary' };
  }

  let rawMarkdown = source.rawMarkdown;
  for (const edit of edits.reverse())
    rawMarkdown = rawMarkdown.slice(0, edit.from) + edit.insert + rawMarkdown.slice(edit.to);
  return {
    ok: true,
    rawMarkdown,
    document: { rawMarkdown, priorCanonicalMarkdown: nextCanonicalMarkdown, priorDocument: nextDocument },
  };
}
