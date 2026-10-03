import type {
  CaptureRecord,
  CaptureSnapshot,
  DurableCaptureStore,
  FrontmatterValue,
  NoteRef,
  Revision,
  SerializedError,
} from './core';

export const LETHE_MARKERS = {
  captureId: 'lethe_capture_id',
  revision: 'lethe_capture_revision',
  profileId: 'lethe_profile_id',
  profileSchemaVersion: 'lethe_profile_schema_version',
} as const;

export const CAPTURE_ID_MARKER = LETHE_MARKERS.captureId;
export const CAPTURE_REVISION_MARKER = LETHE_MARKERS.revision;
export const PROFILE_ID_MARKER = LETHE_MARKERS.profileId;
export const PROFILE_SCHEMA_VERSION_MARKER = LETHE_MARKERS.profileSchemaVersion;

export interface VaultPort {
  list(folder: string): Promise<readonly string[]>;
  read(path: string): Promise<string | null>;
  create(path: string, content: string): Promise<void>;
}

export interface MaterializedCapture {
  readonly snapshot: CaptureSnapshot;
  readonly properties: Readonly<Record<string, FrontmatterValue>>;
  readonly effectiveProfile?: 'plain' | 'book' | 'movie';
  readonly profileSchemaVersion?: number;
  readonly tags?: readonly string[];
}

export interface NoteWriteReceipt {
  readonly captureId: CaptureSnapshot['id'];
  readonly revision: Revision;
  readonly note: NoteRef;
  readonly created: boolean;
}

export interface CaptureStorePort {
  get(id: CaptureSnapshot['id']): Promise<CaptureRecord | undefined>;
  markNoteWritten(id: CaptureSnapshot['id'], revision: Revision, note: NoteRef): Promise<void>;
  markNoteFailure(id: CaptureSnapshot['id'], revision: Revision, error: SerializedError): Promise<void>;
  markNoteConflict(id: CaptureSnapshot['id'], revision: Revision, error: SerializedError): Promise<void>;
  markNoteDeleted(id: CaptureSnapshot['id'], revision: Revision, error?: SerializedError): Promise<void>;
}

export interface IndividualNoteWriterOptions {
  readonly vault: VaultPort;
  readonly store: CaptureStorePort | DurableCaptureStore;
  readonly inboxFolder?: string;
  readonly notesFolder?: string;
  readonly now?: () => string;
}

export class NoteWriterError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'NoteWriterError';
  }
}

export class KnownDeletionError extends NoteWriterError {
  public constructor(message: string) {
    super('known_deletion', message);
    this.name = 'KnownDeletionError';
  }
}

export function deterministicNotePath(snapshot: CaptureSnapshot, inboxFolder = 'Inbox'): string {
  const folder = validateVaultPath(inboxFolder);
  const firstLine = snapshot.body.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? 'capture';
  const stem = sanitizeSegment(firstLine).slice(0, 80) || 'capture';
  return `${folder}/${stem}-${sanitizeSegment(snapshot.id)}.md`;
}

export function validateVaultPath(path: string): string {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').some((segment) => !segment || segment === '..' || segment === '.') ||
    normalized.includes('\0')
  ) {
    throw new NoteWriterError('unsafe_path', `Unsafe vault path: ${path}`);
  }
  return normalized;
}

export function renderNote(materialized: MaterializedCapture): string {
  const { snapshot } = materialized;
  const lines = [
    '---',
    `${LETHE_MARKERS.captureId}: ${snapshot.id}`,
    `${LETHE_MARKERS.revision}: ${snapshot.revision}`,
    `${LETHE_MARKERS.profileId}: ${materialized.effectiveProfile ?? snapshot.profile}`,
    `${LETHE_MARKERS.profileSchemaVersion}: ${materialized.profileSchemaVersion ?? 1}`,
  ];
  for (const [key, value] of Object.entries(materialized.properties)) {
    if (
      Object.values(LETHE_MARKERS).includes(key as typeof LETHE_MARKERS[keyof typeof LETHE_MARKERS]) ||
      (key === 'tags' && materialized.tags)
    ) {
      continue;
    }
    lines.push(...renderProperty(key, value));
  }
  if (materialized.tags && materialized.tags.length > 0) {
    lines.push('tags:');
    for (const tag of materialized.tags) {
      lines.push(`  - ${renderScalar(tag)}`);
    }
  }
  lines.push('---');
  return `${lines.join('\n')}\n${snapshot.body}`;
}

