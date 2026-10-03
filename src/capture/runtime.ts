import {
  CaptureError,
  type CaptureId,
  type CaptureRecord,
  type CaptureSnapshot,
  type CaptureStore,
  type NoteRef,
  type Revision,
  type SerializedError,
  type SubmissionReceipt,
  DurableCaptureStore,
  createCaptureId,
  createDraftSnapshot,
  isBlankForSubmission,
} from './core';
import { type LetheDataRepository } from './repository';
import {
  LETHE_FRONTMATTER_KEYS,
  materializeCapture,
  type CaptureProfileId,
  type MaterializedCapture as ProfileMaterializedCapture,
} from './profiles';
import { IndividualNoteWriter, type MaterializedCapture as WriterMaterializedCapture, type VaultPort } from './writer';
import {
  listOrganizationEnrollments,
  organizationOverridesForSnapshot,
  ORGANIZATION_ENROLLMENT_SCHEMA_VERSION,
  removeOrganizationEnrollment,
  saveOrganizationEnrollment,
  updateOrganizationEnrollment,
  type OrganizationEnrollment,
  type OrganizationRuntimeBridge,
} from '../organization/runtimeBridge';
import { organizationJobId, type OrganizationJob, type OrganizationPolicy } from '../organization/types';

export type CaptureSessionKey = 'main' | 'quick';

