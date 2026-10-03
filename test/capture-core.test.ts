import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureConflictError,
  CaptureRecord,
  DurableCaptureStore,
  StaleRevisionError,
  createCaptureId,
  createDraftSnapshot,
  isBlankForSubmission,
} from '../src/capture/core';
import { SerializedDataRepository } from '../src/capture/repository';

test('creates unique capture ids and preserves the body exactly', () => {
  const first = createCaptureId(() => 'fixed-a');
  const second = createCaptureId(() => 'fixed-b');
  const body = '  日本語\n\n---\n[link](https://example.test)  \n';

  const snapshot = createDraftSnapshot({
    id: first,
    body,
    now: () => '2026-09-22T00:00:00.000Z',
  });

  assert.match(first, /^cap_fixed-a$/);
  assert.match(second, /^cap_fixed-b$/);
  assert.notEqual(first, second);
  assert.equal(snapshot.body, body);
  assert.equal(snapshot.revision, 0);
  assert.equal(isBlankForSubmission(' \n\t '), true);
  assert.equal(isBlankForSubmission('  #tag  '), false);
});

test('serializes capture state without dropping unknown plugin namespaces', async () => {
  let persisted: unknown = {
    settings: { theme: 'dark' },
    _memoIndex: { recent: ['old'] },
    futureNamespace: { keep: true },
  };
  const repository = new SerializedDataRepository({
    loadData: async () => persisted,
    saveData: async (next: unknown) => {
      persisted = next;
    },
  });
  const store = new DurableCaptureStore(repository);
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'store'),
    body: 'first',
    now: () => '2026-09-22T00:00:00.000Z',
  });

  await store.createDraft(snapshot);
  const newer = {
    ...snapshot,
    revision: 1 as typeof snapshot.revision,
    body: 'second',
    updatedAt: '2026-09-22T00:01:00.000Z',
  };
  await store.saveDraft(newer);

  const envelope = (await repository.read()) as Record<string, unknown>;
  assert.deepEqual(envelope.settings, { theme: 'dark' });
  assert.deepEqual(envelope._memoIndex, { recent: ['old'] });
  assert.deepEqual(envelope.futureNamespace, { keep: true });
  const loaded = await store.load();
  assert.equal(loaded.captures[snapshot.id].snapshot.body, 'second');

  await assert.rejects(
    store.saveDraft({
      ...newer,
      revision: 0 as typeof snapshot.revision,
      body: 'stale',
    }),
    StaleRevisionError,
  );
  await assert.rejects(store.createDraft(snapshot), CaptureConflictError);
});

test('makes submission idempotent and returns the durable note state', async () => {
  let persisted: unknown = { settings: { keep: 'yes' } };
  const repository = new SerializedDataRepository({
    loadData: async () => persisted,
    saveData: async (next: unknown) => {
      persisted = next;
    },
  });
  const store = new DurableCaptureStore(repository);
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'receipt'),
    body: 'submitted exactly',
    now: () => '2026-09-22T00:00:00.000Z',
  });
  await store.createDraft(snapshot);

  const [first, duplicate] = await Promise.all([store.commitSubmission(snapshot), store.commitSubmission(snapshot)]);
  assert.deepEqual(duplicate, first);
  assert.equal(first.noteState, 'pending');

  await assert.rejects(
    store.commitSubmission({
      ...snapshot,
      revision: 1 as typeof snapshot.revision,
      body: 'a second submission',
    }),
    CaptureConflictError,
  );

  await store.markNoteWritten(snapshot.id, snapshot.revision, {
    captureId: snapshot.id,
    revision: snapshot.revision,
    path: 'Inbox/submitted-exactly-cap_receipt.md',
    folder: 'inbox',
  });
  const afterWrite = await store.commitSubmission(snapshot);
  assert.equal(afterWrite.noteState, 'written');
  assert.deepEqual(((await repository.read()) as Record<string, unknown>).settings, { keep: 'yes' });
});

