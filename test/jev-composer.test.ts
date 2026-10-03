import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canSkipAI,
  isOrganizationPendingStatus,
  isOrganizationRetryableStatus,
  isOrganizationUndoableStatus,
  organizationDecisionPreview,
  organizationStatusLabel,
} from '../src/capture/composerActions';
import type { OrganizationJob, OrganizationJobStatus } from '../src/organization/types';

test('only enables the per-capture Skip AI control when organization is configured', () => {
  assert.equal(canSkipAI('off'), false);
  assert.equal(canSkipAI('advisory'), true);
  assert.equal(canSkipAI('automatic'), true);
});

test('keeps organization actions bounded to their durable job states', () => {
  const pending: readonly OrganizationJobStatus[] = ['queued', 'processing', 'retry-wait'];
  const retryable: readonly OrganizationJobStatus[] = ['retry-wait', 'failed'];
  const terminalOrInformational: readonly OrganizationJobStatus[] = [
    'advisory',
    'uncertain',
    'applied',
    'undone',
    'conflict',
    'deleted',
    'skipped',
    'cancelled',
  ];

  for (const status of pending) assert.equal(isOrganizationPendingStatus(status), true, status);
  for (const status of retryable) assert.equal(isOrganizationRetryableStatus(status), true, status);
  for (const status of terminalOrInformational) {
    assert.equal(isOrganizationPendingStatus(status), false, status);
    assert.equal(isOrganizationRetryableStatus(status), false, status);
  }

  assert.equal(isOrganizationUndoableStatus('applied'), true);
  assert.equal(isOrganizationUndoableStatus('undone'), false);
  assert.equal(isOrganizationUndoableStatus('conflict'), false);
});

test('labels organization state separately and does not claim work for an absent job', () => {
  assert.equal(organizationStatusLabel('queued'), 'Organization queued');
  assert.equal(organizationStatusLabel('processing'), 'Organization processing');
  assert.equal(organizationStatusLabel('retry-wait'), 'Organization retrying');
  assert.equal(organizationStatusLabel('advisory'), 'Organization advisory');
  assert.equal(organizationStatusLabel('uncertain'), 'Organization uncertain');
  assert.equal(organizationStatusLabel('applied'), 'Organization applied');
  assert.equal(organizationStatusLabel('failed'), 'Organization failed');
  assert.equal(organizationStatusLabel('conflict'), 'Organization conflict');
  assert.equal(organizationStatusLabel('skipped'), 'Organization skipped');
  assert.equal(organizationStatusLabel(undefined, 'pending'), 'Organization waiting for local write');
  assert.equal(organizationStatusLabel(undefined, 'written'), 'Organization not started');
});

test('previews only bounded advisory profile and tag proposals without exposing other properties', () => {
  const job: Pick<OrganizationJob, 'status' | 'decision'> = {
    status: 'advisory',
    decision: {
      outcome: 'certain',
      properties: {
        profile: 'BOOK',
        secretMetadata: 'must not render',
      },
      tags: ['#reading', 'reading', 'type/book', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'],
    },
  };

  assert.deepEqual(organizationDecisionPreview(job), {
    profile: 'book',
    tags: ['reading', 'type/book', 'one', 'two', 'three', 'four', 'five', 'six'],
  });
  assert.equal(organizationDecisionPreview({ status: 'applied', decision: job.decision }), undefined);
});
