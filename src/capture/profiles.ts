export type ConcreteProfileId = 'plain' | 'book' | 'movie';

export type CaptureProfileId = 'auto' | ConcreteProfileId;

export type ProfileFieldType = 'text' | 'date' | 'number' | 'url' | 'text[]';

export type FrontmatterValue = string | number | boolean | string[];

export type FieldValue = FrontmatterValue;

export interface ProfileFieldDefinition {
  readonly id: string;
  readonly property: string;
  readonly type: ProfileFieldType;
  readonly required: false;
  readonly emit: 'when-set';
}

export interface ProfileFieldDescriptor extends ProfileFieldDefinition {
  readonly label: string;
  readonly order: number;
  readonly optional: true;
  readonly control: ProfileFieldType;
}

export interface CaptureProfile {
  readonly id: ConcreteProfileId;
  readonly label: string;
  readonly schemaVersion: number;
  readonly templateRef?: string;
  readonly triggerTags: readonly string[];
  readonly impliedTags: readonly string[];
  readonly fields: readonly ProfileFieldDefinition[];
  readonly uiFields: readonly ProfileFieldDescriptor[];
  readonly defaults: Readonly<Partial<Record<string, FieldValue>>>;
}

function field(id: string, type: ProfileFieldType, label: string, order: number): ProfileFieldDescriptor {
  return {
    id,
    property: id,
    type,
    required: false,
    emit: 'when-set',
    label,
    order,
    optional: true,
    control: type,
  };
}

const bookFields: readonly ProfileFieldDescriptor[] = [
  field('aliases', 'text[]', 'Aliases', 0),
  field('cover', 'url', 'Cover', 1),
  field('startDate', 'date', 'Start date', 2),
  field('endDate', 'date', 'End date', 3),
  field('author', 'text', 'Author', 4),
  field('rating', 'number', 'Rating', 5),
  field('wishlist_section', 'text', 'Wishlist section', 6),
  field('reading_status', 'text', 'Reading status', 7),
  field('priority', 'text', 'Priority', 8),
  field('project', 'text', 'Project', 9),
  field('source', 'text', 'Source', 10),
  field('comment', 'text', 'Comment', 11),
];

const movieFields: readonly ProfileFieldDescriptor[] = [
  field('aliases', 'text[]', 'Aliases', 0),
  field('cover', 'url', 'Cover', 1),
  field('startDate', 'date', 'Start date', 2),
  field('endDate', 'date', 'End date', 3),
  field('rating', 'number', 'Rating', 4),
  field('director', 'text', 'Director', 5),
  field('comment', 'text', 'Comment', 6),
];

function profile(
  id: ConcreteProfileId,
  label: string,
  fields: readonly ProfileFieldDescriptor[],
  triggerTags: readonly string[],
  impliedTags: readonly string[],
  templateRef?: string,
): CaptureProfile {
  return {
    id,
    label,
    schemaVersion: 1,
    ...(templateRef === undefined ? {} : { templateRef }),
    triggerTags,
    impliedTags,
    fields,
    uiFields: fields,
    defaults: {},
  };
}

export const PLAIN_PROFILE: CaptureProfile = profile('plain', 'Plain', [], [], []);

export const BOOK_PROFILE: CaptureProfile = profile(
  'book',
  'Book',
  bookFields,
  ['type/book'],
  ['type/review'],
  'Templates/Book',
);

export const MOVIE_PROFILE: CaptureProfile = profile(
  'movie',
  'Movie',
  movieFields,
  ['type/movie'],
  ['type/review'],
  'Templates/Review',
);

export const CAPTURE_PROFILES: Readonly<Record<ConcreteProfileId, CaptureProfile>> = {
  plain: PLAIN_PROFILE,
  book: BOOK_PROFILE,
  movie: MOVIE_PROFILE,
};

export type ProfileId = CaptureProfileId;

export interface TagIntent {
  readonly userAdded: readonly string[];
  readonly userRemoved: readonly string[];
}

export type TagSource = 'user' | 'profile' | 'default';

export interface TagBinding {
  readonly tag: string;
  readonly source: TagSource;
  readonly profileId?: ConcreteProfileId;
  readonly locked: boolean;
}

