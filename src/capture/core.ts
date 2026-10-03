import type { LetheDataRepository } from './repository';

export type CaptureId = string & { readonly __captureId: unique symbol };
export type Revision = number & { readonly __revision: unique symbol };
export type CaptureProfile = 'auto' | 'plain' | 'book' | 'movie';
export type FrontmatterValue = string | number | boolean | string[];

export type FieldIntent = { readonly state: 'set'; readonly value: FrontmatterValue } | { readonly state: 'cleared' };

export interface TagIntent {
  readonly userAdded: readonly string[];
  readonly userRemoved: readonly string[];
}

export interface CaptureSnapshot {
  readonly id: CaptureId;
  readonly revision: Revision;
  readonly body: string;
  readonly profile: CaptureProfile;
  readonly fields: Readonly<Record<string, FieldIntent>>;
  readonly tags: TagIntent;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDraftSnapshotOptions {
  readonly id: CaptureId;
  readonly body: string;
  readonly now?: () => string;
  readonly profile?: CaptureProfile;
  readonly fields?: Readonly<Record<string, FieldIntent>>;
  readonly tags?: TagIntent;
}

export type CaptureLifecycle = 'draft' | 'submitted' | 'discarded';
export type NoteWriteState = 'not-started' | 'pending' | 'written' | 'failed' | 'conflict' | 'deleted';
export type ProcessingState = 'not-started' | 'pending' | 'applied' | 'failed';

export interface NoteRef {
  readonly captureId: CaptureId;
  readonly revision: Revision;
  readonly path: string;
  readonly folder: 'inbox' | 'notes';
}

export interface SerializedError {
  readonly code: string;
  readonly message: string;
  readonly at: string;
}

export interface CaptureRecord {
  readonly recordVersion: 1;
  readonly snapshot: CaptureSnapshot;
  readonly lifecycle: CaptureLifecycle;
  readonly submittedRevision?: Revision;
  readonly write: {
    readonly state: NoteWriteState;
    readonly note?: NoteRef;
    readonly lastError?: SerializedError;
  };
  readonly processing: {
    readonly state: ProcessingState;
    readonly requestedRevision?: Revision;
    readonly lastError?: SerializedError;
  };
}

export interface CaptureStoreState {
  readonly schemaVersion: 1;
  readonly captures: Readonly<Record<string, CaptureRecord>>;
}

export interface SubmissionReceipt {
  readonly captureId: CaptureId;
  readonly submittedRevision: Revision;
  readonly localPersisted: true;
  readonly noteState: 'pending' | 'written';
}

export interface CaptureStore {
  load(): Promise<CaptureStoreState>;
  get(id: CaptureId): Promise<CaptureRecord | undefined>;
  createDraft(snapshot: CaptureSnapshot): Promise<void>;
  saveDraft(snapshot: CaptureSnapshot): Promise<void>;
  commitSubmission(snapshot: CaptureSnapshot): Promise<SubmissionReceipt>;
  markNoteWritten(id: CaptureId, revision: Revision, note: NoteRef): Promise<void>;
  markNoteFailure(id: CaptureId, revision: Revision, error: SerializedError): Promise<void>;
  markNoteConflict(id: CaptureId, revision: Revision, error: SerializedError): Promise<void>;
  markNoteDeleted(id: CaptureId, revision: Revision, error?: SerializedError): Promise<void>;
  markProcessing(id: CaptureId, revision: Revision, state: ProcessingState): Promise<void>;
  discard(id: CaptureId, expectedRevision: Revision): Promise<void>;
  listRecoverable(): Promise<readonly CaptureRecord[]>;
}

export class CaptureError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

export class CaptureConflictError extends CaptureError {
  public constructor(message: string) {
    super('capture_conflict', message);
    this.name = 'CaptureConflictError';
  }
}

export class StaleRevisionError extends CaptureError {
  public constructor(message: string) {
    super('stale_revision', message);
    this.name = 'StaleRevisionError';
  }
}

export function createCaptureId(nextValue?: () => string): CaptureId {
  const value =
    nextValue?.() ??
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `cap_${value}` as CaptureId;
}

export function createDraftSnapshot(options: CreateDraftSnapshotOptions): CaptureSnapshot {
  const now = options.now?.() ?? new Date().toISOString();
  return {
    id: options.id,
    revision: 0 as Revision,
    body: options.body,
    profile: options.profile ?? 'auto',
    fields: options.fields ?? {},
    tags: options.tags ?? { userAdded: [], userRemoved: [] },
    createdAt: now,
    updatedAt: now,
  };
}

export function isBlankForSubmission(body: string): boolean {
  return /^\s*$/u.test(body);
}

export class DurableCaptureStore implements CaptureStore {
  public constructor(private readonly repository: LetheDataRepository) {}

