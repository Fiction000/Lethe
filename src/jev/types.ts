import type { CaptureId, CaptureProfile, CaptureSnapshot, Revision } from '../capture/core';

export const JEV_SYSTEM_ONE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone' as const;
export const DEFAULT_JEV_MODEL = 'jev-latest' as const;
export const DEFAULT_JEV_TIMEOUT_MS = 15_000 as const;
export const MAX_JEV_TIMEOUT_MS = 120_000 as const;
export const JEV_PROBABILITY_SUM_EPSILON = 1e-6 as const;

export type JevJsonPrimitive = string | number | boolean | null;
export type JevJsonValue = JevJsonPrimitive | readonly JevJsonValue[] | { readonly [key: string]: JevJsonValue };

export type JevQuestionInstructions = string | JevJsonValue;
export type JevCriteriaValue = JevJsonValue;

export interface JevChoiceQuestion {
  readonly type: 'choice';
  readonly instructions: JevQuestionInstructions;
  readonly criteria: Readonly<Record<string, JevCriteriaValue>>;
}

export interface JevNoulQuestion {
  readonly type: 'noul';
  readonly instructions: JevQuestionInstructions;
  readonly criteria?: {
    readonly true: JevCriteriaValue;
    readonly false: JevCriteriaValue;
  };
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;
export type JevQuestionMap = Readonly<Record<string, JevQuestion>>;

export interface JevChoiceAnswer {
  readonly type: 'choice';
  readonly choice: string;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface JevNoulAnswer {
  readonly type: 'noul';
  readonly noul: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export interface JevUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface JevSystemOneResponse {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: JevUsage;
}

export interface JevTransportRequest {
  readonly url: typeof JEV_SYSTEM_ONE_ENDPOINT;
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export interface JevTransportResponse {
  readonly status: number;
  readonly text: () => Promise<string>;
}

export type JevTransport = (request: JevTransportRequest) => Promise<JevTransportResponse>;

export type JevErrorCode =
  | 'invalid_config'
  | 'invalid_response'
  | 'http_error'
  | 'transport_error'
  | 'timeout'
  | 'aborted';

export class JevAdapterError extends Error {
  public readonly retryable: boolean;
  public readonly status?: number;

  public constructor(
    public readonly code: JevErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly status?: number } = {},
  ) {
    super(message);
    this.name = 'JevAdapterError';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface JevSystemOneRequestOptions {
  readonly apiKey: string;
  readonly state: JevJsonValue;
  readonly questions: JevQuestionMap;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly transport?: JevTransport;
}

export interface ApprovedJevTag {
  readonly tag: string;
  readonly description?: string;
  readonly instructions?: string;
}

export interface JevClassifierOptions {
  readonly apiKey: string;
  readonly approvedTags: readonly ApprovedJevTag[];
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly transport?: JevTransport;
}

export interface JevTagQuestionPlan {
  readonly tag: string;
  readonly questionId: string;
}

export interface JevQuestionPlan {
  readonly questions: JevQuestionMap;
  readonly profileQuestionId?: string;
  readonly tagQuestions: readonly JevTagQuestionPlan[];
}

export interface JevInferredProfileDecision {
  readonly source: 'jev';
  readonly profile: 'plain' | 'book' | 'movie';
  readonly choice: 'book' | 'movie' | 'no-match';
  readonly probabilities: Readonly<Record<'book' | 'movie' | 'no-match', number>>;
  readonly confidence: number;
}

export interface JevExplicitProfileDecision {
  readonly source: 'explicit-profile';
  readonly profile: 'plain' | 'book' | 'movie';
}

export interface JevExplicitTagDecision {
  readonly source: 'explicit-tag';
  readonly profile: 'book' | 'movie';
  readonly tag: 'type/book' | 'type/movie';
}

export interface JevExplicitConflictDecision {
  readonly source: 'explicit-conflict';
  readonly profile: 'plain';
  readonly tags: readonly ['type/book', 'type/movie'];
}

export type JevProfileDecision =
  | JevInferredProfileDecision
  | JevExplicitProfileDecision
  | JevExplicitTagDecision
  | JevExplicitConflictDecision;

export interface JevTagJudgment {
  readonly tag: string;
  readonly questionId: string;
  /** Raw Noul probability; this adapter does not choose an application threshold. */
  readonly noul: number;
  readonly active: boolean;
  readonly removed: boolean;
  /** False for active or removed tags; no write is performed by this adapter. */
  readonly eligibleForAddition: boolean;
}

export interface JevCaptureDecision {
  readonly captureId: CaptureId;
  readonly revision: Revision;
  readonly profile: JevProfileDecision;
  readonly tags: readonly JevTagJudgment[];
  readonly model?: string;
  readonly usage?: JevUsage;
}

export interface JevEvaluationResult {
  readonly caseId: string;
  readonly kind: 'live-evaluation';
  readonly expected: unknown;
  readonly observed: JevCaptureDecision | { readonly error: JevErrorCode; readonly retryable: boolean };
}

export type CaptureSnapshotForJev = CaptureSnapshot;
export type CaptureProfileForJev = CaptureProfile;