export interface ResolvedTags {
  readonly profileId: ConcreteProfileId;
  readonly userAdded: readonly string[];
  readonly userRemoved: readonly string[];
  readonly tags: readonly string[];
  readonly bindings: readonly TagBinding[];
}

export type ProfileConflictKind = 'conflicting-primary-tags';

export interface ProfileConflict {
  readonly kind: ProfileConflictKind;
  readonly tags: readonly string[];
  readonly message: string;
}

export interface ProfileResolution {
  readonly requestedProfile: CaptureProfileId;
  readonly effectiveProfile: ConcreteProfileId;
  readonly conflicts: readonly ProfileConflict[];
  readonly requiresExplicitChoice: boolean;
  readonly reason: 'explicit' | 'primary-tag' | 'plain-default' | 'removed-profile-tag';
}

export function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
}

function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const value = normalizeTag(tag);
    if (value !== '' && !seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}

function profileTags(profileId: ConcreteProfileId): string[] {
  const profile = CAPTURE_PROFILES[profileId];
  return normalizeTags([...profile.triggerTags, ...profile.impliedTags]);
}

function hasRemovedProfileTag(profileId: ConcreteProfileId, removed: ReadonlySet<string>): boolean {
  return profileTags(profileId).some((tag) => removed.has(tag));
}

export function resolveProfile(requestedProfile: CaptureProfileId, tags: TagIntent): ProfileResolution {
  const removed = new Set(normalizeTags(tags.userRemoved));

  if (requestedProfile !== 'auto') {
    if (requestedProfile !== 'plain' && hasRemovedProfileTag(requestedProfile, removed)) {
      return {
        requestedProfile,
        effectiveProfile: 'plain',
        conflicts: [],
        requiresExplicitChoice: false,
        reason: 'removed-profile-tag',
      };
    }
    return {
      requestedProfile,
      effectiveProfile: requestedProfile,
      conflicts: [],
      requiresExplicitChoice: false,
      reason: 'explicit',
    };
  }

  const activeTags = new Set(normalizeTags(tags.userAdded).filter((tag) => !removed.has(tag)));
  const candidates = (['book', 'movie'] as const).filter((profileId) =>
    CAPTURE_PROFILES[profileId].triggerTags.some((tag) => activeTags.has(tag)),
  );

  if (candidates.length > 1) {
    const conflict: ProfileConflict = {
      kind: 'conflicting-primary-tags',
      tags: candidates.flatMap((profileId) => CAPTURE_PROFILES[profileId].triggerTags),
      message: 'Conflicting primary profile tags require an explicit profile choice.',
    };
    return {
      requestedProfile,
      effectiveProfile: 'plain',
      conflicts: [conflict],
      requiresExplicitChoice: true,
      reason: 'plain-default',
    };
  }

  if (candidates.length === 1) {
    const candidate = candidates[0];
    if (hasRemovedProfileTag(candidate, removed)) {
      return {
        requestedProfile,
        effectiveProfile: 'plain',
        conflicts: [],
        requiresExplicitChoice: false,
        reason: 'removed-profile-tag',
      };
    }
    return {
      requestedProfile,
      effectiveProfile: candidate,
      conflicts: [],
      requiresExplicitChoice: false,
      reason: 'primary-tag',
    };
  }

  return {
    requestedProfile,
    effectiveProfile: 'plain',
    conflicts: [],
    requiresExplicitChoice: false,
    reason: 'plain-default',
  };
}

export interface TagResolutionOptions {
  readonly defaultTags?: readonly string[];
}

function defaultTagsFrom(options: readonly string[] | TagResolutionOptions | undefined): readonly string[] {
  if (options === undefined) {
    return [];
  }
  if (!Array.isArray(options) && 'defaultTags' in options) {
    return options.defaultTags ?? [];
  }
  return options as readonly string[];
}

