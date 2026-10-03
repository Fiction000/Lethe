import assert from 'node:assert/strict';
import test from 'node:test';

import { createSafeMetadataMergePlan, createSafeUndoPlan, type ParsedMarkdown } from '../src/organization/metadata';
import type {
  OrganizationAppliedMetadata,
  OrganizationDecision,
  OrganizationOverrides,
} from '../src/organization/types';

const certain: OrganizationDecision = {
  outcome: 'certain',
  properties: {
    author: 'AI author',
    rating: 4,
    generated: 'value',
  },
  tags: ['type/book', 'ai/suggested'],
};

function document(frontmatter: Record<string, unknown>, body = 'exact body'): ParsedMarkdown {
  return { frontmatter, body };
}

test('merges only absent generated metadata while preserving body, user fields, tags, and unknown frontmatter', () => {
  const baseline = document({
    lethe_capture_id: 'cap_meta',
    lethe_capture_revision: 0,
    title: 'User title',
    author: 'Manual author',
    tags: ['manual/tag'],
    unknown_nested: { keep: true },
  });

  const plan = createSafeMetadataMergePlan({
    baseline,
    current: document({
      lethe_capture_id: 'cap_meta',
      lethe_capture_revision: 0,
      title: 'User title',
      author: 'Manual author',
      tags: ['manual/tag'],
      unknown_nested: { keep: true },
    }),
    decision: certain,
  });

  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') return;
  assert.deepEqual(plan.document, {
    frontmatter: {
      lethe_capture_id: 'cap_meta',
      lethe_capture_revision: 0,
      title: 'User title',
      author: 'Manual author',
      tags: ['manual/tag', 'type/book', 'ai/suggested'],
      unknown_nested: { keep: true },
      rating: 4,
      generated: 'value',
    },
    body: 'exact body',
  });
  assert.deepEqual(plan.applied.properties, {
    rating: {
      before: { present: false },
      after: 4,
    },
    generated: {
      before: { present: false },
      after: 'value',
    },
  });
  assert.deepEqual(plan.applied.addedTags, ['type/book', 'ai/suggested']);
  assert.deepEqual(plan.applied.tagsAfter, ['manual/tag', 'type/book', 'ai/suggested']);
});

test('declines rather than overwriting a changed body or frontmatter baseline', () => {
  const baseline = document({ title: 'original', tags: ['one'] });
  const bodyChanged = createSafeMetadataMergePlan({
    baseline,
    current: document({ title: 'original', tags: ['one'] }, 'user edit'),
    decision: certain,
  });
  const frontmatterChanged = createSafeMetadataMergePlan({
    baseline,
    current: document({ title: 'user edit', tags: ['one'] }),
    decision: certain,
  });

  assert.deepEqual(bodyChanged, { kind: 'decline', reason: 'changed-baseline' });
  assert.deepEqual(frontmatterChanged, { kind: 'decline', reason: 'changed-baseline' });
});

test('honors explicit field overrides and tag tombstones without restoring removed suggestions', () => {
  const overrides: OrganizationOverrides = {
    properties: {
      author: { state: 'set', value: 'Manual author' },
      rating: { state: 'cleared' },
    },
    propertyTombstones: ['cleared_by_user'],
    tagTombstones: ['type/movie', 'ai/removed'],
  };
  const plan = createSafeMetadataMergePlan({
    baseline: document({ tags: ['manual/tag'] }),
    current: document({ tags: ['manual/tag'] }),
    decision: {
      outcome: 'certain',
      properties: {
        author: 'AI author',
        rating: 5,
        cleared_by_user: 'do not restore',
        kept: true,
      },
      tags: ['type/movie', 'ai/removed', 'ai/kept'],
    },
    overrides,
  });

  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') return;
  assert.deepEqual(plan.document.frontmatter, {
    tags: ['manual/tag', 'ai/kept'],
    kept: true,
  });
  assert.deepEqual(plan.applied.addedTags, ['ai/kept']);
  assert.deepEqual(Object.keys(plan.applied.properties), ['kept']);
});

