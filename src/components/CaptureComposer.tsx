import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'obsidian';
import {
  composerPlaceholder,
  composerSectionOrder,
  formatCaptureAge,
  recentRowAction,
  shouldOfferKeepProfile,
  noteWriteLabel,
  type ComposerSection,
} from '../capture/composerSurface';
import type { CaptureId, CaptureRecord, CaptureSnapshot, FieldIntent, SubmissionReceipt } from '../capture/core';
import { getCaptureRuntime } from '../capture/runtimeRegistry';
import { availableNativeNoteSearch, openNativeNoteSearch, type NativeCommandRegistry } from '../capture/nativeSearch';
import {
  CAPTURE_PROFILES,
  normalizeTag,
  type CaptureProfileId,
  type ProfileFieldDescriptor,
  type ProfileFieldType,
} from '../capture/profiles';
import {
  canSkipAI,
  getSendDisabledReason,
  isOrganizationPendingStatus,
  isOrganizationRetryableStatus,
  isOrganizationUndoableStatus,
  isSubmitDisabled,
  removeComposerTag,
  organizationDecisionPreview,
  submissionWriteState,
  resolveComposerState,
  selectComposerProfile,
  type ComposerPatch,
  type OrganizationMode,
} from '../capture/composerActions';
import type { OrganizationJob } from '../organization/types';
import Editor, { type EditorRefActions } from './Editor/Editor';
import { resourceService } from '../services';
import '../less/capture-composer.less';
import { getProfileRadioNextIndex, getSendShortcutLabels } from './captureControls';

export interface CaptureComposerProps {
  readonly surface: 'main' | 'quick';
}

type CaptureRuntime = NonNullable<ReturnType<typeof getCaptureRuntime>>;
type CaptureSession = Awaited<ReturnType<CaptureRuntime['openSession']>>;
type OrganizationCaptureSession = Omit<CaptureSession, 'submit'> & {
  submit(keepProfile?: boolean, options?: { readonly skipAI?: boolean }): Promise<SubmissionReceipt>;
};
type OrganizationCaptureRuntime = CaptureRuntime & {
  retry?: (id: CaptureId) => Promise<void>;
  getOrganizationMode?: () => OrganizationMode;
  getOrganizationStatus?: (id: CaptureId) => Promise<OrganizationJob | undefined>;
  retryOrganization?: (id: CaptureId) => Promise<void>;
  skipOrganization?: (id: CaptureId) => Promise<void>;
  undoOrganization?: (id: CaptureId) => Promise<void>;
};
type ComposerState = 'loading' | 'ready' | 'error';
type DraftState = 'idle' | 'saving' | 'saved' | 'error';
type ConcreteProfileId = Exclude<CaptureProfileId, 'auto'>;

type RecentRecord = CaptureRecord;

const PROFILE_OPTIONS: readonly { id: CaptureProfileId; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'plain', label: 'Plain' },
  { id: 'book', label: 'Book' },
  { id: 'movie', label: 'Movie' },
];

const PRIMARY_FIELDS: Readonly<Record<ConcreteProfileId, readonly string[]>> = {
  plain: [],
  book: ['author', 'startDate'],
  movie: ['director', 'startDate'],
};

