import { materializeCapture, type ConcreteProfileId } from '../capture/profiles';
import type { CaptureSnapshot } from '../capture/core';
import type { OrganizationDecision, OrganizationValue } from '../organization/types';
import type { JevCaptureDecision } from './types';
import {
  gateAllowsJevProfile,
  gateAllowsJevTag,
  isAdvisoryJevTag,
  type JevQualityGate,
  type JevProfileCategory,
} from './qualityGate';

const PROFILE_TAGS: Readonly<Record<ConcreteProfileId, readonly string[]>> = {
  plain: [],
  book: ['type/book', 'type/review'],
  movie: ['type/movie', 'type/review'],
};

const RESERVED_CAPTURE_MARKERS = new Set([
  'tags',
  'lethe_capture_id',
  'lethe_capture_revision',
  'lethe_profile_id',
  'lethe_profile_schema_version',
]);

export interface JevDecisionMappingOptions {
  readonly approvedTags?: readonly { readonly tag: string; readonly description?: string }[];
  readonly qualityGate?: JevQualityGate;
}

interface CandidateProfile {
  readonly profile: ConcreteProfileId;
  readonly manual: boolean;
}

/**
 * Map a side-effect-free Jev judgment into the queue's decision contract.
 *
 * Automatic certainty is intentionally narrow: explicit user choices are
 * deterministic, while inferred profiles require the fixed quality gate and
 * exact live-evidence pins. High-probability tags that are not qualified remain
 * bounded advisory suggestions on an `uncertain` decision.
 */
export function mapJevDecision(
  snapshot: CaptureSnapshot,
  decision: JevCaptureDecision,
  options: JevDecisionMappingOptions = {},
): OrganizationDecision {
  const approvedTags = options.approvedTags ?? [];
  if (decision.captureId !== snapshot.id || decision.revision !== snapshot.revision) {
    return { outcome: 'uncertain', properties: {}, tags: [] };
  }

  const removed = new Set(normalizeTags(snapshot.tags.userRemoved));
  const active = new Set(normalizeTags(snapshot.tags.userAdded).filter((tag) => !removed.has(tag)));
  const activeTypeTags = (['type/book', 'type/movie'] as const).filter((tag) => active.has(tag));
  const candidate = manualProfile(snapshot, activeTypeTags);

  if (candidate === 'conflict') {
    return { outcome: 'uncertain', properties: {}, tags: [] };
  }

  const advisoryTags = unique(
    decision.tags
      .filter((judgment) => isAdvisoryJevTag(judgment, approvedTags))
      .map((judgment) => normalizeTag(judgment.tag)),
  );
  const qualifiedTags = unique(
    decision.tags
      .filter((judgment) => gateAllowsJevTag(decision, judgment, approvedTags, options.qualityGate))
      .map((judgment) => normalizeTag(judgment.tag)),
  );

  if (candidate !== undefined) {
    // A model suggestion that is not live-qualified must never ride along on a
    // certain manual decision: OrganizationQueue applies all tags on certainty.
    if (advisoryTags.some((tag) => !qualifiedTags.includes(tag))) {
      return { outcome: 'uncertain', properties: {}, tags: advisoryTags };
    }
    return certainDecision(snapshot, candidate.profile, removed, qualifiedTags);
  }

  if (decision.profile.source !== 'jev' || decision.profile.profile === 'plain') {
    return { outcome: 'uncertain', properties: {}, tags: advisoryTags };
  }

  const inferredProfile = decision.profile.profile as JevProfileCategory;
  const blockedByTombstone = removed.has(`type/${inferredProfile}`);
  const profileQualified = !blockedByTombstone && gateAllowsJevProfile(decision, inferredProfile, options.qualityGate);

  // Unqualified tag suggestions stay advisory even when the profile itself is
  // qualified. They therefore prevent a certain write and stay in Inbox.
  if (advisoryTags.some((tag) => !qualifiedTags.includes(tag))) {
    return { outcome: 'uncertain', properties: {}, tags: advisoryTags };
  }
  if (!profileQualified) {
    return { outcome: 'uncertain', properties: {}, tags: advisoryTags };
  }
  return certainDecision(snapshot, inferredProfile, removed, qualifiedTags);
}

function manualProfile(
  snapshot: CaptureSnapshot,
  activeTypeTags: readonly ('type/book' | 'type/movie')[],
): CandidateProfile | 'conflict' | undefined {
  if (snapshot.profile !== 'auto') {
    return { profile: snapshot.profile, manual: true };
  }
  if (activeTypeTags.length > 1) {
    return 'conflict';
  }
  if (activeTypeTags[0] === 'type/book') {
    return { profile: 'book', manual: true };
  }
  if (activeTypeTags[0] === 'type/movie') {
    return { profile: 'movie', manual: true };
  }
  return undefined;
}

function certainDecision(
  snapshot: CaptureSnapshot,
  profile: ConcreteProfileId,
  removed: ReadonlySet<string>,
  tags: readonly string[],
): OrganizationDecision {
  const generatedTags = PROFILE_TAGS[profile].filter((tag) => !removed.has(tag));
  const allTags = unique([...generatedTags, ...tags.filter((tag) => !removed.has(tag))]);
  return {
    outcome: 'certain',
    properties: deterministicProperties(snapshot, profile),
    tags: allTags,
  };
}

/** Use only explicit, schema-validated capture fields; never infer arbitrary metadata. */
function deterministicProperties(
  snapshot: CaptureSnapshot,
  profile: ConcreteProfileId,
): Readonly<Record<string, OrganizationValue>> {
  const materialized = materializeCapture({
    body: snapshot.body,
    profile,
    fields: snapshot.fields,
    // materializeCapture treats removed profile tags as a profile fallback. The
    // profile is already explicit or gate-accepted here, so tag tombstones are
    // applied below to generated tags rather than changing field resolution.
    tags: {
      userAdded: snapshot.tags.userAdded,
      userRemoved: snapshot.tags.userRemoved.filter((tag) => !PROFILE_TAGS[profile].includes(normalizeTag(tag))),
    },
  });
  const properties: Record<string, OrganizationValue> = {};
  for (const [key, value] of Object.entries(materialized.properties)) {
    if (RESERVED_CAPTURE_MARKERS.has(key)) {
      continue;
    }
    properties[key] = cloneOrganizationValue(value);
  }
  return properties;
}

function normalizeTags(tags: readonly string[]): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized !== '' && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
}

function unique(tags: readonly string[]): readonly string[] {
  return normalizeTags(tags);
}

function cloneOrganizationValue(value: string | number | boolean | string[]): OrganizationValue {
  return Array.isArray(value) ? [...value] : value;
}

export type { JevQualityGate } from './qualityGate';