export function resolveTags(
  profileId: ConcreteProfileId,
  tags: TagIntent,
  options?: readonly string[] | TagResolutionOptions,
): ResolvedTags {
  const removed = new Set(normalizeTags(tags.userRemoved));
  const bindings: TagBinding[] = [];
  const included = new Set<string>();

  const add = (tag: string, binding: TagBinding): void => {
    const normalized = normalizeTag(tag);
    if (normalized === '' || removed.has(normalized) || included.has(normalized)) {
      return;
    }
    included.add(normalized);
    bindings.push({ ...binding, tag: normalized });
  };

  for (const tag of normalizeTags(tags.userAdded)) {
    add(tag, { tag, source: 'user', locked: true });
  }
  for (const tag of profileTags(profileId)) {
    add(tag, { tag, source: 'profile', profileId, locked: false });
  }
  for (const tag of normalizeTags(defaultTagsFrom(options))) {
    add(tag, { tag, source: 'default', locked: false });
  }

  return {
    profileId,
    userAdded: normalizeTags(tags.userAdded),
    userRemoved: normalizeTags(tags.userRemoved),
    tags: bindings.map((binding) => binding.tag),
    bindings,
  };
}

export type FieldIntent = { readonly state: 'set'; readonly value: FieldValue } | { readonly state: 'cleared' };

export type CaptureFields = Record<string, FieldIntent>;

export type FieldValidationCode =
  | 'unknown-field'
  | 'invalid-type'
  | 'invalid-date'
  | 'invalid-url'
  | 'invalid-number'
  | 'invalid-array-item';

export interface FieldValidationError {
  readonly fieldId: string;
  readonly property?: string;
  readonly code: FieldValidationCode;
  readonly message: string;
  readonly source?: 'explicit' | 'default' | 'ai';
}

export type FieldValidationResult =
  | { readonly valid: true; readonly value: FieldValue }
  | { readonly valid: false; readonly error: FieldValidationError };

export interface FieldResolutionInput {
  readonly explicit?: FieldIntent;
  readonly configuredDefault?: unknown;
  readonly validatedInference?: unknown;
}

export type FieldResolutionSource = 'explicit' | 'default' | 'ai' | 'explicit-clear' | 'unset' | 'invalid';

export type FieldResolution =
  | {
      readonly included: true;
      readonly value: FieldValue;
      readonly source: 'explicit' | 'default' | 'ai';
      readonly locked: boolean;
    }
  | {
      readonly included: false;
      readonly source: 'explicit-clear' | 'unset' | 'invalid';
      readonly locked: boolean;
      readonly error?: FieldValidationError;
    };

function fieldDefinition(profileId: ConcreteProfileId, fieldId: string): ProfileFieldDefinition | undefined {
  return CAPTURE_PROFILES[profileId].fields.find((field) => field.id === fieldId);
}

function invalidFieldError(
  profileId: ConcreteProfileId,
  fieldId: string,
  code: FieldValidationCode,
  message: string,
  source?: 'explicit' | 'default' | 'ai',
): FieldValidationResult {
  const definition = fieldDefinition(profileId, fieldId);
  return {
    valid: false,
    error: {
      fieldId,
      ...(definition === undefined ? {} : { property: definition.property }),
      code,
      message,
      ...(source === undefined ? {} : { source }),
    },
  };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

function isUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'obsidian:';
  } catch {
    return false;
  }
}

export function validateFieldValue(
  profileId: ConcreteProfileId,
  fieldId: string,
  value: unknown,
): FieldValidationResult {
  const definition = fieldDefinition(profileId, fieldId);
  if (definition === undefined) {
    return invalidFieldError(profileId, fieldId, 'unknown-field', `Unknown field: ${fieldId}.`);
  }

  switch (definition.type) {
    case 'text':
      if (typeof value === 'string') {
        return { valid: true, value };
      }
      return invalidFieldError(profileId, fieldId, 'invalid-type', `${fieldId} must be text.`);
    case 'date':
      if (typeof value !== 'string') {
        return invalidFieldError(profileId, fieldId, 'invalid-type', `${fieldId} must be a YYYY-MM-DD date.`);
      }
      if (!isCalendarDate(value)) {
        return invalidFieldError(profileId, fieldId, 'invalid-date', `${fieldId} must be a valid YYYY-MM-DD date.`);
      }
      return { valid: true, value };
    case 'number':
      if (typeof value !== 'number') {
        return invalidFieldError(profileId, fieldId, 'invalid-type', `${fieldId} must be a number.`);
      }
      if (!Number.isFinite(value)) {
        return invalidFieldError(profileId, fieldId, 'invalid-number', `${fieldId} must be a finite number.`);
      }
      return { valid: true, value };
    case 'url':
      if (typeof value !== 'string') {
        return invalidFieldError(profileId, fieldId, 'invalid-type', `${fieldId} must be a URL.`);
      }
      if (!isUrl(value)) {
        return invalidFieldError(profileId, fieldId, 'invalid-url', `${fieldId} must be an absolute URL.`);
      }
      return { valid: true, value };
    case 'text[]':
      if (!Array.isArray(value)) {
        return invalidFieldError(profileId, fieldId, 'invalid-type', `${fieldId} must be an array of text.`);
      }
      if (!value.every((item) => typeof item === 'string')) {
        return invalidFieldError(profileId, fieldId, 'invalid-array-item', `${fieldId} must contain only text values.`);
      }
      return { valid: true, value: [...value] as string[] };
  }
}