export interface CaptureSession {
  getSnapshot(): CaptureSnapshot;
  update(patch: Partial<Pick<CaptureSnapshot, 'body' | 'profile' | 'fields' | 'tags'>>): Promise<void>;
  submit(keepProfile?: boolean, options?: { readonly skipAI?: boolean }): Promise<SubmissionReceipt>;
  discard(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface CaptureRuntimeOptions {
  readonly repository: LetheDataRepository;
  readonly vault: VaultPort;
  readonly now?: () => string;
  readonly createId?: () => CaptureId;
  readonly idFactory?: () => CaptureId;
  readonly inboxFolder?: string;
  readonly notesFolder?: string;
  readonly defaultTags?: readonly string[];
  readonly openNote?: (note: NoteRef) => Promise<void>;
  readonly organization?: OrganizationRuntimeBridge;
}

interface CaptureSessionsState {
  readonly schemaVersion: 1;
  readonly sessions: Record<CaptureSessionKey, CaptureId | undefined>;
  readonly busy: Record<CaptureSessionKey, CaptureSessionBusy | undefined>;
  [key: string]: unknown;
}

interface CaptureSessionBusy {
  readonly captureId: CaptureId;
  readonly revision: Revision;
}

interface MutableCaptureStoreState {
  readonly schemaVersion: 1;
  readonly captures: Record<string, CaptureRecord>;
  [key: string]: unknown;
}

interface SessionAllocation {
  readonly snapshot: CaptureSnapshot;
}

export class CaptureRuntime {
  public readonly store: CaptureStore;

  private readonly repository: LetheDataRepository;
  private readonly writer: IndividualNoteWriter;
  private readonly vault: VaultPort;
  private readonly organization?: OrganizationRuntimeBridge;
  private readonly now: () => string;
  private readonly createId: () => CaptureId;
  private defaultTags: readonly string[];
  private readonly sessions = new Map<CaptureSessionKey, CaptureSessionImpl>();
  private readonly opening = new Map<CaptureSessionKey, Promise<CaptureSession>>();
  private readonly listeners = new Set<() => void>();
  private noteOpener?: (note: NoteRef) => Promise<void>;
  private ready?: Promise<void>;
  private inboxFolder: string;
  private notesFolder: string;
  private unsubscribeOrganization?: () => void;
  private disposed = false;

  public constructor(options: CaptureRuntimeOptions) {
    this.repository = options.repository;
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? options.idFactory ?? (() => createCaptureId());
    this.defaultTags = [...(options.defaultTags ?? [])];
    this.inboxFolder = options.inboxFolder ?? 'Inbox';
    this.notesFolder = options.notesFolder ?? 'Notes';
    this.noteOpener = options.openNote;
    this.vault = options.vault;
    this.organization = options.organization;
    this.store = new DurableCaptureStore(options.repository);
    this.writer = new IndividualNoteWriter({
      vault: options.vault,
      store: this.store,
      inboxFolder: this.inboxFolder,
      notesFolder: this.notesFolder,
      now: this.now,
    });
    this.unsubscribeOrganization = this.organization?.subscribe(() => {
      this.emit();
      void this.syncOrganizationNotePaths().catch(() => undefined);
    });
  }

  public initialize(): Promise<void> {
    if (!this.ready) {
      this.ready = this.recoverStaleSubmissionBusy()
        .then(() => this.recoverPending())
        .then(async () => {
          await this.organization?.initialize();
          await this.recoverOrganizationEnrollments();
        })
        .catch((error: unknown) => {
          this.ready = undefined;
          throw error;
        });
    }
    return this.ready;
  }

  public async openSession(key: CaptureSessionKey): Promise<CaptureSession> {
    await this.initialize();
    const existing = this.sessions.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.opening.get(key);
    if (pending) {
      return pending;
    }
    const opening = this.openSessionOnce(key);
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      if (this.opening.get(key) === opening) {
        this.opening.delete(key);
      }
    }
  }

  public async recent(): Promise<readonly CaptureRecord[]> {
    await this.initialize();
    const state = await this.store.load();
    return Object.values(state.captures)
      .filter((record) => record.lifecycle === 'submitted')
      .sort((left, right) => right.snapshot.updatedAt.localeCompare(left.snapshot.updatedAt))
      .map((record) => clone(record));
  }

  public async retry(id: CaptureId): Promise<void> {
    await this.initialize();
    const record = await this.store.get(id);
    if (!record || record.lifecycle !== 'submitted') {
      throw new CaptureError('capture_not_found', `Capture ${id} is not a submitted capture`);
    }
    if (record.write.state === 'written' || record.write.state === 'deleted' || record.write.state === 'conflict') {
      return;
    }
    await this.writeRecord(record);
  }

  public async openNote(id: CaptureId): Promise<void> {
    await this.initialize();
    const record = await this.store.get(id);
    if (!record || record.lifecycle !== 'submitted') {
      throw new CaptureError('capture_not_found', `Capture ${id} is not a submitted capture`);
    }
    if (!record.write.note || record.write.state === 'deleted') {
      throw new CaptureError('note_unavailable', `Capture ${id} has no openable note`);
    }
    if (!this.noteOpener) {
      throw new CaptureError('note_opener_unavailable', 'No note opener is configured');
    }
    await this.noteOpener(record.write.note);
  }

  public setNoteOpener(opener: ((note: NoteRef) => Promise<void>) | undefined): void {
    this.noteOpener = opener;
  }

  /** @internal */
  public getDefaultTags(): readonly string[] {
    return this.defaultTags;
  }

  /** Update settings-derived tags for captures created after the change. */
  public setDefaultTags(tags: readonly string[]): void {
    this.defaultTags = [...tags];
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getOrganizationMode(): 'off' | 'advisory' | 'automatic' {
    return this.organization?.getOrganizationMode() ?? 'off';
  }

  public updateOrganizationSettings(
    settings: Parameters<OrganizationRuntimeBridge['updateSettings']>[0],
  ): Promise<void> {
    return this.organization?.updateSettings(settings) ?? Promise.resolve();
  }

  public async getOrganizationStatus(id: CaptureId): Promise<OrganizationJob | undefined> {
    await this.initialize();
    if (!this.organization) {
      return undefined;
    }
    const record = await this.store.get(id);
    if (record?.lifecycle !== 'submitted') {
      return undefined;
    }
    return this.organization.getJob(organizationJobId(id, record.submittedRevision ?? record.snapshot.revision));
  }

  public async retryOrganization(id: CaptureId): Promise<void> {
    await this.organizationAction(id, (revision) => this.organization?.retry(id, revision));
  }

  public async skipOrganization(id: CaptureId): Promise<void> {
    await this.organizationAction(id, (revision) => this.organization?.skip(id, revision));
  }

  public async undoOrganization(id: CaptureId): Promise<void> {
    await this.organizationAction(id, (revision) => this.organization?.undo(id, revision).then(() => undefined));
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribeOrganization?.();
    this.unsubscribeOrganization = undefined;
    await this.organization?.dispose();
    this.sessions.clear();
    this.opening.clear();
  }

  private async organizationAction(
    id: CaptureId,
    action: (revision: Revision) => Promise<void> | undefined,
  ): Promise<void> {
    await this.initialize();
    if (!this.organization) {
      throw new CaptureError('organization_unavailable', 'Organization processing is unavailable');
    }
    const record = await this.store.get(id);
    if (record?.lifecycle !== 'submitted') {
      throw new CaptureError('capture_not_found', `Capture ${id} is not a submitted capture`);
    }
    const revision = record.submittedRevision ?? record.snapshot.revision;
    await action(revision);
    this.emit();
  }

  private async syncOrganizationNotePaths(): Promise<void> {
    if (this.disposed || !this.organization) {
      return;
    }
    const jobs = await this.organization.listJobs();
    if (this.disposed) {
      return;
    }
    const appliedJobs = new Map<string, OrganizationJob>();
    for (const job of jobs) {
      if ((job.status === 'applied' || job.status === 'undone' || job.status === 'deleted') && job.notePath) {
        appliedJobs.set(organizationJobId(job.captureId, job.revision), job);
      }
    }
    if (appliedJobs.size === 0) {
      return;
    }
    const changed = await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const store = readMutableCaptureStore(root);
      let didChange = false;
      for (const record of Object.values(store.captures)) {
        if (record.lifecycle !== 'submitted' || !record.write.note) {
          continue;
        }
        const key = organizationJobId(record.snapshot.id, record.submittedRevision ?? record.snapshot.revision);
        const job = appliedJobs.get(key);
        if (!job || job.notePath === record.write.note.path) {
          continue;
        }
        const note = record.write.note;
        store.captures[record.snapshot.id] = {
          ...record,
          write: {
            ...record.write,
            note: {
              ...note,
              path: job.notePath,
              folder: this.folderForPath(job.notePath),
            },
          },
        };
        didChange = true;
      }
      if (!didChange) {
        return { next: root, result: false };
      }
      root._captureStore = store;
      return { next: root, result: true };
    });
    if (changed) {
      this.emit();
    }
  }
  public async handleVaultRename(oldPath: string, newPath: string): Promise<void> {
    await this.initialize();
    const changed = await this.repository.transact((current) => {
      const root = asMutableRecord(current);
      const store = readMutableCaptureStore(root);
      let didChange = false;
      for (const [id, record] of Object.entries(store.captures)) {
        if (record.lifecycle !== 'submitted' || record.write.note?.path !== oldPath) {
          continue;
        }
        const note = record.write.note;
        store.captures[id] = {
          ...record,
          write: {
            ...record.write,
            note: {
              ...note,
              path: newPath,
              folder: this.folderForPath(newPath),
            },
          },
        };
        didChange = true;
      }
      if (!didChange) {
        return { next: root, result: false };
      }
      root._captureStore = store;
      return { next: root, result: true };
    });
    if (changed) {
      this.emit();
    }
  }