export class IndividualNoteWriter {
  private readonly inboxFolder: string;
  private readonly notesFolder: string;
  private readonly inFlight = new Map<string, Promise<NoteWriteReceipt>>();

  public constructor(private readonly options: IndividualNoteWriterOptions) {
    this.inboxFolder = validateVaultPath(options.inboxFolder ?? 'Inbox');
    this.notesFolder = validateVaultPath(options.notesFolder ?? 'Notes');
  }

  public ensureWritten(materialized: MaterializedCapture): Promise<NoteWriteReceipt> {
    const key = materialized.snapshot.id;
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const operation = this.ensureWrittenOnce(materialized);
    this.inFlight.set(key, operation);
    const clear = (): void => {
      if (this.inFlight.get(key) === operation) {
        this.inFlight.delete(key);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async ensureWrittenOnce(materialized: MaterializedCapture): Promise<NoteWriteReceipt> {
    const { snapshot } = materialized;
    const record = await this.options.store.get(snapshot.id);
    assertSubmitted(record, snapshot);

    if (record.write.state === 'deleted') {
      throw new KnownDeletionError(`Capture ${snapshot.id} was deleted and will not be recreated`);
    }

    if (record.write.note) {
      validateVaultPath(record.write.note.path);
      const existing = await this.options.vault.read(record.write.note.path);
      if (existing !== null) {
        try {
          reconcileExisting(existing, snapshot);
        } catch (error) {
          await this.markConflict(snapshot, error instanceof Error ? error.message : 'Existing note conflict');
          throw error;
        }
        return {
          captureId: snapshot.id,
          revision: snapshot.revision,
          note: record.write.note,
          created: false,
        };
      }
    }

    const matches = await this.findByCaptureId(snapshot.id);
    if (matches.length > 1) {
      await this.markConflict(snapshot, `Multiple notes carry ${snapshot.id}`);
      throw new NoteWriterError('marker_conflict', `Multiple notes carry ${snapshot.id}`);
    }
    if (matches.length === 1) {
      const match = matches[0];
      const existing = await this.options.vault.read(match.path);
      if (existing === null) {
        throw new NoteWriterError('vault_race', `Matched note disappeared: ${match.path}`);
      }
      try {
        reconcileExisting(existing, snapshot);
      } catch (error) {
        await this.markConflict(snapshot, error instanceof Error ? error.message : 'Existing note conflict');
        throw error;
      }
      await this.options.store.markNoteWritten(snapshot.id, snapshot.revision, match);
      return { captureId: snapshot.id, revision: snapshot.revision, note: match, created: false };
    }

    if (record.write.note) {
      await this.markDeleted(snapshot, `Known note path is missing: ${record.write.note.path}`);
      throw new KnownDeletionError(`Known note path is missing: ${record.write.note.path}`);
    }

    const path = await this.findAvailablePath(snapshot);
    const note: NoteRef = {
      captureId: snapshot.id,
      revision: snapshot.revision,
      path,
      folder: path.startsWith(`${this.notesFolder}/`) ? 'notes' : 'inbox',
    };
    try {
      await this.options.vault.create(path, renderNote(materialized));
    } catch (error) {
      try {
        await this.options.store.markNoteFailure(
          snapshot.id,
          snapshot.revision,
          serializeError(
            'vault_create_failed',
            error instanceof Error ? error.message : 'Vault create failed',
            this.options.now,
          ),
        );
      } catch {
        // The marker scan remains the recovery source if this receipt cannot persist.
      }
      throw error;
    }
    await this.options.store.markNoteWritten(snapshot.id, snapshot.revision, note);
    return { captureId: snapshot.id, revision: snapshot.revision, note, created: true };
  }

  public async findByCaptureId(id: CaptureSnapshot['id']): Promise<readonly NoteRef[]> {
    const matches: NoteRef[] = [];
    const folders = new Map<string, 'inbox' | 'notes'>([
      [this.inboxFolder, 'inbox'],
      [this.notesFolder, 'notes'],
    ]);
    for (const [folder, kind] of folders) {
      for (const path of await this.options.vault.list(folder)) {
        validateVaultPath(path);
        const content = await this.options.vault.read(path);
        if (content === null) {
          continue;
        }
        const marker = parseMarker(content);
        if (marker?.captureId === id) {
          matches.push({
            captureId: id,
            revision: marker.revision,
            path,
            folder: kind,
          });
        }
      }
    }
    return matches;
  }

  private async findAvailablePath(snapshot: CaptureSnapshot): Promise<string> {
    const base = deterministicNotePath(snapshot, this.inboxFolder);
    for (let index = 0; ; index += 1) {
      const path = index === 0 ? base : addCollisionSuffix(base, index);
      if ((await this.options.vault.read(path)) === null) {
        return path;
      }
    }
  }

  private async markConflict(snapshot: CaptureSnapshot, message: string): Promise<void> {
    await this.options.store.markNoteConflict(
      snapshot.id,
      snapshot.revision,
      serializeError('marker_conflict', message, this.options.now),
    );
  }

  private async markDeleted(snapshot: CaptureSnapshot, message: string): Promise<void> {
    await this.options.store.markNoteDeleted(
      snapshot.id,
      snapshot.revision,
      serializeError('known_deletion', message, this.options.now),
    );
  }
}

interface Marker {
  readonly captureId: CaptureSnapshot['id'];
  readonly revision: Revision;
}

function assertSubmitted(
  record: CaptureRecord | undefined,
  snapshot: CaptureSnapshot,
): asserts record is CaptureRecord {
  if (
    !record ||
    record.lifecycle !== 'submitted' ||
    record.submittedRevision !== snapshot.revision ||
    JSON.stringify(record.snapshot) !== JSON.stringify(snapshot)
  ) {
    throw new NoteWriterError(
      'stale_capture',
      `Capture ${snapshot.id} is not submitted at revision ${snapshot.revision}`,
    );
  }
}

function reconcileExisting(content: string, snapshot: CaptureSnapshot): void {
  const marker = parseMarker(content);
  if (!marker || marker.captureId !== snapshot.id || marker.revision !== snapshot.revision) {
    throw new NoteWriterError('marker_conflict', `Existing note does not match ${snapshot.id}@${snapshot.revision}`);
  }
  if (extractBody(content) !== snapshot.body) {
    throw new NoteWriterError('body_conflict', `Existing note body was edited for ${snapshot.id}`);
  }
}

function parseMarker(content: string): Marker | undefined {
  if (!content.startsWith('---\n')) {
    return undefined;
  }
  const close = content.indexOf('\n---\n', 4);
  if (close < 0) {
    return undefined;
  }
  const header = content.slice(4, close).split('\n');
  const values = new Map<string, string>();
  for (const line of header) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      values.set(line.slice(0, separator), line.slice(separator + 1).trim());
    }
  }
  const captureId = values.get(LETHE_MARKERS.captureId);
  const rawRevision = values.get(LETHE_MARKERS.revision);
  const revision = rawRevision === undefined ? NaN : Number(rawRevision);
  if (!captureId || !Number.isInteger(revision) || revision < 0) {
    return undefined;
  }
  return { captureId: captureId as CaptureSnapshot['id'], revision: revision as Revision };
}

function extractBody(content: string): string {
  const close = content.indexOf('\n---\n', 4);
  return close < 0 ? '' : content.slice(close + 5);
}

function serializeError(code: string, message: string, now?: () => string): SerializedError {
  return { code, message, at: now?.() ?? new Date().toISOString() };
}

function renderProperty(key: string, value: FrontmatterValue): string[] {
  const safeKey = key.replace(/[\r\n:]/gu, '_');
  if (Array.isArray(value)) {
    return [safeKey + ':', ...value.map((item) => `  - ${renderScalar(item)}`)];
  }
  return [`${safeKey}: ${renderScalar(value)}`];
}

function renderScalar(value: string | number | boolean): string {
  if (typeof value !== 'string') {
    return String(value);
  }
  if (
    value.length > 0 &&
    value.trim() === value &&
    /^[\p{L}\p{N}._/ -]+$/u.test(value) &&
    !['true', 'false', 'null', '~'].includes(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function sanitizeSegment(value: string): string {
  const withoutControlCharacters = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint < 32 ? ' ' : character;
    })
    .join('');
  return withoutControlCharacters
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .trim()
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '');
}

function addCollisionSuffix(path: string, index: number): string {
  return path.replace(/\.md$/u, `-${index}.md`);
}
