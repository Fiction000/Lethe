import assert from 'node:assert/strict';
import test from 'node:test';

import { CaptureRuntime, type CaptureRuntimeOptions } from '../src/capture/runtime';
import { ObsidianVaultAdapter } from '../src/capture/obsidianAdapter';
import { getCaptureRuntime, setCaptureRuntime } from '../src/capture/runtimeRegistry';
import { CaptureError, type CaptureId, type CaptureRecord, type NoteRef, type Revision } from '../src/capture/core';
import { createCaptureId } from '../src/capture/core';
import { SerializedDataRepository, type PluginDataPort } from '../src/capture/repository';
import type { VaultPort } from '../src/capture/writer';

class FakeVault implements VaultPort {
  public readonly files = new Map<string, string>();
  public readonly createCalls: string[] = [];
  public failNextCreate = false;

  public async list(folder: string): Promise<readonly string[]> {
    const prefix = `${folder.replace(/\/$/u, '')}/`;
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  public async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  public async create(path: string, content: string): Promise<void> {
    if (this.files.has(path)) {
      throw new Error(`already exists: ${path}`);
    }
    this.createCalls.push(path);
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error('vault unavailable');
    }
    this.files.set(path, content);
  }
}

let runtimePrefix = 0;

function makeRuntime(
  initial: unknown = {},
  configure: (port: TestDataPort) => void = () => undefined,
  sharedPort?: TestDataPort,
  defaultTags: readonly string[] = [],
): {
  runtime: CaptureRuntime;
  persisted: () => unknown;
  port: TestDataPort;
  vault: FakeVault;
} {
  const port = sharedPort ?? new TestDataPort(initial);
  configure(port);
  const repository = new SerializedDataRepository(port);
  const vault = new FakeVault();
  const options: CaptureRuntimeOptions = {
    repository,
    vault,
    now: () => '2026-09-22T00:00:00.000Z',
    createId: (() => {
      let next = 0;
      const prefix = `runtime-${runtimePrefix++}`;
      return () => createCaptureId(() => `${prefix}-${next++}`);
    })(),
    defaultTags,
  };
  return {
    runtime: new CaptureRuntime(options),
    persisted: () => port.value,
    port,
    vault,
  };
}

class TestDataPort implements PluginDataPort {
  public value: unknown;
  public saveCount = 0;
  public failNextSave = false;

  public constructor(value: unknown) {
    this.value = value;
  }

  public async loadData(): Promise<unknown> {
    return this.value;
  }

  public async saveData(data: unknown): Promise<void> {
    this.saveCount += 1;
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('data unavailable');
    }
    this.value = data;
  }
}

