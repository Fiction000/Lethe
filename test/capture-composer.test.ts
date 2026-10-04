import assert from 'node:assert/strict';
import test from 'node:test';

import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createCaptureId, createDraftSnapshot, type CaptureRecord, type SubmissionReceipt } from '../src/capture/core';
import {
  applyComposerPatch,
  getSendDisabledReason,
  isRetryableWriteState,
  isSubmitDisabled,
  isSubmitShortcut,
  removeComposerTag,
  resetComposerDraft,
  selectComposerProfile,
  resolveComposerState,
  submissionWriteState,
} from '../src/capture/composerActions';
import { createEditorEditLock } from '../src/components/Editor/editLock';

test('accepts Cmd/Ctrl+Enter only when composition is settled', () => {
  const shortcut = { key: 'Enter', code: 'Enter', metaKey: true };

  assert.equal(isSubmitShortcut(shortcut), true);
  assert.equal(isSubmitShortcut({ ...shortcut, ctrlKey: true, metaKey: false }), true);
  assert.equal(isSubmitShortcut({ ...shortcut, shiftKey: true }), false);
  assert.equal(isSubmitShortcut({ key: 'Enter', metaKey: true }), true);
  assert.equal(isSubmitShortcut({ key: 'NumpadEnter', code: 'NumpadEnter', metaKey: true }), false);
  assert.equal(isSubmitShortcut({ ...shortcut, isComposing: true }), false);
  assert.equal(isSubmitShortcut(shortcut, true), false);
  assert.equal(isSubmitShortcut({ ...shortcut, keyCode: 229 }), false);
  assert.equal(isSubmitShortcut({ ...shortcut, which: 229 }), false);
});

test('updates a draft immutably without trimming the body or losing fields', () => {
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'composer-patch'),
    body: '  exact body\n',
    profile: 'book',
    fields: { author: { state: 'set', value: 'Author' } },
    tags: { userAdded: ['custom'], userRemoved: [] },
    now: () => '2026-09-22T00:00:00.000Z',
  });

  const next = applyComposerPatch(
    snapshot,
    {
      body: '  exact body\n\nsecond line',
      fields: {
        ...snapshot.fields,
        startDate: { state: 'set', value: '2026-09-22' },
      },
    },
    () => '2026-09-22T00:01:00.000Z',
  );

  assert.equal(next.body, '  exact body\n\nsecond line');
  assert.equal(next.profile, 'book');
  assert.deepEqual(next.fields, {
    author: { state: 'set', value: 'Author' },
    startDate: { state: 'set', value: '2026-09-22' },
  });
  assert.deepEqual(next.tags, snapshot.tags);
  assert.equal(next.revision, 1);
  assert.equal(next.updatedAt, '2026-09-22T00:01:00.000Z');
  assert.equal(snapshot.body, '  exact body\n');
  assert.equal(snapshot.revision, 0);
});

test('resets item state for the next capture and can keep the selected profile', () => {
  const draft = {
    body: 'body',
    profile: 'movie' as const,
    fields: { director: { state: 'set' as const, value: 'Director' } },
    tags: { userAdded: ['custom'], userRemoved: ['type/review'] },
  };

  assert.deepEqual(resetComposerDraft(draft), {
    body: '',
    profile: 'auto',
    fields: {},
    tags: { userAdded: [], userRemoved: [] },
  });
  assert.deepEqual(resetComposerDraft(draft, true), {
    body: '',
    profile: 'movie',
    fields: {},
    tags: { userAdded: [], userRemoved: [] },
  });
});

test('disables submit for blank drafts, composition, uploads, or an in-flight submission', () => {
  assert.equal(isSubmitDisabled('  \n', false, false, false), true);
  assert.equal(isSubmitDisabled('body', true, false, false), true);
  assert.equal(isSubmitDisabled('body', false, true, false), true);
  assert.equal(isSubmitDisabled('body', false, false, true), true);
  assert.equal(isSubmitDisabled('body', false, false, false), false);
});

