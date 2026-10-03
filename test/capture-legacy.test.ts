import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LegacyCaptureActions,
  createLegacyCaptureOrigin,
  createLegacyEditorScope,
  normalizeLegacyContent,
} from '../src/capture/legacyCaptureActions';

test('force-new legacy scope never inherits shared main draft state', () => {
  assert.deepEqual(createLegacyEditorScope(false), {
    surface: 'main',
    usesSharedEditMemoId: true,
    usesSharedContentCache: true,
    usesSharedMarkMemoId: true,
  });
  assert.deepEqual(createLegacyEditorScope(true), {
    surface: 'quick',
    usesSharedEditMemoId: false,
    usesSharedContentCache: false,
    usesSharedMarkMemoId: false,
  });

  assert.deepEqual(createLegacyCaptureOrigin(true, 'main-memo'), {
    surface: 'quick',
    editMemoId: '',
  });
  assert.deepEqual(createLegacyCaptureOrigin(false, 'main-memo'), {
    surface: 'main',
    editMemoId: 'main-memo',
  });
});

test('tracks upload generations by draft origin and rejects stale completions', () => {
  const actions = new LegacyCaptureActions(createLegacyCaptureOrigin(false, 'daily-a'));
  const first = actions.beginUpload();
  assert.ok(first);
  assert.equal(actions.snapshot().pendingUploads, 1);
  assert.equal(actions.beginSubmit(), false);

  actions.setOrigin(createLegacyCaptureOrigin(false, 'daily-b'));
  assert.equal(actions.snapshot().pendingUploads, 0);
  assert.equal(actions.completeUpload(first), false);
  assert.equal(actions.failUpload(first), false);

  const second = actions.beginUpload();
  assert.ok(second);
  assert.equal(actions.completeUpload(second), true);
  assert.equal(actions.snapshot().pendingUploads, 0);
});

test('submission locks the current legacy draft and rotates its upload generation', () => {
  const actions = new LegacyCaptureActions(createLegacyCaptureOrigin(false, 'daily'));
  const finishedUpload = actions.beginUpload();
  assert.ok(finishedUpload);
  assert.equal(actions.completeUpload(finishedUpload), true);

  assert.equal(actions.beginSubmit(), true);
  assert.equal(actions.snapshot().submitting, true);
  assert.equal(actions.beginSubmit(), false);
  assert.equal(actions.finishSubmit(), undefined);
  assert.equal(actions.snapshot().submitting, false);

  const nextUpload = actions.beginUpload();
  assert.ok(nextUpload);
  assert.equal(nextUpload.generation > finishedUpload.generation, true);
  assert.equal(actions.completeUpload(nextUpload), true);
});

test('cancel and unmount guard late upload errors and pending counters', () => {
  const actions = new LegacyCaptureActions(createLegacyCaptureOrigin(false, 'daily'));
  const cancelled = actions.beginUpload();
  assert.ok(cancelled);
  assert.equal(actions.cancel(), true);
  assert.equal(actions.completeUpload(cancelled), false);
  assert.equal(actions.failUpload(cancelled), false);
  assert.equal(actions.snapshot().pendingUploads, 0);

  const unmounted = actions.beginUpload();
  assert.ok(unmounted);
  actions.dispose();
  assert.equal(actions.completeUpload(unmounted), false);
  assert.equal(actions.failUpload(unmounted), false);
  assert.equal(actions.beginUpload(), undefined);
  assert.equal(actions.beginSubmit(), false);
  assert.equal(actions.snapshot().mounted, false);
  assert.equal(actions.snapshot().pendingUploads, 0);
});

test('legacy content normalization preserves captured whitespace', () => {
  assert.equal(normalizeLegacyContent('  captured text\n\n'), '  captured text\n\n');
  assert.equal(normalizeLegacyContent('before&nbsp;after'), 'before after');
});
