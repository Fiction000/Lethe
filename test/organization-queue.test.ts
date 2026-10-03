import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaptureId, createDraftSnapshot, type CaptureSnapshot } from '../src/capture/core';
import { SerializedDataRepository } from '../src/capture/repository';
import {
  OrganizationQueue,
  type OrganizationDecisionProvider,
  type OrganizationExecutorPort,
} from '../src/organization/queue';
import type {
  OrganizationAppliedMetadata,
  OrganizationApplyRequest,
  OrganizationApplyResult,
  OrganizationBaseline,
  OrganizationDecision,
  OrganizationLocalReceipt,
  OrganizationUndoRequest,
  OrganizationUndoResult,
  OrganizationSubmission,
} from '../src/organization/types';

function makeRepository(initial: unknown = {}) {
  let disk = initial;
  const data = new SerializedDataRepository({
    loadData: async () => disk,
    saveData: async (next) => {
      disk = next;
    },
  });
  return { repository: data, persisted: () => disk };
}

function capture(id = 'queue'): CaptureSnapshot {
  return createDraftSnapshot({
    id: createCaptureId(() => id),
    body: `body for ${id}`,
    now: () => '2026-09-23T00:00:00.000Z',
  });
}

function baselineFor(snapshot: CaptureSnapshot, path = 'Inbox/body.md'): OrganizationBaseline {
  return {
    path,
    folder: path.startsWith('Notes/') ? 'notes' : 'inbox',
    content: `local note for ${snapshot.id}`,
  };
}

function receiptFor(snapshot: CaptureSnapshot, path = 'Inbox/body.md'): OrganizationLocalReceipt {
  return {
    captureId: snapshot.id,
    revision: snapshot.revision,
    localPersisted: true,
    notePath: path,
    noteFolder: path.startsWith('Notes/') ? 'notes' : 'inbox',
    persistedAt: '2026-09-23T00:00:00.000Z',
  };
}

function submission(snapshot: CaptureSnapshot, overrides?: Partial<OrganizationSubmission>): OrganizationSubmission {
  return {
    snapshot,
    localReceipt: receiptFor(snapshot),
    baseline: baselineFor(snapshot),
    intent: 'opt-in',
    ...overrides,
  };
}

function decision(outcome: OrganizationDecision['outcome'] = 'certain'): OrganizationDecision {
  return { outcome, properties: { suggested: 'yes' }, tags: ['ai/tag'] };
}

function appliedFor(request: OrganizationApplyRequest): OrganizationAppliedMetadata {
  return {
    path: request.notePath,
    body: request.capture.body,
    properties: {},
    addedTags: [],
  };
}

class FakeExecutor implements OrganizationExecutorPort {
  public readonly applyCalls: OrganizationApplyRequest[] = [];
  public readonly undoCalls: OrganizationUndoRequest[] = [];
  public applyResult?: OrganizationApplyResult;
  public undoResult?: OrganizationUndoResult;

  public async apply(request: OrganizationApplyRequest): Promise<OrganizationApplyResult> {
    this.applyCalls.push(request);
    return (
      this.applyResult ?? {
        status: 'applied',
        notePath: 'Notes/body.md',
        applied: appliedFor(request),
      }
    );
  }

  public async undo(request: OrganizationUndoRequest): Promise<OrganizationUndoResult> {
    this.undoCalls.push(request);
    return this.undoResult ?? { status: 'undone', notePath: request.notePath };
  }
}

class DeferredProvider implements OrganizationDecisionProvider {
  public readonly calls: Array<{ attempt: number; signal: AbortSignal }> = [];
  public readonly started: Promise<void>;
  private announceStarted!: () => void;
  private resolveDecision!: (decision: OrganizationDecision) => void;
  private rejectDecision!: (error: Error) => void;
  private readonly pending: Promise<OrganizationDecision>;

  public constructor() {
    this.started = new Promise<void>((resolve) => {
      this.announceStarted = resolve;
    });
    this.pending = new Promise<OrganizationDecision>((resolve, reject) => {
      this.resolveDecision = resolve;
      this.rejectDecision = reject;
    });
  }

  public decide(request: { attempt: number; signal: AbortSignal }): Promise<OrganizationDecision> {
    this.calls.push(request);
    this.announceStarted();
    return this.pending;
  }

  public resolve(decisionValue: OrganizationDecision = decision()): void {
    this.resolveDecision(decisionValue);
  }

  public reject(error = new Error('provider outage')): void {
    this.rejectDecision(error);
  }
}

