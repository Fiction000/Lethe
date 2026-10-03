import { classifyCaptureSnapshot, type JevCaptureDecision, type JevTransport } from '../jev';
import { hasNativeSecretStorage, normalizeJevSettings, type JevSettings } from '../jevSettings';
import { mapJevDecision } from '../jev/policy';
import { JEV_SMOKE_QUALITY_GATE } from '../jev/smokeGate';
import type { JevQualityGate } from '../jev/qualityGate';
import type { CaptureSnapshot } from '../capture/core';
import type { LetheDataRepository, TransactionChange } from '../capture/repository';
import type { FrontmatterPort, OrganizationExecutorOptions, OrganizationVaultPort } from './executor';
import { OrganizationExecutor } from './executor';
import { OrganizationQueue, type OrganizationDecisionProvider } from './queue';
import {
  organizationJobId,
  type OrganizationBaseline,
  type OrganizationDecision,
  type OrganizationEnqueueReceipt,
  type OrganizationJob,
  type OrganizationLocalReceipt,
  type OrganizationOverrides,
  type OrganizationPolicy,
  type OrganizationQueueOptions,
  type OrganizationSubmission,
} from './types';

export const ORGANIZATION_ENROLLMENT_NAMESPACE = '_organizationEnrollment' as const;
export const ORGANIZATION_ENROLLMENT_SCHEMA_VERSION = 1 as const;

export interface JevPolicyHookOptions {
  readonly approvedTags?: readonly { readonly tag: string; readonly description?: string }[];
  /** Parent-owned live quality gate. This bridge never interprets it. */
  readonly qualityGate?: JevQualityGate;
}

/** Parent-owned Jev policy boundary; raw Jev confidence is not a write policy. */
export type OrganizationPolicyHook = (
  snapshot: CaptureSnapshot,
  decision: JevCaptureDecision,
  options?: JevPolicyHookOptions,
) => OrganizationDecision | Promise<OrganizationDecision>;

export interface OrganizationRuntimeBridgeOptions {
  readonly repository: LetheDataRepository;
  readonly vault: OrganizationVaultPort;
  readonly frontmatter: FrontmatterPort;
  readonly settings: JevSettings;
  readonly policy?: OrganizationPolicyHook;
  readonly qualityGate?: JevQualityGate;
  readonly readApiKey?: (secretId: string) => string | null | Promise<string | null>;
  readonly transport?: JevTransport;
  /** False when the host lacks both native secret storage and SecretComponent. */
  readonly remoteProcessingAvailable?: () => boolean;
  /** Test/local override; production uses the Jev provider below. */
  readonly provider?: OrganizationDecisionProvider;
  readonly retry?: OrganizationQueueOptions['retry'];
  readonly now?: () => string;
  readonly inboxFolder?: string;
  readonly notesFolder?: string;
  readonly onStateChange?: () => void;
}

export class JevRuntimeBridgeError extends Error {
  public constructor(
    public readonly code: 'missing-secret' | 'policy-unavailable',
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'JevRuntimeBridgeError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface OrganizationEnrollment {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly captureId: string;
  readonly revision: number;
  readonly snapshot: CaptureSnapshot;
  readonly intent: 'opt-in' | 'skip';
  readonly policy: OrganizationPolicy;
  readonly overrides: OrganizationOverrides;
  readonly enrolledAt: string;
  readonly localReceipt?: OrganizationLocalReceipt;
  readonly baseline?: OrganizationBaseline;
}

interface OrganizationEnrollmentState {
  readonly schemaVersion: 1;
  readonly captures: Record<string, OrganizationEnrollment>;
}

export class OrganizationRuntimeBridge {
  public readonly queue: OrganizationQueue;

  private settings: JevSettings;
  private transport?: JevTransport;
  private readonly policy?: OrganizationPolicyHook;
  private readonly qualityGate?: JevQualityGate;
  private readonly readApiKey: (secretId: string) => string | null | Promise<string | null>;
  private readonly remoteProcessingAvailable: () => boolean;
  private readonly listeners = new Set<() => void>();
  private readonly onStateChange?: () => void;
  private disposed = false;
  private ready?: Promise<void>;

