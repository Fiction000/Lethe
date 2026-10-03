import {
  ORGANIZATION_NAMESPACE,
  ORGANIZATION_SCHEMA_VERSION,
  organizationJobId,
  type OrganizationApplyResult,
  type OrganizationDecision,
  type OrganizationDecisionProvider,
  type OrganizationEnqueueReceipt,
  type OrganizationError,
  type OrganizationExecutorPort,
  type OrganizationJob,
  type OrganizationJobStatus,
  type OrganizationPolicy,
  type OrganizationQueueOptions,
  type OrganizationRetryPolicy,
  type OrganizationSubmission,
  type OrganizationStoreSettings,
  type OrganizationStoreState,
  type OrganizationUndoReceipt,
  type OrganizationUndoResult,
  type OrganizationValue,
} from './types';

export type { OrganizationDecisionProvider, OrganizationExecutorPort } from './types';

export class OrganizationQueueError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OrganizationQueueError';
  }
}

interface ActiveOperation {
  readonly jobId: string;
  readonly controller: AbortController;
}

interface DecodedState {
  readonly state: OrganizationStoreState;
  readonly present: boolean;
  readonly corrupt: boolean;
}

interface MutableStoreState {
  schemaVersion: 1;
  settings: OrganizationStoreSettings;
  jobs: Record<string, OrganizationJob>;
}

interface OrganizationQueueRuntimeOptions {
  readonly enforceSettings?: boolean;
}

const JOB_STATUSES: ReadonlySet<OrganizationJobStatus> = new Set<OrganizationJobStatus>([
  'queued',
  'processing',
  'retry-wait',
  'advisory',
  'uncertain',
  'applied',
  'undone',
  'failed',
  'conflict',
  'deleted',
  'skipped',
  'cancelled',
]);

export class OrganizationQueue {
  private readonly repository: OrganizationQueueOptions['repository'];
  private readonly provider: OrganizationDecisionProvider;
  private readonly executor: OrganizationExecutorPort;
  private readonly now: () => string;
  private readonly defaults: OrganizationStoreSettings;
  private readonly enforceSettings: boolean;
  private readonly retryPolicy: OrganizationRetryPolicy;
  private ready?: Promise<void>;
  private pumpPromise?: Promise<void>;
  private active?: ActiveOperation;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private kickAgain = false;
  private disposed = false;

