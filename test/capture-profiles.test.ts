import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BOOK_PROFILE,
  MOVIE_PROFILE,
  PLAIN_PROFILE,
  materializeCapture,
  resolveField,
  resolveFields,
  resolveProfile,
  resolveTags,
  resetForNextCapture,
  switchProfile,
  validateFieldValue,
} from '../src/capture/profiles';

test('defines Plain, Book, and Movie schemas with UI descriptors', () => {
  assert.deepEqual(
    PLAIN_PROFILE.fields.map((field) => field.property),
    [],
  );
  assert.deepEqual(
    BOOK_PROFILE.fields.map((field) => field.property),
    [
      'aliases',
      'cover',
      'startDate',
      'endDate',
      'author',
      'rating',
      'wishlist_section',
      'reading_status',
      'priority',
      'project',
      'source',
      'comment',
    ],
  );
  assert.deepEqual(
    MOVIE_PROFILE.fields.map((field) => field.property),
    ['aliases', 'cover', 'startDate', 'endDate', 'rating', 'director', 'comment'],
  );

  assert.deepEqual(BOOK_PROFILE.triggerTags, ['type/book']);
  assert.deepEqual(BOOK_PROFILE.impliedTags, ['type/review']);
  assert.deepEqual(MOVIE_PROFILE.triggerTags, ['type/movie']);
  assert.deepEqual(MOVIE_PROFILE.impliedTags, ['type/review']);
  assert.equal(PLAIN_PROFILE.uiFields.length, 0);
  assert.equal(BOOK_PROFILE.uiFields.length, BOOK_PROFILE.fields.length);
  assert.equal(MOVIE_PROFILE.uiFields.length, MOVIE_PROFILE.fields.length);
  assert.equal(BOOK_PROFILE.uiFields[0].id, 'aliases');
  assert.equal(BOOK_PROFILE.uiFields[0].optional, true);
});

test('normalizes and binds user, profile, and default tags without touching body text', () => {
  const tags = {
    userAdded: [' #custom ', '#custom', 'type/book'],
    userRemoved: ['#type/review'],
  };

  const profile = resolveProfile('auto', tags);
  assert.equal(profile.effectiveProfile, 'plain');
  assert.deepEqual(profile.conflicts, []);

  const resolved = resolveTags(profile.effectiveProfile, tags, [' #default ', 'custom']);
  assert.deepEqual(resolved.tags, ['custom', 'type/book', 'default']);
  assert.deepEqual(
    resolved.bindings.map(({ tag, source, locked }) => ({ tag, source, locked })),
    [
      { tag: 'custom', source: 'user', locked: true },
      { tag: 'type/book', source: 'user', locked: true },
      { tag: 'default', source: 'default', locked: false },
    ],
  );
});

test('keeps explicit profile choices, treats review as ambiguous, and reports primary-tag conflicts', () => {
  const reviewOnly = resolveProfile('auto', {
    userAdded: ['type/review'],
    userRemoved: [],
  });
  assert.equal(reviewOnly.effectiveProfile, 'plain');
  assert.equal(reviewOnly.requiresExplicitChoice, false);

  const conflict = resolveProfile('auto', {
    userAdded: ['type/book', 'type/movie'],
    userRemoved: [],
  });
  assert.equal(conflict.effectiveProfile, 'plain');
  assert.equal(conflict.requiresExplicitChoice, true);
  assert.equal(conflict.conflicts[0].kind, 'conflicting-primary-tags');
  assert.deepEqual(conflict.conflicts[0].tags, ['type/book', 'type/movie']);

  const explicit = resolveProfile('movie', {
    userAdded: ['type/book', 'type/movie'],
    userRemoved: [],
  });
  assert.equal(explicit.effectiveProfile, 'movie');
  assert.deepEqual(explicit.conflicts, []);
});

