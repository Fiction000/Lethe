import type { CaptureSnapshot } from '../capture/core';
import type { LetheDataRepository } from '../capture/repository';

export const ORGANIZATION_NAMESPACE = '_organizationStore' as const;
export const ORGANIZATION_SCHEMA_VERSION = 1 as const;

export type OrganizationPolicy = 'advisory' | 'automatic';
export type OrganizationIntent = 'opt-in' | 'skip';
export type OrganizationDecisionOutcome = 'certain' | 'uncertain' | 'declined';
export type OrganizationValue = string | number | boolean | string[];

export type OrganizationJobStatus =
  | 'queued'
  | 'processing'
  | 'retry-wait'
  | 'advisory'
  | 'uncertain'
  | 'applied'
  | 'undone'
  | 'failed'
  | 'conflict'
  | 'deleted'
  | 'skipped'
  | 'cancelled';

export interface OrganizationPropertyOverrideSet {
  readonly state: 'set';
  readonly value: OrganizationValue;
}

export interface OrganizationPropertyOverrideCleared {
  readonly state: 'cleared';
}

export type OrganizationPropertyOverride = OrganizationPropertyOverrideSet | OrganizationPropertyOverrideCleared;

/** User decisions are persisted separately so a provider cannot restore them. */
export interface OrganizationOverrides {
  readonly properties?: Readonly<Record<string, OrganizationPropertyOverride>>;
  readonly propertyTombstones?: readonly string[];
  readonly tagTombstones?: readonly string[];
}

export interface OrganizationLocalReceipt {
  readonly captureId: string;
  readonly revision: number;
  readonly localPersisted: true;
  readonly notePath: string;
  readonly noteFolder: 'inbox' | 'notes';
  readonly persistedAt: string;
}

/** The exact note bytes observed after the local capture receipt was written. */
export interface OrganizationBaseline {
  readonly path: string;
  readonly folder: 'inbox' | 'notes';
  readonly content: string;
}

export interface OrganizationSubmission {
  readonly snapshot: CaptureSnapshot;
  readonly localReceipt: OrganizationLocalReceipt;
  readonly baseline: OrganizationBaseline;
  readonly intent: OrganizationIntent;
  readonly policy?: OrganizationPolicy;
  readonly overrides?: OrganizationOverrides;
}

export interface OrganizationDecisionRequest {
  readonly capture: CaptureSnapshot;
  readonly note: Readonly<{
    path: string;
    folder: 'inbox' | 'notes';
    body: string;
  }>;
  readonly overrides: OrganizationOverrides;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

/**
 * The parent Jev adapter implements this local contract. It may call a network
 * service only after the queue has durably accepted an OrganizationSubmission.
 */
export interface OrganizationDecisionProvider {
  decide(request: OrganizationDecisionRequest): Promise<OrganizationDecision>;
}

export interface OrganizationDecision {
  readonly outcome: OrganizationDecisionOutcome;
  readonly properties?: Readonly<Record<string, OrganizationValue>>;
  readonly tags?: readonly string[];
}

export interface OrganizationAppliedProperty {
  readonly before: { readonly present: false } | { readonly present: true; readonly value: unknown };
  readonly after: OrganizationValue;
}

export interface OrganizationPromotionRecord {
  readonly from: string;
  readonly to: string;
}

/** Small generated-only preimage; unrelated user metadata is never overwritten. */
export interface OrganizationAppliedMetadata {
  readonly path: string;
  readonly body: string;
  readonly properties: Readonly<Record<string, OrganizationAppliedProperty>>;
  readonly addedTags: readonly string[];
  /** Exact tag array observed after apply; omitted for legacy or unreliable records. */
  readonly tagsAfter?: readonly string[];
  readonly promotion?: OrganizationPromotionRecord;
}

export interface OrganizationError {
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface OrganizationJob {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly captureId: string;
  readonly revision: number;
  readonly snapshot: CaptureSnapshot;
  readonly localReceipt: OrganizationLocalReceipt;
  readonly baseline: OrganizationBaseline;
  readonly intent: OrganizationIntent;
  readonly policy: OrganizationPolicy;
  readonly overrides: OrganizationOverrides;
  readonly status: OrganizationJobStatus;
  readonly attempt: number;
  readonly enqueuedAt: string;
  readonly updatedAt: string;
  readonly nextAttemptAt?: string;
  readonly notePath?: string;
  readonly decision?: OrganizationDecision;
  readonly applied?: OrganizationAppliedMetadata;
  readonly lastError?: OrganizationError;
}

export interface OrganizationStoreSettings {
  readonly enabled: boolean;
  readonly policy: OrganizationPolicy;
}

export interface OrganizationStoreState {
  readonly schemaVersion: 1;
  readonly settings: OrganizationStoreSettings;
  readonly jobs: Readonly<Record<string, OrganizationJob>>;
}

export interface OrganizationEnqueueReceipt {
  readonly jobId: string;
  readonly captureId: string;
  readonly revision: number;
  readonly localReceiptConfirmed: true;
  readonly status: OrganizationJobStatus;
}

export interface OrganizationRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface OrganizationQueueOptions {
  readonly repository: LetheDataRepository;
  readonly provider: OrganizationDecisionProvider;
  readonly executor: OrganizationExecutorPort;
  readonly enabled?: boolean;
  readonly policy?: OrganizationPolicy;
  readonly retry?: Partial<OrganizationRetryPolicy>;
  readonly now?: () => string;
  readonly inboxFolder?: string;
  readonly notesFolder?: string;
}

export interface OrganizationApplyRequest {
  readonly capture: CaptureSnapshot;
  readonly baseline: OrganizationBaseline;
  readonly notePath: string;
  readonly decision: OrganizationDecision;
  readonly overrides: OrganizationOverrides;
  readonly signal: AbortSignal;
}

export type OrganizationApplyResult =
  | {
      readonly status: 'applied';
      readonly notePath: string;
      readonly applied: OrganizationAppliedMetadata;
    }
  | {
      readonly status: 'conflict';
      readonly code: string;
      readonly notePath?: string;
    }
  | {
      readonly status: 'deleted';
      readonly code: 'known-deletion';
      readonly notePath?: string;
    };

export interface OrganizationUndoRequest {
  readonly capture: CaptureSnapshot;
  readonly baseline: OrganizationBaseline;
  readonly notePath: string;
  readonly applied: OrganizationAppliedMetadata;
  readonly signal: AbortSignal;
}

export type OrganizationUndoResult =
  | {
      readonly status: 'undone' | 'unchanged';
      readonly notePath: string;
    }
  | {
      readonly status: 'conflict';
      readonly code: string;
      readonly notePath?: string;
    }
  | {
      readonly status: 'deleted';
      readonly code: 'known-deletion';
      readonly notePath?: string;
    };

export interface OrganizationExecutorPort {
  apply(request: OrganizationApplyRequest): Promise<OrganizationApplyResult>;
  undo(request: OrganizationUndoRequest): Promise<OrganizationUndoResult>;
}

export interface OrganizationUndoReceipt {
  readonly jobId: string;
  readonly result: OrganizationUndoResult;
}

export function organizationJobId(captureId: string, revision: number): string {
  return JSON.stringify([captureId, revision]);
}