test('discards explicitly and lists only live drafts and submitted captures for recovery', async () => {
  let persisted: unknown = {};
  const repository = new SerializedDataRepository({
    loadData: async () => persisted,
    saveData: async (next: unknown) => {
      persisted = next;
    },
  });
  const store = new DurableCaptureStore(repository);
  const discarded = createDraftSnapshot({
    id: createCaptureId(() => 'discarded'),
    body: 'discard me',
    now: () => '2026-09-22T00:00:00.000Z',
  });
  const recoverable = createDraftSnapshot({
    id: createCaptureId(() => 'recoverable'),
    body: 'keep me',
    now: () => '2026-09-22T00:01:00.000Z',
  });
  await store.createDraft(discarded);
  await store.createDraft(recoverable);
  await store.discard(discarded.id, discarded.revision);

  await assert.rejects(
    store.saveDraft({
      ...discarded,
      revision: 1 as typeof discarded.revision,
      body: 'must not resurrect',
    }),
    CaptureConflictError,
  );
  const records = await store.listRecoverable();
  assert.deepEqual(
    records.map((record: CaptureRecord) => record.snapshot.id),
    [recoverable.id],
  );
  assert.equal((await store.load()).captures[discarded.id].lifecycle, 'discarded');
});

test('keeps the submitted snapshot when a late draft save resolves', async () => {
  let persisted: unknown = {};
  const repository = new SerializedDataRepository({
    loadData: async () => persisted,
    saveData: async (next: unknown) => {
      persisted = next;
    },
  });
  const store = new DurableCaptureStore(repository);
  const initial = createDraftSnapshot({
    id: createCaptureId(() => 'late'),
    body: 'acknowledged body',
    now: () => '2026-09-22T00:00:00.000Z',
  });
  const current = {
    ...initial,
    revision: 1 as typeof initial.revision,
    body: 'submitted body',
    updatedAt: '2026-09-22T00:01:00.000Z',
  };
  await store.createDraft(initial);
  await store.saveDraft(current);
  await store.commitSubmission(current);

  await assert.rejects(
    store.saveDraft({
      ...current,
      revision: 2 as typeof current.revision,
      body: 'late callback must not replace it',
    }),
    CaptureConflictError,
  );
  const record = await store.get(initial.id);
  assert.equal(record?.lifecycle, 'submitted');
  assert.equal(record?.snapshot.body, 'submitted body');
  assert.equal(record?.snapshot.revision, 1);
});

test('serializes overlapping namespace transactions without last-write-wins loss', async () => {
  let persisted: unknown = { settings: { before: true } };
  const repository = new SerializedDataRepository({
    loadData: async () => persisted,
    saveData: async (next: unknown) => {
      await Promise.resolve();
      persisted = next;
    },
  });

  await Promise.all([
    repository.transact((current) => {
      const root = current as Record<string, unknown>;
      return {
        next: { ...root, settings: { before: true, fromSettings: true } },
        result: undefined,
      };
    }),
    repository.transact((current) => {
      const root = current as Record<string, unknown>;
      return {
        next: { ...root, _memoIndex: { fromIndex: true } },
        result: undefined,
      };
    }),
  ]);

  assert.deepEqual(persisted, {
    settings: { before: true, fromSettings: true },
    _memoIndex: { fromIndex: true },
  });
});

test('keeps the previous complete envelope after a failed save and retries cleanly', async () => {
  let persisted: unknown = { settings: { keep: true }, future: { version: 2 } };
  let failNextSave = true;
  const repository = new SerializedDataRepository({
    loadData: async () => persisted,
    saveData: async (next: unknown) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('simulated plugin-data failure');
      }
      persisted = next;
    },
  });
  const store = new DurableCaptureStore(repository);
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'fault'),
    body: 'retry me',
    now: () => '2026-09-22T00:00:00.000Z',
  });

  await assert.rejects(store.createDraft(snapshot), /simulated plugin-data failure/);
  assert.deepEqual(await repository.read(), { settings: { keep: true }, future: { version: 2 } });
  await store.createDraft(snapshot);
  assert.equal((await store.get(snapshot.id))?.snapshot.body, 'retry me');
  assert.deepEqual(((await repository.read()) as Record<string, unknown>).future, { version: 2 });
});
