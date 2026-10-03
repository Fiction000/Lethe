export type JevCorpusLanguage = 'en' | 'ja';
export type JevCorpusKind = 'clear' | 'ambiguous' | 'unrelated' | 'false-positive' | 'explicit-override';
export type JevCorpusExpectedProfile = 'book' | 'movie' | 'no-match';
export type JevCorpusExpectedSource = 'jev' | 'explicit-profile' | 'explicit-tag';

export interface JevCorpusTagIntent {
  readonly userAdded: readonly string[];
  readonly userRemoved: readonly string[];
}

export interface JevCorpusCase {
  readonly id: string;
  readonly language: JevCorpusLanguage;
  readonly kind: JevCorpusKind;
  readonly body: string;
  readonly profile: 'auto' | 'plain' | 'book' | 'movie';
  readonly tags: JevCorpusTagIntent;
  readonly expected: {
    readonly profile: JevCorpusExpectedProfile;
    readonly source: JevCorpusExpectedSource;
    readonly tags: readonly string[];
  };
}

export const JEV_EVAL_APPROVED_TAGS = Object.freeze([
  Object.freeze({
    tag: 'topic/reading',
    description: 'The capture is substantively about reading or a book.',
  }),
  Object.freeze({
    tag: 'topic/cinema',
    description: 'The capture is substantively about a movie or film.',
  }),
] as const);

function freezeCase(item: JevCorpusCase): JevCorpusCase {
  return Object.freeze({
    ...item,
    tags: Object.freeze({
      userAdded: Object.freeze([...item.tags.userAdded]),
      userRemoved: Object.freeze([...item.tags.userRemoved]),
    }),
    expected: Object.freeze({
      ...item.expected,
      tags: Object.freeze([...item.expected.tags]),
    }),
  });
}

/**
 * Frozen offline labels only. This corpus contains no provider outputs and is
 * deliberately separate from live evaluation results written by scripts/jev-eval.ts.
 */
export const JEV_EVAL_CORPUS: readonly JevCorpusCase[] = Object.freeze([
  freezeCase({
    id: 'en-clear-book-notes',
    language: 'en',
    kind: 'clear',
    body: "Finished reading Ursula K. Le Guin's The Left Hand of Darkness. The shifting point of view deserves a longer note.",
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'book', source: 'jev', tags: ['topic/reading'] },
  }),
  freezeCase({
    id: 'ja-clear-book-notes',
    language: 'ja',
    kind: 'clear',
    body: '夏目漱石の『こころ』を読み終えた。先生とKの距離の描き方について考えたことをメモする。',
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'book', source: 'jev', tags: ['topic/reading'] },
  }),
  freezeCase({
    id: 'en-clear-movie-notes',
    language: 'en',
    kind: 'clear',
    body: "Watched Hayao Miyazaki's Spirited Away again. The train sequence still carries the whole film.",
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'movie', source: 'jev', tags: ['topic/cinema'] },
  }),
  freezeCase({
    id: 'ja-clear-movie-notes',
    language: 'ja',
    kind: 'clear',
    body: '映画『パプリカ』を見返した。夢と現実の切り替わりが印象に残った。',
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'movie', source: 'jev', tags: ['topic/cinema'] },
  }),
  freezeCase({
    id: 'en-ambiguous-novel-film-adaptation',
    language: 'en',
    kind: 'ambiguous',
    body: 'I am comparing the novel with its film adaptation for a class; this note intentionally mixes both versions.',
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    // Both approved tag meanings apply; the profile stays no-match because
    // the capture intentionally mixes the two media.
    expected: { profile: 'no-match', source: 'jev', tags: ['topic/reading', 'topic/cinema'] },
  }),
  freezeCase({
    id: 'ja-ambiguous-original-and-film',
    language: 'ja',
    kind: 'ambiguous',
    body: '原作小説と映画版の違いを授業で比較している。どちらについての記録かはまだ決めていない。',
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    // Both approved tag meanings apply; the profile stays no-match because
    // the capture intentionally mixes the two media.
    expected: { profile: 'no-match', source: 'jev', tags: ['topic/reading', 'topic/cinema'] },
  }),
  freezeCase({
    id: 'en-unrelated-book-club-mention',
    language: 'en',
    kind: 'unrelated',
    body: 'The office book club meets on Thursday, but this capture is about replacing the broken printer.',
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'no-match', source: 'jev', tags: [] },
  }),
  freezeCase({
    id: 'en-false-positive-book-a-flight',
    language: 'en',
    kind: 'false-positive',
    body: 'Need to book a flight to Osaka before the fare changes.',
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'no-match', source: 'jev', tags: [] },
  }),
  freezeCase({
    id: 'ja-false-positive-hotel-reservation',
    language: 'ja',
    kind: 'false-positive',
    body: '来週の出張のホテルを予約する。読書や映画のメモではない。',
    profile: 'auto',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'no-match', source: 'jev', tags: [] },
  }),
  freezeCase({
    id: 'en-explicit-movie-override',
    language: 'en',
    kind: 'explicit-override',
    body: 'This draft mentions a book, but the user explicitly chose the Movie profile for a later adaptation note.',
    profile: 'movie',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'movie', source: 'explicit-profile', tags: [] },
  }),
  freezeCase({
    id: 'ja-explicit-plain-override',
    language: 'ja',
    kind: 'explicit-override',
    body: '映画についての引用を含むが、ユーザーは単なるPlainノートとして保存することを選んだ。',
    profile: 'plain',
    tags: { userAdded: [], userRemoved: [] },
    expected: { profile: 'no-match', source: 'explicit-profile', tags: [] },
  }),
  freezeCase({
    id: 'en-explicit-book-tag',
    language: 'en',
    kind: 'explicit-override',
    body: 'A short capture whose profile is fixed by the explicit type/book tag.',
    profile: 'auto',
    tags: { userAdded: ['type/book'], userRemoved: [] },
    expected: { profile: 'book', source: 'explicit-tag', tags: [] },
  }),
] as const);