  public async load(): Promise<CaptureStoreState> {
    const envelope = await this.repository.read();
    return clone(readState(envelope));
  }

  public async get(id: CaptureId): Promise<CaptureRecord | undefined> {
    const state = await this.load();
    return state.captures[id] ? clone(state.captures[id]) : undefined;
  }

  public createDraft(snapshot: CaptureSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    return this.mutate((state) => {
      if (state.captures[snapshot.id]) {
        throw new CaptureConflictError(`Capture ${snapshot.id} already exists`);
      }
      state.captures[snapshot.id] = makeDraftRecord(snapshot);
    });
  }

  public saveDraft(snapshot: CaptureSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    return this.mutate((state) => {
      const record = state.captures[snapshot.id];
      if (!record) {
        throw new CaptureConflictError(`Capture ${snapshot.id} does not exist`);
      }
      if (record.lifecycle !== 'draft') {
        throw new CaptureConflictError(`Capture ${snapshot.id} is no longer a draft`);
      }
      if (snapshot.revision < record.snapshot.revision) {
        throw new StaleRevisionError(`Revision ${snapshot.revision} is older than ${record.snapshot.revision}`);
      }
      if (snapshot.revision === record.snapshot.revision) {
        if (sameSnapshot(record.snapshot, snapshot)) {
          return;
        }
        throw new StaleRevisionError(`Revision ${snapshot.revision} is already acknowledged`);
      }
      state.captures[snapshot.id] = {
        ...record,
        snapshot: clone(snapshot),
      };
    });
  }

  public commitSubmission(snapshot: CaptureSnapshot): Promise<SubmissionReceipt> {
    validateSnapshot(snapshot);
    return this.mutate((state) => {
      const existing = state.captures[snapshot.id];
      if (existing?.lifecycle === 'discarded') {
        throw new CaptureConflictError(`Capture ${snapshot.id} was discarded`);
      }
      if (existing?.lifecycle === 'submitted') {
        if (existing.submittedRevision === snapshot.revision && sameSnapshot(existing.snapshot, snapshot)) {
          return receiptFor(existing);
        }
        throw new CaptureConflictError(`Capture ${snapshot.id} was already submitted`);
      }
      if (existing && snapshot.revision < existing.snapshot.revision) {
        throw new StaleRevisionError(`Revision ${snapshot.revision} is older than ${existing.snapshot.revision}`);
      }
      if (existing && snapshot.revision === existing.snapshot.revision && !sameSnapshot(existing.snapshot, snapshot)) {
        throw new CaptureConflictError(`Revision ${snapshot.revision} conflicts with the saved draft`);
      }

      const submitted: CaptureRecord = {
        recordVersion: 1,
        snapshot: clone(snapshot),
        lifecycle: 'submitted',
        submittedRevision: snapshot.revision,
        write: { state: 'pending' },
        processing: { state: 'not-started' },
      };
      state.captures[snapshot.id] = submitted;
      return receiptFor(submitted);
    });
  }

  public markNoteWritten(id: CaptureId, revision: Revision, note: NoteRef): Promise<void> {
    return this.mutate((state) => {
      const record = requireSubmitted(state.captures, id, revision);
      if (record.write.state === 'deleted') {
        throw new CaptureConflictError(`Capture ${id} is marked deleted`);
      }
      state.captures[id] = {
        ...record,
        write: { state: 'written', note: clone(note) },
      };
    });
  }

  public markNoteFailure(id: CaptureId, revision: Revision, error: SerializedError): Promise<void> {
    return this.setWriteState(id, revision, 'failed', error);
  }

  public markNoteConflict(id: CaptureId, revision: Revision, error: SerializedError): Promise<void> {
    return this.setWriteState(id, revision, 'conflict', error);
  }