  public constructor(options: OrganizationQueueOptions & OrganizationQueueRuntimeOptions) {
    this.repository = options.repository;
    this.provider = options.provider;
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date().toISOString());
    this.defaults = {
      enabled: options.enabled ?? false,
      policy: options.policy ?? 'advisory',
    };
    this.enforceSettings = options.enforceSettings === true;
    this.retryPolicy = normalizeRetry(options.retry);
  }

  public initialize(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new OrganizationQueueError('disposed', 'Organization queue is disposed'));
    }
    if (!this.ready) {
      this.ready = this.recoverState().catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }

  public async enqueue(submission: OrganizationSubmission): Promise<OrganizationEnqueueReceipt> {
    await this.initialize();
    assertNotDisposed(this.disposed);
    validateSubmission(submission);
    const jobId = organizationJobId(submission.snapshot.id, submission.snapshot.revision);
    const result = await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const decoded = decodeState(root, this.defaults);
      const state = toMutableState(decoded.state);
      const existing = state.jobs[jobId];
      if (existing !== undefined) {
        if (!sameSubmission(existing, submission)) {
          throw new OrganizationQueueError(
            'job-conflict',
            `Organization job ${jobId} already has a different snapshot`,
          );
        }
        return {
          next: root,
          result: receiptFor(existing),
        };
      }

      const createdAt = this.now();
      const job: OrganizationJob = {
        schemaVersion: 1,
        jobId,
        captureId: submission.snapshot.id,
        revision: submission.snapshot.revision,
        snapshot: clone(submission.snapshot),
        localReceipt: clone(submission.localReceipt),
        baseline: clone(submission.baseline),
        intent: submission.intent,
        policy: submission.policy ?? state.settings.policy,
        overrides: clone(submission.overrides ?? {}),
        status: submission.intent === 'skip' ? 'skipped' : 'queued',
        attempt: 0,
        enqueuedAt: createdAt,
        updatedAt: createdAt,
        notePath: submission.baseline.path,
      };
      state.jobs[jobId] = job;
      root[ORGANIZATION_NAMESPACE] = state;
      return {
        next: root,
        result: receiptFor(job),
      };
    });
    this.kick();
    return result;
  }

  public async getJob(jobId: string): Promise<OrganizationJob | undefined> {
    await this.initialize();
    const decoded = decodeState(await this.repository.read(), this.defaults);
    const job = decoded.state.jobs[jobId];
    return job === undefined ? undefined : clone(job);
  }

  public async listJobs(): Promise<readonly OrganizationJob[]> {
    await this.initialize();
    const decoded = decodeState(await this.repository.read(), this.defaults);
    return Object.values(decoded.state.jobs)
      .sort((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.jobId.localeCompare(right.jobId))
      .map((job) => clone(job));
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    await this.initialize();
    assertNotDisposed(this.disposed);
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      state.settings = { ...state.settings, enabled };
      if (!enabled) {
        for (const [jobId, job] of Object.entries(state.jobs)) {
          if (job.status === 'processing') {
            state.jobs[jobId] = {
              ...job,
              status: 'queued',
              nextAttemptAt: undefined,
              updatedAt: this.now(),
            };
          }
        }
      }
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
    if (!enabled) {
      this.clearWakeTimer();
      this.active?.controller.abort();
    } else {
      this.kick();
    }
  }

  public async setPolicy(policy: OrganizationPolicy): Promise<void> {
    await this.initialize();
    assertNotDisposed(this.disposed);
    if (policy === 'advisory') {
      this.active?.controller.abort();
    }
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      state.settings = { ...state.settings, policy };
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
  }

  public async skip(captureId: string, revision: number): Promise<void> {
    await this.setTerminal(captureId, revision, 'skipped');
  }

  public async cancel(captureId: string, revision: number): Promise<void> {
    await this.setTerminal(captureId, revision, 'cancelled');
  }

  public async retry(captureId: string, revision: number): Promise<void> {
    await this.initialize();
    assertNotDisposed(this.disposed);
    const jobId = organizationJobId(captureId, revision);
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const job = state.jobs[jobId];
      if (job === undefined) {
        throw new OrganizationQueueError('job-not-found', `Organization job ${jobId} was not found`);
      }
      if (
        job.status === 'applied' ||
        job.status === 'undone' ||
        job.status === 'deleted' ||
        job.status === 'skipped' ||
        job.status === 'cancelled'
      ) {
        return { next: root, result: undefined };
      }
      state.jobs[jobId] = {
        ...job,
        status: 'queued',
        nextAttemptAt: undefined,
        lastError: undefined,
        updatedAt: this.now(),
      };
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
    this.kick();
  }

  public async undo(captureId: string, revision: number): Promise<OrganizationUndoReceipt> {
    await this.initialize();
    assertNotDisposed(this.disposed);
    await this.waitForIdle();
    const jobId = organizationJobId(captureId, revision);
    const job = await this.getJob(jobId);
    if (job === undefined) {
      throw new OrganizationQueueError('job-not-found', `Organization job ${jobId} was not found`);
    }
    if (job.applied === undefined) {
      throw new OrganizationQueueError('nothing-to-undo', `Organization job ${jobId} has no applied metadata`);
    }
    const controller = new AbortController();
    this.active = { jobId, controller };
    await this.markProcessingForUndo(jobId);
    try {
      const result = await this.executor.undo({
        capture: job.snapshot,
        baseline: job.baseline,
        notePath: job.notePath ?? job.baseline.path,
        applied: job.applied,
        signal: controller.signal,
      });
      await this.finishUndo(jobId, result);
      return { jobId, result };
    } catch (error) {
      await this.restoreAppliedAfterUndoFailure(jobId);
      throw error;
    } finally {
      if (this.active?.jobId === jobId && this.active.controller === controller) {
        this.active = undefined;
      }
    }
  }

  /** Waits for currently runnable work; future retry windows are not fast-forwarded. */
  public async waitForIdle(): Promise<void> {
    for (;;) {
      const running = this.pumpPromise;
      if (running === undefined) {
        return;
      }
      await running;
      if (this.pumpPromise === running) {
        return;
      }
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearWakeTimer();
    this.active?.controller.abort();
    if (this.ready !== undefined) {
      await this.ready.catch(() => undefined);
      await this.repository.transact((current) => {
        const root = asMutableRecord(current);
        const decoded = decodeState(root, this.defaults);
        const state = toMutableState(decoded.state);
        let changed = false;
        for (const [jobId, job] of Object.entries(state.jobs)) {
          if (job.status !== 'processing') {
            continue;
          }
          state.jobs[jobId] = { ...job, status: 'queued', nextAttemptAt: undefined, updatedAt: this.now() };
          changed = true;
        }
        if (changed || decoded.present === false || decoded.corrupt) {
          root[ORGANIZATION_NAMESPACE] = state;
        }
        return { next: root, result: undefined };
      });
    }
  }

  private async recoverState(): Promise<void> {
    const reconciliation = await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const decoded = decodeState(root, this.defaults);
      const state = toMutableState(decoded.state);
      const acceptedDecisions: OrganizationJob[] = [];
      let changed = decoded.present === false || decoded.corrupt;
      if (
        this.enforceSettings &&
        (state.settings.enabled !== this.defaults.enabled || state.settings.policy !== this.defaults.policy)
      ) {
        state.settings = clone(this.defaults);
        changed = true;
      }
      for (const [jobId, job] of Object.entries(state.jobs)) {
        if (job.status !== 'processing') {
          continue;
        }
        const acceptedDecision = acceptedAutomaticDecision(job);
        if (acceptedDecision !== undefined) {
          if (!state.settings.enabled) {
            state.jobs[jobId] = { ...job, status: 'queued', nextAttemptAt: undefined, updatedAt: this.now() };
            changed = true;
          } else if (state.settings.policy === 'advisory') {
            state.jobs[jobId] = {
              ...job,
              status: 'advisory',
              decision: acceptedDecision,
              updatedAt: this.now(),
            };
            changed = true;
          } else if (job.attempt >= this.retryPolicy.maxAttempts) {
            // The provider decision is durable. Reconcile the local side
            // effect before treating a max-attempt crash as terminal.
            acceptedDecisions.push({ ...job, decision: acceptedDecision });
          } else {
            state.jobs[jobId] = { ...job, status: 'queued', nextAttemptAt: undefined, updatedAt: this.now() };
            changed = true;
          }
          continue;
        }
        if (job.attempt >= this.retryPolicy.maxAttempts) {
          state.jobs[jobId] = {
            ...job,
            status: 'failed',
            updatedAt: this.now(),
            lastError: safeError('max-attempts', 'Organization retry limit reached', this.now()),
          };
        } else {
          state.jobs[jobId] = { ...job, status: 'queued', nextAttemptAt: undefined, updatedAt: this.now() };
        }
        changed = true;
      }
      if (changed) {
        root[ORGANIZATION_NAMESPACE] = state;
      }
      return { next: root, result: acceptedDecisions };
    });
    for (const job of reconciliation) {
      await this.reconcileAcceptedDecision(job);
    }
    const decoded = decodeState(await this.repository.read(), this.defaults);
    if (decoded.state.settings.enabled && !this.disposed) {
      this.kick();
    }
  }

  private async setTerminal(captureId: string, revision: number, status: 'skipped' | 'cancelled'): Promise<void> {
    await this.initialize();
    assertNotDisposed(this.disposed);
    const jobId = organizationJobId(captureId, revision);
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const job = state.jobs[jobId];
      if (job === undefined) {
        throw new OrganizationQueueError('job-not-found', `Organization job ${jobId} was not found`);
      }
      if (job.status === 'applied' || job.status === 'undone') {
        return { next: root, result: undefined };
      }
      state.jobs[jobId] = {
        ...job,
        status,
        nextAttemptAt: undefined,
        updatedAt: this.now(),
      };
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
    if (this.active?.jobId === jobId) {
      this.active.controller.abort();
    }
  }

  private async markProcessingForUndo(jobId: string): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const job = state.jobs[jobId];
      if (job === undefined || (job.status !== 'applied' && job.status !== 'undone')) {
        throw new OrganizationQueueError('undo-unavailable', `Organization job ${jobId} is not undoable`);
      }
      state.jobs[jobId] = { ...job, status: 'processing', updatedAt: this.now() };
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
  }

  private async finishUndo(jobId: string, result: OrganizationUndoResult): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const job = state.jobs[jobId];
      if (job === undefined || job.status !== 'processing') {
        return { next: root, result: undefined };
      }
      const status: OrganizationJobStatus =
        result.status === 'undone' || result.status === 'unchanged'
          ? 'undone'
          : result.status === 'deleted'
          ? 'deleted'
          : 'conflict';
      state.jobs[jobId] = {
        ...job,
        status,
        notePath: result.notePath ?? job.notePath,
        ...(result.status === 'conflict'
          ? { lastError: safeError(result.code, 'Organization undo declined safely', this.now()) }
          : {}),
        updatedAt: this.now(),
      };
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
  }

  private async restoreAppliedAfterUndoFailure(jobId: string): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const job = state.jobs[jobId];
      if (job?.status === 'processing' && job.applied !== undefined) {
        state.jobs[jobId] = { ...job, status: 'applied', updatedAt: this.now() };
        root[ORGANIZATION_NAMESPACE] = state;
      }
      return { next: root, result: undefined };
    });
  }

  private kick(): void {
    if (this.disposed) {
      return;
    }
    if (this.pumpPromise !== undefined) {
      this.kickAgain = true;
      return;
    }
    const running = this.runPump();
    this.pumpPromise = running;
    void running.then(
      () => {
        if (this.pumpPromise === running) {
          this.pumpPromise = undefined;
          if (this.kickAgain) {
            this.kickAgain = false;
            this.kick();
          }
        }
      },
      () => {
        if (this.pumpPromise === running) {
          this.pumpPromise = undefined;
          if (this.kickAgain) {
            this.kickAgain = false;
            this.kick();
          }
        }
      },
    );
  }

  private async runPump(): Promise<void> {
    try {
      while (!this.disposed) {
        const job = await this.claimNext();
        if (job === undefined) {
          await this.scheduleWake();
          return;
        }
        await this.process(job);
      }
    } catch {
      // A later explicit retry or restart can recover a repository failure.
    }
  }

  private async claimNext(): Promise<OrganizationJob | undefined> {
    return this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      if (!state.settings.enabled) {
        return { next: root, result: undefined };
      }
      const now = Date.parse(this.now());
      const candidates = Object.values(state.jobs)
        .filter((job) => {
          if (job.status === 'queued') return true;
          if (job.status !== 'retry-wait') return false;
          const due = job.nextAttemptAt === undefined ? now : Date.parse(job.nextAttemptAt);
          return !Number.isFinite(due) || due <= now;
        })
        .sort(
          (left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt) || left.jobId.localeCompare(right.jobId),
        );
      for (const candidate of candidates) {
        const acceptedDecision = acceptedAutomaticDecision(candidate);
        if (candidate.attempt >= this.retryPolicy.maxAttempts && acceptedDecision === undefined) {
          state.jobs[candidate.jobId] = {
            ...candidate,
            status: 'failed',
            updatedAt: this.now(),
            lastError: safeError('max-attempts', 'Organization retry limit reached', this.now()),
          };
          continue;
        }
        const claimed: OrganizationJob = {
          ...candidate,
          status: 'processing',
          attempt:
            candidate.attempt >= this.retryPolicy.maxAttempts && acceptedDecision !== undefined
              ? candidate.attempt
              : candidate.attempt + 1,
          nextAttemptAt: undefined,
          lastError: undefined,
          updatedAt: this.now(),
        };
        state.jobs[candidate.jobId] = claimed;
        root[ORGANIZATION_NAMESPACE] = state;
        return { next: root, result: clone(claimed) };
      }
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
  }

  private async process(job: OrganizationJob): Promise<void> {
    const controller = new AbortController();
    this.active = { jobId: job.jobId, controller };
    try {
      if (!(await this.isCurrentProcessing(job)) || this.disposed) {
        return;
      }
      const settings = await this.currentSettings();
      if (!settings.enabled) {
        await this.requeueIfProcessing(job.jobId);
        return;
      }

      const durableDecision = acceptedAutomaticDecision(job);
      if (job.policy === 'automatic' && settings.policy !== 'automatic' && durableDecision !== undefined) {
        await this.finishDecision(job, 'advisory', durableDecision);
        return;
      }

      let sanitized: OrganizationDecision | undefined;
      if (job.policy === 'automatic' && job.decision?.outcome === 'certain') {
        // Accepted decisions are durable before any vault mutation. Recovery
        // reuses this exact decision rather than asking Jev again.
        sanitized = sanitizeDecision(job.decision);
      } else {
        let rawDecision: OrganizationDecision;
        try {
          rawDecision = await this.provider.decide({
            capture: clone(job.snapshot),
            note: {
              path: job.notePath ?? job.baseline.path,
              folder: job.baseline.folder,
              body: job.snapshot.body,
            },
            overrides: clone(job.overrides),
            attempt: job.attempt,
            signal: controller.signal,
          });
        } catch (error) {
          await this.handleFailure(job, 'provider-failed', 'Decision provider failed', retryableFrom(error));
          return;
        }
        sanitized = sanitizeDecision(rawDecision);
      }
      if (this.disposed || !(await this.isCurrentProcessing(job))) {
        return;
      }
      if (sanitized === undefined) {
        await this.handleFailure(job, 'invalid-decision', 'Decision provider returned an invalid decision', false);
        return;
      }
      const settingsBeforeDecision = await this.currentSettings();
      if (!settingsBeforeDecision.enabled) {
        await this.requeueIfProcessing(job.jobId);
        return;
      }
      if (job.policy === 'automatic' && settingsBeforeDecision.policy !== 'automatic') {
        await this.finishDecision(job, sanitized.outcome === 'certain' ? 'advisory' : 'uncertain', sanitized);
        return;
      }

      if (job.policy === 'advisory') {
        await this.finishDecision(job, sanitized.outcome === 'certain' ? 'advisory' : 'uncertain', sanitized);
        return;
      }
      if (sanitized.outcome !== 'certain') {
        await this.finishDecision(job, 'uncertain', sanitized);
        return;
      }

      await this.persistAcceptedDecision(job, sanitized);
      const settingsBeforeApply = await this.currentSettings();
      if (this.disposed || controller.signal.aborted || !(await this.isCurrentProcessing(job))) {
        await this.requeueIfProcessing(job.jobId);
        return;
      }
      if (!settingsBeforeApply.enabled) {
        await this.requeueIfProcessing(job.jobId);
        return;
      }
      if (job.policy === 'automatic' && settingsBeforeApply.policy !== 'automatic') {
        await this.finishDecision(job, 'advisory', sanitized);
        return;
      }

      let result: OrganizationApplyResult;
      try {
        result = await this.executor.apply({
          capture: clone(job.snapshot),
          baseline: clone(job.baseline),
          notePath: job.notePath ?? job.baseline.path,
          decision: sanitized,
          overrides: clone(job.overrides),
          signal: controller.signal,
        });
      } catch (error) {
        await this.handleFailure(job, 'executor-failed', 'Local organization write failed', retryableFrom(error));
        return;
      }
      if (this.disposed || !(await this.isCurrentProcessing(job))) {
        return;
      }
      await this.finishApply(job, sanitized, result);
    } finally {
      if (this.active?.jobId === job.jobId && this.active.controller === controller) {
        this.active = undefined;
      }
    }
  }

  private async isCurrentProcessing(job: OrganizationJob): Promise<boolean> {
    const decoded = decodeState(await this.repository.read(), this.defaults);
    const current = decoded.state.jobs[job.jobId];
    return current?.status === 'processing' && current.attempt === job.attempt;
  }

  private async reconcileAcceptedDecision(job: OrganizationJob): Promise<void> {
    const controller = new AbortController();
    this.active = { jobId: job.jobId, controller };
    try {
      const settings = await this.currentSettings();
      const decision = acceptedAutomaticDecision(job);
      if (decision === undefined) {
        await this.handleFailure(job, 'invalid-decision', 'Organization recovery found an invalid decision', false);
        return;
      }
      if (!settings.enabled) {
        await this.requeueIfProcessing(job.jobId);
        return;
      }
      if (settings.policy !== 'automatic') {
        await this.finishDecision(job, 'advisory', decision);
        return;
      }
      if (this.disposed || controller.signal.aborted || !(await this.isCurrentProcessing(job))) {
        await this.requeueIfProcessing(job.jobId);
        return;
      }

      let result: OrganizationApplyResult;
      try {
        result = await this.executor.apply({
          capture: clone(job.snapshot),
          baseline: clone(job.baseline),
          notePath: job.notePath ?? job.baseline.path,
          decision,
          overrides: clone(job.overrides),
          signal: controller.signal,
        });
      } catch {
        await this.markReconciliationConflict(
          job,
          'executor-reconcile-failed',
          'Local organization recovery needs review',
        );
        return;
      }
      if (this.disposed || controller.signal.aborted || !(await this.isCurrentProcessing(job))) {
        await this.requeueIfProcessing(job.jobId);
        return;
      }
      await this.finishApply(job, decision, result);
    } finally {
      if (this.active?.jobId === job.jobId && this.active.controller === controller) {
        this.active = undefined;
      }
    }
  }

  private async markReconciliationConflict(job: OrganizationJob, code: string, message: string): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const currentJob = state.jobs[job.jobId];
      if (currentJob?.status === 'processing' && currentJob.attempt === job.attempt) {
        state.jobs[job.jobId] = {
          ...currentJob,
          status: 'conflict',
          lastError: safeError(code, message, this.now()),
          updatedAt: this.now(),
        };
        root[ORGANIZATION_NAMESPACE] = state;
      }
      return { next: root, result: undefined };
    });
  }

  private async currentSettings(): Promise<OrganizationStoreSettings> {
    return decodeState(await this.repository.read(), this.defaults).state.settings;
  }

  private async requeueIfProcessing(jobId: string): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const job = state.jobs[jobId];
      if (job?.status === 'processing') {
        state.jobs[jobId] = { ...job, status: 'queued', nextAttemptAt: undefined, updatedAt: this.now() };
        root[ORGANIZATION_NAMESPACE] = state;
      }
      return { next: root, result: undefined };
    });
  }

  private async finishDecision(
    job: OrganizationJob,
    status: 'advisory' | 'uncertain',
    decision: OrganizationDecision,
  ): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const currentJob = state.jobs[job.jobId];
      if (currentJob?.status === 'processing' && currentJob.attempt === job.attempt) {
        state.jobs[job.jobId] = { ...currentJob, status, decision, updatedAt: this.now() };
        root[ORGANIZATION_NAMESPACE] = state;
      }
      return { next: root, result: undefined };
    });
  }

  private async persistAcceptedDecision(job: OrganizationJob, decision: OrganizationDecision): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const currentJob = state.jobs[job.jobId];
      if (currentJob?.status === 'processing' && currentJob.attempt === job.attempt) {
        state.jobs[job.jobId] = { ...currentJob, decision, updatedAt: this.now() };
        root[ORGANIZATION_NAMESPACE] = state;
      }
      return { next: root, result: undefined };
    });
  }

  private async finishApply(
    job: OrganizationJob,
    decision: OrganizationDecision,
    result: OrganizationApplyResult,
  ): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const currentJob = state.jobs[job.jobId];
      if (currentJob?.status !== 'processing' || currentJob.attempt !== job.attempt) {
        return { next: root, result: undefined };
      }
      const status: OrganizationJobStatus = result.status === 'applied' ? 'applied' : result.status;
      state.jobs[job.jobId] = {
        ...currentJob,
        status,
        decision,
        ...(result.notePath === undefined ? {} : { notePath: result.notePath }),
        ...(result.status === 'applied' ? { applied: result.applied, notePath: result.notePath } : {}),
        ...(result.status === 'conflict'
          ? { lastError: safeError(result.code, 'Organization declined to overwrite the note', this.now()) }
          : {}),
        ...(result.status === 'deleted'
          ? { lastError: safeError(result.code, 'The known note was deleted; it was not recreated', this.now()) }
          : {}),
        updatedAt: this.now(),
      };
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
  }

  private async handleFailure(job: OrganizationJob, code: string, message: string, retryable = true): Promise<void> {
    await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const state = toMutableState(decodeState(root, this.defaults).state);
      const currentJob = state.jobs[job.jobId];
      if (currentJob?.status !== 'processing' || currentJob.attempt !== job.attempt) {
        return { next: root, result: undefined };
      }
      if (!state.settings.enabled || this.disposed) {
        state.jobs[job.jobId] = { ...currentJob, status: 'queued', nextAttemptAt: undefined, updatedAt: this.now() };
      } else if (!retryable || currentJob.attempt >= this.retryPolicy.maxAttempts) {
        state.jobs[job.jobId] = {
          ...currentJob,
          status: 'failed',
          lastError: safeError(code, message, this.now()),
          updatedAt: this.now(),
        };
      } else {
        const delay = retryDelay(this.retryPolicy, currentJob.attempt);
        state.jobs[job.jobId] = {
          ...currentJob,
          status: 'retry-wait',
          nextAttemptAt: new Date(Date.parse(this.now()) + delay).toISOString(),
          lastError: safeError(code, message, this.now()),
          updatedAt: this.now(),
        };
      }
      root[ORGANIZATION_NAMESPACE] = state;
      return { next: root, result: undefined };
    });
  }

  private async scheduleWake(): Promise<void> {
    if (this.disposed || this.wakeTimer !== undefined) {
      return;
    }
    const state = decodeState(await this.repository.read(), this.defaults).state;
    if (!state.settings.enabled) {
      return;
    }
    const times = Object.values(state.jobs)
      .filter((job) => job.status === 'retry-wait' && job.nextAttemptAt !== undefined)
      .map((job) => Date.parse(job.nextAttemptAt as string))
      .filter((value) => Number.isFinite(value));
    if (times.length === 0) {
      return;
    }
    const delay = Math.max(0, Math.min(...times) - Date.parse(this.now()));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.kick();
    }, delay);
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }
}