  public async handleVaultDelete(path: string): Promise<void> {
    await this.initialize();
    const state = await this.store.load();
    for (const record of Object.values(state.captures)) {
      if (
        record.lifecycle !== 'submitted' ||
        record.write.note?.path !== path ||
        record.write.state === 'deleted' ||
        record.write.state === 'conflict'
      ) {
        continue;
      }
      await this.store.markNoteDeleted(
        record.snapshot.id,
        record.snapshot.revision,
        serializeError('known_deletion', `Capture note was deleted: ${path}`, this.now),
      );
      this.emit();
    }
  }

  private async openSessionOnce(key: CaptureSessionKey): Promise<CaptureSession> {
    const allocation = await this.allocateSession(key, 'auto');
    const session = new CaptureSessionImpl(this, key, allocation.snapshot);
    this.sessions.set(key, session);
    return session;
  }

  private async allocateSession(
    key: CaptureSessionKey,
    profile: CaptureProfileId,
    releaseBusy?: CaptureSessionBusy,
  ): Promise<SessionAllocation> {
    const current = await this.readSharedEnvelope();
    const currentRoot = asMutableRecord(current);
    const currentSessions = readMutableCaptureSessions(currentRoot);
    const currentBusy = currentSessions.busy[key];
    if (currentBusy && !sameBusy(currentBusy, releaseBusy)) {
      throw new CaptureError('capture_submitting', 'Capture submission is already in progress');
    }
    const mapped = readMappedSnapshot(current, key);
    if (mapped?.lifecycle === 'draft' && currentBusy === undefined) {
      return { snapshot: clone(mapped.snapshot) };
    }

    return this.repository.transact((currentEnvelope) => {
      const root = asMutableRecord(currentEnvelope);
      const sessions = readMutableCaptureSessions(root);
      const store = readMutableCaptureStore(root);
      const busy = sessions.busy[key];
      if (busy && !sameBusy(busy, releaseBusy)) {
        throw new CaptureError('capture_submitting', 'Capture submission is already in progress');
      }
      const mappedId = sessions.sessions[key];
      const mappedRecord = mappedId === undefined ? undefined : store.captures[mappedId];
      if (mappedRecord?.lifecycle === 'draft') {
        if (releaseBusy !== undefined && sameBusy(busy, releaseBusy)) {
          delete sessions.busy[key];
          root._captureSessions = sessions;
        }
        return { next: root, result: { snapshot: clone(mappedRecord.snapshot) } };
      }

      const id = this.createId();
      if (store.captures[id]) {
        throw new CaptureError('capture_id_conflict', `Capture ${id} already exists`);
      }
      const snapshot = createDraftSnapshot({
        id,
        body: '',
        profile,
        now: this.now,
      });
      store.captures[id] = draftRecord(snapshot);
      sessions.sessions[key] = id;
      if (releaseBusy !== undefined && sameBusy(busy, releaseBusy)) {
        delete sessions.busy[key];
      }
      root._captureStore = store;
      root._captureSessions = sessions;
      return { next: root, result: { snapshot: clone(snapshot) } };
    });
  }

