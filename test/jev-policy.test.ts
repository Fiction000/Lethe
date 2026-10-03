import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaptureId, createDraftSnapshot, type CaptureSnapshot } from '../src/capture/core';
import { JEV_PROFILE_TAXONOMY, JEV_QUESTION_VERSION, type JevQualityGate } from '../src/jev/qualityGate';
import { mapJevDecision } from '../src/jev/policy';
import type { JevCaptureDecision, JevInferredProfileDecision, JevTagJudgment } from '../src/jev/types';

const APPROVED_TAGS = [
  { tag: 'topic/reading', description: 'The capture is substantively about reading or a book.' },
  { tag: 'topic/cinema', description: 'The capture is substantively about a movie or film.' },
] as const;

function snapshot(
  body = 'A note about a book.',
  options: Partial<Pick<CaptureSnapshot, 'profile' | 'fields' | 'tags'>> = {},
): CaptureSnapshot {
  return createDraftSnapshot({
    id: createCaptureId(() => 'policy-test'),
    body,
    now: () => '2026-09-23T00:00:00.000Z',
    ...options,
  });
}

function inferred(
  profile: JevInferredProfileDecision['profile'] = 'book',
  overrides: Partial<JevInferredProfileDecision> = {},
): JevCaptureDecision {
  const choice = profile === 'plain' ? 'no-match' : profile;
  return {
    captureId: snapshot().id,
    revision: 0 as CaptureSnapshot['revision'],
    profile: {
      source: 'jev',
      profile,
      choice,
      probabilities:
        profile === 'book'
          ? { book: 0.97, movie: 0.02, 'no-match': 0.01 }
          : profile === 'movie'
          ? { book: 0.01, movie: 0.97, 'no-match': 0.02 }
          : { book: 0.02, movie: 0.03, 'no-match': 0.95 },
      confidence: 0.94,
      ...overrides,
    },
    tags: [],
    model: 'jev-1.13.0',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function tagJudgment(tag: string, noul: number, overrides: Partial<JevTagJudgment> = {}): JevTagJudgment {
  return {
    tag,
    questionId: `approved-${tag.replaceAll('/', '-')}`,
    noul,
    active: false,
    removed: false,
    eligibleForAddition: true,
    ...overrides,
  };
}

function gate(overrides: Partial<JevQualityGate> = {}): JevQualityGate {
  return {
    model: 'jev-1.13.0',
    questionVersion: JEV_QUESTION_VERSION,
    qualifiedProfiles: [
      { profile: 'book', meaning: JEV_PROFILE_TAXONOMY.book },
      { profile: 'movie', meaning: JEV_PROFILE_TAXONOMY.movie },
    ],
    qualifiedTags: [
      { tag: 'topic/reading', description: APPROVED_TAGS[0].description },
      { tag: 'topic/cinema', description: APPROVED_TAGS[1].description },
    ],
    ...overrides,
  };
}

test('keeps an inferred profile uncertain when the gate model is not the exact returned model', () => {
  const decision = inferred('book');
  const result = mapJevDecision(snapshot(), decision, {
    approvedTags: APPROVED_TAGS,
    qualityGate: gate({ model: 'jev-1.12.0' }),
  });

  assert.equal(result.outcome, 'uncertain');
  assert.deepEqual(result.properties, {});
  assert.deepEqual(result.tags, []);
});

test('requires the exact profile taxonomy meaning and question version before automatic organization', () => {
  const decision = inferred('book');
  const taxonomyMismatch = mapJevDecision(snapshot(), decision, {
    qualityGate: gate({
      qualifiedProfiles: [{ profile: 'book', meaning: 'A looser book label.' }],
    }),
  });
  const versionMismatch = mapJevDecision(snapshot(), decision, {
    qualityGate: gate({ questionVersion: 'capture-profile-v0' }),
  });

  assert.equal(taxonomyMismatch.outcome, 'uncertain');
  assert.equal(versionMismatch.outcome, 'uncertain');
});

test('denies a low-confidence or below-threshold profile even with a compatible gate', () => {
  const lowWinningProbability = inferred('book', {
    probabilities: { book: 0.94, movie: 0.04, 'no-match': 0.02 },
  });
  const lowConfidence = inferred('book', { confidence: 0.89 });

  assert.equal(mapJevDecision(snapshot(), lowWinningProbability, { qualityGate: gate() }).outcome, 'uncertain');
  assert.equal(mapJevDecision(snapshot(), lowConfidence, { qualityGate: gate() }).outcome, 'uncertain');
});

test('keeps a high-probability but unqualified custom tag advisory instead of writing it', () => {
  const decision = {
    ...inferred('book'),
    tags: [tagJudgment('topic/unseen', 0.99)],
  };
  const result = mapJevDecision(snapshot(), decision, {
    approvedTags: [{ tag: 'topic/unseen', description: 'A new meaning not in live evidence.' }],
    qualityGate: gate(),
  });

  assert.equal(result.outcome, 'uncertain');
  assert.deepEqual(result.tags, ['topic/unseen']);
});

test('respects type tombstones and cleared fields without inferring endDate or reserved markers', () => {
  const capture = snapshot('A detailed book note.', {
    tags: { userAdded: [], userRemoved: ['type/book'] },
    fields: {
      author: { state: 'set', value: 'Manual Author' },
      rating: { state: 'cleared' },
    },
  });
  const result = mapJevDecision(capture, inferred('book'), { qualityGate: gate() });

  assert.equal(result.outcome, 'uncertain');
  assert.deepEqual(result.properties, {});
  assert.deepEqual(result.tags, []);

  const explicit = mapJevDecision(
    snapshot('A manually selected book.', {
      profile: 'book',
      tags: { userAdded: [], userRemoved: ['type/book'] },
      fields: {
        author: { state: 'set', value: 'Manual Author' },
        rating: { state: 'cleared' },
      },
    }),
    {
      ...inferred('book'),
      profile: { source: 'explicit-profile', profile: 'book' },
    },
  );

  assert.equal(explicit.outcome, 'certain');
  assert.equal(explicit.properties?.author, 'Manual Author');
  assert.equal('rating' in (explicit.properties ?? {}), false);
  assert.equal('endDate' in (explicit.properties ?? {}), false);
  assert.equal('lethe_capture_id' in (explicit.properties ?? {}), false);
  assert.deepEqual(explicit.tags, ['type/review']);
});

test('manual profile and type choices are authoritative while Plain bypasses inference', () => {
  const explicitBook = mapJevDecision(snapshot('Book chosen manually.', { profile: 'book' }), {
    ...inferred('movie'),
    profile: { source: 'explicit-profile', profile: 'book' },
  });
  const explicitPlain = mapJevDecision(snapshot('Plain chosen manually.', { profile: 'plain' }), {
    ...inferred('movie'),
    profile: { source: 'explicit-profile', profile: 'plain' },
  });
  const explicitTag = mapJevDecision(
    snapshot('Type tag chosen manually.', { tags: { userAdded: ['type/movie'], userRemoved: [] } }),
    {
      ...inferred('book'),
      profile: { source: 'explicit-tag', profile: 'movie', tag: 'type/movie' },
    },
  );

  assert.equal(explicitBook.outcome, 'certain');
  assert.deepEqual(explicitBook.tags, ['type/book', 'type/review']);
  assert.equal(explicitPlain.outcome, 'certain');
  assert.deepEqual(explicitPlain.tags, []);
  assert.equal(explicitTag.outcome, 'certain');
  assert.deepEqual(explicitTag.tags, ['type/movie', 'type/review']);
});

test('keeps conflicting manual type tags and no-match captures in Inbox as uncertain', () => {
  const conflict = mapJevDecision(
    snapshot('Conflicting type tags.', {
      tags: { userAdded: ['type/book', 'type/movie'], userRemoved: [] },
    }),
    {
      ...inferred('book'),
      profile: { source: 'explicit-conflict', profile: 'plain', tags: ['type/book', 'type/movie'] },
    },
  );
  const noMatch = mapJevDecision(snapshot('A printer repair note.'), inferred('plain'));

  assert.equal(conflict.outcome, 'uncertain');
  assert.deepEqual(conflict.tags, []);
  assert.equal(noMatch.outcome, 'uncertain');
  assert.deepEqual(noMatch.tags, []);
});

test('does not make a default quality gate permissive without explicit live qualification', () => {
  const result = mapJevDecision(snapshot(), inferred('book'));

  assert.equal(result.outcome, 'uncertain');
  assert.deepEqual(result.tags, []);
});