test('explains each state that keeps Send disabled', () => {
  assert.equal(getSendDisabledReason('  ', false, false, false), 'Write something to enable Send');
  assert.equal(getSendDisabledReason('body', false, false, true), 'Wait for the image upload to finish');
  assert.equal(getSendDisabledReason('body', false, true, false), 'Finish composing to enable Send');
  assert.equal(getSendDisabledReason('body', true, false, false), 'Saving capture');
  assert.equal(getSendDisabledReason('body', false, false, false), undefined);
});

test('resolves Auto profile tags into fields and tombstones removed profile tags', () => {
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'composer-profile-tags'),
    body: 'book body',
    profile: 'auto',
    tags: { userAdded: ['type/book'], userRemoved: [] },
  });

  const resolved = resolveComposerState(snapshot);
  assert.equal(resolved.profile.effectiveProfile, 'book');
  assert.deepEqual(resolved.tags.tags, ['type/book', 'type/review']);
  assert.equal(resolved.selectedProfile, 'book');

  const removedSnapshot = applyComposerPatch(snapshot, {
    tags: removeComposerTag(snapshot.tags, 'type/book'),
  });
  const afterRemoval = resolveComposerState(removedSnapshot);
  assert.equal(afterRemoval.profile.effectiveProfile, 'plain');
  assert.equal(afterRemoval.selectedProfile, 'plain');
  assert.deepEqual(afterRemoval.tags.tags, []);
  assert.deepEqual(removedSnapshot.tags, {
    userAdded: [],
    userRemoved: ['type/book'],
  });
});

test('explicit profile reselection supersedes only its profile-tag removals', () => {
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'profile-reselection'),
    body: '',
    profile: 'auto',
    tags: { userAdded: ['custom'], userRemoved: ['type/book', 'type/review', 'type/movie', 'other'] },
  });
  const selected = applyComposerPatch(snapshot, selectComposerProfile(snapshot.tags, 'book'));
  assert.equal(resolveComposerState(selected).selectedProfile, 'book');
  assert.deepEqual(selected.tags.userRemoved, ['type/movie', 'other']);
  assert.deepEqual(selected.tags.userAdded, ['custom']);
  const automatic = applyComposerPatch(snapshot, selectComposerProfile(snapshot.tags, 'auto'));
  assert.equal(resolveComposerState(automatic).selectedProfile, 'auto');
  assert.deepEqual(automatic.tags.userRemoved, ['other']);
});

test('derives receipt state from the latest record and only marks pending or failed writes retryable', () => {
  const id = createCaptureId(() => 'composer-receipt');
  const receipt: SubmissionReceipt = {
    captureId: id,
    submittedRevision: 0 as SubmissionReceipt['submittedRevision'],
    localPersisted: true,
    noteState: 'pending',
  };
  const record = (state: CaptureRecord['write']['state']): Pick<CaptureRecord, 'snapshot' | 'write'> => ({
    snapshot: { id } as CaptureRecord['snapshot'],
    write: { state },
  });

  assert.equal(submissionWriteState(receipt, [record('pending')]), 'pending');
  assert.equal(submissionWriteState(receipt, [record('written')]), 'written');
  assert.equal(submissionWriteState(receipt, [record('failed')]), 'failed');
  assert.equal(submissionWriteState(receipt, []), 'pending');
  assert.equal(isRetryableWriteState('pending'), true);
  assert.equal(isRetryableWriteState('failed'), true);
  assert.equal(isRetryableWriteState('written'), false);
  assert.equal(isRetryableWriteState('deleted'), false);
  assert.equal(isRetryableWriteState('conflict'), false);
});

test('locks CodeMirror editing by toggling both read-only and editable facets', () => {
  const lock = createEditorEditLock();
  let state = EditorState.create({ extensions: [lock.extension] });

  assert.equal(state.facet(EditorView.editable), true);
  assert.equal(state.facet(EditorState.readOnly), false);

  state = state.update({ effects: lock.setEditable(false) }).state;
  assert.equal(state.facet(EditorView.editable), false);
  assert.equal(state.facet(EditorState.readOnly), true);

  state = state.update({ effects: lock.setEditable(true) }).state;
  assert.equal(state.facet(EditorView.editable), true);
  assert.equal(state.facet(EditorState.readOnly), false);
});