function validateSubmission(submission: OrganizationSubmission): void {
  if (submission.localReceipt.localPersisted !== true) {
    throw new OrganizationQueueError('local-receipt-required', 'Organization requires a written local receipt first');
  }
  if (
    submission.snapshot.id !== submission.localReceipt.captureId ||
    submission.snapshot.revision !== submission.localReceipt.revision
  ) {
    throw new OrganizationQueueError('receipt-mismatch', 'Local receipt does not match the submitted snapshot');
  }
  if (submission.localReceipt.notePath !== submission.baseline.path) {
    throw new OrganizationQueueError('baseline-mismatch', 'Baseline path does not match the local receipt');
  }
  if (submission.baseline.content.length === 0) {
    throw new OrganizationQueueError('baseline-missing', 'Organization requires the written note baseline');
  }
}

function sameSubmission(job: OrganizationJob, submission: OrganizationSubmission): boolean {
  return (
    JSON.stringify(job.snapshot) === JSON.stringify(submission.snapshot) &&
    JSON.stringify(job.localReceipt) === JSON.stringify(submission.localReceipt) &&
    JSON.stringify(job.baseline) === JSON.stringify(submission.baseline) &&
    job.intent === submission.intent &&
    JSON.stringify(job.overrides) === JSON.stringify(submission.overrides ?? {})
  );
}