  private async persistDraft(snapshot: CaptureSnapshot): Promise<void> {
    await this.store.saveDraft(snapshot);
  }

  private readSharedEnvelope(): Promise<unknown> {
    return this.repository.readFresh ? this.repository.readFresh() : this.repository.read();
  }

  private async claimSubmission(session: CaptureSessionImpl, frozen: CaptureSnapshot): Promise<CaptureSessionBusy> {
    const busy: CaptureSessionBusy = { captureId: frozen.id, revision: frozen.revision };
    await this.readSharedEnvelope();
    await this.repository.transact((currentEnvelope) => {
      const root = asMutableRecord(currentEnvelope);
      const sessions = readMutableCaptureSessions(root);
      const store = readMutableCaptureStore(root);
      const existingBusy = sessions.busy[session.key];
      if (existingBusy) {
        throw new CaptureError('capture_submitting', 'Capture submission is already in progress');
      }
      const mappedId = sessions.sessions[session.key];
      const mappedRecord = mappedId === undefined ? undefined : store.captures[mappedId];
      if (
        mappedId !== frozen.id ||
        !mappedRecord ||
        mappedRecord.lifecycle !== 'draft' ||
        mappedRecord.snapshot.revision > frozen.revision ||
        (mappedRecord.snapshot.revision === frozen.revision && !sameSnapshot(mappedRecord.snapshot, frozen))
      ) {
        throw new CaptureError('stale_revision', `Capture ${frozen.id} changed before submission`);
      }
      sessions.busy[session.key] = busy;
      root._captureSessions = sessions;
      return { next: root, result: undefined };
    });
    return busy;
  }

  private async clearSubmissionBusy(key: CaptureSessionKey, busy: CaptureSessionBusy): Promise<void> {
    await this.repository.transact((currentEnvelope) => {
      const root = asMutableRecord(currentEnvelope);
      const sessions = readMutableCaptureSessions(root);
      if (!sameBusy(sessions.busy[key], busy)) {
        return { next: root, result: undefined };
      }
      delete sessions.busy[key];
      root._captureSessions = sessions;
      return { next: root, result: undefined };
    });
  }

  private async hasDurableSubmission(snapshot: CaptureSnapshot): Promise<boolean> {
    try {
      return (await this.store.get(snapshot.id))?.lifecycle === 'submitted';
    } catch {
      // Do not release a claim when the durable state cannot be verified.
      return true;
    }
  }

  public async submit(
    session: CaptureSessionImpl,
    frozen: CaptureSnapshot,
    resolved: ProfileMaterializedCapture,
    keepProfile: boolean,
    options: { readonly skipAI?: boolean } = {},
  ): Promise<SubmissionReceipt> {
    const busy = await this.claimSubmission(session, frozen);
    let committed = false;
    try {
      await this.prepareOrganizationEnrollment(frozen, options);
      const receipt = await this.store.commitSubmission(frozen);
      committed = true;
      this.emit();

      let next: SessionAllocation;
      try {
        next = await this.allocateSession(session.key, keepProfile ? frozen.profile : 'auto', busy);
      } catch (error) {
        session.blockAfterCommit();
        if (this.sessions.get(session.key) === session) {
          this.sessions.delete(session.key);
        }
        await this.clearSubmissionBusy(session.key, busy).catch(() => undefined);
        void this.writeSubmission(frozen, resolved);
        throw error;
      }

      session.replaceSnapshot(next.snapshot);
      this.emit();
      void this.writeSubmission(frozen, resolved);
      return receipt;
    } catch (error) {
      const committedOnDisk = committed || (await this.hasDurableSubmission(frozen));
      if (!committedOnDisk) {
        if (this.organization) {
          await removeOrganizationEnrollment(this.repository, organizationJobId(frozen.id, frozen.revision)).catch(
            () => undefined,
          );
        }
        await this.clearSubmissionBusy(session.key, busy).catch(() => undefined);
      }
      throw error;
    }
  }

