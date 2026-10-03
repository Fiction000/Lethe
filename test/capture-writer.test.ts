import assert from 'node:assert/strict';
import test from 'node:test';

import { DurableCaptureStore, createCaptureId, createDraftSnapshot } from '../src/capture/core';
import { SerializedDataRepository } from '../src/capture/repository';
import {
  IndividualNoteWriter,
  type CaptureStorePort,
  type MaterializedCapture,
  type VaultPort,
  deterministicNotePath,
  renderNote,
} from '../src/capture/writer';

class FakeVault implements VaultPort {
  public readonly files = new Map<string, string>();
  public readonly createCalls: string[] = [];
  public failAfterCreate = false;
  public failBeforeCreate = false;
  public createDelay = false;

  public async list(folder: string): Promise<readonly string[]> {
    const prefix = `${folder.replace(/\/$/u, '')}/`;
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  public async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  public async create(path: string, content: string): Promise<void> {
    if (this.createDelay) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (this.files.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
    this.createCalls.push(path);
    if (this.failBeforeCreate) {
      this.failBeforeCreate = false;
      throw new Error('vault unavailable before create');
    }
    this.files.set(path, content);
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw new Error('create response lost after file creation');
    }
  }
}

function makeStore() {
  let persisted: unknown = {};
  const repository = new SerializedDataRepository({
    loadData: async () => persisted,
    saveData: async (next: unknown) => {
      persisted = next;
    },
  });
  return new DurableCaptureStore(repository);
}

async function submittedCapture(body = '  hello\n\n---\n') {
  const store = makeStore();
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'writer'),
    body,
    now: () => '2026-09-22T00:00:00.000Z',
  });
  await store.createDraft(snapshot);
  await store.commitSubmission(snapshot);
  return { store, snapshot };
}

function materialized(snapshot: Awaited<ReturnType<typeof submittedCapture>>['snapshot']): MaterializedCapture {
  return {
    snapshot,
    profileSchemaVersion: 1,
    properties: { rating: 5, aliases: ['one', 'two'] },
    tags: ['type/book'],
  };
}

test('writes one deterministic marker note and reuses it on retry', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture();
  const writer = new IndividualNoteWriter({ vault, store });

  const first = await writer.ensureWritten(materialized(snapshot));
  const second = await writer.ensureWritten(materialized(snapshot));
  const content = await vault.read(first.note.path);

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.note.path, first.note.path);
  assert.equal(vault.createCalls.length, 1);
  assert.match(content ?? '', /lethe_capture_id: cap_writer/);
  assert.match(content ?? '', /lethe_capture_revision: 0/);
  assert.match(content ?? '', /lethe_profile_id: auto/);
  assert.match(content ?? '', /lethe_profile_schema_version: 1/);
  assert.match(content ?? '', /rating: 5/);
  assert.equal((content ?? '').endsWith(snapshot.body), true);
});

test('writes once when overlapping ensure calls race for the same capture', async () => {
  const vault = new FakeVault();
  vault.createDelay = true;
  const { store, snapshot } = await submittedCapture('overlap');
  const writer = new IndividualNoteWriter({ vault, store });
  const note = materialized(snapshot);

  const [first, second] = await Promise.all([writer.ensureWritten(note), writer.ensureWritten(note)]);

  assert.equal(first.note.path, second.note.path);
  assert.equal(vault.createCalls.length, 1);
  assert.equal((await store.get(snapshot.id))?.write.state, 'written');
});

test('reconciles a vault create error after the file was actually created', async () => {
  const vault = new FakeVault();
  vault.failAfterCreate = true;
  const { store, snapshot } = await submittedCapture('body survives');
  const writer = new IndividualNoteWriter({ vault, store });

  await assert.rejects(writer.ensureWritten(materialized(snapshot)));
  const recovered = await writer.ensureWritten(materialized(snapshot));

  assert.equal(recovered.created, false);
  assert.equal(vault.createCalls.length, 1);
  assert.equal((await store.get(snapshot.id))?.write.state, 'written');
});

test('does not overwrite an unrelated deterministic path', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture('Collision title');
  const originalPath = deterministicNotePath(snapshot, 'Inbox');
  vault.files.set(originalPath, 'unmanaged file');
  const writer = new IndividualNoteWriter({ vault, store });

  const receipt = await writer.ensureWritten(materialized(snapshot));

  assert.notEqual(receipt.note.path, originalPath);
  assert.equal(await vault.read(originalPath), 'unmanaged file');
  assert.equal(vault.createCalls.length, 1);
});

test('marks a missing known note deleted and never recreates it', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture('delete me');
  const writer = new IndividualNoteWriter({ vault, store });

  const first = await writer.ensureWritten(materialized(snapshot));
  vault.files.delete(first.note.path);

  await assert.rejects(writer.ensureWritten(materialized(snapshot)));
  const callsAfterDeletion = vault.createCalls.length;
  await assert.rejects(writer.ensureWritten(materialized(snapshot)));

  assert.equal((await store.get(snapshot.id))?.write.state, 'deleted');
  assert.equal(vault.createCalls.length, callsAfterDeletion);
});

