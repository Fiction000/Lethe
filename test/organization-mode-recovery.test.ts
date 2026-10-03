import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaptureId, createDraftSnapshot, type CaptureSnapshot } from '../src/capture/core';
import { SerializedDataRepository } from '../src/capture/repository';
import { applyLocalOnlyFallback } from '../src/jevSettings';
import { createObsidianJevTransport, type ObsidianRequestUrl } from '../src/organization/obsidianAdapter';
import { OrganizationQueue, type OrganizationExecutorPort } from '../src/organization/queue';
import { OrganizationRuntimeBridge, type OrganizationRuntimeBridgeOptions } from '../src/organization/runtimeBridge';
import {
  organizationJobId,
  type OrganizationAppliedMetadata,
  type OrganizationApplyRequest,
  type OrganizationBaseline,
  type OrganizationJob,
  type OrganizationLocalReceipt,
  type OrganizationSubmission,
  type OrganizationUndoRequest,
  type OrganizationUndoResult,
} from '../src/organization/types';

function makeRepository(initial: unknown = {}): {
  repository: SerializedDataRepository;
  persisted: () => unknown;
} {
  let value = initial;
  const repository = new SerializedDataRepository({
    loadData: async () => value,
    saveData: async (next) => {
      value = next;
    },
  });
  return { repository, persisted: () => value };
}

function snapshot(id: string): CaptureSnapshot {
  return createDraftSnapshot({
    id: createCaptureId(() => id),
    body: `body for ${id}`,
    now: () => '2026-09-23T00:00:00.000Z',
  });
}

function baselineFor(capture: CaptureSnapshot): OrganizationBaseline {
  return {
    path: 'Inbox/capture.md',
    folder: 'inbox',
    content: `---\nlethe_capture_id: ${capture.id}\n---\n${capture.body}`,
  };
}

function receiptFor(capture: CaptureSnapshot): OrganizationLocalReceipt {
  return {
    captureId: capture.id,
    revision: capture.revision,
    localPersisted: true,
    notePath: 'Inbox/capture.md',
    noteFolder: 'inbox',
    persistedAt: '2026-09-23T00:00:00.000Z',
  };
}

function submissionFor(capture: CaptureSnapshot): OrganizationSubmission {
  return {
    snapshot: capture,
    localReceipt: receiptFor(capture),
    baseline: baselineFor(capture),
    intent: 'opt-in',
    policy: 'automatic',
    overrides: {},
  };
}

function appliedFor(request: OrganizationApplyRequest): OrganizationAppliedMetadata {
  return {
    path: request.notePath,
    body: request.capture.body,
    properties: {},
    addedTags: [],
  };
}

class RecordingExecutor implements OrganizationExecutorPort {
  public readonly applyCalls: OrganizationApplyRequest[] = [];
  public readonly undoCalls: OrganizationUndoRequest[] = [];

  public async apply(request: OrganizationApplyRequest) {
    this.applyCalls.push(request);
    return { status: 'applied' as const, notePath: request.notePath, applied: appliedFor(request) };
  }

  public async undo(request: OrganizationUndoRequest): Promise<OrganizationUndoResult> {
    this.undoCalls.push(request);
    return { status: 'undone', notePath: request.notePath };
  }
}

function persistedProcessingJob(
  capture: CaptureSnapshot,
  settings: { enabled: boolean; policy: 'advisory' | 'automatic' },
): Record<string, unknown> {
  const baseline = baselineFor(capture);
  const receipt = receiptFor(capture);
  const jobId = organizationJobId(capture.id, capture.revision);
  const job: OrganizationJob = {
    schemaVersion: 1,
    jobId,
    captureId: capture.id,
    revision: capture.revision,
    snapshot: capture,
    localReceipt: receipt,
    baseline,
    intent: 'opt-in',
    policy: 'automatic',
    overrides: {},
    status: 'processing',
    attempt: 1,
    enqueuedAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    notePath: baseline.path,
    decision: { outcome: 'certain', properties: { generated: 'yes' }, tags: ['ai/generated'] },
  };
  return {
    _organizationStore: {
      schemaVersion: 1,
      settings,
      jobs: { [jobId]: job },
    },
  };
}