async function waitFor(predicate: () => boolean, timeout = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) {
      throw new Error('timed out waiting for runtime state');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function records(value: unknown): Record<string, CaptureRecord> {
  return ((value as Record<string, unknown>)._captureStore as { captures: Record<string, CaptureRecord> }).captures;
}

test('persists independent main and quick sessions through one repository', async () => {
  const first = makeRuntime({ futureNamespace: { keep: true } });
  const main = await first.runtime.openSession('main');
  const quick = await first.runtime.openSession('quick');

  assert.notEqual(main.getSnapshot().id, quick.getSnapshot().id);
  await Promise.all([main.update({ body: 'main body' }), quick.update({ body: 'quick body' })]);

  const stored = records(first.persisted());
  assert.equal(stored[main.getSnapshot().id].snapshot.body, 'main body');
  assert.equal(stored[quick.getSnapshot().id].snapshot.body, 'quick body');
  assert.deepEqual((first.persisted() as Record<string, unknown>).futureNamespace, { keep: true });

  const second = makeRuntime(first.persisted());
  const reopened = await second.runtime.openSession('main');
  assert.equal(reopened.getSnapshot().id, main.getSnapshot().id);
  assert.equal(reopened.getSnapshot().body, 'main body');
});

test('publishes and clears the runtime registry without constructing a second runtime', () => {
  const setup = makeRuntime();
  setCaptureRuntime(setup.runtime);
  assert.equal(getCaptureRuntime(), setup.runtime);
  setCaptureRuntime(undefined);
  assert.equal(getCaptureRuntime(), undefined);
});

test('updates memory before a failed draft save and commits the latest text', async () => {
  const setup = makeRuntime();
  const session = await setup.runtime.openSession('main');
  setup.port.failNextSave = true;

  await assert.rejects(session.update({ body: 'latest body' }), /data unavailable/);
  assert.equal(session.getSnapshot().body, 'latest body');
  assert.equal(session.getSnapshot().revision, 1);

  const submittedId = session.getSnapshot().id;
  const receipt = await session.submit();
  assert.equal(receipt.localPersisted, true);
  const submitted = records(setup.persisted())[submittedId];
  assert.equal(submitted.snapshot.body, 'latest body');
  assert.equal(submitted.lifecycle, 'submitted');
});

test('commits before save-and-next, keeps the profile, and exposes a retryable receipt', async () => {
  const setup = makeRuntime();
  const session = await setup.runtime.openSession('main');
  await session.update({ profile: 'book', body: 'book body' });
  const submittedId = session.getSnapshot().id;

  const receipt = await session.submit(true);

  assert.equal(receipt.captureId, submittedId);
  assert.equal(receipt.noteState, 'pending');
  assert.notEqual(session.getSnapshot().id, submittedId);
  assert.equal(session.getSnapshot().body, '');
  assert.equal(session.getSnapshot().profile, 'book');
  assert.deepEqual(session.getSnapshot().fields, {});
  assert.deepEqual(session.getSnapshot().tags, { userAdded: [], userRemoved: [] });

  await waitFor(() => records(setup.persisted())[submittedId]?.write.state === 'written');
  const writtenPath = records(setup.persisted())[submittedId].write.note?.path as string;
  assert.match((await setup.vault.read(writtenPath)) ?? '', /lethe_profile_id: book/);
  const recent = await setup.runtime.recent();
  assert.deepEqual(
    recent.map((record) => record.snapshot.id),
    [submittedId],
  );
});

test('applies changed default tags to captures without rebuilding the runtime', async () => {
  const setup = makeRuntime({}, () => undefined, undefined, ['old-default']);
  const session = await setup.runtime.openSession('main');
  assert.deepEqual(setup.runtime.getDefaultTags(), ['old-default']);
  await session.update({ body: 'old capture' });
  const oldId = session.getSnapshot().id;
  await session.submit();
  await waitFor(() => records(setup.persisted())[oldId]?.write.state === 'written');
  const oldPath = records(setup.persisted())[oldId].write.note?.path as string;
  assert.match((await setup.vault.read(oldPath)) ?? '', /- old-default/);

  setup.runtime.setDefaultTags(['new-default']);
  assert.deepEqual(setup.runtime.getDefaultTags(), ['new-default']);
  await session.update({ body: 'new capture' });
  const newId = session.getSnapshot().id;
  await session.submit();
  await waitFor(() => records(setup.persisted())[newId]?.write.state === 'written');
  const newPath = records(setup.persisted())[newId].write.note?.path as string;
  assert.match((await setup.vault.read(newPath)) ?? '', /- new-default/);
  assert.doesNotMatch((await setup.vault.read(newPath)) ?? '', /- old-default/);
});

test('recovers only pending or failed notes on startup and retries failed writes', async () => {
  const setup = makeRuntime();
  const session = await setup.runtime.openSession('main');
  await session.update({ body: 'recover me' });
  const submittedId = session.getSnapshot().id;
  setup.vault.failNextCreate = true;
  await session.submit();
  await waitFor(() => records(setup.persisted())[submittedId]?.write.state === 'failed');
  const createsBeforeRestart = setup.vault.createCalls.length;

  const restarted = makeRuntime(setup.persisted());
  await restarted.runtime.openSession('quick');
  await waitFor(() => records(restarted.persisted())[submittedId]?.write.state === 'written');
  assert.equal(restarted.vault.createCalls.length, 1);
  assert.equal(createsBeforeRestart, 1);
});

test('does not resend a written note and supports open, rename, delete, and retry actions', async () => {
  const opened: NoteRef[] = [];
  const setup = makeRuntime();
  const session = await setup.runtime.openSession('main');
  await session.update({ body: 'action note' });
  const submittedId = session.getSnapshot().id;
  await session.submit();
  await waitFor(() => records(setup.persisted())[submittedId]?.write.state === 'written');

  const written = records(setup.persisted())[submittedId].write.note as NoteRef;
  const renamed = `${written.path}-renamed`;
  setup.vault.files.set(renamed, setup.vault.files.get(written.path) as string);
  setup.vault.files.delete(written.path);
  await setup.runtime.handleVaultRename(written.path, renamed);
  const renamedRecord = records(setup.persisted())[submittedId];
  assert.equal(renamedRecord.write.note?.path, renamed);

  const runtimeWithOpen = setup.runtime;
  runtimeWithOpen.setNoteOpener(async (note) => {
    opened.push(note);
  });
  await runtimeWithOpen.openNote(submittedId);
  assert.equal(opened[0].path, renamed);

  const createsBeforeDelete = setup.vault.createCalls.length;
  await setup.runtime.handleVaultDelete(renamed);
  assert.equal(records(setup.persisted())[submittedId].write.state, 'deleted');
  await setup.runtime.retry(submittedId);
  assert.equal(setup.vault.createCalls.length, createsBeforeDelete);
});

test('does not make a committed capture editable when next-draft allocation fails', async () => {
  const setup = makeRuntime({}, (port) => {
    const original = port.saveData.bind(port);
    let saveCount = 0;
    port.saveData = async (data: unknown) => {
      saveCount += 1;
      if (saveCount === 5) {
        throw new Error('next draft unavailable');
      }
      await original(data);
    };
  });
  const session = await setup.runtime.openSession('main');
  await session.update({ body: 'committed body' });
  const submittedId = session.getSnapshot().id;

  await assert.rejects(session.submit(), /next draft unavailable/);
  assert.equal(records(setup.persisted())[submittedId].lifecycle, 'submitted');
  await assert.rejects(session.submit(), CaptureError);

  const replacement = await setup.runtime.openSession('main');
  assert.notEqual(replacement.getSnapshot().id, submittedId);
  assert.equal(records(setup.persisted())[replacement.getSnapshot().id].lifecycle, 'draft');
});

test('adapts Obsidian vault create, recursive listing, readback, and note opening', async () => {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const opened: string[] = [];
  const vault = {
    getMarkdownFiles: () =>
      [...files.keys()].map((path) => ({ path, extension: 'md' })) as Array<{ path: string; extension: string }>,
    getAbstractFileByPath: (path: string) => {
      if (files.has(path)) {
        return { path, extension: 'md' };
      }
      if (folders.has(path)) {
        return { path, children: [] as unknown[] };
      }
      return null;
    },
    read: async (file: { path: string }) => files.get(file.path) ?? '',
    createFolder: async (path: string) => {
      folders.add(path);
    },
    create: async (path: string, content: string) => {
      files.set(path, content);
      return { path, extension: 'md' };
    },
  };
  const app = {
    vault,
    workspace: {
      getLeaf: () => ({
        openFile: async (file: { path: string }) => {
          opened.push(file.path);
        },
      }),
    },
  };
  const adapter = new ObsidianVaultAdapter(app as never);

  await adapter.create('Inbox/2026/note.md', 'body');
  assert.deepEqual(await adapter.list('Inbox'), ['Inbox/2026/note.md']);
  assert.equal(await adapter.read('Inbox/2026/note.md'), 'body');
  await adapter.openNote({
    captureId: 'cap_adapter' as CaptureId,
    revision: 0 as Revision,
    path: 'Inbox/2026/note.md',
    folder: 'inbox',
  });
  assert.deepEqual([...folders], ['Inbox', 'Inbox/2026']);
  assert.deepEqual(opened, ['Inbox/2026/note.md']);
});

test('coalesces duplicate submissions and rotates discard to a new persistent draft', async () => {
  const setup = makeRuntime();
  const session = await setup.runtime.openSession('main');
  await session.update({ body: 'discarded body' });
  const discardedId = session.getSnapshot().id;
  const first = session.submit();
  assert.equal(session.submit(), first);
  await first;

  const submittedId = discardedId;
  const next = await setup.runtime.openSession('main');
  assert.notEqual(next.getSnapshot().id, submittedId);
  await next.discard();
  assert.notEqual(next.getSnapshot().id, submittedId);
  assert.equal(records(setup.persisted())[submittedId].lifecycle, 'submitted');
  assert.equal(records(setup.persisted())[next.getSnapshot().id].lifecycle, 'draft');
});

test('publishes busy before commit so a second host cannot overwrite a stale same-id draft', async () => {
  const first = makeRuntime();
  const firstSession = await first.runtime.openSession('main');
  await firstSession.update({ body: 'first body' });

  const second = makeRuntime({}, () => undefined, first.port);
  const secondSession = await second.runtime.openSession('main');
  assert.equal(secondSession.getSnapshot().body, 'first body');

  let releaseCommit!: () => void;
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  const originalSave = first.port.saveData.bind(first.port);
  let saveCount = 0;
  first.port.saveData = async (data: unknown): Promise<void> => {
    saveCount += 1;
    if (saveCount === 2) {
      await commitGate;
    }
    await originalSave(data);
  };

  const submission = firstSession.submit();
  await waitFor(() => {
    const sessions = (first.persisted() as Record<string, unknown>)._captureSessions as Record<string, unknown>;
    const busy = sessions?.busy as Record<string, unknown> | undefined;
    return busy?.main !== undefined;
  });

  const staleUpdate = secondSession.update({ body: 'stale extra' });
  await assert.rejects(
    staleUpdate,
    (error: unknown) => error instanceof CaptureError && error.code === 'capture_submitting',
  );
  assert.equal(secondSession.getSnapshot().body, 'first body');

  releaseCommit();
  await submission;
  assert.equal(records(first.persisted())[firstSession.getSnapshot().id].snapshot.body, '');
  const submitted = Object.values(records(first.persisted())).find(
    (record) => record.lifecycle === 'submitted',
  ) as CaptureRecord;
  assert.equal(submitted.snapshot.body, 'first body');
});
