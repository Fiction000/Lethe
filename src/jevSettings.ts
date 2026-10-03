export type JevMode = 'off' | 'advisory' | 'automatic';

export interface JevApprovedTag {
  tag: string;
  description: string;
}

/**
 * The persisted Jev configuration is deliberately limited to safe references
 * and user-approved taxonomy. Secret values never belong in this shape.
 */
export interface JevSettings {
  mode: JevMode;
  model: string;
  secretId: string;
  approvedTags: JevApprovedTag[];
}

export interface JevManagedFolders {
  inbox: string;
  notes: string;
}

export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_DEFAULT_SECRET_ID = 'lethe-typesafe';
export const JEV_DEFAULT_MANAGED_FOLDERS: Readonly<JevManagedFolders> = {
  inbox: 'Inbox',
  notes: 'Notes',
};

export const JEV_MAX_APPROVED_TAGS = 64;
export const JEV_MAX_TAG_LENGTH = 80;
export const JEV_MAX_DESCRIPTION_LENGTH = 240;
export const JEV_MAX_MODEL_LENGTH = 64;
export const JEV_MAX_SECRET_ID_LENGTH = 80;

export const DEFAULT_JEV_SETTINGS: JevSettings = {
  mode: 'off',
  model: JEV_DEFAULT_MODEL,
  secretId: JEV_DEFAULT_SECRET_ID,
  approvedTags: [],
};

export type JevTagRejectionReason =
  | 'entry-not-object'
  | 'invalid-tag'
  | 'structural-tag'
  | 'tag-too-long'
  | 'invalid-description'
  | 'description-too-long'
  | 'duplicate-tag'
  | 'too-many-tags';

export interface JevTagRejection {
  index: number;
  reason: JevTagRejectionReason;
}

export interface JevApprovedTagValidation {
  accepted: JevApprovedTag[];
  rejected: JevTagRejection[];
}

export interface JevSecretStorageLike {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  listSecrets(): string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

function normalizeMode(value: unknown): JevMode {
  return value === 'advisory' || value === 'automatic' || value === 'off' ? value : 'off';
}

function normalizeModel(value: unknown): string {
  const model = normalizedString(value);
  if (
    model === null ||
    model.length === 0 ||
    model.length > JEV_MAX_MODEL_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)
  ) {
    return JEV_DEFAULT_MODEL;
  }
  return model;
}

function normalizeSecretId(value: unknown): string {
  const secretId = normalizedString(value);
  if (
    secretId === null ||
    secretId.length === 0 ||
    secretId.length > JEV_MAX_SECRET_ID_LENGTH ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(secretId)
  ) {
    return JEV_DEFAULT_SECRET_ID;
  }
  return secretId;
}

function normalizeTag(value: unknown): { value: string | null; reason?: JevTagRejectionReason } {
  if (typeof value !== 'string') {
    return { value: null, reason: 'invalid-tag' };
  }

  const trimmed = value.trim();
  const tag = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (
    tag.length === 0 ||
    tag.length > JEV_MAX_TAG_LENGTH ||
    /[\s#]/u.test(tag) ||
    !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/u.test(tag)
  ) {
    return {
      value: null,
      reason: tag.length > JEV_MAX_TAG_LENGTH ? 'tag-too-long' : 'invalid-tag',
    };
  }

  if (/^(?:type|state)(?:\/|$)/i.test(tag)) {
    return { value: null, reason: 'structural-tag' };
  }

  return { value: tag };
}

/**
 * Validate and normalize approved Jev taxonomy without touching user/manual
 * tags. Rejections only contain an index and reason, never the rejected value.
 */
export function validateApprovedTags(input: unknown): JevApprovedTagValidation {
  if (!Array.isArray(input)) {
    return { accepted: [], rejected: [] };
  }

  const accepted: JevApprovedTag[] = [];
  const rejected: JevTagRejection[] = [];
  const seen = new Set<string>();

  input.forEach((entry, index) => {
    if (!isRecord(entry)) {
      rejected.push({ index, reason: 'entry-not-object' });
      return;
    }

    const normalizedTag = normalizeTag(entry.tag);
    if (normalizedTag.value === null) {
      rejected.push({ index, reason: normalizedTag.reason ?? 'invalid-tag' });
      return;
    }

    const rawDescription = entry.description === undefined ? '' : entry.description;
    if (typeof rawDescription !== 'string') {
      rejected.push({ index, reason: 'invalid-description' });
      return;
    }

    const description = rawDescription.trim();
    if (description.length > JEV_MAX_DESCRIPTION_LENGTH) {
      rejected.push({ index, reason: 'description-too-long' });
      return;
    }

    const duplicateKey = normalizedTag.value.toLowerCase();
    if (seen.has(duplicateKey)) {
      rejected.push({ index, reason: 'duplicate-tag' });
      return;
    }

    if (accepted.length >= JEV_MAX_APPROVED_TAGS) {
      rejected.push({ index, reason: 'too-many-tags' });
      return;
    }

    seen.add(duplicateKey);
    accepted.push({ tag: normalizedTag.value, description });
  });

  return { accepted, rejected };
}

export function normalizeApprovedTags(input: unknown): JevApprovedTag[] {
  return validateApprovedTags(input).accepted;
}

export function createDefaultJevSettings(): JevSettings {
  return {
    mode: DEFAULT_JEV_SETTINGS.mode,
    model: DEFAULT_JEV_SETTINGS.model,
    secretId: DEFAULT_JEV_SETTINGS.secretId,
    approvedTags: [],
  };
}

/**
 * Normalize an unknown persisted value into the complete, safe Jev shape.
 * Unknown fields (including accidental plaintext credentials) are discarded.
 */
export function normalizeJevSettings(input: unknown): JevSettings {
  const source = isRecord(input) ? input : {};
  return {
    mode: normalizeMode(source.mode),
    model: normalizeModel(source.model),
    secretId: normalizeSecretId(source.secretId),
    approvedTags: normalizeApprovedTags(source.approvedTags),
  };
}

/**
 * Persist only the normalized Jev settings contract. This is intentionally
 * separate from secret storage: it returns an ID reference, never a secret.
 */
export function serializeJevSettings(input: unknown): JevSettings {
  return normalizeJevSettings(input);
}

export function hasNativeSecretStorage(app: unknown): boolean {
  if (!isRecord(app) || !isRecord(app.secretStorage)) {
    return false;
  }

  const storage = app.secretStorage;
  return (
    typeof storage.getSecret === 'function' &&
    typeof storage.setSecret === 'function' &&
    typeof storage.listSecrets === 'function'
  );
}

/**
 * Unsupported Obsidian versions stay local-only. The optional component flag
 * lets the settings UI require both SecretStorage and SecretComponent without
 * importing newer Obsidian types into this plugin.
 */
export function applyLocalOnlyFallback(
  input: unknown,
  app: unknown,
  nativeSecretComponentAvailable = true,
): JevSettings {
  const normalized = normalizeJevSettings(input);
  if (hasNativeSecretStorage(app) && nativeSecretComponentAvailable) {
    return normalized;
  }
  return { ...normalized, mode: 'off' };
}