export function resolveField(
  profileId: ConcreteProfileId,
  fieldId: string,
  input: FieldResolutionInput,
): FieldResolution {
  const explicit = input.explicit;
  if (explicit?.state === 'cleared') {
    return { included: false, source: 'explicit-clear', locked: true };
  }

  const candidates: readonly ['explicit' | 'default' | 'ai', boolean, unknown, boolean][] = [
    ['explicit', explicit?.state === 'set', explicit?.state === 'set' ? explicit.value : undefined, true],
    ['default', input.configuredDefault !== undefined, input.configuredDefault, false],
    ['ai', input.validatedInference !== undefined, input.validatedInference, false],
  ];

  for (const [source, present, value, locked] of candidates) {
    if (!present) {
      continue;
    }
    const validation = validateFieldValue(profileId, fieldId, value);
    if (validation.valid === false) {
      return {
        included: false,
        source: 'invalid',
        locked,
        error: { ...validation.error, source },
      };
    }
    return {
      included: true,
      value: validation.value,
      source,
      locked,
    };
  }

  return { included: false, source: 'unset', locked: false };
}

export interface ResolveFieldsOptions {
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly inference?: Readonly<Record<string, unknown>>;
}

export interface ResolvedFields {
  readonly properties: Record<string, FrontmatterValue>;
  readonly resolutions: Readonly<Record<string, FieldResolution>>;
  readonly errors: readonly FieldValidationError[];
  readonly blockingErrors: readonly FieldValidationError[];
  readonly canCapture: boolean;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function resolveFields(
  profileId: ConcreteProfileId,
  fields: Readonly<Record<string, FieldIntent>>,
  options: ResolveFieldsOptions = {},
): ResolvedFields {
  const profile = CAPTURE_PROFILES[profileId];
  const properties: Record<string, FrontmatterValue> = {};
  const resolutions: Record<string, FieldResolution> = {};
  const errors: FieldValidationError[] = [];
  const blockingErrors: FieldValidationError[] = [];

  for (const definition of profile.fields) {
    const configuredDefault = hasOwn(options.defaults ?? {}, definition.id)
      ? options.defaults?.[definition.id]
      : profile.defaults[definition.id];
    const validatedInference = options.inference?.[definition.id];
    const resolution = resolveField(profileId, definition.id, {
      explicit: fields[definition.id],
      configuredDefault,
      validatedInference,
    });
    resolutions[definition.id] = resolution;
    if (resolution.included) {
      properties[definition.property] = resolution.value;
    } else if (resolution.included === false && resolution.error !== undefined) {
      errors.push(resolution.error);
      if (resolution.error.source !== 'ai') {
        blockingErrors.push(resolution.error);
      }
    }
  }

  return {
    properties,
    resolutions,
    errors,
    blockingErrors,
    canCapture: blockingErrors.length === 0,
  };
}

export interface MaterializeCaptureInput {
  readonly body: string;
  readonly profile: CaptureProfileId;
  readonly fields?: Readonly<Record<string, FieldIntent>>;
  readonly tags?: TagIntent;
  readonly defaults?: Readonly<Record<string, unknown>>;
  readonly inference?: Readonly<Record<string, unknown>>;
  readonly defaultTags?: readonly string[];
  readonly captureId?: string;
  readonly revision?: number;
}

export const LETHE_FRONTMATTER_KEYS = {
  captureId: 'lethe_capture_id',
  revision: 'lethe_capture_revision',
  profileId: 'lethe_profile_id',
  profileSchemaVersion: 'lethe_profile_schema_version',
} as const;

export interface MaterializedCapture {
  readonly body: string;
  readonly effectiveProfile: ConcreteProfileId;
  readonly profileResolution: ProfileResolution;
  readonly conflicts: readonly ProfileConflict[];
  readonly metadata: Record<string, FrontmatterValue>;
  readonly properties: Record<string, FrontmatterValue>;
  readonly tags: ResolvedTags;
  readonly tagBindings: readonly TagBinding[];
  readonly validationErrors: readonly FieldValidationError[];
  readonly canCapture: boolean;
}

export function materializeCapture(input: MaterializeCaptureInput): MaterializedCapture {
  const tags: TagIntent = input.tags ?? { userAdded: [], userRemoved: [] };
  const profileResolution = resolveProfile(input.profile, tags);
  const resolvedFields = resolveFields(profileResolution.effectiveProfile, input.fields ?? {}, {
    defaults: input.defaults,
    inference: input.inference,
  });
  const resolvedTags = resolveTags(profileResolution.effectiveProfile, tags, input.defaultTags ?? []);
  const properties: Record<string, FrontmatterValue> = { ...resolvedFields.properties };
  const metadata: Record<string, FrontmatterValue> = {
    ...properties,
    tags: [...resolvedTags.tags],
    [LETHE_FRONTMATTER_KEYS.profileId]: profileResolution.effectiveProfile,
    [LETHE_FRONTMATTER_KEYS.profileSchemaVersion]: CAPTURE_PROFILES[profileResolution.effectiveProfile].schemaVersion,
  };

  if (input.captureId !== undefined) {
    metadata[LETHE_FRONTMATTER_KEYS.captureId] = input.captureId;
  }
  if (input.revision !== undefined) {
    metadata[LETHE_FRONTMATTER_KEYS.revision] = input.revision;
  }

  return {
    body: input.body,
    effectiveProfile: profileResolution.effectiveProfile,
    profileResolution,
    conflicts: profileResolution.conflicts,
    metadata,
    properties,
    tags: resolvedTags,
    tagBindings: resolvedTags.bindings,
    validationErrors: resolvedFields.errors,
    canCapture: resolvedFields.canCapture && !profileResolution.requiresExplicitChoice,
  };
}

export interface CaptureDraft {
  readonly body: string;
  readonly profile: CaptureProfileId;
  readonly fields: Readonly<Record<string, FieldIntent>>;
  readonly tags: TagIntent;
}

function cloneFields(fields: Readonly<Record<string, FieldIntent>>): CaptureFields {
  const cloned: CaptureFields = {};
  for (const [fieldId, intent] of Object.entries(fields)) {
    cloned[fieldId] =
      intent.state === 'cleared'
        ? { state: 'cleared' }
        : {
            state: 'set',
            value: Array.isArray(intent.value) ? [...intent.value] : intent.value,
          };
  }
  return cloned;
}

function cloneTags(tags: TagIntent): TagIntent {
  return {
    userAdded: [...tags.userAdded],
    userRemoved: [...tags.userRemoved],
  };
}

export function switchProfile(draft: CaptureDraft, profile: CaptureProfileId): CaptureDraft {
  return {
    body: draft.body,
    profile,
    fields: cloneFields(draft.fields),
    tags: cloneTags(draft.tags),
  };
}

export interface ResetCaptureOptions {
  readonly keepProfile?: boolean;
}

export function resetForNextCapture(draft: CaptureDraft, options: ResetCaptureOptions | boolean = {}): CaptureDraft {
  const keepProfile = typeof options === 'boolean' ? options : options.keepProfile === true;
  return {
    body: '',
    profile: keepProfile ? draft.profile : 'auto',
    fields: {},
    tags: { userAdded: [], userRemoved: [] },
  };
}
