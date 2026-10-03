import type {
  OrganizationAppliedMetadata,
  OrganizationDecision,
  OrganizationOverrides,
  OrganizationValue,
} from './types';

export interface ParsedMarkdown {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  /** Body bytes after frontmatter. Do not trim or normalize this value. */
  readonly body: string;
}

export interface MetadataMergeInput {
  readonly baseline: ParsedMarkdown;
  readonly current: ParsedMarkdown;
  readonly decision: OrganizationDecision;
  readonly overrides?: OrganizationOverrides;
  readonly path?: string;
}

export type MetadataMergePlan =
  | { readonly kind: 'decline'; readonly reason: 'changed-baseline' }
  | {
      readonly kind: 'apply';
      readonly document: ParsedMarkdown;
      readonly applied: OrganizationAppliedMetadata;
    };

export interface UndoPlanInput {
  readonly current: ParsedMarkdown;
  readonly applied: OrganizationAppliedMetadata;
}

export type UndoPlan =
  | { readonly kind: 'decline'; readonly reason: 'body-changed' }
  | {
      readonly kind: 'apply';
      readonly document: ParsedMarkdown;
      readonly restoredProperties: readonly string[];
      readonly removedTags: readonly string[];
      readonly skippedProperties: readonly string[];
    };

const RESERVED_KEYS = new Set([
  'tags',
  'lethe_capture_id',
  'lethe_capture_revision',
  'lethe_profile_id',
  'lethe_profile_schema_version',
]);

export function createSafeMetadataMergePlan(input: MetadataMergeInput): MetadataMergePlan {
  if (!sameDocument(input.baseline, input.current)) {
    return { kind: 'decline', reason: 'changed-baseline' };
  }

  const frontmatter = cloneRecord(input.baseline.frontmatter);
  const appliedProperties: Record<string, OrganizationAppliedMetadata['properties'][string]> = {};
  const propertyOverrides = input.overrides?.properties ?? {};
  const propertyTombstones = new Set(input.overrides?.propertyTombstones ?? []);

  for (const [key, rawValue] of Object.entries(input.decision.properties ?? {})) {
    if (!isSafeGeneratedKey(key) || RESERVED_KEYS.has(key) || propertyTombstones.has(key)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(propertyOverrides, key)) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      continue;
    }
    const value = cloneValue(rawValue) as OrganizationValue;
    frontmatter[key] = value;
    appliedProperties[key] = {
      before: { present: false },
      after: cloneValue(value) as OrganizationValue,
    };
  }

  const addedTags = addSafeTags(frontmatter, input.decision.tags ?? [], input.overrides?.tagTombstones ?? []);
  const tagsAfter = cloneTagSnapshot(frontmatter.tags);
  const applied: OrganizationAppliedMetadata = {
    path: input.path ?? '',
    body: input.baseline.body,
    properties: appliedProperties,
    addedTags,
    ...(tagsAfter === undefined ? {} : { tagsAfter }),
  };

  return {
    kind: 'apply',
    document: { frontmatter, body: input.baseline.body },
    applied,
  };
}

export function createSafeUndoPlan(input: UndoPlanInput): UndoPlan {
  if (input.current.body !== input.applied.body) {
    return { kind: 'decline', reason: 'body-changed' };
  }

  const frontmatter = cloneRecord(input.current.frontmatter);
  const restoredProperties: string[] = [];
  const skippedProperties: string[] = [];

  for (const [key, property] of Object.entries(input.applied.properties)) {
    if (!Object.prototype.hasOwnProperty.call(frontmatter, key) || !deepEqual(frontmatter[key], property.after)) {
      skippedProperties.push(key);
      continue;
    }
    if (property.before.present) {
      frontmatter[key] = cloneValue(property.before.value);
    } else {
      delete frontmatter[key];
    }
    restoredProperties.push(key);
  }

  const removedTags: string[] = [];
  const tagsAfter = input.applied.tagsAfter;
  // This compares observations only: an identical remove-and-readd between reads is
  // indistinguishable from no edit, just as it is for generated properties.
  if (isStringArray(tagsAfter) && isStringArray(frontmatter.tags) && deepEqual(frontmatter.tags, tagsAfter)) {
    const generated = new Set(input.applied.addedTags.map(normalizeTag));
    const tags = frontmatter.tags;
    const remaining = tags.filter((tag) => {
      if (!generated.has(normalizeTag(tag))) {
        return true;
      }
      removedTags.push(tag);
      return false;
    });
    if (removedTags.length > 0) {
      frontmatter.tags = remaining;
    }
  }

  return {
    kind: 'apply',
    document: { frontmatter, body: input.current.body },
    restoredProperties,
    removedTags,
    skippedProperties,
  };
}

export function sameDocument(left: ParsedMarkdown, right: ParsedMarkdown): boolean {
  return left.body === right.body && deepEqual(left.frontmatter, right.frontmatter);
}

export function cloneParsedMarkdown(document: ParsedMarkdown): ParsedMarkdown {
  return {
    frontmatter: cloneRecord(document.frontmatter),
    body: document.body,
  };
}

function addSafeTags(
  frontmatter: Record<string, unknown>,
  candidates: readonly string[],
  tombstones: readonly string[],
): string[] {
  const blocked = new Set(tombstones.map(normalizeTag));
  const existingValue = frontmatter.tags;
  let existing: string[];
  if (existingValue === undefined) {
    existing = [];
  } else if (Array.isArray(existingValue) && existingValue.every((tag) => typeof tag === 'string')) {
    existing = [...(existingValue as string[])];
  } else if (typeof existingValue === 'string') {
    existing = [existingValue];
  } else {
    return [];
  }

  const present = new Set(existing.map(normalizeTag));
  const added: string[] = [];
  for (const candidate of candidates) {
    const tag = normalizeTag(candidate);
    if (tag === '' || blocked.has(tag) || present.has(tag)) {
      continue;
    }
    present.add(tag);
    existing.push(tag);
    added.push(tag);
  }
  if (added.length > 0) {
    frontmatter.tags = existing;
  }
  return added;
}

function cloneTagSnapshot(value: unknown): readonly string[] | undefined {
  return isStringArray(value) ? [...value] : undefined;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((tag) => typeof tag === 'string');
}

function normalizeTag(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
}

function isSafeGeneratedKey(key: string): boolean {
  return key.length > 0 && !/[\r\n:]/u.test(key);
}

function cloneRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = cloneValue(child);
  }
  return result;
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = cloneValue(child);
  }
  return result as T;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]),
  );
}