test('applies explicit set and clear precedence without coercing invalid values', () => {
  const explicit = resolveField('book', 'author', {
    explicit: { state: 'set', value: 'Octavia Butler' },
    configuredDefault: 'Configured author',
    validatedInference: 'Suggested author',
  });
  assert.deepEqual(explicit, {
    included: true,
    value: 'Octavia Butler',
    source: 'explicit',
    locked: true,
  });

  const cleared = resolveField('book', 'author', {
    explicit: { state: 'cleared' },
    configuredDefault: 'Configured author',
    validatedInference: 'Suggested author',
  });
  assert.equal(cleared.included, false);
  assert.equal(cleared.source, 'explicit-clear');
  assert.equal(cleared.locked, true);

  const defaulted = resolveField('book', 'author', {
    configuredDefault: 'Configured author',
    validatedInference: 'Suggested author',
  });
  assert.deepEqual(defaulted, {
    included: true,
    value: 'Configured author',
    source: 'default',
    locked: false,
  });

  const inferred = resolveField('book', 'author', {
    validatedInference: 'Suggested author',
  });
  assert.deepEqual(inferred, {
    included: true,
    value: 'Suggested author',
    source: 'ai',
    locked: false,
  });

  const invalid = resolveField('book', 'rating', {
    explicit: { state: 'set', value: '5' },
    configuredDefault: 4,
    validatedInference: 3,
  });
  assert.equal(invalid.included, false);
  assert.equal(invalid.source, 'invalid');
  assert.equal(invalid.locked, true);
  assert.equal(invalid.error?.code, 'invalid-type');

  const explicitUndefined = resolveField('book', 'rating', {
    explicit: { state: 'set', value: undefined as unknown as string },
    configuredDefault: 4,
  });
  assert.equal(explicitUndefined.included, false);
  assert.equal(explicitUndefined.source, 'invalid');
  assert.equal(explicitUndefined.error?.source, 'explicit');
});

test('validates typed fields, accepts any finite rating, and leaves optional dates unset', () => {
  assert.equal(validateFieldValue('book', 'rating', 0).valid, true);
  assert.equal(validateFieldValue('book', 'rating', 10_000).valid, true);
  assert.equal(validateFieldValue('book', 'rating', Number.POSITIVE_INFINITY).valid, false);
  assert.equal(validateFieldValue('book', 'startDate', '2026-09-22').valid, true);
  assert.equal(validateFieldValue('book', 'startDate', '2026-02-30').valid, false);
  assert.equal(validateFieldValue('book', 'aliases', ['one', 'two']).valid, true);
  assert.equal(validateFieldValue('book', 'aliases', 'one').valid, false);

  const noEndDate = resolveField('book', 'endDate', {});
  assert.deepEqual(noEndDate, {
    included: false,
    source: 'unset',
    locked: false,
  });
});

test('resolves only active profile fields and reports invalid explicit values without fallback', () => {
  const resolved = resolveFields(
    'book',
    {
      author: { state: 'set', value: 'Ursula K. Le Guin' },
      director: { state: 'set', value: 'Not a Book field' },
      rating: { state: 'cleared' },
      startDate: { state: 'set', value: '2026-02-30' },
    },
    {
      defaults: { rating: 4, comment: 'configured' },
      inference: { comment: 'suggested' },
    },
  );

  assert.deepEqual(resolved.properties, {
    author: 'Ursula K. Le Guin',
    comment: 'configured',
  });
  assert.equal(resolved.resolutions.director, undefined);
  assert.equal(resolved.resolutions.rating.source, 'explicit-clear');
  assert.equal(resolved.resolutions.startDate.source, 'invalid');
  assert.equal(resolved.errors.length, 1);
  assert.equal(resolved.errors[0].code, 'invalid-date');
  assert.equal(resolved.canCapture, false);
});

