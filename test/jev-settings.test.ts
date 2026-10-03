import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaptureId, createDraftSnapshot } from '../src/capture/core';
import { buildJevQuestions } from '../src/jev/adapter';
import { resolveJevModel } from '../src/jev/client';
import {
  DEFAULT_JEV_SETTINGS,
  JEV_DEFAULT_MANAGED_FOLDERS,
  JEV_MAX_APPROVED_TAGS,
  JEV_MAX_DESCRIPTION_LENGTH,
  JEV_MAX_MODEL_LENGTH,
  JEV_MAX_TAG_LENGTH,
  applyLocalOnlyFallback,
  hasNativeSecretStorage,
  normalizeJevSettings,
  serializeJevSettings,
  validateApprovedTags,
} from '../src/jevSettings';

test('exports an opt-in Jev default with only a secret reference', () => {
  assert.deepEqual(DEFAULT_JEV_SETTINGS, {
    mode: 'off',
    model: 'jev-latest',
    secretId: 'lethe-typesafe',
    approvedTags: [],
  });
  assert.deepEqual(JEV_DEFAULT_MANAGED_FOLDERS, { inbox: 'Inbox', notes: 'Notes' });
  assert.equal('apiKey' in DEFAULT_JEV_SETTINGS, false);
});

test('normalizes a Jev config without persisting unknown or secret-like fields', () => {
  const normalized = normalizeJevSettings({
    mode: 'advisory',
    model: ' custom-model ',
    secretId: 'not a valid secret id',
    apiKey: 'this must not become plugin data',
    approvedTags: [
      { tag: '#culture', description: '  Culture and ideas  ' },
      { tag: 'type/book', description: 'structural tags are not taxonomy labels' },
      { tag: '#CULTURE', description: 'duplicate, case-insensitively' },
      { tag: 'state/processing', description: 'state markers are not taxonomy labels' },
    ],
    manualTags: ['keep-me-out-of-jev-settings'],
  });

  assert.deepEqual(normalized, {
    mode: 'advisory',
    model: 'custom-model',
    secretId: 'lethe-typesafe',
    approvedTags: [{ tag: 'culture', description: 'Culture and ideas' }],
  });
  assert.equal(JSON.stringify(normalized).includes('this must not become plugin data'), false);
  assert.equal(JSON.stringify(normalized).includes('keep-me-out-of-jev-settings'), false);
});

test('rejects structural, malformed, overlong, duplicate, and over-count taxonomy entries', () => {
  const tooLongTag = 't'.repeat(JEV_MAX_TAG_LENGTH + 1);
  const tooLongDescription = 'd'.repeat(JEV_MAX_DESCRIPTION_LENGTH + 1);
  const entries = [
    { tag: 'type/book', description: '' },
    { tag: 'state/draft', description: '' },
    { tag: 'has whitespace', description: '' },
    { tag: tooLongTag, description: '' },
    { tag: 'long-description', description: tooLongDescription },
    { tag: '#allowed', description: '' },
    { tag: 'ALLOWED', description: 'duplicate' },
    ...Array.from({ length: JEV_MAX_APPROVED_TAGS }, (_, index) => ({ tag: `extra-${index}`, description: '' })),
  ];

  const result = validateApprovedTags(entries);

  assert.deepEqual(result.accepted[0], { tag: 'allowed', description: '' });
  assert.equal(result.accepted.length, JEV_MAX_APPROVED_TAGS);
  assert.deepEqual(
    result.rejected.slice(0, 5).map(({ index, reason }) => ({ index, reason })),
    [
      { index: 0, reason: 'structural-tag' },
      { index: 1, reason: 'structural-tag' },
      { index: 2, reason: 'invalid-tag' },
      { index: 3, reason: 'tag-too-long' },
      { index: 4, reason: 'description-too-long' },
    ],
  );
  assert.equal(
    result.rejected.some(({ reason }) => reason === 'duplicate-tag'),
    true,
  );
  assert.equal(
    result.rejected.some(({ reason }) => reason === 'too-many-tags'),
    true,
  );
});

test('serializes only the safe Jev settings shape', () => {
  const serialized = serializeJevSettings({
    mode: 'automatic',
    model: 'jev-latest',
    secretId: 'lethe-typesafe',
    approvedTags: [{ tag: '#reading', description: 'Reading notes' }],
    secret: 'not accepted',
    token: 'not accepted',
  });

  assert.deepEqual(serialized, {
    mode: 'automatic',
    model: 'jev-latest',
    secretId: 'lethe-typesafe',
    approvedTags: [{ tag: 'reading', description: 'Reading notes' }],
  });
  assert.equal('secret' in serialized, false);
  assert.equal('token' in serialized, false);
});

test('falls back to local-only mode when native secret storage is unavailable', () => {
  const supportedApp = {
    secretStorage: {
      getSecret: () => null,
      setSecret: () => undefined,
      listSecrets: () => [],
    },
  };
  const unsupportedApp = { secretStorage: undefined };
  const settings = { ...DEFAULT_JEV_SETTINGS, mode: 'automatic' as const };

  assert.equal(hasNativeSecretStorage(supportedApp), true);
  assert.equal(hasNativeSecretStorage(unsupportedApp), false);
  assert.equal(applyLocalOnlyFallback(settings, supportedApp).mode, 'automatic');
  assert.equal(applyLocalOnlyFallback(settings, unsupportedApp).mode, 'off');
  assert.deepEqual(applyLocalOnlyFallback(settings, unsupportedApp).approvedTags, []);
});

test('settings model validation only accepts identifiers the request client accepts', () => {
  assert.equal(JEV_MAX_MODEL_LENGTH, 64);
  assert.equal(resolveJevModel('custom.model-1_2'), 'custom.model-1_2');
  assert.equal(normalizeJevSettings({ ...DEFAULT_JEV_SETTINGS, model: 'custom.model-1_2' }).model, 'custom.model-1_2');

  for (const invalidModel of ['provider:model', 'm'.repeat(JEV_MAX_MODEL_LENGTH + 1)]) {
    assert.throws(() => resolveJevModel(invalidModel));
    assert.equal(
      normalizeJevSettings({ ...DEFAULT_JEV_SETTINGS, model: invalidModel }).model,
      DEFAULT_JEV_SETTINGS.model,
    );
  }
});

test('settings approved-tag validation rejects values the request adapter cannot send', () => {
  const unicodeTag = validateApprovedTags([{ tag: '読書', description: '' }]);
  assert.deepEqual(unicodeTag.accepted, []);
  assert.deepEqual(unicodeTag.rejected, [{ index: 0, reason: 'invalid-tag' }]);

  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'jev-settings-validation'),
    body: 'A note.',
    now: () => '2026-09-23T00:00:00.000Z',
  });
  assert.throws(() => buildJevQuestions(snapshot, [{ tag: '読書' }]));

  const accepted = validateApprovedTags([{ tag: 'topic/reading', description: '' }]).accepted;
  assert.doesNotThrow(() => buildJevQuestions(snapshot, accepted));
});