  public markNoteDeleted(id: CaptureId, revision: Revision, error?: SerializedError): Promise<void> {
    return this.setWriteState(id, revision, 'deleted', error);
  }

  public markProcessing(id: CaptureId, revision: Revision, state: ProcessingState): Promise<void> {
    return this.mutate((captureState) => {
      const record = requireSubmitted(captureState.captures, id, revision);
      captureState.captures[id] = {
        ...record,
        processing: {
          ...record.processing,
          state,
          requestedRevision: revision,
        },
      };
    });
  }

  public discard(id: CaptureId, expectedRevision: Revision): Promise<void> {
    return this.mutate((state) => {
      const record = state.captures[id];
      if (!record) {
        throw new CaptureConflictError(`Capture ${id} does not exist`);
      }
      if (record.lifecycle === 'discarded') {
        if (record.snapshot.revision === expectedRevision) {
          return;
        }
        throw new StaleRevisionError(`Revision ${expectedRevision} does not match discarded capture`);
      }
      if (record.lifecycle !== 'draft') {
        throw new CaptureConflictError(`Capture ${id} is already submitted`);
      }
      if (record.snapshot.revision !== expectedRevision) {
        throw new StaleRevisionError(`Revision ${expectedRevision} does not match ${record.snapshot.revision}`);
      }
      state.captures[id] = { ...record, lifecycle: 'discarded' };
    });
  }

  public async listRecoverable(): Promise<readonly CaptureRecord[]> {
    const state = await this.load();
    return Object.values(state.captures)
      .filter((record) => record.lifecycle !== 'discarded')
      .sort((left, right) => left.snapshot.updatedAt.localeCompare(right.snapshot.updatedAt))
      .map((record) => clone(record));
  }

  private mutate<T>(mutator: (state: MutableCaptureStoreState) => T): Promise<T> {
    return this.repository.transact((envelope) => {
      const root = isRecord(envelope) ? { ...envelope } : {};
      const state = readState(root) as MutableCaptureStoreState;
      const result = mutator(state);
      root._captureStore = state;
      return { next: root, result };
    });
  }

  private setWriteState(
    id: CaptureId,
    revision: Revision,
    state: NoteWriteState,
    error?: SerializedError,
  ): Promise<void> {
    return this.mutate((captureState) => {
      const record = requireSubmitted(captureState.captures, id, revision);
      captureState.captures[id] = {
        ...record,
        write: {
          state,
          ...(record.write.note ? { note: record.write.note } : {}),
          ...(error ? { lastError: clone(error) } : {}),
        },
      };
    });
  }
}

interface MutableCaptureStoreState {
  [key: string]: unknown;
  schemaVersion: 1;
  captures: Record<string, CaptureRecord>;
}

function makeDraftRecord(snapshot: CaptureSnapshot): CaptureRecord {
  return {
    recordVersion: 1,
    snapshot: clone(snapshot),
    lifecycle: 'draft',
    write: { state: 'not-started' },
    processing: { state: 'not-started' },
  };
}

function receiptFor(record: CaptureRecord): SubmissionReceipt {
  return {
    captureId: record.snapshot.id,
    submittedRevision: record.submittedRevision as Revision,
    localPersisted: true,
    noteState: record.write.state === 'written' ? 'written' : 'pending',
  };
}

function requireSubmitted(captures: Record<string, CaptureRecord>, id: CaptureId, revision: Revision): CaptureRecord {
  const record = captures[id];
  if (!record || record.lifecycle !== 'submitted') {
    throw new CaptureConflictError(`Capture ${id} is not submitted`);
  }
  if (record.submittedRevision !== revision) {
    throw new StaleRevisionError(`Revision ${revision} is not current for ${id}`);
  }
  return record;
}

function validateSnapshot(snapshot: CaptureSnapshot): void {
  if (!snapshot.id || !Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new CaptureConflictError('Capture snapshot has an invalid identity or revision');
  }
}

function readState(envelope: unknown): CaptureStoreState {
  const root = isRecord(envelope) ? envelope : {};
  const raw = isRecord(root._captureStore) ? root._captureStore : {};
  const captures = isRecord(raw.captures) ? raw.captures : {};
  return {
    ...raw,
    schemaVersion: 1,
    captures: clone(captures) as Record<string, CaptureRecord>,
  };
}

function sameSnapshot(left: CaptureSnapshot, right: CaptureSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