  private async writeSubmission(snapshot: CaptureSnapshot, resolved: ProfileMaterializedCapture): Promise<void> {
    try {
      const receipt = await this.writer.ensureWritten(toWriterMaterialized(snapshot, resolved));
      await this.markWrittenIfNeeded(snapshot, receipt.note);
      const baselineContent = await this.vault.read(receipt.note.path);
      if (baselineContent === null) {
        throw new Error(`Written organization note disappeared for ${snapshot.id}`);
      }
      await this.enqueueOrganization(snapshot, receipt.note, baselineContent);
    } catch {
      // The store and enrollment record retain the failure for recovery/retry.
    }
    this.emit();
  }

  private async writeRecord(record: CaptureRecord): Promise<void> {
    const resolved = materializeForSnapshot(record.snapshot, this.defaultTags);
    if (!resolved.canCapture) {
      throw new CaptureError('capture_invalid', resolved.validationErrors.map((error) => error.message).join(' '));
    }
    const receipt = await this.writer.ensureWritten(toWriterMaterialized(record.snapshot, resolved));
    await this.markWrittenIfNeeded(record.snapshot, receipt.note);
    await this.enqueueOrganization(record.snapshot, receipt.note);
    this.emit();
  }

  private async markWrittenIfNeeded(snapshot: CaptureSnapshot, note: NoteRef): Promise<void> {
    const latest = await this.store.get(snapshot.id);
    if (
      latest?.lifecycle === 'submitted' &&
      latest.write.state !== 'written' &&
      latest.write.state !== 'deleted' &&
      latest.write.state !== 'conflict'
    ) {
      await this.store.markNoteWritten(snapshot.id, snapshot.revision, note);
    }
  }

  private async prepareOrganizationEnrollment(
    snapshot: CaptureSnapshot,
    options: { readonly skipAI?: boolean },
  ): Promise<OrganizationEnrollment | undefined> {
    if (!this.organization) {
      return undefined;
    }
    const mode = this.organization.getOrganizationMode();
    const enrollment: OrganizationEnrollment = {
      schemaVersion: ORGANIZATION_ENROLLMENT_SCHEMA_VERSION,
      jobId: organizationJobId(snapshot.id, snapshot.revision),
      captureId: snapshot.id,
      revision: snapshot.revision,
      snapshot: clone(snapshot),
      intent: options.skipAI === true || mode === 'off' ? 'skip' : 'opt-in',
      policy: (mode === 'automatic' ? 'automatic' : 'advisory') as OrganizationPolicy,
      overrides: organizationOverridesForSnapshot(snapshot),
      enrolledAt: this.now(),
    };
    // This is written before commit so a crash after the local submission
    // commits cannot lose the user's per-capture consent.
    await saveOrganizationEnrollment(this.repository, enrollment);
    return enrollment;
  }

  private async enqueueOrganization(
    snapshot: CaptureSnapshot,
    writtenNote: NoteRef,
    baselineContent?: string,
  ): Promise<void> {
    if (!this.organization) {
      return;
    }
    const jobId = organizationJobId(snapshot.id, snapshot.revision);
    const enrollment = (await listOrganizationEnrollments(this.repository)).find((entry) => entry.jobId === jobId);
    if (!enrollment) {
      return;
    }
    const record = await this.store.get(snapshot.id);
    if (
      record?.lifecycle !== 'submitted' ||
      record.submittedRevision !== snapshot.revision ||
      record.write.state !== 'written'
    ) {
      return;
    }

    let note = record.write.note ?? writtenNote;
    let currentContent = baselineContent ?? (await this.vault.read(note.path));
    if (currentContent === null) {
      const matches = await this.writer.findByCaptureId(snapshot.id);
      if (matches.length !== 1) {
        throw new Error(`Written organization note could not be located for ${snapshot.id}`);
      }
      note = matches[0];
      currentContent = await this.vault.read(note.path);
      if (currentContent === null) {
        throw new Error(`Written organization note disappeared for ${snapshot.id}`);
      }
      await this.store.markNoteWritten(snapshot.id, snapshot.revision, note);
    }

    const baseline = enrollment.baseline
      ? { ...enrollment.baseline, path: note.path, folder: note.folder }
      : { path: note.path, folder: note.folder, content: currentContent };
    const localReceipt = enrollment.localReceipt ?? {
      captureId: snapshot.id,
      revision: snapshot.revision,
      localPersisted: true as const,
      notePath: note.path,
      noteFolder: note.folder,
      persistedAt: this.now(),
    };
    const durableReceipt = { ...localReceipt, notePath: note.path, noteFolder: note.folder };
    await updateOrganizationEnrollment(this.repository, jobId, {
      localReceipt: durableReceipt,
      baseline,
    });

    await this.organization.enqueue({
      snapshot: clone(enrollment.snapshot),
      localReceipt: durableReceipt,
      baseline,
      intent: enrollment.intent,
      policy: enrollment.policy,
      overrides: clone(enrollment.overrides),
    });
    // If the process dies before this delete, enqueue is idempotent and the
    // durable enrollment is replayed safely on startup.
    await removeOrganizationEnrollment(this.repository, jobId);
  }