  public constructor(options: OrganizationRuntimeBridgeOptions) {
    this.remoteProcessingAvailable = options.remoteProcessingAvailable ?? (() => true);
    this.settings = this.normalizeSettings(options.settings);
    this.transport = options.transport;
    this.policy = options.policy;
    this.qualityGate = options.qualityGate;
    this.readApiKey = options.readApiKey ?? (() => null);
    this.onStateChange = options.onStateChange;

    const observedRepository: LetheDataRepository = {
      read: () => options.repository.read(),
      readFresh: options.repository.readFresh ? () => options.repository.readFresh?.() as Promise<unknown> : undefined,
      transact: <T>(mutate: (current: unknown) => TransactionChange<T>) =>
        options.repository.transact<T>(mutate).then((result) => {
          this.emitStateChange();
          return result;
        }),
    };
    const provider = options.provider ?? { decide: (request) => this.decide(request) };
    const executorOptions: OrganizationExecutorOptions = {
      vault: options.vault,
      frontmatter: options.frontmatter,
      inboxFolder: options.inboxFolder,
      notesFolder: options.notesFolder,
    };
    this.queue = new OrganizationQueue({
      repository: observedRepository,
      provider,
      executor: new OrganizationExecutor(executorOptions),
      enabled: this.settings.mode !== 'off',
      policy: policyForMode(this.settings.mode),
      enforceSettings: true,
      retry: options.retry,
      now: options.now,
      inboxFolder: options.inboxFolder,
      notesFolder: options.notesFolder,
    });
  }

  public initialize(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('Organization runtime bridge is disposed'));
    }
    if (!this.ready) {
      this.ready = this.queue.initialize().catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    }
    return this.ready;
  }

  public getOrganizationMode(): JevSettings['mode'] {
    return this.settings.mode;
  }

  public getSettings(): JevSettings {
    return clone(this.settings);
  }

  public setTransport(transport: JevTransport | undefined): void {
    this.transport = transport;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async updateSettings(input: JevSettings): Promise<void> {
    if (this.disposed) {
      return;
    }
    const next = this.normalizeSettings(input);
    // Disable first: this aborts the provider and makes a late request unable
    // to reach the executor. Wait before re-enabling to avoid a second request
    // racing an unabortable requestUrl call.
    await this.queue.setEnabled(false);
    await this.queue.waitForIdle();
    this.settings = next;
    await this.queue.setPolicy(policyForMode(next.mode));
    if (next.mode !== 'off') {
      await this.queue.setEnabled(true);
    }
    this.emitStateChange();
  }

  public enqueue(submission: OrganizationSubmission): Promise<OrganizationEnqueueReceipt> {
    return this.queue.enqueue(submission);
  }

  public getJob(jobId: string): Promise<OrganizationJob | undefined> {
    return this.queue.getJob(jobId);
  }

  public listJobs(): Promise<readonly OrganizationJob[]> {
    return this.queue.listJobs();
  }

  public retry(captureId: string, revision: number): Promise<void> {
    return this.queue.retry(captureId, revision);
  }

  public skip(captureId: string, revision: number): Promise<void> {
    return this.queue.skip(captureId, revision);
  }

  public undo(captureId: string, revision: number) {
    return this.queue.undo(captureId, revision);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.queue.dispose();
    this.listeners.clear();
  }

  private async decide(request: Parameters<OrganizationDecisionProvider['decide']>[0]): Promise<OrganizationDecision> {
    const settings = this.settings;
    if (settings.mode === 'off' || request.signal.aborted || !this.canUseRemoteProcessing()) {
      return { outcome: 'uncertain' };
    }

    const job = await this.queue.getJob(organizationJobId(request.capture.id, request.capture.revision));
    if (job?.policy === 'automatic' && settings.mode !== 'automatic') {
      return { outcome: 'uncertain' };
    }

    // This is intentionally the only point where the configured secret ID is
    // resolved. The key is never retained in bridge state or a job payload.
    const apiKey = await this.readApiKey(settings.secretId);
    if (!this.canUseRemoteProcessing()) {
      return { outcome: 'uncertain' };
    }
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new JevRuntimeBridgeError('missing-secret', 'Jev secure key is unavailable', false);
    }

    const raw = await classifyCaptureSnapshot(request.capture, {
      apiKey,
      approvedTags: settings.approvedTags,
      model: settings.model,
      signal: request.signal,
      transport: this.transport,
    });
    if (request.signal.aborted || this.settings.mode === 'off') {
      return { outcome: 'uncertain' };
    }
    if (job?.policy === 'automatic' && this.settings.mode !== 'automatic') {
      return { outcome: 'uncertain' };
    }
    if (this.policy) {
      return this.policy(request.capture, raw, {
        approvedTags: settings.approvedTags,
        qualityGate: this.qualityGate ?? JEV_SMOKE_QUALITY_GATE,
      });
    }
    return mapJevDecision(request.capture, raw, {
      approvedTags: settings.approvedTags,
      qualityGate: JEV_SMOKE_QUALITY_GATE,
    });
  }

  private emitStateChange(): void {
    this.onStateChange?.();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private normalizeSettings(input: JevSettings): JevSettings {
    const normalized = normalizeJevSettings(input);
    return this.canUseRemoteProcessing() ? normalized : { ...normalized, mode: 'off' };
  }

  private canUseRemoteProcessing(): boolean {
    try {
      return this.remoteProcessingAvailable() === true;
    } catch {
      return false;
    }
  }
}