test('requires a written local receipt and never calls the provider for a skipped capture', async () => {
  const { repository } = makeRepository();
  let providerCalls = 0;
  const provider: OrganizationDecisionProvider = {
    decide: async () => {
      providerCalls += 1;
      return decision();
    },
  };
  const queue = new OrganizationQueue({
    repository,
    provider,
    executor: new FakeExecutor(),
    enabled: true,
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const snapshot = capture('receipt');

  await assert.rejects(
    queue.enqueue({
      ...submission(snapshot),
      localReceipt: { ...receiptFor(snapshot), localPersisted: false as true },
    }),
    /local receipt/i,
  );
  const skipped = await queue.enqueue({ ...submission(snapshot), intent: 'skip' });
  await queue.waitForIdle();

  assert.equal(skipped.status, 'skipped');
  assert.equal(providerCalls, 0);
  await queue.dispose();
});

test('persists an opt-in job, serializes duplicate enqueue, and applies once', async () => {
  const { repository } = makeRepository();
  const providerCalls: number[] = [];
  const executor = new FakeExecutor();
  const queue = new OrganizationQueue({
    repository,
    provider: {
      decide: async (request) => {
        providerCalls.push(request.attempt);
        return decision();
      },
    },
    executor,
    enabled: true,
    policy: 'automatic',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const input = submission(capture('idempotent'));

  const first = await queue.enqueue(input);
  const second = await queue.enqueue(input);
  await queue.waitForIdle();
  const job = await queue.getJob(first.jobId);

  assert.equal(first.jobId, second.jobId);
  assert.equal(providerCalls.length, 1);
  assert.equal(executor.applyCalls.length, 1);
  assert.equal(job?.status, 'applied');
  assert.equal(job?.localReceipt.localPersisted, true);
  await queue.dispose();
});

test('advisory policy records a suggestion without writing, and uncertainty stays in Inbox', async () => {
  const advisoryExecutor = new FakeExecutor();
  const advisoryData = makeRepository();
  const advisory = new OrganizationQueue({
    repository: advisoryData.repository,
    provider: { decide: async () => decision('certain') },
    executor: advisoryExecutor,
    enabled: true,
    policy: 'advisory',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const advisoryReceipt = await advisory.enqueue(submission(capture('advisory')));
  await advisory.waitForIdle();

  const uncertainExecutor = new FakeExecutor();
  const uncertainData = makeRepository();
  const uncertain = new OrganizationQueue({
    repository: uncertainData.repository,
    provider: { decide: async () => decision('uncertain') },
    executor: uncertainExecutor,
    enabled: true,
    policy: 'automatic',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const uncertainReceipt = await uncertain.enqueue(submission(capture('uncertain')));
  await uncertain.waitForIdle();

  assert.equal((await advisory.getJob(advisoryReceipt.jobId))?.status, 'advisory');
  assert.equal(advisoryExecutor.applyCalls.length, 0);
  assert.equal((await uncertain.getJob(uncertainReceipt.jobId))?.status, 'uncertain');
  assert.equal(uncertainExecutor.applyCalls.length, 0);
  assert.equal((await uncertain.getJob(uncertainReceipt.jobId))?.baseline.folder, 'inbox');
  await advisory.dispose();
  await uncertain.dispose();
});

test('bounds provider retries with backoff and ends in failed without an unbounded loop', async () => {
  const { repository } = makeRepository();
  let calls = 0;
  const queue = new OrganizationQueue({
    repository,
    provider: {
      decide: async () => {
        calls += 1;
        throw new Error('temporary provider failure');
      },
    },
    executor: new FakeExecutor(),
    enabled: true,
    retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  });
  const receipt = await queue.enqueue(submission(capture('bounded')));
  await queue.waitForIdle();
  const job = await queue.getJob(receipt.jobId);

  assert.equal(calls, 2);
  assert.equal(job?.status, 'failed');
  assert.equal(job?.attempt, 2);
  assert.equal(job?.lastError?.code, 'provider-failed');
  await queue.dispose();
});

test('persists an exponential retry window before the bounded retry', async () => {
  const { repository } = makeRepository();
  const now = () => '2026-09-23T00:00:00.000Z';
  const queue = new OrganizationQueue({
    repository,
    provider: {
      decide: async () => {
        throw new Error('temporary provider failure');
      },
    },
    executor: new FakeExecutor(),
    enabled: true,
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 5_000 },
    now,
  });
  const receipt = await queue.enqueue(submission(capture('backoff')));
  await queue.waitForIdle();
  const job = await queue.getJob(receipt.jobId);

  assert.equal(job?.status, 'retry-wait');
  assert.equal(job?.attempt, 1);
  assert.equal(job?.nextAttemptAt, '2026-09-23T00:00:01.000Z');
  await queue.dispose();
});

test('recovers a processing job after dispose and ignores its late provider response', async () => {
  const data = makeRepository();
  const firstProvider = new DeferredProvider();
  const firstExecutor = new FakeExecutor();
  const first = new OrganizationQueue({
    repository: data.repository,
    provider: firstProvider,
    executor: firstExecutor,
    enabled: true,
    policy: 'automatic',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const input = submission(capture('restart'));
  const receipt = await first.enqueue(input);
  await firstProvider.started;
  await first.dispose();
  firstProvider.resolve();

  const recoveredExecutor = new FakeExecutor();
  const second = new OrganizationQueue({
    repository: data.repository,
    provider: { decide: async () => decision() },
    executor: recoveredExecutor,
    enabled: true,
    policy: 'automatic',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  await second.initialize();
  await second.waitForIdle();

  assert.equal(firstExecutor.applyCalls.length, 0);
  assert.equal(recoveredExecutor.applyCalls.length, 1);
  assert.equal((await second.getJob(receipt.jobId))?.status, 'applied');
  await second.dispose();
});

test('disable and skip cancel in-flight work so late responses cannot apply', async () => {
  const disabledData = makeRepository();
  const disabledProvider = new DeferredProvider();
  const disabledExecutor = new FakeExecutor();
  const disabled = new OrganizationQueue({
    repository: disabledData.repository,
    provider: disabledProvider,
    executor: disabledExecutor,
    enabled: true,
    policy: 'automatic',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const disabledReceipt = await disabled.enqueue(submission(capture('disabled')));
  await disabledProvider.started;
  await disabled.setEnabled(false);
  disabledProvider.resolve();
  await disabled.waitForIdle();

  const skippedData = makeRepository();
  const skippedProvider = new DeferredProvider();
  const skippedExecutor = new FakeExecutor();
  const skipped = new OrganizationQueue({
    repository: skippedData.repository,
    provider: skippedProvider,
    executor: skippedExecutor,
    enabled: true,
    policy: 'automatic',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const skippedReceipt = await skipped.enqueue(submission(capture('skip-late')));
  await skippedProvider.started;
  await skipped.skip('cap_skip-late', 0);
  skippedProvider.resolve();
  await skipped.waitForIdle();

  assert.equal(disabledExecutor.applyCalls.length, 0);
  assert.equal((await disabled.getJob(disabledReceipt.jobId))?.status, 'queued');
  assert.equal(skippedExecutor.applyCalls.length, 0);
  assert.equal((await skipped.getJob(skippedReceipt.jobId))?.status, 'skipped');
  await disabled.dispose();
  await skipped.dispose();
});

test('cancellation and safe undo are durable queue operations', async () => {
  const data = makeRepository();
  const executor = new FakeExecutor();
  const queue = new OrganizationQueue({
    repository: data.repository,
    provider: { decide: async () => decision() },
    executor,
    enabled: true,
    policy: 'automatic',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
  });
  const cancelled = await queue.enqueue(submission(capture('cancelled')));
  await queue.cancel('cap_cancelled', 0);
  assert.equal((await queue.getJob(cancelled.jobId))?.status, 'cancelled');

  const applied = await queue.enqueue(submission(capture('undo')));
  await queue.waitForIdle();
  const undo = await queue.undo('cap_undo', 0);

  assert.equal(undo.jobId, applied.jobId);
  assert.equal(undo.result.status, 'undone');
  assert.equal(executor.undoCalls.length, 1);
  assert.equal((await queue.getJob(applied.jobId))?.status, 'undone');
  await queue.dispose();
});

test('repairs corrupt reserved state without touching unrelated capture data', async () => {
  const data = makeRepository({
    _captureStore: { schemaVersion: 1, captures: { preserved: { lifecycle: 'submitted' } } },
    _organizationStore: { corrupt: true, jobs: 'not-an-object' },
  });
  const queue = new OrganizationQueue({
    repository: data.repository,
    provider: { decide: async () => decision() },
    executor: new FakeExecutor(),
    enabled: false,
  });

  await queue.initialize();
  assert.deepEqual(await queue.listJobs(), []);
  const persisted = data.persisted() as Record<string, unknown>;
  assert.deepEqual(persisted._captureStore, { schemaVersion: 1, captures: { preserved: { lifecycle: 'submitted' } } });
  assert.deepEqual((persisted._organizationStore as { jobs: unknown }).jobs, {});
  await queue.dispose();
});