  private async recoverOrganizationEnrollments(): Promise<void> {
    if (!this.organization) {
      return;
    }
    const enrollments = await listOrganizationEnrollments(this.repository);
    for (const enrollment of enrollments) {
      const record = await this.store.get(enrollment.snapshot.id);
      if (
        record?.lifecycle !== 'submitted' ||
        record.submittedRevision !== enrollment.revision ||
        record.snapshot.id !== enrollment.captureId
      ) {
        await removeOrganizationEnrollment(this.repository, enrollment.jobId);
        continue;
      }
      if (record.write.state !== 'written' || !record.write.note) {
        continue;
      }
      try {
        await this.enqueueOrganization(enrollment.snapshot, record.write.note);
      } catch {
        // Keep the enrollment for a later startup or explicit retry.
      }
    }
  }

  private async recoverStaleSubmissionBusy(): Promise<void> {
    const current = await this.readSharedEnvelope();
    const root = asMutableRecord(current);
    const sessions = readMutableCaptureSessions(root);
    const store = readMutableCaptureStore(root);
    const staleKeys = (['main', 'quick'] as const).filter((key) => {
      const claimed = sessions.busy[key];
      const record = claimed === undefined ? undefined : store.captures[claimed.captureId];
      return (
        claimed !== undefined &&
        sessions.sessions[key] === claimed.captureId &&
        record?.lifecycle === 'draft' &&
        record.snapshot.id === claimed.captureId &&
        record.snapshot.revision === claimed.revision
      );
    });
    if (staleKeys.length === 0) {
      return;
    }

    await this.repository.transact((currentEnvelope) => {
      const nextRoot = asMutableRecord(currentEnvelope);
      const nextSessions = readMutableCaptureSessions(nextRoot);
      const nextStore = readMutableCaptureStore(nextRoot);
      let changed = false;
      for (const key of staleKeys) {
        const claimed = nextSessions.busy[key];
        const record = claimed === undefined ? undefined : nextStore.captures[claimed.captureId];
        if (
          claimed === undefined ||
          nextSessions.sessions[key] !== claimed.captureId ||
          record?.lifecycle !== 'draft' ||
          record.snapshot.id !== claimed.captureId ||
          record.snapshot.revision !== claimed.revision
        ) {
          continue;
        }
        delete nextSessions.busy[key];
        changed = true;
      }
      if (!changed) {
        return { next: nextRoot, result: undefined };
      }
      nextRoot._captureSessions = nextSessions;
      return { next: nextRoot, result: undefined };
    });
  }

  private async recoverPending(): Promise<void> {
    const state = await this.store.load();
    const recoverable = Object.values(state.captures).filter(
      (record) =>
        record.lifecycle === 'submitted' && (record.write.state === 'pending' || record.write.state === 'failed'),
    );
    await Promise.all(
      recoverable.map(async (record) => {
        try {
          await this.writeRecord(record);
        } catch {
          // Recovery is best effort. The durable failed state remains retryable.
        }
      }),
    );
  }