test('materializes active metadata, markers, and exact body without filling endDate', () => {
  const body = '  日本語\n\n---\n[link](https://example.test)\n#body-tag  ';
  const materialized = materializeCapture({
    body,
    profile: 'book',
    fields: {
      author: { state: 'set', value: 'N. K. Jemisin' },
      director: { state: 'set', value: 'Ignored movie field' },
    },
    tags: {
      userAdded: ['#custom'],
      userRemoved: [],
    },
    captureId: 'cap_profiles',
    revision: 3,
  });

  assert.equal(materialized.body, body);
  assert.equal(materialized.effectiveProfile, 'book');
  assert.deepEqual(materialized.conflicts, []);
  assert.deepEqual(materialized.metadata, {
    author: 'N. K. Jemisin',
    tags: ['custom', 'type/book', 'type/review'],
    lethe_capture_id: 'cap_profiles',
    lethe_capture_revision: 3,
    lethe_profile_id: 'book',
    lethe_profile_schema_version: 1,
  });
  assert.equal('director' in materialized.metadata, false);
  assert.equal('endDate' in materialized.metadata, false);
  assert.equal(materialized.validationErrors.length, 0);
});

test('profile-bound tag removal materializes Plain and preserves the tombstone decision', () => {
  const materialized = materializeCapture({
    body: 'body',
    profile: 'book',
    fields: {
      author: { state: 'set', value: 'Should not emit' },
    },
    tags: {
      userAdded: [],
      userRemoved: ['#type/book'],
    },
  });

  assert.equal(materialized.effectiveProfile, 'plain');
  assert.deepEqual(materialized.metadata.tags, []);
  assert.equal('author' in materialized.metadata, false);
  assert.deepEqual(materialized.tags.userRemoved, ['type/book']);
});

test('switching profiles retains draft intents while next-capture reset clears item state', () => {
  const draft = {
    body: '  exact body\n',
    profile: 'book' as const,
    fields: {
      author: { state: 'set' as const, value: 'Author' },
      rating: { state: 'set' as const, value: 4 },
    },
    tags: {
      userAdded: ['custom'],
      userRemoved: ['type/review'],
    },
  };

  const switched = switchProfile(draft, 'movie');
  assert.equal(switched.profile, 'movie');
  assert.equal(switched.body, draft.body);
  assert.deepEqual(switched.fields, draft.fields);
  assert.deepEqual(switched.tags, draft.tags);
  assert.notEqual(switched.fields, draft.fields);
  assert.notEqual(switched.tags, draft.tags);

  const reset = resetForNextCapture(switched);
  assert.deepEqual(reset, {
    body: '',
    profile: 'auto',
    fields: {},
    tags: { userAdded: [], userRemoved: [] },
  });

  const kept = resetForNextCapture(switched, { keepProfile: true });
  assert.equal(kept.profile, 'movie');
  assert.deepEqual(kept.fields, {});
  assert.deepEqual(kept.tags, { userAdded: [], userRemoved: [] });
});

test('leaves invalid inference blank without blocking an otherwise optional capture', () => {
  const materialized = materializeCapture({
    body: 'body',
    profile: 'book',
    tags: { userAdded: [], userRemoved: [] },
    inference: { rating: 'not a number' },
  });

  assert.equal('rating' in materialized.metadata, false);
  assert.equal(materialized.validationErrors.length, 1);
  assert.equal(materialized.validationErrors[0].source, 'ai');
  assert.equal(materialized.canCapture, true);
});

test('materializes Movie fields and keeps Plain free of an invented content type', () => {
  const movie = materializeCapture({
    body: 'movie',
    profile: 'movie',
    fields: {
      director: { state: 'set', value: 'Director' },
      startDate: { state: 'set', value: '2026-09-22' },
    },
    tags: { userAdded: [], userRemoved: [] },
  });
  assert.equal(movie.metadata.director, 'Director');
  assert.equal(movie.metadata.startDate, '2026-09-22');
  assert.deepEqual(movie.metadata.tags, ['type/movie', 'type/review']);

  const plain = materializeCapture({
    body: 'plain',
    profile: 'plain',
    fields: { author: { state: 'set', value: 'Ignored' } },
    tags: { userAdded: [], userRemoved: [] },
  });
  assert.deepEqual(plain.metadata.tags, []);
  assert.equal('type' in plain.metadata, false);
  assert.equal('author' in plain.metadata, false);
});
