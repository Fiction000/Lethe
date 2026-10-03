import assert from 'node:assert/strict';
import test from 'node:test';

import { CaptureRuntime, type CaptureRuntimeOptions } from '../src/capture/runtime';
import { createCaptureId, type CaptureRecord, type CaptureSnapshot } from '../src/capture/core';
import { SerializedDataRepository, type PluginDataPort } from '../src/capture/repository';
import type { VaultPort } from '../src/capture/writer';
import {
  createObsidianFrontmatterPort,
  ObsidianOrganizationVaultAdapter,
  type ObsidianYamlApi,
} from '../src/organization/obsidianAdapter';
import {
  OrganizationRuntimeBridge,
  stripOrganizationRuntimeNamespaces,
  type OrganizationPolicyHook,
} from '../src/organization/runtimeBridge';
import { OrganizationExecutor, type OrganizationVaultPort } from '../src/organization/executor';
import { OrganizationQueue, type OrganizationDecisionProvider } from '../src/organization/queue';
import type {
  OrganizationBaseline,
  OrganizationDecision,
  OrganizationLocalReceipt,
  OrganizationSubmission,
} from '../src/organization/types';
import { createDraftSnapshot } from '../src/capture/core';

class MemoryDataPort implements PluginDataPort {
  public saveCount = 0;
  public failNextSave = false;

  public constructor(public value: unknown = {}) {}

  public async loadData(): Promise<unknown> {
    return this.value;
  }

  public async saveData(next: unknown): Promise<void> {
    this.saveCount += 1;
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('simulated repository crash');
    }
    this.value = next;
  }
}

class MemoryVault implements VaultPort, OrganizationVaultPort {
  public readonly files = new Map<string, string>();
  public readonly createCalls: string[] = [];
  public readonly writes: Array<{ path: string; expected: string; content: string }> = [];
  public readonly renames: Array<{ from: string; to: string }> = [];
  public afterWrite?: () => void;

  public async list(folder: string): Promise<readonly string[]> {
    const prefix = `${folder.replace(/\/$/u, '')}/`;
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  public async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  public async create(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new Error(`already exists: ${path}`);
    this.createCalls.push(path);
    this.files.set(path, content);
  }

  public async write(path: string, content: string, expectedContent: string): Promise<void> {
    const current = this.files.get(path);
    if (current === undefined) throw new Error(`missing file: ${path}`);
    if (current !== expectedContent) throw new Error('compare-and-swap conflict');
    this.writes.push({ path, expected: expectedContent, content });
    this.files.set(path, content);
    this.afterWrite?.();
  }

  public async rename(from: string, to: string): Promise<void> {
    const content = this.files.get(from);
    if (content === undefined) throw new Error(`missing source: ${from}`);
    if (this.files.has(to)) throw new Error(`target exists: ${to}`);
    this.files.delete(from);
    this.files.set(to, content);
    this.renames.push({ from, to });
  }
}

const jsonYaml: ObsidianYamlApi = {
  parseYaml: (yaml: string) => {
    const trimmed = yaml.trim();
    if (trimmed === '') return {};
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    const result: Record<string, unknown> = {};
    let activeArray: string | undefined;
    for (const line of trimmed.split(/\r?\n/u)) {
      const item = /^\s*-\s+(.*)$/u.exec(line);
      if (item && activeArray !== undefined) {
        const values = (result[activeArray] as string[] | undefined) ?? [];
        values.push(item[1]);
        result[activeArray] = values;
        continue;
      }
      const match = /^([^:]+):(?:\s+(.*))?$/u.exec(line);
      if (!match) continue;
      const key = match[1].trim();
      const raw = match[2] ?? '';
      if (raw === '') {
        activeArray = key;
        result[key] = [];
      } else if (/^-?\d+$/u.test(raw)) {
        activeArray = undefined;
        result[key] = Number(raw);
      } else {
        activeArray = undefined;
        result[key] =
          raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))
            ? raw.slice(1, -1)
            : raw;
      }
    }
    return result;
  },
  stringifyYaml: (value: unknown) => `${JSON.stringify(value)}\n`,
};

function noteContent(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
}

function makeRepository(initial: unknown = {}): { repository: SerializedDataRepository; port: MemoryDataPort } {
  const port = new MemoryDataPort(initial);
  return { repository: new SerializedDataRepository(port), port };
}