function receiptFor(job: OrganizationJob): OrganizationEnqueueReceipt {
  return {
    jobId: job.jobId,
    captureId: job.captureId,
    revision: job.revision,
    localReceiptConfirmed: true,
    status: job.status,
  };
}

function normalizeRetry(input: Partial<OrganizationRetryPolicy> | undefined): OrganizationRetryPolicy {
  const maxAttempts = input?.maxAttempts ?? 3;
  const baseDelayMs = input?.baseDelayMs ?? 1_000;
  const maxDelayMs = input?.maxDelayMs ?? 60_000;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isFinite(baseDelayMs) ||
    baseDelayMs < 0 ||
    !Number.isFinite(maxDelayMs) ||
    maxDelayMs < 0
  ) {
    throw new OrganizationQueueError('invalid-retry-policy', 'Retry policy must be bounded and non-negative');
  }
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
  };
}

function retryDelay(policy: OrganizationRetryPolicy, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

function sanitizeDecision(value: OrganizationDecision): OrganizationDecision | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  if (value.outcome !== 'certain' && value.outcome !== 'uncertain' && value.outcome !== 'declined') {
    return undefined;
  }
  if (value.properties !== undefined && !isRecord(value.properties)) {
    return undefined;
  }
  const properties: Record<string, OrganizationValue> = {};
  for (const [key, property] of Object.entries(value.properties ?? {})) {
    if (!isOrganizationValue(property)) {
      return undefined;
    }
    properties[key] = clone(property);
  }
  const tags = value.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    return undefined;
  }
  return {
    outcome: value.outcome,
    properties,
    tags: [...tags],
  };
}

