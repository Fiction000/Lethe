import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptureId, createDraftSnapshot } from '../src/capture/core';
import { materializeCapture } from '../src/capture/profiles';
import { renderNote } from '../src/capture/writer';

test('writes the resolved profile without changing the submitted Auto snapshot', () => {
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'profile-integration'),
    body: '  本について\n',
    tags: { userAdded: ['type/book'], userRemoved: [] },
  });
  const resolved = materializeCapture(snapshot);
  const note = renderNote({
    snapshot,
    properties: resolved.metadata,
    effectiveProfile: resolved.effectiveProfile,
  });
  assert.match(note, /lethe_profile_id: book\n/);
  assert.equal(snapshot.profile, 'auto');
  assert.equal(note.endsWith(snapshot.body), true);
});