export function createObsidianSecretReader(
  app: unknown,
  nativeSecretComponentAvailable = true,
): (secretId: string) => Promise<string | null> {
  return async (secretId: string) => {
    if (!nativeSecretComponentAvailable || !hasNativeSecretStorage(app)) {
      return null;
    }
    try {
      const storage = (app as { secretStorage: { getSecret: (id: string) => string | null } }).secretStorage;
      const value = await Promise.resolve(storage.getSecret(secretId));
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch {
      return null;
    }
  };
}

export function organizationOverridesForSnapshot(snapshot: CaptureSnapshot): OrganizationOverrides {
  const properties: Record<string, OrganizationOverrides['properties'][string]> = {};
  for (const [key, intent] of Object.entries(snapshot.fields)) {
    properties[key] = intent.state === 'cleared' ? { state: 'cleared' } : { state: 'set', value: clone(intent.value) };
  }
  return {
    ...(Object.keys(properties).length === 0 ? {} : { properties }),
    tagTombstones: snapshot.tags.userRemoved.map(normalizeTag).filter((tag) => tag !== ''),
  };
}

export async function saveOrganizationEnrollment(
  repository: LetheDataRepository,
  enrollment: OrganizationEnrollment,
): Promise<void> {
  await repository.transact((current) => {
    const root = asMutableRecord(current);
    const state = readEnrollmentState(root);
    state.captures[enrollment.jobId] = clone(enrollment);
    root[ORGANIZATION_ENROLLMENT_NAMESPACE] = state;
    return { next: root, result: undefined };
  });
}

export async function updateOrganizationEnrollment(
  repository: LetheDataRepository,
  jobId: string,
  patch: Pick<OrganizationEnrollment, 'localReceipt' | 'baseline'>,
): Promise<void> {
  await repository.transact((current) => {
    const root = asMutableRecord(current);
    const state = readEnrollmentState(root);
    const existing = state.captures[jobId];
    if (existing !== undefined) {
      state.captures[jobId] = { ...existing, ...clone(patch) };
      root[ORGANIZATION_ENROLLMENT_NAMESPACE] = state;
    }
    return { next: root, result: undefined };
  });
}

export async function listOrganizationEnrollments(
  repository: LetheDataRepository,
): Promise<readonly OrganizationEnrollment[]> {
  const root = await repository.read();
  return Object.values(readEnrollmentState(asMutableRecord(root)).captures).map((entry) => clone(entry));
}

export async function removeOrganizationEnrollment(repository: LetheDataRepository, jobId: string): Promise<void> {
  await repository.transact((current) => {
    const root = asMutableRecord(current);
    const state = readEnrollmentState(root);
    delete state.captures[jobId];
    if (Object.keys(state.captures).length === 0) {
      delete root[ORGANIZATION_ENROLLMENT_NAMESPACE];
    } else {
      root[ORGANIZATION_ENROLLMENT_NAMESPACE] = state;
    }
    return { next: root, result: undefined };
  });
}

/** Remove organization-only runtime data before settings are serialized. */
export function stripOrganizationRuntimeNamespaces(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  delete result._organizationStore;
  delete result._organizationEnrollment;
  return result;
}

function policyForMode(mode: JevSettings['mode']): OrganizationPolicy {
  return mode === 'automatic' ? 'automatic' : 'advisory';
}

function readEnrollmentState(root: Record<string, unknown>): OrganizationEnrollmentState {
  const raw = root[ORGANIZATION_ENROLLMENT_NAMESPACE];
  if (!isRecord(raw) || raw.schemaVersion !== ORGANIZATION_ENROLLMENT_SCHEMA_VERSION || !isRecord(raw.captures)) {
    return { schemaVersion: 1, captures: {} };
  }
  const captures: Record<string, OrganizationEnrollment> = {};
  for (const [key, value] of Object.entries(raw.captures)) {
    if (isRecord(value) && value.schemaVersion === 1 && value.jobId === key && isRecord(value.snapshot)) {
      captures[key] = clone(value) as OrganizationEnrollment;
    }
  }
  return { schemaVersion: 1, captures };
}

function normalizeTag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