  private folderForPath(path: string): 'inbox' | 'notes' {
    return path.startsWith(`${this.notesFolder}/`) ? 'notes' : 'inbox';
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  /** @internal */
  public async updateSession(session: CaptureSessionImpl, patch: CaptureSessionPatch): Promise<void> {
    if (session.isBlocked()) {
      throw new CaptureError('session_unavailable', 'This capture session needs to be reopened');
    }
    const shared = await this.readSharedEnvelope();
    const sharedSessions = readMutableCaptureSessions(asMutableRecord(shared));
    if (sharedSessions.busy[session.key]) {
      throw new CaptureError('capture_submitting', 'Capture submission is already in progress');
    }
    const current = session.getSnapshot();
    const mapped = readMappedSnapshot(shared, session.key);
    if (
      !mapped ||
      mapped.lifecycle !== 'draft' ||
      mapped.snapshot.id !== current.id ||
      !sameSnapshot(mapped.snapshot, current)
    ) {
      throw new CaptureError('stale_revision', `Capture ${current.id} changed before this update`);
    }
    const next: CaptureSnapshot = {
      ...current,
      ...(patch.body === undefined ? {} : { body: patch.body }),
      ...(patch.profile === undefined ? {} : { profile: patch.profile }),
      ...(patch.fields === undefined ? {} : { fields: clone(patch.fields) }),
      ...(patch.tags === undefined ? {} : { tags: clone(patch.tags) }),
      revision: (current.revision + 1) as Revision,
      updatedAt: this.now(),
    };
    session.replaceSnapshot(next);
    this.emit();
    await this.persistDraft(next);
  }

  /** @internal */
  public async discardSession(session: CaptureSessionImpl): Promise<void> {
    if (session.isBlocked()) {
      throw new CaptureError('session_unavailable', 'This capture session needs to be reopened');
    }
    const snapshot = session.getSnapshot();
    await this.store.discard(snapshot.id, snapshot.revision);
    this.emit();

    let next: SessionAllocation;
    try {
      next = await this.allocateSession(session.key, 'auto');
    } catch (error) {
      session.blockAfterCommit();
      if (this.sessions.get(session.key) === session) {
        this.sessions.delete(session.key);
      }
      throw error;
    }
    session.replaceSnapshot(next.snapshot);
    this.emit();
  }
}

type CaptureSessionPatch = Partial<Pick<CaptureSnapshot, 'body' | 'profile' | 'fields' | 'tags'>>;

class CaptureSessionImpl implements CaptureSession {
  private snapshot: CaptureSnapshot;
  private readonly listeners = new Set<() => void>();
  private updateQueue: Promise<void> = Promise.resolve();
  private submitPromise?: Promise<SubmissionReceipt>;
  private blocked = false;

  public constructor(
    private readonly runtime: CaptureRuntime,
    public readonly key: CaptureSessionKey,
    snapshot: CaptureSnapshot,
  ) {
    this.snapshot = clone(snapshot);
  }

  public getSnapshot(): CaptureSnapshot {
    return clone(this.snapshot);
  }