const CaptureComposer: React.FC<CaptureComposerProps> = ({ surface }) => {
  const [serviceState, setServiceState] = useState<ComposerState>('loading');
  const [retryOpen, setRetryOpen] = useState(0);
  const [, setSession] = useState<OrganizationCaptureSession>();
  const [snapshot, setSnapshot] = useState<CaptureSnapshot>();
  const [recent, setRecent] = useState<readonly RecentRecord[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [draftState, setDraftState] = useState<DraftState>('idle');
  const [composerError, setComposerError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [keepProfile, setKeepProfile] = useState(false);
  const [skipAI, setSkipAI] = useState(false);
  const [organizationMode, setOrganizationMode] = useState<OrganizationMode>('off');
  const [organizationStatuses, setOrganizationStatuses] = useState<
    Readonly<Record<string, OrganizationJob | undefined>>
  >({});
  const [moreFieldsOpen, setMoreFieldsOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<SubmissionReceipt>();

  const [busyReceiptId, setBusyReceiptId] = useState<string>();
  const [nativeSearchUnavailable, setNativeSearchUnavailable] = useState(false);

  const editorRef = useRef<EditorRefActions>(null);
  const profileButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const sessionRef = useRef<OrganizationCaptureSession>();
  const runtimeRef = useRef<OrganizationCaptureRuntime>();
  const sessionIdRef = useRef<string>();
  const updateSequenceRef = useRef(0);
  const isSubmittingRef = useRef(false);
  const mountedRef = useRef(false);
  const recentRefreshSequenceRef = useRef(0);

  const refreshRecent = useCallback(async (): Promise<void> => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const sequence = recentRefreshSequenceRef.current + 1;
    recentRefreshSequenceRef.current = sequence;
    try {
      const records = (await runtime.recent()).slice(0, 8);
      const statusEntries = await Promise.all(
        records.map(async (record): Promise<readonly [string, OrganizationJob | undefined]> => {
          if (runtime.getOrganizationStatus === undefined) {
            return [record.snapshot.id, undefined];
          }
          try {
            return [record.snapshot.id, await runtime.getOrganizationStatus(record.snapshot.id)];
          } catch {
            return [record.snapshot.id, undefined];
          }
        }),
      );
      if (!mountedRef.current || sequence !== recentRefreshSequenceRef.current || runtimeRef.current !== runtime)
        return;

      const nextStatuses: Record<string, OrganizationJob | undefined> = {};
      for (const [captureId, job] of statusEntries) {
        nextStatuses[captureId] = job;
      }
      setRecent(records);
      setOrganizationStatuses(nextStatuses);
    } catch {
      // A receipt refresh should not replace the active draft or block writing.
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribeSession: (() => void) | undefined;
    let unsubscribeRuntime: (() => void) | undefined;
    mountedRef.current = true;

    const open = async (): Promise<void> => {
      setServiceState('loading');
      setComposerError(undefined);
      const runtime = getCaptureRuntime() as unknown as OrganizationCaptureRuntime | undefined;
      if (!runtime) {
        if (!disposed) {
          setServiceState('error');
          setComposerError('Capture service is unavailable. Your draft cannot be saved yet.');
        }
        return;
      }

      runtimeRef.current = runtime;
      try {
        const nextSession = await runtime.openSession(surface);
        if (disposed) return;

        const organizationSession = nextSession as OrganizationCaptureSession;
        sessionRef.current = organizationSession;
        setSession(organizationSession);
        const initialSnapshot = nextSession.getSnapshot();
        sessionIdRef.current = initialSnapshot.id;
        setSnapshot(initialSnapshot);
        if (!disposed) {
          setOrganizationMode(readOrganizationMode(runtime));
        }

        unsubscribeSession = nextSession.subscribe(() => {
          if (disposed) return;
          const nextSnapshot = nextSession.getSnapshot();
          if (nextSnapshot.id !== sessionIdRef.current) {
            sessionIdRef.current = nextSnapshot.id;
            setIsComposing(false);
          }
          setSnapshot(nextSnapshot);
        });
        unsubscribeRuntime = runtime.subscribe(() => {
          if (disposed || !mountedRef.current) return;
          setOrganizationMode(readOrganizationMode(runtime));
          void refreshRecent();
        });

        await refreshRecent();
        if (!disposed) {
          setServiceState('ready');
        }
      } catch (error) {
        if (!disposed) {
          setServiceState('error');
          setComposerError(errorMessage(error, 'Capture service could not open a draft.'));
        }
      }
    };

    void open();
    return () => {
      disposed = true;
      mountedRef.current = false;
      recentRefreshSequenceRef.current += 1;
      unsubscribeSession?.();
      unsubscribeRuntime?.();
      sessionRef.current = undefined;
      runtimeRef.current = undefined;
    };
  }, [refreshRecent, retryOpen, surface]);

  const snapshotId = snapshot?.id;

  useEffect(() => {
    if (snapshotId) setSkipAI(false);
  }, [snapshotId]);

  useEffect(() => {
    if (snapshotId && serviceState === 'ready' && !isSubmitting) {
      editorRef.current?.focus();
    }
  }, [snapshotId, serviceState, isSubmitting]);

  useEffect(() => {
    if (!canSkipAI(organizationMode)) {
      setSkipAI(false);
    }
  }, [organizationMode]);

  const updateSession = useCallback((patch: ComposerPatch): void => {
    if (isSubmittingRef.current) return;
    const activeSession = sessionRef.current;
    if (!activeSession) return;

    const sequence = updateSequenceRef.current + 1;
    updateSequenceRef.current = sequence;
    const sessionId = sessionIdRef.current;
    setDraftState('saving');
    setComposerError(undefined);
    setLastReceipt(undefined);

    void activeSession.update(patch).then(
      () => {
        if (sequence === updateSequenceRef.current && sessionId === sessionIdRef.current) {
          setDraftState('saved');
        }
      },
      (error: unknown) => {
        if (sequence === updateSequenceRef.current && sessionId === sessionIdRef.current) {
          setDraftState('error');
          setComposerError(errorMessage(error, 'Draft could not be saved.'));
        }
      },
    );
  }, []);

  const handleBodyChange = useCallback(
    (body: string): void => {
      updateSession({ body });
    },
    [updateSession],
  );

  const handleSubmit = useCallback(
    async (content: string): Promise<void> => {
      const activeSession = sessionRef.current;
      const currentSnapshot = activeSession?.getSnapshot();
      if (
        !activeSession ||
        !currentSnapshot ||
        isSubmitDisabled(content, isSubmittingRef.current, isComposing, pendingUploads > 0)
      ) {
        return;
      }

      const submittedId = currentSnapshot.id;
      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setDraftState('saving');
      setComposerError(undefined);

      try {
        // CM6 is locked before this callback runs. Reconcile only the final
        // document text that was read after that lock, then freeze it in submit.
        if (content !== currentSnapshot.body) {
          await activeSession.update({ body: content });
        }
        const receipt = await activeSession.submit(keepProfile, { skipAI });
        const nextSnapshot = activeSession.getSnapshot();
        setSnapshot(nextSnapshot);
        setLastReceipt(receipt);

        setSkipAI(false);
        setDraftState('saved');
        if (nextSnapshot.id !== submittedId) {
          sessionIdRef.current = nextSnapshot.id;
        }
        await refreshRecent();
      } catch (error) {
        setDraftState('error');
        setComposerError(errorMessage(error, 'Capture could not be saved. Your draft is still here.'));
        throw error;
      } finally {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
      }
    },
    [isComposing, keepProfile, pendingUploads, refreshRecent, skipAI],
  );

  const handleAttachment = useCallback(async (file: File): Promise<void> => {
    if (isSubmittingRef.current || !file.type.startsWith('image')) return;
    const originSessionId = sessionIdRef.current;
    if (!originSessionId) return;

    setPendingUploads((count) => count + 1);
    setComposerError(undefined);
    try {
      const image = await resourceService.upload(file);
      if (image && originSessionId === sessionIdRef.current) {
        editorRef.current?.insertText(`${image}`);
      }
    } catch (error) {
      if (originSessionId === sessionIdRef.current) {
        setDraftState('error');
        setComposerError(errorMessage(error, 'Image upload failed. The draft was not changed.'));
      }
    } finally {
      setPendingUploads((count) => Math.max(0, count - 1));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent): void => {
      if (isSubmittingRef.current) {
        event.preventDefault();
        return;
      }
      const file = event.clipboardData?.files.item(0);
      if (file) void handleAttachment(file);
    },
    [handleAttachment],
  );

  const handleDrop = useCallback(
    (event: DragEvent): void => {
      if (isSubmittingRef.current) {
        event.preventDefault();
        return;
      }
      const file = event.dataTransfer?.files.item(0);
      if (file) void handleAttachment(file);
    },
    [handleAttachment],
  );

  const handleFieldChange = useCallback(
    (field: ProfileFieldDescriptor, value: string): void => {
      if (isSubmittingRef.current) return;
      const currentSnapshot = sessionRef.current?.getSnapshot();
      if (!currentSnapshot) return;
      const fields = {
        ...currentSnapshot.fields,
        [field.id]: toFieldIntent(field.type, value),
      };
      updateSession({ fields });
    },
    [updateSession],
  );

  const handleTagInput = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (isSubmittingRef.current) return;
      if (event.nativeEvent.isComposing || event.keyCode === 229 || event.which === 229) return;
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const input = event.currentTarget;
      const tag = normalizeTag(input.value);
      if (!tag) return;

      const currentSnapshot = sessionRef.current?.getSnapshot();
      if (!currentSnapshot || currentSnapshot.tags.userAdded.includes(tag)) {
        input.value = '';
        return;
      }
      updateSession({
        tags: {
          userAdded: [...currentSnapshot.tags.userAdded, tag],
          userRemoved: currentSnapshot.tags.userRemoved.filter((removed) => removed !== tag),
        },
      });
      input.value = '';
    },
    [updateSession],
  );

  const removeTag = useCallback(
    (tag: string): void => {
      if (isSubmittingRef.current) return;
      const currentSnapshot = sessionRef.current?.getSnapshot();
      if (!currentSnapshot) return;
      updateSession({ tags: removeComposerTag(currentSnapshot.tags, tag) });
    },
    [updateSession],
  );

  const handleOpen = useCallback(async (record: RecentRecord): Promise<void> => {
    const runtime = runtimeRef.current;
    if (isSubmittingRef.current || !runtime || record.write.state !== 'written') return;
    setBusyReceiptId(record.snapshot.id);
    setOperationError(undefined);
    try {
      await runtime.openNote(record.snapshot.id);
    } catch (error) {
      setOperationError(errorMessage(error, 'The note could not be opened.'));
    } finally {
      setBusyReceiptId(undefined);
    }
  }, []);

  const handleOrganizationAction = useCallback(
    async (record: RecentRecord, action: 'retry' | 'skip' | 'undo'): Promise<void> => {
      const runtime = runtimeRef.current;
      const job = organizationStatuses[record.snapshot.id];
      if (isSubmittingRef.current || !runtime || !job) return;
      if (
        (action === 'retry' &&
          (!isOrganizationRetryableStatus(job.status) || runtime.retryOrganization === undefined)) ||
        (action === 'skip' && (!isOrganizationPendingStatus(job.status) || runtime.skipOrganization === undefined)) ||
        (action === 'undo' && (!isOrganizationUndoableStatus(job.status) || runtime.undoOrganization === undefined))
      ) {
        return;
      }

      setBusyReceiptId(record.snapshot.id);
      setOperationError(undefined);
      try {
        if (action === 'retry') {
          await runtime.retryOrganization(record.snapshot.id);
        } else if (action === 'skip') {
          await runtime.skipOrganization(record.snapshot.id);
        } else {
          await runtime.undoOrganization(record.snapshot.id);
        }
        await refreshRecent();
      } catch (error) {
        if (mountedRef.current) {
          setOperationError(errorMessage(error, `Organization ${action} could not be completed.`));
        }
      } finally {
        if (mountedRef.current) {
          setBusyReceiptId(undefined);
        }
      }
    },
    [organizationStatuses, refreshRecent],
  );

  const handleRowAction = useCallback(
    async (record: RecentRecord, action: 'retry' | 'skip' | 'undo'): Promise<void> => {
      const writeNeedsRetry = record.write.state === 'failed' || record.write.state === 'pending';
      if (action === 'retry' && writeNeedsRetry) {
        const runtime = runtimeRef.current;
        if (isSubmittingRef.current || runtime?.retry === undefined) return;
        setBusyReceiptId(record.snapshot.id);
        setOperationError(undefined);
        try {
          await runtime.retry(record.snapshot.id);
          await refreshRecent();
        } catch (error) {
          if (mountedRef.current) {
            setOperationError(errorMessage(error, 'The capture could not be retried.'));
          }
        } finally {
          if (mountedRef.current) setBusyReceiptId(undefined);
        }
        return;
      }
      await handleOrganizationAction(record, action);
    },
    [handleOrganizationAction, refreshRecent],
  );

  const openReceipt = useCallback(
    async (receipt: SubmissionReceipt): Promise<void> => {
      if (submissionWriteState(receipt, recent) !== 'written') return;
      const runtime = runtimeRef.current;
      if (isSubmittingRef.current || !runtime) return;
      setOperationError(undefined);
      try {
        await runtime.openNote(receipt.captureId);
      } catch (error) {
        setOperationError(errorMessage(error, 'The note could not be opened.'));
      }
    },
    [recent],
  );

  const composerState = snapshot
    ? resolveComposerState(snapshot, runtimeRef.current?.getDefaultTags() ?? [])
    : undefined;
  const activeProfile = composerState?.profile.effectiveProfile;
  const selectedProfile = composerState?.selectedProfile;
  const selectedProfileIndex = PROFILE_OPTIONS.findIndex((option) => option.id === selectedProfile);
  const sendShortcut = getSendShortcutLabels(Platform.isMacOS);
  const resolvedTags = composerState?.tags;
  const profileFields = activeProfile ? CAPTURE_PROFILES[activeProfile].uiFields : [];
  const primaryFields = activeProfile
    ? PRIMARY_FIELDS[activeProfile]
        .map((fieldId) => profileFields.find((field) => field.id === fieldId))
        .filter((field): field is ProfileFieldDescriptor => field !== undefined)
    : [];
  const additionalFields = profileFields.filter(
    (field) => !PRIMARY_FIELDS[activeProfile ?? 'plain'].includes(field.id),
  );
  const canSubmit = Boolean(
    snapshot && !isSubmitDisabled(snapshot.body, isSubmitting, isComposing, pendingUploads > 0),
  );
  const sendDisabledReason = snapshot
    ? getSendDisabledReason(snapshot.body, isSubmitting, isComposing, pendingUploads > 0)
    : undefined;

  const editor = snapshot ? (
    <Editor
      key={snapshot.id}
      ref={editorRef}
      className="capture-composer__editor"
      inputerType={`capture-${surface}`}
      initialContent={snapshot.body}
      placeholder={composerPlaceholder(Platform.isMacOS)}
      showConfirmBtn={false}
      showCancelBtn={false}
      showTools={false}
      clearOnConfirm={false}
      useContentCache={false}
      focusOnMount
      isSubmitting={isSubmitting}
      isComposing={isComposing}
      onConfirmBtnClick={handleSubmit}
      onCancelBtnClick={() => undefined}
      onContentChange={handleBodyChange}
      onCompositionChange={setIsComposing}
      onPaste={handlePaste}
      onDrop={handleDrop}
    />
  ) : null;

  const showReceipt = Boolean(lastReceipt && snapshot && snapshot.body.trim() === '');
  const latestReceiptState = submissionWriteState(lastReceipt, recent);
  const offerKeepProfile = shouldOfferKeepProfile(activeProfile);
  const nativeCommands =
    typeof app === 'undefined' ? undefined : (app as unknown as { commands: NativeCommandRegistry }).commands;
  const nativeSearchCommand = nativeCommands ? availableNativeNoteSearch(nativeCommands) : undefined;
  const sections: Partial<Record<ComposerSection | 'profile' | 'fields' | 'tags', React.ReactNode>> = {
    details: null,
    editor: <div className="capture-composer__body">{editor}</div>,
    action: (
      <footer className="capture-composer__footer">
        <div
          className={`capture-composer__status${draftState === 'error' ? ' capture-composer__status--error' : ''}`}
          role="status"
          aria-live="polite"
        >
          {pendingUploads > 0 && 'Uploading image…'}
          {pendingUploads === 0 && (draftState === 'saving' || isSubmitting) && 'Saving capture'}
          {pendingUploads === 0 && draftState === 'error' && composerError}
          {pendingUploads === 0 && draftState !== 'error' && !isSubmitting && showReceipt && lastReceipt && (
            <>
              <span>{latestReceiptState ? noteWriteLabel(latestReceiptState) : 'Queued'}</span>
              {latestReceiptState === 'written' && (
                <button
                  type="button"
                  className="capture-composer__receipt-open"
                  onClick={() => void openReceipt(lastReceipt)}
                >
                  Open note
                </button>
              )}
            </>
          )}
          {pendingUploads === 0 && draftState !== 'error' && !isSubmitting && !showReceipt && sendDisabledReason}
        </div>
        <button
          type="button"
          className="capture-composer__send"
          disabled={!canSubmit}
          onClick={() => void editorRef.current?.confirm()}
          title={sendShortcut.title}
          aria-describedby={sendDisabledReason ? `capture-composer-send-hint-${surface}` : undefined}
        >
          Send
        </button>
        {sendDisabledReason && (
          <span id={`capture-composer-send-hint-${surface}`} className="capture-composer__send-hint sr-only">
            {sendDisabledReason}
          </span>
        )}
      </footer>
    ),
    profile: (
      <div className="capture-composer__profile-row">
        <div role="radiogroup" aria-label="Capture profile">
          {PROFILE_OPTIONS.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selectedProfile === option.id}
              tabIndex={selectedProfile === option.id ? 0 : -1}
              className={`capture-composer__profile ${selectedProfile === option.id ? 'is-active' : ''}`}
              disabled={isSubmitting}
              ref={(element) => {
                profileButtonRefs.current[index] = element;
              }}
              onKeyDown={(event) => {
                const nextIndex = getProfileRadioNextIndex(selectedProfileIndex, event.key, PROFILE_OPTIONS.length);
                if (nextIndex === undefined) return;
                event.preventDefault();
                const nextOption = PROFILE_OPTIONS[nextIndex];
                const current = sessionRef.current?.getSnapshot();
                if (current) updateSession(selectComposerProfile(current.tags, nextOption.id));
                profileButtonRefs.current[nextIndex]?.focus();
              }}
              onClick={() => {
                const current = sessionRef.current?.getSnapshot();
                if (current) updateSession(selectComposerProfile(current.tags, option.id));
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="capture-composer__section-button"
          aria-expanded={tagsOpen}
          disabled={isSubmitting}
          onClick={() => setTagsOpen((open) => !open)}
        >
          Tags
        </button>
      </div>
    ),
    fields: (
      <>
        {primaryFields.length > 0 && (
          <div className="capture-composer__fields capture-composer__fields--primary">
            {primaryFields.map((field) => renderField(field, snapshot!, handleFieldChange, isSubmitting))}
          </div>
        )}
        {additionalFields.length > 0 && (
          <div className="capture-composer__progressive-section">
            <button
              type="button"
              className="capture-composer__section-button"
              aria-expanded={moreFieldsOpen}
              disabled={isSubmitting}
              onClick={() => setMoreFieldsOpen((open) => !open)}
            >
              More fields <span aria-hidden="true">{moreFieldsOpen ? '−' : '+'}</span>
            </button>
            {moreFieldsOpen && (
              <div className="capture-composer__fields capture-composer__fields--additional">
                {additionalFields.map((field) => renderField(field, snapshot!, handleFieldChange, isSubmitting))}
              </div>
            )}
          </div>
        )}
      </>
    ),
    tags: tagsOpen ? (
      <div className="capture-composer__tags">
        <div className="capture-composer__tag-list">
          {(resolvedTags?.bindings ?? []).map((binding) => (
            <span className="capture-composer__tag" key={`${binding.source}-${binding.tag}`}>
              #{binding.tag}
              <button
                type="button"
                onClick={() => removeTag(binding.tag)}
                disabled={isSubmitting}
                aria-label={`Remove tag ${binding.tag}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <input
          type="text"
          className="capture-composer__tag-input"
          placeholder="Add a tag and press Enter"
          aria-label="Add tag"
          disabled={isSubmitting}
          onKeyDown={handleTagInput}
        />
      </div>
    ) : null,
    recent: (
      <section className="capture-composer__recent" aria-label="Recent captures">
        <header className="capture-composer__recent-header">
          <h2>Recent captures</h2>
          {nativeSearchCommand && (
            <button
              type="button"
              className="capture-composer__quiet-button"
              onClick={() => {
                const opened = nativeCommands ? openNativeNoteSearch(nativeCommands) : false;
                setNativeSearchUnavailable(!opened);
              }}
            >
              {nativeSearchCommand === 'global-search:open' ? 'Search notes' : 'Find a note'}
            </button>
          )}
          {!nativeSearchCommand && (
            <span className="capture-composer__search-unavailable">
              Obsidian Search is unavailable. Enable the core Search plugin to search notes.
            </span>
          )}
          {nativeSearchUnavailable && (
            <span className="capture-composer__search-unavailable" role="status">
              Obsidian could not open note search.
            </span>
          )}
        </header>
        <ul>
          {recent.map((record) => {
            const isBusy = busyReceiptId === record.snapshot.id;
            const organizationJob = organizationStatuses[record.snapshot.id];
            const action = recentRowAction(record.write.state, organizationJob?.status);
            const preview = organizationDecisionPreview(organizationJob);
            const age = formatCaptureAge(record.snapshot.createdAt, new Date());
            const canOpen = record.write.state === 'written' && !isBusy && !isSubmitting;
            return (
              <li key={`${record.snapshot.id}-${record.submittedRevision ?? record.snapshot.revision}`}>
                <button
                  type="button"
                  className="capture-composer__recent-open"
                  disabled={!canOpen}
                  onClick={() => void handleOpen(record)}
                >
                  <span className="capture-composer__recent-title">{previewBody(record.snapshot.body)}</span>
                  {record.write.state === 'written' && record.write.note?.path && (
                    <span className="capture-composer__recent-path">{record.write.note.path}</span>
                  )}
                  <span className="capture-composer__recent-meta">
                    {noteWriteLabel(record.write.state)} · {age}
                    {preview && (
                      <span className="capture-composer__organization-preview">
                        Proposed
                        {preview.profile && ` · ${preview.profile}`}
                        {preview.tags.length > 0 && ` · ${preview.tags.map((tag) => `#${tag}`).join(' ')}`}
                      </span>
                    )}
                  </span>
                </button>
                {action && (
                  <button
                    type="button"
                    className="capture-composer__recent-action-button"
                    disabled={isBusy || isSubmitting}
                    onClick={() => void handleRowAction(record, action)}
                  >
                    {action === 'retry' ? 'Retry' : action === 'skip' ? 'Skip' : 'Undo'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    ),
  };

  sections.details = (
    <details className="capture-composer__details">
      <summary>Details</summary>
      <div className="capture-composer__details-content">
        {sections.profile}
        {sections.fields}
        {sections.tags}
        {(offerKeepProfile || canSkipAI(organizationMode)) && (
          <div className="capture-composer__preferences">
            {offerKeepProfile && (
              <label className="capture-composer__keep-profile">
                <input
                  type="checkbox"
                  checked={keepProfile}
                  disabled={isSubmitting}
                  onChange={(event) => setKeepProfile(event.target.checked)}
                />
                Keep profile
              </label>
            )}
            {canSkipAI(organizationMode) && (
              <label className="capture-composer__skip-ai" title="Skip AI organization for this capture">
                <input
                  type="checkbox"
                  checked={skipAI}
                  disabled={isSubmitting}
                  aria-label="Skip AI organization for this capture"
                  onChange={(event) => setSkipAI(event.target.checked)}
                />
                Skip AI
              </label>
            )}
          </div>
        )}
      </div>
    </details>
  );

  return (
    <section className={`capture-composer capture-composer--${surface}`} aria-label="Capture composer">
      {serviceState === 'loading' && <p className="capture-composer__service-state">Opening your draft…</p>}
      {serviceState === 'error' && (
        <div className="capture-composer__service-state capture-composer__service-state--error" role="alert">
          <p>{composerError}</p>
          <button
            type="button"
            className="capture-composer__quiet-button"
            onClick={() => setRetryOpen((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      )}

      {serviceState === 'ready' && snapshot && (
        <>
          {operationError && (
            <p className="capture-composer__operation-error" role="alert">
              {operationError}
            </p>
          )}
          {composerSectionOrder(surface).map((section) => (
            <React.Fragment key={section}>{sections[section]}</React.Fragment>
          ))}
        </>
      )}
    </section>
  );
};

function renderField(
  field: ProfileFieldDescriptor,
  snapshot: CaptureSnapshot,
  onChange: (field: ProfileFieldDescriptor, value: string) => void,
  disabled: boolean,
): React.ReactElement {
  return (
    <label className="capture-composer__field" key={field.id}>
      <span>{field.label}</span>
      <input
        type={inputType(field.type)}
        value={fieldInputValue(snapshot.fields[field.id])}
        onChange={(event) => onChange(field, event.target.value)}
        placeholder={field.label}
        disabled={disabled}
      />
    </label>
  );
}

function inputType(type: ProfileFieldType): 'text' | 'date' | 'number' | 'url' {
  if (type === 'date' || type === 'number' || type === 'url') return type;
  return 'text';
}

function fieldInputValue(intent: FieldIntent | undefined): string {
  if (!intent || intent.state === 'cleared') return '';
  return Array.isArray(intent.value) ? intent.value.join(', ') : String(intent.value);
}

function toFieldIntent(type: ProfileFieldType, value: string): FieldIntent {
  if (value.trim() === '') return { state: 'cleared' };
  if (type === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? { state: 'set', value: number } : { state: 'set', value };
  }
  if (type === 'text[]') {
    return {
      state: 'set',
      value: value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    };
  }
  return { state: 'set', value };
}

function previewBody(body: string): string {
  return (
    body
      .split(/\r?\n/u)
      .find((line) => line.trim() !== '')
      ?.trim() || 'Untitled capture'
  );
}

function readOrganizationMode(runtime: OrganizationCaptureRuntime): OrganizationMode {
  try {
    return runtime.getOrganizationMode?.() ?? 'off';
  } catch {
    return 'off';
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default CaptureComposer;
