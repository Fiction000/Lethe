import type {
  CaptureProfile,
  CaptureRecord,
  CaptureSnapshot,
  FieldIntent,
  NoteWriteState,
  SubmissionReceipt,
  TagIntent,
} from './core';
import type { OrganizationJob, OrganizationJobStatus } from '../organization/types';
import {
  CAPTURE_PROFILES,
  normalizeTag,
  resolveProfile,
  resolveTags,
  type ProfileResolution,
  type ResolvedTags,
} from './profiles';

export interface ComposerKeyEvent {
  readonly key?: string;
  readonly code?: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly which?: number;
}

export type ComposerPatch = Partial<Pick<CaptureSnapshot, 'body' | 'profile' | 'fields' | 'tags'>>;

export interface ComposerDraft {
  readonly body: string;
  readonly profile: CaptureProfile;
  readonly fields: Readonly<Record<string, FieldIntent>>;
  readonly tags: TagIntent;
}

/** Return true only for the explicit submit chord, never for a plain newline. */
export function isSubmitShortcut(event: ComposerKeyEvent, editorComposing = false): boolean {
  if (event.isComposing === true || editorComposing || event.keyCode === 229 || event.which === 229) {
    return false;
  }

  const isEnter = event.key === 'Enter' || event.code === 'Enter';
  return isEnter && (event.metaKey === true || event.ctrlKey === true) && event.shiftKey !== true;
}

/** Apply the session's synchronous update semantics without mutating its snapshot. */
export function applyComposerPatch(
  snapshot: CaptureSnapshot,
  patch: ComposerPatch,
  now: () => string = () => new Date().toISOString(),
): CaptureSnapshot {
  return {
    ...snapshot,
    ...(patch.body === undefined ? {} : { body: patch.body }),
    ...(patch.profile === undefined ? {} : { profile: patch.profile }),
    fields: patch.fields === undefined ? snapshot.fields : cloneFields(patch.fields),
    tags: patch.tags === undefined ? snapshot.tags : cloneTags(patch.tags),
    revision: (snapshot.revision + 1) as CaptureSnapshot['revision'],
    updatedAt: now(),
  };
}

export function resetComposerDraft(draft: ComposerDraft, keepProfile = false): ComposerDraft {
  return {
    body: '',
    profile: keepProfile ? draft.profile : 'auto',
    fields: {},
    tags: { userAdded: [], userRemoved: [] },
  };
}

export function isSubmitDisabled(
  body: string,
  isSubmitting: boolean,
  isComposing: boolean,
  hasPendingUploads: boolean,
): boolean {
  return body.trim().length === 0 || isSubmitting || isComposing || hasPendingUploads;
}

export interface ComposerResolution {
  readonly profile: ProfileResolution;
  readonly tags: ResolvedTags;
  readonly selectedProfile: CaptureProfile;
}

/** Resolve the profile and every visible tag from the same draft intents used at write time. */
export function resolveComposerState(
  snapshot: Pick<CaptureSnapshot, 'profile' | 'tags'>,
  defaultTags: readonly string[] = [],
): ComposerResolution {
  const profile = resolveProfile(snapshot.profile, snapshot.tags);
  const tags = resolveTags(profile.effectiveProfile, snapshot.tags, defaultTags);
  const hasProfileTagTombstone = snapshot.tags.userRemoved.some((tag) => isProfileBoundTag(normalizeTag(tag)));
  const selectedProfile =
    snapshot.profile === 'auto' && profile.effectiveProfile === 'plain' && !hasProfileTagTombstone
      ? 'auto'
      : profile.effectiveProfile;
  return { profile, tags, selectedProfile };
}

/** A deliberate profile choice supersedes prior removals of that profile's bindings. */
export function selectComposerProfile(tags: TagIntent, profile: CaptureProfile): ComposerPatch {
  const definition = profile === 'auto' ? undefined : CAPTURE_PROFILES[profile];
  const bindings = new Set(definition ? [...definition.triggerTags, ...definition.impliedTags] : []);
  return {
    profile,
    tags: {
      userAdded: [...tags.userAdded],
      userRemoved: tags.userRemoved.filter((tag) =>
        profile === 'auto' ? !isProfileBoundTag(normalizeTag(tag)) : !bindings.has(normalizeTag(tag)),
      ),
    },
  };
}

/** Remove a tag while retaining a tombstone for profile-owned tags. */
export function removeComposerTag(tags: TagIntent, tag: string): TagIntent {
  const normalized = normalizeTag(tag);
  if (normalized === '') {
    return {
      userAdded: [...tags.userAdded],
      userRemoved: [...tags.userRemoved],
    };
  }

  const userRemoved = tags.userRemoved.map(normalizeTag).filter((current) => current !== '');
  if (isProfileBoundTag(normalized) && !userRemoved.includes(normalized)) {
    userRemoved.push(normalized);
  }

  return {
    userAdded: tags.userAdded.filter((current) => normalizeTag(current) !== normalized),
    userRemoved,
  };
}

export function submissionWriteState(
  receipt: Pick<SubmissionReceipt, 'captureId' | 'noteState'> | undefined,
  records: readonly Pick<CaptureRecord, 'snapshot' | 'write'>[],
): NoteWriteState | undefined {
  if (!receipt) return undefined;
  return records.find((record) => record.snapshot.id === receipt.captureId)?.write.state ?? receipt.noteState;
}