  public update(patch: CaptureSessionPatch): Promise<void> {
    if (this.submitPromise) {
      return Promise.reject(new CaptureError('capture_submitting', 'Capture submission is already in progress'));
    }
    const operation = this.updateQueue.then(() => this.runtime.updateSession(this, patch));
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  public submit(keepProfile = false, options: { readonly skipAI?: boolean } = {}): Promise<SubmissionReceipt> {
    if (this.submitPromise) {
      return this.submitPromise;
    }
    if (this.blocked) {
      return Promise.reject(new CaptureError('session_unavailable', 'This capture session needs to be reopened'));
    }
    const pendingUpdates = this.updateQueue;
    const promise = this.submitAfterUpdates(pendingUpdates, keepProfile, options);
    this.submitPromise = promise;
    void promise.then(
      () => this.clearSubmitPromise(promise),
      () => this.clearSubmitPromise(promise),
    );
    return promise;
  }

  public discard(): Promise<void> {
    return this.runtime.discardSession(this);
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public replaceSnapshot(snapshot: CaptureSnapshot): void {
    this.snapshot = clone(snapshot);
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  public blockAfterCommit(): void {
    this.blocked = true;
  }

  public isBlocked(): boolean {
    return this.blocked;
  }

  private async submitAfterUpdates(
    pendingUpdates: Promise<void>,
    keepProfile: boolean,
    options: { readonly skipAI?: boolean },
  ): Promise<SubmissionReceipt> {
    await pendingUpdates.catch(() => undefined);
    if (this.blocked) {
      throw new CaptureError('session_unavailable', 'Capture session needs to be reopened');
    }
    return this.submitOnce(this.getSnapshot(), keepProfile, options);
  }

  private async submitOnce(
    frozen: CaptureSnapshot,
    keepProfile: boolean,
    options: { readonly skipAI?: boolean },
  ): Promise<SubmissionReceipt> {
    if (isBlankForSubmission(frozen.body)) {
      throw new CaptureError('blank_capture', 'A capture needs a non-blank body');
    }
    const resolved = materializeForSnapshot(frozen, this.runtimeDefaultTags());
    if (!resolved.canCapture) {
      throw new CaptureError('capture_invalid', resolved.validationErrors.map((error) => error.message).join(' '));
    }
    return this.runtime.submit(this, frozen, resolved, keepProfile, options);
  }

  private runtimeDefaultTags(): readonly string[] {
    return this.runtime.getDefaultTags();
  }

  private clearSubmitPromise(promise: Promise<SubmissionReceipt>): void {
    if (this.submitPromise === promise) {
      this.submitPromise = undefined;
    }
  }
}

function materializeForSnapshot(snapshot: CaptureSnapshot, defaultTags: readonly string[]): ProfileMaterializedCapture {
  return materializeCapture({
    body: snapshot.body,
    profile: snapshot.profile,
    fields: snapshot.fields,
    tags: snapshot.tags,
    defaultTags,
    captureId: snapshot.id,
    revision: snapshot.revision,
  });
}

function toWriterMaterialized(
  snapshot: CaptureSnapshot,
  resolved: ProfileMaterializedCapture,
): WriterMaterializedCapture {
  return {
    snapshot,
    effectiveProfile: resolved.effectiveProfile,
    properties: resolved.metadata,
    profileSchemaVersion: resolved.metadata[LETHE_FRONTMATTER_KEYS.profileSchemaVersion] as number,
    tags: resolved.tags.tags,
  };
}

function draftRecord(snapshot: CaptureSnapshot): CaptureRecord {
  return {
    recordVersion: 1,
    snapshot: clone(snapshot),
    lifecycle: 'draft',
    write: { state: 'not-started' },
    processing: { state: 'not-started' },
  };
}

function readMappedSnapshot(envelope: unknown, key: CaptureSessionKey): CaptureRecord | undefined {
  const root = isRecord(envelope) ? envelope : {};
  const sessions = isRecord(root._captureSessions) ? root._captureSessions : {};
  const mapping = isRecord(sessions.sessions) ? sessions.sessions : sessions;
  const id = typeof mapping[key] === 'string' ? mapping[key] : undefined;
  if (!id) {
    return undefined;
  }
  const store = isRecord(root._captureStore) ? root._captureStore : {};
  const captures = isRecord(store.captures) ? store.captures : {};
  const record = captures[id];
  return isRecord(record) ? (clone(record) as CaptureRecord) : undefined;
}

function readMutableCaptureSessions(root: Record<string, unknown>): CaptureSessionsState {
  const raw = isRecord(root._captureSessions) ? root._captureSessions : {};
  const mapping = isRecord(raw.sessions) ? raw.sessions : raw;
  const rawBusy = isRecord(raw.busy) ? raw.busy : {};
  const readBusy = (key: CaptureSessionKey): CaptureSessionBusy | undefined => {
    const value = rawBusy[key];
    if (!isRecord(value) || typeof value.captureId !== 'string' || !Number.isInteger(value.revision)) {
      return undefined;
    }
    return {
      captureId: value.captureId as CaptureId,
      revision: value.revision as Revision,
    };
  };
  return {
    ...raw,
    schemaVersion: 1,
    sessions: {
      main: typeof mapping.main === 'string' ? (mapping.main as CaptureId) : undefined,
      quick: typeof mapping.quick === 'string' ? (mapping.quick as CaptureId) : undefined,
    },
    busy: {
      main: readBusy('main'),
      quick: readBusy('quick'),
    },
  };
}

function readMutableCaptureStore(root: Record<string, unknown>): MutableCaptureStoreState {
  const raw = isRecord(root._captureStore) ? root._captureStore : {};
  const captures = isRecord(raw.captures) ? raw.captures : {};
  return {
    ...raw,
    schemaVersion: 1,
    captures: { ...captures } as Record<string, CaptureRecord>,
  };
}

function sameBusy(left: CaptureSessionBusy | undefined, right: CaptureSessionBusy | undefined): boolean {
  return (
    left !== undefined && right !== undefined && left.captureId === right.captureId && left.revision === right.revision
  );
}

function sameSnapshot(left: CaptureSnapshot, right: CaptureSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function serializeError(code: string, message: string, now: () => string): SerializedError {
  return { code, message, at: now() };
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
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