function currentCaptureRecords(value: unknown): Record<string, CaptureRecord> {
  const root = value as Record<string, unknown>;
  return ((root._captureStore as { captures: Record<string, CaptureRecord> }).captures ?? {}) as Record<
    string,
    CaptureRecord
  >;
}

async function waitFor(predicate: () => boolean, timeout = 1500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for organization state');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function policyThatReturnsTags(): OrganizationPolicyHook {
  return async () => ({ outcome: 'certain', tags: ['ai/approved'] });
}

function makeBridge(
  repository: SerializedDataRepository,
  vault: MemoryVault,
  options: {
    mode?: 'off' | 'advisory' | 'automatic';
    provider?: OrganizationDecisionProvider;
    policy?: OrganizationPolicyHook;
    readApiKey?: (secretId: string) => string | null;
    maxAttempts?: number;
  } = {},
): OrganizationRuntimeBridge {
  return new OrganizationRuntimeBridge({
    repository,
    vault,
    frontmatter: createObsidianFrontmatterPort(jsonYaml),
    settings: {
      mode: options.mode ?? 'automatic',
      model: 'jev-latest',
      secretId: 'test-secret',
      approvedTags: [{ tag: 'ai/approved', description: 'approved' }],
    },
    provider: options.provider,
    policy: options.policy ?? policyThatReturnsTags(),
    readApiKey: options.readApiKey ?? (() => 'synthetic-test-key'),
    retry: { maxAttempts: options.maxAttempts ?? 1, baseDelayMs: 0, maxDelayMs: 0 },
  });
}

function makeRuntime(
  repository: SerializedDataRepository,
  vault: MemoryVault,
  organization?: OrganizationRuntimeBridge,
): CaptureRuntime {
  const options: CaptureRuntimeOptions = {
    repository,
    vault,
    organization,
    now: () => '2026-09-23T00:00:00.000Z',
    createId: (() => {
      let next = 0;
      return () => createCaptureId(() => `integration-${next++}`);
    })(),
  };
  return new CaptureRuntime(options);
}

function submissionFor(snapshot: CaptureSnapshot, content: string, path = 'Inbox/body.md'): OrganizationSubmission {
  const baseline: OrganizationBaseline = { path, folder: 'inbox', content };
  const localReceipt: OrganizationLocalReceipt = {
    captureId: snapshot.id,
    revision: snapshot.revision,
    localPersisted: true,
    notePath: baseline.path,
    noteFolder: baseline.folder,
    persistedAt: '2026-09-23T00:00:00.000Z',
  };
  return { snapshot, localReceipt, baseline, intent: 'opt-in', policy: 'automatic', overrides: {} };
}

