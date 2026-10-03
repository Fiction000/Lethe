import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCaptureId, type CaptureRecord } from '../src/capture/core';
import { CaptureRuntime } from '../src/capture/runtime';
import { SerializedDataRepository, type PluginDataPort } from '../src/capture/repository';
import type { VaultPort } from '../src/capture/writer';
import type { OrganizationRuntimeBridge } from '../src/organization/runtimeBridge';

class TestDataPort implements PluginDataPort {
  public saveCount = 0;
  public failAtSave?: number;
  public persistBeforeFailure = false;

  public constructor(public value: unknown = {}) {}

  public async loadData(): Promise<unknown> {
    return this.value;
  }

  public async saveData(next: unknown): Promise<void> {
    this.saveCount += 1;
    if (this.saveCount === this.failAtSave) {
      this.failAtSave = undefined;
      if (this.persistBeforeFailure) {
        this.value = next;
      }
      throw new Error('enrollment persistence unavailable');
    }
    this.value = next;
  }
}

class TestVault implements VaultPort {
  public readonly files = new Map<string, string>();

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
    this.files.set(path, content);
  }
}

let idSequence = 0;

function makeOrganization(): OrganizationRuntimeBridge {
  return {
    getOrganizationMode: () => 'advisory',
    subscribe: () => () => undefined,
    initialize: async () => undefined,
    enqueue: async () => ({}),
    getJob: async () => undefined,
    listJobs: async () => [],
    retry: async () => undefined,
    skip: async () => undefined,
    undo: async () => undefined,
    dispose: async () => undefined,
  } as unknown as OrganizationRuntimeBridge;
}

function makeRuntime(port: TestDataPort, organization?: OrganizationRuntimeBridge): CaptureRuntime {
  const repository = new SerializedDataRepository(port);
  return new CaptureRuntime({
    repository,
    vault: new TestVault(),
    organization,
    now: () => '2026-09-23T00:00:00.000Z',
    createId: () => createCaptureId(() => `jev-send-${idSequence++}`),
  });
}

function root(value: unknown): Record<string, any> {
  return value as Record<string, any>;
}

function records(value: unknown): Record<string, CaptureRecord> {
  return root(value)._captureStore.captures as Record<string, CaptureRecord>;
}

function busy(value: unknown, key: 'main' | 'quick' = 'main'): unknown {
  return root(value)._captureSessions?.busy?.[key];
}

test('the composer footer delegates Send to the editor confirm action', () => {
  const composer = readFileSync(new URL('../src/components/CaptureComposer.tsx', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../src/components/Editor/Editor.tsx', import.meta.url), 'utf8');

  assert.match(composer, /onClick=\{\(\) => void editorRef\.current\?\.confirm\(\)\}/u);
  assert.doesNotMatch(composer, /onClick=\{\(\) => void handleSubmit\(snapshot\.body\)\}/u);
  assert.match(editor, /confirm:\s*\(\) => Promise<void>/u);
});

test('clears enrollment claim busy after a transient save failure so the same draft can retry', async () => {
  const port = new TestDataPort();
  const runtime = makeRuntime(port, makeOrganization());
  const session = await runtime.openSession('main');
  await session.update({ body: 'retry this exact draft' });
  const captureId = session.getSnapshot().id;

  // update() saved once; claim saves next; enrollment save is the following transaction.
  port.failAtSave = port.saveCount + 2;
  port.persistBeforeFailure = true;
  await assert.rejects(session.submit(), /enrollment persistence unavailable/u);

  assert.equal(busy(port.value), undefined);
  assert.equal(root(port.value)._organizationEnrollment, undefined);
  assert.equal(records(port.value)[captureId].lifecycle, 'draft');
  assert.equal(session.getSnapshot().body, 'retry this exact draft');

  const receipt = await session.submit();
  assert.equal(receipt.captureId, captureId);
  assert.equal(records(port.value)[captureId].lifecycle, 'submitted');
  assert.equal(busy(port.value), undefined);
});

test('keeps the claim when the commit was durable but its transaction reported failure', async () => {
  const port = new TestDataPort();
  const runtime = makeRuntime(port);
  const session = await runtime.openSession('main');
  await session.update({ body: 'committed despite the error' });
  const snapshot = session.getSnapshot();

  // update() saved once; claim saves next; commit persists and then reports an error.
  port.failAtSave = port.saveCount + 2;
  port.persistBeforeFailure = true;
  await assert.rejects(session.submit(), /unavailable/u);

  assert.equal(records(port.value)[snapshot.id].lifecycle, 'submitted');
  assert.deepEqual(busy(port.value), { captureId: snapshot.id, revision: snapshot.revision });
});

test('releases a stale pre-commit busy claim on restart but never clears a committed claim', async () => {
  const port = new TestDataPort();
  const first = makeRuntime(port);
  const draft = await first.openSession('main');
  await draft.update({ body: 'draft interrupted before commit' });
  const draftSnapshot = draft.getSnapshot();
  const draftRoot = root(port.value);
  draftRoot._captureSessions.busy = {
    ...(draftRoot._captureSessions.busy ?? {}),
    main: { captureId: draftSnapshot.id, revision: draftSnapshot.revision },
  };
  port.value = draftRoot;

  const restarted = makeRuntime(port);
  const reopened = await restarted.openSession('main');
  assert.equal(reopened.getSnapshot().id, draftSnapshot.id);
  assert.equal(reopened.getSnapshot().body, 'draft interrupted before commit');
  assert.equal(busy(port.value), undefined);

  await reopened.submit();
  const committed = Object.values(records(port.value)).find((record) => record.lifecycle === 'submitted');
  assert.ok(committed);
  const committedRoot = root(port.value);
  const committedBusy = {
    captureId: committed.snapshot.id,
    revision: committed.snapshot.revision,
  };
  committedRoot._captureSessions.busy = { ...(committedRoot._captureSessions.busy ?? {}), main: committedBusy };
  port.value = committedRoot;

  const secondRestart = makeRuntime(port);
  await secondRestart.initialize();
  assert.deepEqual(busy(port.value), committedBusy);
});
