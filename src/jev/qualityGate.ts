import type { JevCaptureDecision, JevTagJudgment } from './types';

export const JEV_QUESTION_VERSION = 'capture-profile-v1' as const;
export const JEV_PROFILE_PROBABILITY_THRESHOLD = 0.95 as const;
export const JEV_PROFILE_CONFIDENCE_THRESHOLD = 0.9 as const;
export const JEV_TAG_PROBABILITY_THRESHOLD = 0.95 as const;

export const JEV_PROFILE_TAXONOMY = Object.freeze({
  book: 'A substantive capture about a specific book, reading experience, or book review. Incidental mentions, book clubs, or the verb “book” do not qualify.',
  movie: 'A substantive capture about a specific movie, film, or movie review. Incidental mentions do not qualify.',
  'no-match':
    'The capture is unrelated, ambiguous between book and movie, or only mentions one in passing; do not guess.',
} as const);

export type JevProfileCategory = 'book' | 'movie';

export interface JevProfileQualification {
  readonly profile: JevProfileCategory;
  /** Exact taxonomy meaning used by the preregistered Choice question. */
  readonly meaning: string;
}

export interface JevTagQualification {
  readonly tag: string;
  /** Exact description used by the preregistered Noul question. */
  readonly description?: string;
}

/**
 * Evidence produced by a bounded live evaluation. Empty or omitted evidence is
 * intentionally non-permissive: it cannot authorize automatic organization.
 */
export interface JevQualityGate {
  /** Exact model string returned by the qualifying live requests. */
  readonly model: string;
  /** Exact question/prompt contract version used by the qualifying requests. */
  readonly questionVersion: string;
  /** Categories that met the fixed profile thresholds in the live smoke corpus. */
  readonly qualifiedProfiles: readonly JevProfileQualification[];
  /** Tags whose exact approved meaning met the fixed Noul threshold. */
  readonly qualifiedTags: readonly JevTagQualification[];
}

/** A non-permissive value useful when a caller needs an explicit default. */
export const DEFAULT_JEV_QUALITY_GATE: JevQualityGate = Object.freeze({
  model: '',
  questionVersion: '',
  qualifiedProfiles: Object.freeze([]),
  qualifiedTags: Object.freeze([]),
});

function sameModelAndQuestionVersion(decision: JevCaptureDecision, gate: JevQualityGate): boolean {
  return (
    typeof decision.model === 'string' &&
    decision.model.length > 0 &&
    decision.model === gate.model &&
    gate.questionVersion === JEV_QUESTION_VERSION
  );
}

/** Return true only when the fixed preregistered profile gate is satisfied. */
export function gateAllowsJevProfile(
  decision: JevCaptureDecision,
  profile: JevProfileCategory,
  gate: JevQualityGate | undefined,
): boolean {
  if (gate === undefined || decision.profile.source !== 'jev' || decision.profile.profile !== profile) {
    return false;
  }
  if (!sameModelAndQuestionVersion(decision, gate)) {
    return false;
  }
  const probability = decision.profile.probabilities[profile];
  if (
    probability < JEV_PROFILE_PROBABILITY_THRESHOLD ||
    decision.profile.confidence < JEV_PROFILE_CONFIDENCE_THRESHOLD
  ) {
    return false;
  }
  return gate.qualifiedProfiles.some(
    (qualification) => qualification.profile === profile && qualification.meaning === JEV_PROFILE_TAXONOMY[profile],
  );
}

function approvedTagDescription(
  approvedTags: readonly { readonly tag: string; readonly description?: string }[],
  tag: string,
): string | undefined {
  const normalized = normalizeTag(tag);
  return approvedTags.find((entry) => normalizeTag(entry.tag) === normalized)?.description;
}

/**
 * Return true only when a tag has both a fixed-threshold judgment and exact
 * model/question/taxonomy evidence. This is the certainty path; callers may
 * still expose a bounded judgment as advisory when this returns false.
 */
export function gateAllowsJevTag(
  decision: JevCaptureDecision,
  judgment: JevTagJudgment,
  approvedTags: readonly { readonly tag: string; readonly description?: string }[],
  gate: JevQualityGate | undefined,
): boolean {
  if (
    gate === undefined ||
    !sameModelAndQuestionVersion(decision, gate) ||
    judgment.noul < JEV_TAG_PROBABILITY_THRESHOLD ||
    !judgment.eligibleForAddition ||
    judgment.active ||
    judgment.removed
  ) {
    return false;
  }
  const normalized = normalizeTag(judgment.tag);
  const description = approvedTagDescription(approvedTags, normalized);
  if (description === undefined) {
    return false;
  }
  return gate.qualifiedTags.some(
    (qualification) =>
      normalizeTag(qualification.tag) === normalized &&
      typeof qualification.description === 'string' &&
      qualification.description === description,
  );
}

/**
 * A high-probability approved tag that is not gate-qualified is advisory only.
 * It is deliberately bounded by the same preregistered Noul threshold.
 */
export function isAdvisoryJevTag(
  judgment: JevTagJudgment,
  approvedTags: readonly { readonly tag: string; readonly description?: string }[],
): boolean {
  return (
    judgment.noul >= JEV_TAG_PROBABILITY_THRESHOLD &&
    judgment.eligibleForAddition &&
    !judgment.active &&
    !judgment.removed &&
    approvedTagDescription(approvedTags, judgment.tag) !== undefined
  );
}

function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
}