async function waitUntilJob(
  runtime: CaptureRuntime,
  id: CaptureSnapshot['id'],
  predicate: (status: string) => boolean,
): Promise<NonNullable<Awaited<ReturnType<CaptureRuntime['getOrganizationStatus']>>>> {
  const started = Date.now();
  for (;;) {
    const job = await runtime.getOrganizationStatus(id);
    if (job !== undefined && predicate(job.status)) return job;
    if (Date.now() - started > 1500) throw new Error('timed out waiting for capture organization job');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test('uses Obsidian YAML functions, preserves unknown frontmatter, and keeps body bytes exact', () => {
  const port = createObsidianFrontmatterPort(jsonYaml);
  const body = '\n  exact body\n\n';
  const parsed = port.parse(noteContent({ lethe_capture_id: 'cap', unknown: { keep: true } }, body));

  assert.deepEqual(parsed.frontmatter, { lethe_capture_id: 'cap', unknown: { keep: true } });
  assert.equal(parsed.body, body);
  const serialized = port.serialize({ frontmatter: { ...parsed.frontmatter, generated: 'yes' }, body: parsed.body });
  assert.match(serialized, /unknown/);
  assert.match(serialized, /generated/);
  assert.equal(serialized.slice(serialized.indexOf('\n---\n') + 5), body);
});

test('organization vault adapter performs atomic compare-and-swap and uses fileManager rename', async () => {
  const files = new Map<string, string>([['Inbox/note.md', 'old']]);
  const folders = new Set<string>();
  const processed: string[] = [];
  const renamed: string[] = [];
  const app = {
    vault: {
      getMarkdownFiles: () => [{ path: 'Inbox/note.md', extension: 'md' }],
      getAbstractFileByPath: (path: string) => {
        if (files.has(path)) return { path, extension: 'md' };
        if (folders.has(path)) return { path, children: [] };
        return null;
      },
      read: async (file: { path: string }) => files.get(file.path) ?? '',
      process: async (file: { path: string }, callback: (current: string) => string) => {
        processed.push(file.path);
        const next = callback(files.get(file.path) ?? '');
        files.set(file.path, next);
      },
      createFolder: async (path: string) => {
        folders.add(path);
      },
    },
    fileManager: {
      renameFile: async (file: { path: string }, path: string) => {
        renamed.push(`${file.path}->${path}`);
        const content = files.get(file.path) as string;
        files.delete(file.path);
        files.set(path, content);
      },
    },
  };
  const adapter = new ObsidianOrganizationVaultAdapter(app as never);

  await adapter.write('Inbox/note.md', 'new', 'old');
  await adapter.rename('Inbox/note.md', 'Notes/note.md');
  assert.deepEqual(processed, ['Inbox/note.md']);
  assert.deepEqual(renamed, ['Inbox/note.md->Notes/note.md']);
  assert.deepEqual([...folders], ['Notes']);
  assert.equal(await adapter.read('Notes/note.md'), 'new');

  await assert.rejects(adapter.write('Notes/note.md', 'lost', 'old'), /compare-and-swap/i);
  assert.equal(await adapter.read('Notes/note.md'), 'new');
});

test('slow organization provider does not block local send and disabled mode never calls it', async () => {
  const data = makeRepository();
  const vault = new MemoryVault();
  let release!: (decision: OrganizationDecision) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const provider: OrganizationDecisionProvider = {
    decide: async () => {
      started();
      return new Promise<OrganizationDecision>((resolve) => {
        release = resolve;
      });
    },
  };
  const bridge = makeBridge(data.repository, vault, { provider });
  const runtime = makeRuntime(data.repository, vault, bridge);
  const session = await runtime.openSession('main');
  await session.update({ body: 'slow send' });
  const id = session.getSnapshot().id;

  const startedAt = Date.now();
  const receipt = await session.submit();
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(receipt.localPersisted, true);
  assert.notEqual(session.getSnapshot().id, id);
  await startedPromise;
  release({ outcome: 'certain', tags: ['ai/slow'] });
  await bridge.queue.waitForIdle();
  assert.equal((await runtime.getOrganizationStatus(id))?.status, 'applied');
  await runtime.dispose();

  const disabledData = makeRepository();
  const disabledVault = new MemoryVault();
  let disabledCalls = 0;
  const disabledBridge = makeBridge(disabledData.repository, disabledVault, {
    mode: 'off',
    provider: {
      decide: async () => {
        disabledCalls += 1;
        return { outcome: 'certain' };
      },
    },
  });
  const disabledRuntime = makeRuntime(disabledData.repository, disabledVault, disabledBridge);
  const disabledSession = await disabledRuntime.openSession('quick');
  await disabledSession.update({ body: 'offline send' });
  const disabledId = disabledSession.getSnapshot().id;
  await disabledSession.submit();
  await waitUntilJob(disabledRuntime, disabledId, (status) => status === 'skipped');
  assert.equal(disabledCalls, 0);
  await disabledRuntime.dispose();
});

test('provider errors stay off the send path and become a bounded failed job', async () => {
  const data = makeRepository();
  const vault = new MemoryVault();
  const bridge = makeBridge(data.repository, vault, {
    provider: {
      decide: async () => {
        throw new Error('provider is unavailable');
      },
    },
  });
  const runtime = makeRuntime(data.repository, vault, bridge);
  const session = await runtime.openSession('main');
  await session.update({ body: 'error send' });
  const id = session.getSnapshot().id;
  await session.submit();
  const job = await waitUntilJob(runtime, id, (status) => status === 'failed');
  assert.equal(job.lastError?.message, 'Decision provider failed');
  assert.equal(currentCaptureRecords(data.port.value)[id].write.state, 'written');
  await runtime.dispose();
});

test('recovers an opted-in written receipt after a crash before enqueue without uploading an old backlog', async () => {
  const data = makeRepository();
  const vault = new MemoryVault();
  const syntheticProvider: OrganizationDecisionProvider = {
    decide: async () => ({ outcome: 'certain', tags: ['ai/recovered'] }),
  };
  const firstBridge = makeBridge(data.repository, vault, { provider: syntheticProvider });
  const firstEnqueue = firstBridge.enqueue.bind(firstBridge);
  let failOnce = true;
  firstBridge.enqueue = async (submission) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('crash after written receipt');
    }
    return firstEnqueue(submission);
  };
  const firstRuntime = makeRuntime(data.repository, vault, firstBridge);
  const session = await firstRuntime.openSession('main');
  await session.update({ body: 'recover enrollment' });
  const id = session.getSnapshot().id;
  await session.submit();
  await waitFor(() => currentCaptureRecords(data.port.value)[id]?.write.state === 'written');
  assert.equal((data.port.value as Record<string, unknown>)._organizationEnrollment !== undefined, true);
  await firstRuntime.dispose();

  const restartedBridge = makeBridge(data.repository, vault, { provider: syntheticProvider });
  const restarted = makeRuntime(data.repository, vault, restartedBridge);
  await restarted.initialize();
  const recovered = await waitUntilJob(restarted, id, (status) => status === 'applied');
  assert.equal(recovered.intent, 'opt-in');
  assert.equal((data.port.value as Record<string, unknown>)._organizationEnrollment, undefined);
  await restarted.dispose();
});