function organizationOptions(
  repository: SerializedDataRepository,
  overrides: Partial<OrganizationRuntimeBridgeOptions> = {},
): OrganizationRuntimeBridgeOptions {
  return {
    repository,
    vault: {
      list: async () => [],
      read: async () => null,
      write: async () => undefined,
      rename: async () => undefined,
    },
    frontmatter: {
      parse: () => ({ frontmatter: {}, body: '' }),
      serialize: () => '---\n---\n',
    },
    settings: {
      mode: 'automatic',
      model: 'jev-latest',
      secretId: 'test-secret',
      approvedTags: [],
    },
    provider: { decide: async () => ({ outcome: 'certain' }) },
    readApiKey: async () => 'test-key',
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error('timed out waiting for test interleaving');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function request(signal: AbortSignal) {
  return {
    url: 'https://api.typesafe.ai/v1/systemone' as const,
    method: 'POST' as const,
    headers: { Authorization: 'Bearer test-key', Accept: 'application/json' },
    body: '{"state":"same"}',
    signal,
  };
}

test('runtime stays local-only when the native secret UI capability is missing', async () => {
  const storage = {
    getSecret: () => 'test-key',
    setSecret: () => undefined,
    listSecrets: () => ['test-secret'],
  };
  assert.equal(applyLocalOnlyFallback({ mode: 'automatic' }, { secretStorage: storage }, false).mode, 'off');

  const data = makeRepository(
    persistedProcessingJob(snapshot('capability-persisted'), { enabled: true, policy: 'automatic' }),
  );
  let providerCalls = 0;
  let secretReads = 0;
  const bridge = new OrganizationRuntimeBridge(
    organizationOptions(data.repository, {
      remoteProcessingAvailable: () => false,
      provider: {
        decide: async () => {
          providerCalls += 1;
          return { outcome: 'certain' };
        },
      },
      readApiKey: async () => {
        secretReads += 1;
        return 'must-not-be-read';
      },
    }),
  );

  assert.equal(bridge.getOrganizationMode(), 'off');
  await bridge.updateSettings({
    mode: 'automatic',
    model: 'jev-latest',
    secretId: 'test-secret',
    approvedTags: [],
  });
  assert.equal(bridge.getOrganizationMode(), 'off');
  const persistedJobId = organizationJobId(
    createCaptureId(() => 'capability-persisted'),
    0,
  );
  assert.equal((await bridge.getJob(persistedJobId))?.status, 'queued');

  const capture = snapshot('capability-gate');
  await bridge.enqueue(submissionFor(capture));
  await bridge.queue.waitForIdle();
  assert.equal(providerCalls, 0);
  assert.equal(secretReads, 0);
  await bridge.dispose();
});

test('advisory policy caps a persisted automatic decision without applying it', async () => {
  const capture = snapshot('downgrade');
  const data = makeRepository(persistedProcessingJob(capture, { enabled: true, policy: 'advisory' }));
  const executor = new RecordingExecutor();
  const queue = new OrganizationQueue({
    repository: data.repository,
    provider: { decide: async () => ({ outcome: 'certain' }) },
    executor,
    enabled: true,
    policy: 'automatic',
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });

  await queue.initialize();
  await queue.waitForIdle();

  const job = await queue.getJob(organizationJobId(capture.id, capture.revision));
  assert.equal(executor.applyCalls.length, 0);
  assert.equal(job?.status, 'advisory');
  assert.equal(job?.decision?.outcome, 'certain');
  await queue.dispose();
});

test('reconciles a certain max-attempt decision so its applied record remains undoable', async () => {
  const capture = snapshot('reconcile');
  const data = makeRepository(persistedProcessingJob(capture, { enabled: true, policy: 'automatic' }));
  const executor = new RecordingExecutor();
  const queue = new OrganizationQueue({
    repository: data.repository,
    provider: { decide: async () => ({ outcome: 'declined' }) },
    executor,
    enabled: true,
    policy: 'automatic',
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  });

  await queue.initialize();
  await queue.waitForIdle();

  const jobId = organizationJobId(capture.id, capture.revision);
  assert.equal(executor.applyCalls.length, 1);
  assert.equal((await queue.getJob(jobId))?.status, 'applied');

  const undo = await queue.undo(capture.id, capture.revision);
  assert.equal(undo.result.status, 'undone');
  assert.equal(executor.undoCalls.length, 1);
  assert.equal((await queue.getJob(jobId))?.status, 'undone');
  await queue.dispose();
});

test('joins the underlying requestUrl promise after an abort instead of uploading twice', async () => {
  let requestCount = 0;
  const resolvers: Array<(response: { status: number; text: string }) => void> = [];
  const requestUrl: ObsidianRequestUrl = async () => {
    requestCount += 1;
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  };
  const transport = createObsidianJevTransport(requestUrl);
  const firstController = new AbortController();
  const first = transport(request(firstController.signal));
  await waitFor(() => requestCount === 1);

  firstController.abort();
  const firstOutcome = first.then(
    () => undefined,
    (error: unknown) => error,
  );
  const secondController = new AbortController();
  const second = transport(request(secondController.signal));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requestCount, 1);

  for (const resolve of resolvers) {
    resolve({ status: 200, text: 'response' });
  }
  const firstError = await firstOutcome;
  assert.ok(firstError instanceof Error);
  assert.match(firstError.message, /aborted/u);
  assert.equal((await second).status, 200);
});

test('sanitizes a raw requestUrl failure at the Obsidian transport boundary', async () => {
  const transport = createObsidianJevTransport(async () => {
    throw new Error('secret-key-and-private-body');
  });

  await assert.rejects(transport(request(new AbortController().signal)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Jev request failed before a response was received');
    assert.doesNotMatch(error.message, /secret-key-and-private-body/u);
    return true;
  });
});