test('undo restores only unchanged generated values and never removes later user edits', () => {
  const applied = {
    path: 'Notes/exact.md',
    body: 'exact body',
    properties: {
      generated: {
        before: { present: false } as const,
        after: 'generated value',
      },
      restored: {
        before: { present: true, value: 'old value' } as const,
        after: 'new value',
      },
    },
    addedTags: ['ai/suggested'],
    tagsAfter: ['manual/tag', 'ai/suggested'],
    promotion: { from: 'Inbox/exact.md', to: 'Notes/exact.md' },
  };
  const plan = createSafeUndoPlan({
    current: document({
      generated: 'generated value',
      restored: 'user changed later',
      tags: ['manual/tag', 'ai/suggested'],
      unknown: 'keep',
    }),
    applied,
  });

  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') return;
  assert.deepEqual(plan.document.frontmatter, {
    restored: 'user changed later',
    tags: ['manual/tag'],
    unknown: 'keep',
  });
  assert.deepEqual(plan.restoredProperties, ['generated']);
  assert.deepEqual(plan.removedTags, ['ai/suggested']);
  assert.deepEqual(plan.skippedProperties, ['restored']);
});

function appliedForTagUndo(tagsAfter?: readonly string[]): OrganizationAppliedMetadata {
  const applied: OrganizationAppliedMetadata = {
    path: 'Notes/exact.md',
    body: 'exact body',
    properties: {
      generated: {
        before: { present: false },
        after: 'generated value',
      },
    },
    addedTags: ['ai/suggested'],
  };
  return tagsAfter === undefined ? applied : { ...applied, tagsAfter };
}

test('undo preserves all tags when a user adds a duplicate after organization', () => {
  const currentTags = ['manual/tag', 'ai/suggested', 'ai/suggested'];
  const plan = createSafeUndoPlan({
    current: document({ generated: 'generated value', tags: currentTags }),
    applied: appliedForTagUndo(['manual/tag', 'ai/suggested']),
  });

  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') return;
  assert.deepEqual(plan.document.frontmatter.tags, currentTags);
  assert.deepEqual(plan.removedTags, []);
  assert.deepEqual(plan.restoredProperties, ['generated']);
});

test('undo preserves all tags when a user reorders the tag array', () => {
  const currentTags = ['ai/suggested', 'manual/tag'];
  const plan = createSafeUndoPlan({
    current: document({ generated: 'generated value', tags: currentTags }),
    applied: appliedForTagUndo(['manual/tag', 'ai/suggested']),
  });

  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') return;
  assert.deepEqual(plan.document.frontmatter.tags, currentTags);
  assert.deepEqual(plan.removedTags, []);
});

test('undo preserves a user-readded tag with a different normalized spelling', () => {
  const currentTags = ['manual/tag', '#ai/suggested'];
  const plan = createSafeUndoPlan({
    current: document({ generated: 'generated value', tags: currentTags }),
    applied: appliedForTagUndo(['manual/tag', 'ai/suggested']),
  });

  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') return;
  assert.deepEqual(plan.document.frontmatter.tags, currentTags);
  assert.deepEqual(plan.removedTags, []);
});

test('undo preserves generated and user tags when a user adds a new tag', () => {
  const currentTags = ['manual/tag', 'ai/suggested', 'user/new'];
  const plan = createSafeUndoPlan({
    current: document({ generated: 'generated value', tags: currentTags }),
    applied: appliedForTagUndo(['manual/tag', 'ai/suggested']),
  });

  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') return;
  assert.deepEqual(plan.document.frontmatter.tags, currentTags);
  assert.deepEqual(plan.removedTags, []);
});

test('legacy applied metadata without a tag snapshot preserves tags', () => {
  const currentTags = ['manual/tag', 'ai/suggested'];
  const plan = createSafeUndoPlan({
    current: document({ generated: 'generated value', tags: currentTags }),
    applied: appliedForTagUndo(),
  });

  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') return;
  assert.deepEqual(plan.document.frontmatter.tags, currentTags);
  assert.deepEqual(plan.removedTags, []);
  assert.deepEqual(plan.restoredProperties, ['generated']);
});

test('undo declines when the body changed after organization', () => {
  const plan = createSafeUndoPlan({
    current: document({ generated: 'value' }, 'user body'),
    applied: {
      path: 'Notes/exact.md',
      body: 'exact body',
      properties: {
        generated: { before: { present: false }, after: 'value' },
      },
      addedTags: [],
    },
  });

  assert.deepEqual(plan, { kind: 'decline', reason: 'body-changed' });
});