export function isRetryableWriteState(state: NoteWriteState): boolean {
  return state === 'pending' || state === 'failed';
}

export type OrganizationMode = 'off' | 'advisory' | 'automatic';

/** Skip AI is a per-capture choice and is unavailable while Jev is off. */
export function canSkipAI(mode: OrganizationMode): boolean {
  return mode !== 'off';
}

export function isOrganizationPendingStatus(status: OrganizationJobStatus): boolean {
  return status === 'queued' || status === 'processing' || status === 'retry-wait';
}

/** Only jobs that can still be safely re-queued expose a retry action. */
export function isOrganizationRetryableStatus(status: OrganizationJobStatus): boolean {
  return status === 'retry-wait' || status === 'failed';
}

export function isOrganizationUndoableStatus(status: OrganizationJobStatus): boolean {
  return status === 'applied';
}

const ORGANIZATION_STATUS_LABELS: Readonly<Record<OrganizationJobStatus, string>> = {
  queued: 'Organization queued',
  processing: 'Organization processing',
  'retry-wait': 'Organization retrying',
  advisory: 'Organization advisory',
  uncertain: 'Organization uncertain',
  applied: 'Organization applied',
  undone: 'Organization undone',
  failed: 'Organization failed',
  conflict: 'Organization conflict',
  deleted: 'Organization note deleted',
  skipped: 'Organization skipped',
  cancelled: 'Organization cancelled',
};

export function organizationStatusLabel(
  status: OrganizationJobStatus | undefined,
  localWriteState?: NoteWriteState,
): string | undefined {
  if (status !== undefined) return ORGANIZATION_STATUS_LABELS[status];
  if (localWriteState === 'pending' || localWriteState === 'failed') {
    return 'Organization waiting for local write';
  }
  if (localWriteState === 'written') return 'Organization not started';
  return undefined;
}

export interface OrganizationDecisionPreview {
  readonly profile?: 'plain' | 'book' | 'movie';
  readonly tags: readonly string[];
}

const ORGANIZATION_PREVIEW_TAG_LIMIT = 8;
const ORGANIZATION_PREVIEW_TAG_LENGTH = 80;
const ORGANIZATION_PROFILES = new Set<OrganizationDecisionPreview['profile']>(['plain', 'book', 'movie']);

/**
 * Advisory output is display-only. Keep the preview to the bounded profile
 * field and tags; arbitrary provider properties never become UI controls.
 */
export function organizationDecisionPreview(
  job: Pick<OrganizationJob, 'status' | 'decision'> | undefined,
): OrganizationDecisionPreview | undefined {
  if (job?.status !== 'advisory' || job.decision === undefined) return undefined;

  const rawProfile = job.decision.properties?.profile;
  const profile =
    typeof rawProfile === 'string' &&
    ORGANIZATION_PROFILES.has(rawProfile.trim().toLowerCase() as 'plain' | 'book' | 'movie')
      ? (rawProfile.trim().toLowerCase() as 'plain' | 'book' | 'movie')
      : undefined;
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of job.decision.tags ?? []) {
    if (tags.length >= ORGANIZATION_PREVIEW_TAG_LIMIT) break;
    if (typeof rawTag !== 'string') continue;
    const tag = rawTag.trim().replace(/^#/u, '');
    if (tag === '') continue;
    const bounded =
      tag.length > ORGANIZATION_PREVIEW_TAG_LENGTH ? `${tag.slice(0, ORGANIZATION_PREVIEW_TAG_LENGTH - 1)}…` : tag;
    const key = bounded.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(bounded);
  }

  const tagProfile = tags.find((tag) => tag.toLowerCase() === 'type/book' || tag.toLowerCase() === 'type/movie');
  const inferredProfile =
    tagProfile?.toLowerCase() === 'type/book'
      ? 'book'
      : tagProfile?.toLowerCase() === 'type/movie'
      ? 'movie'
      : undefined;
  const resolvedProfile = profile ?? inferredProfile;
  if (resolvedProfile === undefined && tags.length === 0) return undefined;
  return {
    ...(resolvedProfile === undefined ? {} : { profile: resolvedProfile }),
    tags,
  };
}

function isProfileBoundTag(tag: string): boolean {
  return Object.values(CAPTURE_PROFILES).some((profile) =>
    [...profile.triggerTags, ...profile.impliedTags].some((profileTag) => normalizeTag(profileTag) === tag),
  );
}

function cloneFields(fields: Readonly<Record<string, FieldIntent>>): Readonly<Record<string, FieldIntent>> {
  const copy: Record<string, FieldIntent> = {};
  for (const [fieldId, intent] of Object.entries(fields)) {
    copy[fieldId] =
      intent.state === 'cleared'
        ? { state: 'cleared' }
        : {
            state: 'set',
            value: Array.isArray(intent.value) ? [...intent.value] : intent.value,
          };
  }
  return copy;
}

function cloneTags(tags: TagIntent): TagIntent {
  return {
    userAdded: [...tags.userAdded],
    userRemoved: [...tags.userRemoved],
  };
}