function acceptedAutomaticDecision(job: OrganizationJob): OrganizationDecision | undefined {
  if (job.policy !== 'automatic') {
    return undefined;
  }
  const decision = job.decision === undefined ? undefined : sanitizeDecision(job.decision);
  return decision?.outcome === 'certain' ? decision : undefined;
}

function isOrganizationValue(value: unknown): value is OrganizationValue {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function retryableFrom(error: unknown): boolean {
  return !isRecord(error) || typeof error.retryable !== 'boolean' ? true : error.retryable;
}

function safeError(code: string, message: string, at: string): OrganizationError {
  return { code, message, at };
}

function decodeState(envelope: unknown, defaults: OrganizationStoreSettings): DecodedState {
  if (!isRecord(envelope)) {
    return { state: emptyState(defaults), present: false, corrupt: false };
  }
  const raw = envelope[ORGANIZATION_NAMESPACE];
  if (raw === undefined) {
    return { state: emptyState(defaults), present: false, corrupt: false };
  }
  if (!isRecord(raw) || raw.schemaVersion !== ORGANIZATION_SCHEMA_VERSION) {
    return { state: emptyState(defaults), present: true, corrupt: true };
  }
  const rawSettings = raw.settings;
  const rawJobs = raw.jobs;
  if (
    !isRecord(rawSettings) ||
    typeof rawSettings.enabled !== 'boolean' ||
    !isPolicy(rawSettings.policy) ||
    !isRecord(rawJobs)
  ) {
    return { state: emptyState(defaults), present: true, corrupt: true };
  }
  const jobs: Record<string, OrganizationJob> = {};
  let corrupt = false;
  for (const [jobId, rawJob] of Object.entries(rawJobs)) {
    const parsed = decodeJob(jobId, rawJob);
    if (parsed === undefined) {
      corrupt = true;
    } else {
      jobs[jobId] = parsed;
    }
  }
  return {
    state: {
      schemaVersion: 1,
      settings: { enabled: rawSettings.enabled, policy: rawSettings.policy },
      jobs,
    },
    present: true,
    corrupt,
  };
}

function decodeJob(key: string, value: unknown): OrganizationJob | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (
    typeof value.jobId !== 'string' ||
    value.jobId !== key ||
    typeof value.captureId !== 'string' ||
    !Number.isInteger(value.revision) ||
    !isJobStatus(value.status) ||
    !isPolicy(value.policy) ||
    (value.intent !== 'opt-in' && value.intent !== 'skip') ||
    !Number.isInteger(value.attempt) ||
    value.attempt < 0 ||
    !isRecord(value.snapshot) ||
    !isRecord(value.localReceipt) ||
    !isRecord(value.baseline) ||
    !isRecord(value.overrides) ||
    typeof value.enqueuedAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return clone(value) as OrganizationJob;
}

function emptyState(settings: OrganizationStoreSettings): OrganizationStoreState {
  return { schemaVersion: 1, settings: clone(settings), jobs: {} };
}

function toMutableState(state: OrganizationStoreState): MutableStoreState {
  return {
    schemaVersion: 1,
    settings: clone(state.settings),
    jobs: clone(state.jobs) as Record<string, OrganizationJob>,
  };
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function isPolicy(value: unknown): value is OrganizationPolicy {
  return value === 'advisory' || value === 'automatic';
}

function isJobStatus(value: unknown): value is OrganizationJobStatus {
  return typeof value === 'string' && JOB_STATUSES.has(value as OrganizationJobStatus);
}

function assertNotDisposed(disposed: boolean): void {
  if (disposed) {
    throw new OrganizationQueueError('disposed', 'Organization queue is disposed');
  }
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => clone(item)) as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = clone(child);
  }
  return result as T;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