test('rebinds a note renamed while the plugin was unavailable without recreating it', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture('renamed offline');
  const writer = new IndividualNoteWriter({ vault, store });
  const first = await writer.ensureWritten(materialized(snapshot));
  const body = await vault.read(first.note.path);
  vault.files.delete(first.note.path);
  vault.files.set('Notes/renamed.md', body as string);

  const restartedWriter = new IndividualNoteWriter({ vault, store });
  const receipt = await restartedWriter.ensureWritten(materialized(snapshot));
  assert.equal(receipt.note.path, 'Notes/renamed.md');
  assert.equal(receipt.created, false);
  assert.equal((await store.get(snapshot.id))?.write.note?.path, 'Notes/renamed.md');
  assert.equal(vault.createCalls.length, 1);
});

test('rejects duplicate marker matches and records a conflict instead of choosing one', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture('ambiguous');
  const note = materialized(snapshot);
  vault.files.set('Inbox/first.md', renderNote(note));
  vault.files.set('Notes/second.md', renderNote(note));
  const writer = new IndividualNoteWriter({ vault, store });

  await assert.rejects(writer.ensureWritten(note), /multiple notes/i);

  assert.equal((await store.get(snapshot.id))?.write.state, 'conflict');
  assert.equal(vault.createCalls.length, 0);
});

test('preserves an edited body and records a reconciliation conflict', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture('original body');
  const note = materialized(snapshot);
  vault.files.set('Inbox/edited.md', `${renderNote(note)}\nuser edit`);
  const writer = new IndividualNoteWriter({ vault, store });

  await assert.rejects(writer.ensureWritten(note), /body was edited/i);

  assert.equal((await store.get(snapshot.id))?.write.state, 'conflict');
  assert.equal(vault.createCalls.length, 0);
});

test('binds a pre-existing matching marker without creating a duplicate', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture('already here');
  const note = materialized(snapshot);
  vault.files.set('Notes/already-here.md', renderNote(note));
  const writer = new IndividualNoteWriter({ vault, store });

  const receipt = await writer.ensureWritten(note);

  assert.equal(receipt.created, false);
  assert.equal(receipt.note.path, 'Notes/already-here.md');
  assert.equal(vault.createCalls.length, 0);
});

test('records a failed vault create while keeping the submission retryable', async () => {
  const vault = new FakeVault();
  vault.failBeforeCreate = true;
  const { store, snapshot } = await submittedCapture('temporary vault outage');
  const writer = new IndividualNoteWriter({ vault, store });
  const note = materialized(snapshot);

  await assert.rejects(writer.ensureWritten(note), /vault unavailable/);
  assert.equal((await store.get(snapshot.id))?.write.state, 'failed');
  const retry = await writer.ensureWritten(note);

  assert.equal(retry.created, true);
  assert.equal((await store.get(snapshot.id))?.write.state, 'written');
});

test('binds the marker after receipt persistence fails instead of creating a duplicate', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture('receipt fault');
  let failReceipt = true;
  const flakyStore: CaptureStorePort = {
    get: store.get.bind(store),
    markNoteWritten: async (id, revision, note) => {
      if (failReceipt) {
        failReceipt = false;
        throw new Error('plugin-data receipt failure');
      }
      return store.markNoteWritten(id, revision, note);
    },
    markNoteFailure: store.markNoteFailure.bind(store),
    markNoteConflict: store.markNoteConflict.bind(store),
    markNoteDeleted: store.markNoteDeleted.bind(store),
  };
  const writer = new IndividualNoteWriter({ vault, store: flakyStore });
  const note = materialized(snapshot);

  await assert.rejects(writer.ensureWritten(note), /receipt failure/);
  const recovered = await writer.ensureWritten(note);

  assert.equal(recovered.created, false);
  assert.equal(vault.createCalls.length, 1);
  assert.equal((await store.get(snapshot.id))?.write.state, 'written');
});

test('rejects unsafe configured paths before touching the vault', async () => {
  const vault = new FakeVault();
  const { store } = await submittedCapture();

  assert.throws(() => new IndividualNoteWriter({ vault, store, inboxFolder: '../Inbox' }), /unsafe vault path/i);
  assert.equal(vault.createCalls.length, 0);
});

test('rejects a persisted unsafe note path before reading or recreating it', async () => {
  const vault = new FakeVault();
  const { store, snapshot } = await submittedCapture('unsafe stored path');
  await store.markNoteWritten(snapshot.id, snapshot.revision, {
    captureId: snapshot.id,
    revision: snapshot.revision,
    path: '../escape.md',
    folder: 'inbox',
  });
  const writer = new IndividualNoteWriter({ vault, store });

  await assert.rejects(writer.ensureWritten(materialized(snapshot)), /unsafe vault path/i);
  assert.equal(vault.createCalls.length, 0);
});