test('uses the persisted baseline and declines a note edited after local save', async () => {
  const data = makeRepository();
  const vault = new MemoryVault();
  let release!: (decision: OrganizationDecision) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const bridge = makeBridge(data.repository, vault, {
    provider: {
      decide: async () => {
        started();
        return new Promise<OrganizationDecision>((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const runtime = makeRuntime(data.repository, vault, bridge);
  const session = await runtime.openSession('main');
  await session.update({ body: 'edit after save' });
  const id = session.getSnapshot().id;
  await session.submit();
  await startedPromise;
  const record = currentCaptureRecords(data.port.value)[id];
  const path = record.write.note?.path as string;
  vault.files.set(path, `${vault.files.get(path) as string}user edit`);
  release({ outcome: 'certain', tags: ['ai/edit'] });
  await bridge.queue.waitForIdle();
  const job = await runtime.getOrganizationStatus(id);
  assert.equal(job?.status, 'conflict');
  assert.equal(job?.lastError?.code, 'changed-baseline');
  assert.match((await vault.read(path)) as string, /user edit$/u);
  await runtime.dispose();
});

test('missing secret produces a safe provider failure without persisting or exposing the key', async () => {
  const data = makeRepository();
  const vault = new MemoryVault();
  let transportCalls = 0;
  const bridge = makeBridge(data.repository, vault, {
    readApiKey: () => null,
    policy: policyThatReturnsTags(),
  });
  bridge.setTransport(async () => {
    transportCalls += 1;
    throw new Error('must not send');
  });
  const runtime = makeRuntime(data.repository, vault, bridge);
  const session = await runtime.openSession('main');
  await session.update({ body: 'missing secret' });
  const id = session.getSnapshot().id;
  await session.submit();
  const job = await waitUntilJob(runtime, id, (status) => status === 'failed');
  assert.equal(transportCalls, 0);
  assert.equal(job.lastError?.message, 'Decision provider failed');
  assert.doesNotMatch(JSON.stringify(data.port.value), /synthetic-test-key/u);
  await runtime.dispose();
});

test('keeps reserved organization namespaces out of settings snapshots', () => {
  const result = stripOrganizationRuntimeNamespaces({
    DefaultTag: 'keep',
    _captureStore: { keep: true },
    _captureSessions: { keep: true },
    _organizationStore: { jobs: { secret: 'no' } },
    _organizationEnrollment: { captures: { secret: 'no' } },
  });
  assert.deepEqual(result, {
    DefaultTag: 'keep',
    _captureStore: { keep: true },
    _captureSessions: { keep: true },
  });
});

test('local materialization remains the source of profile metadata and does not invent fields', async () => {
  const data = makeRepository();
  const vault = new MemoryVault();
  const bridge = makeBridge(data.repository, vault, {
    provider: { decide: async () => ({ outcome: 'certain', tags: ['ai/bookish'] }) },
  });
  const runtime = makeRuntime(data.repository, vault, bridge);
  const session = await runtime.openSession('main');
  await session.update({
    body: 'book metadata',
    profile: 'book',
    fields: { author: { state: 'set', value: 'Existing author' } },
  });
  const id = session.getSnapshot().id;
  await session.submit();
  await waitFor(() => currentCaptureRecords(data.port.value)[id]?.write.state === 'written');
  const path = currentCaptureRecords(data.port.value)[id].write.note?.path as string;
  const content = (await vault.read(path)) as string;
  const document = createObsidianFrontmatterPort(jsonYaml).parse(content);
  assert.equal(document.frontmatter.lethe_profile_id, 'book');
  assert.equal(document.frontmatter.author, 'Existing author');
  assert.deepEqual(document.frontmatter.tags, ['type/book', 'type/review', 'ai/bookish']);
  assert.equal(document.frontmatter.endDate, undefined);
  assert.equal((await bridge.queue.listJobs()).length, 1);
  await runtime.dispose();
});

test('persists an accepted Jev decision before mutation and reuses it after a crash, then undoes safely', async () => {
  const data = makeRepository();
  const vault = new MemoryVault();
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'crash-decision'),
    body: 'crash recovery',
    now: () => '2026-09-23T00:00:00.000Z',
  });
  const original = noteContent(
    { lethe_capture_id: snapshot.id, lethe_capture_revision: snapshot.revision, tags: [] },
    snapshot.body,
  );
  vault.files.set('Inbox/crash.md', original);
  vault.afterWrite = () => {
    data.port.failNextSave = true;
    vault.afterWrite = undefined;
  };
  const frontmatter = createObsidianFrontmatterPort(jsonYaml);
  const executor = new OrganizationExecutor({ vault, frontmatter });
  let providerCalls = 0;
  const provider: OrganizationDecisionProvider = {
    decide: async () => {
      providerCalls += 1;
      return { outcome: 'certain', properties: { generated: providerCalls === 1 ? 'first' : 'second' } };
    },
  };
  const first = new OrganizationQueue({
    repository: data.repository,
    provider,
    executor,
    enabled: true,
    policy: 'automatic',
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  });
  const receipt = await first.enqueue(submissionFor(snapshot, original, 'Inbox/crash.md'));
  await first.waitForIdle();
  assert.equal((await first.getJob(receipt.jobId))?.status, 'processing');
  await first.dispose();

  const second = new OrganizationQueue({
    repository: data.repository,
    provider,
    executor,
    enabled: true,
    policy: 'automatic',
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  });
  await second.initialize();
  await second.waitForIdle();
  const applied = await second.getJob(receipt.jobId);
  assert.equal(providerCalls, 1);
  assert.equal(applied?.status, 'applied');
  assert.equal((await vault.read(applied?.notePath as string))?.includes('"generated":"first"'), true);

  const undo = await second.undo(snapshot.id, snapshot.revision);
  assert.equal(undo.result.status, 'undone');
  assert.equal(await vault.read('Inbox/crash.md'), original);
  await second.dispose();
});

test('does not retry a classifier error marked retryable false', async () => {
  const data = makeRepository();
  const snapshot = createDraftSnapshot({
    id: createCaptureId(() => 'nonretry'),
    body: 'nonretry',
    now: () => '2026-09-23T00:00:00.000Z',
  });
  let calls = 0;
  const provider: OrganizationDecisionProvider = {
    decide: async () => {
      calls += 1;
      throw Object.assign(new Error('schema response'), { code: 'invalid_response', retryable: false });
    },
  };
  const queue = new OrganizationQueue({
    repository: data.repository,
    provider,
    executor: new OrganizationExecutor({
      vault: new MemoryVault(),
      frontmatter: createObsidianFrontmatterPort(jsonYaml),
    }),
    enabled: true,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
  });
  const receipt = await queue.enqueue(
    submissionFor(snapshot, noteContent({ lethe_capture_id: snapshot.id }, snapshot.body)),
  );
  await queue.waitForIdle();
  const job = await queue.getJob(receipt.jobId);
  assert.equal(calls, 1);
  assert.equal(job?.status, 'failed');
  await queue.dispose();
});
