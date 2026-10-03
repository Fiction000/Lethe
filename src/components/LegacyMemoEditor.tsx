import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import appContext from '../stores/appContext';
import { dailyNotesService, globalStateService, locationService, memoService, resourceService } from '../services';
import utils from '../helpers/utils';
import { storage } from '../helpers/storage';
import Editor, { EditorRefActions } from './Editor/Editor';
import '../less/memo-editor.less';
import '../less/select-date-picker.less';
import { usePopper } from 'react-popper';
import useState from 'react-usestateref';
import DatePicker from './common/DatePicker';
import { TagInput } from './common/TagInput';
import { moment, Notice, Platform } from 'obsidian';
import { DefaultPrefix, DefaultTag, FocusOnEditor, MemoStorageMode } from '../memos';
import {
  createLegacyCaptureOrigin,
  createLegacyEditorScope,
  LegacyCaptureActions,
  normalizeLegacyContent,
  type LegacyUploadToken,
} from '../capture/legacyCaptureActions';

interface Props {
  /** Quick Capture must never participate in the main editor's edit flow. */
  forceNew?: boolean;
}

let positionX = 0;

const LegacyMemoEditor: React.FC<Props> = ({ forceNew = false }) => {
  const { globalState } = useContext(appContext);
  const app = dailyNotesService.getState()?.app;
  const scope = useMemo(() => createLegacyEditorScope(forceNew), [forceNew]);
  const sharedEditMemoId = forceNew ? '' : globalState.editMemoId;
  const sharedMarkMemoId = forceNew ? '' : globalState.markMemoId;
  const currentOrigin = useMemo(
    () => createLegacyCaptureOrigin(forceNew, sharedEditMemoId),
    [forceNew, sharedEditMemoId],
  );

  const [isEditorShown] = useState(false);
  const [isListShown, setIsListShown] = useState(DefaultPrefix !== 'List');

  const editorRef = useRef<EditorRefActions>(null);
  const prevEditMemoIdRef = useRef('');
  const mountedRef = useRef(true);
  const captureActionsRef = useRef<LegacyCaptureActions>();
  if (!captureActionsRef.current) {
    captureActionsRef.current = new LegacyCaptureActions(currentOrigin);
  }
  const captureActions = captureActionsRef.current;
  const [captureSnapshot, setCaptureSnapshot] = useState(captureActions.snapshot());

  const [isDatePickerOpen, setIsDatePickerOpen] = useState(false);

  const popperRef = useRef<HTMLDivElement>(null);
  const [popperElement, setPopperElement] = useState<HTMLDivElement | null>(null);
  const [currentDateStamp] = useState(parseInt(moment().format('x')));
  const defaultTags = useMemo(() => (DefaultTag ? [DefaultTag] : []), []);
  const [selectedTags, setSelectedTags] = useState<string[]>(defaultTags);

  useEffect(() => {
    const unsubscribe = captureActions.subscribe(() => {
      if (mountedRef.current) {
        setCaptureSnapshot(captureActions.snapshot());
      }
    });

    return () => {
      mountedRef.current = false;
      captureActions.dispose();
      unsubscribe();
    };
  }, [captureActions]);

  useEffect(() => {
    if (!editorRef.current) return;
    if (FocusOnEditor) {
      editorRef.current.focus();
    }
  }, []);

  // Change Date Picker Popper Position. Keep the hook unconditional so the
  // legacy component remains safe when the viewport changes.
  const selectorPopupWidth = 280;
  const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth;
  const mobilePlacement: 'right-end' | 'left-end' | 'bottom' =
    viewportWidth - positionX > selectorPopupWidth * 1.2
      ? 'right-end'
      : viewportWidth - positionX < selectorPopupWidth && viewportWidth > selectorPopupWidth * 1.5
      ? 'left-end'
      : 'bottom';
  const popper = usePopper(popperRef.current, popperElement, {
    placement: Platform.isMobile ? mobilePlacement : 'right-end',
    modifiers: [
      {
        name: 'flip',
        options: {
          allowedAutoPlacements: ['bottom', 'left-end', 'right-end'],
          rootBoundary: 'document',
        },
      },
      { name: 'preventOverflow', options: { rootBoundary: 'document' } },
    ],
  });

  const closePopper = () => {
    setIsDatePickerOpen(false);
  };

  useEffect(() => {
    captureActions.setOrigin(currentOrigin);

    if (scope.usesSharedMarkMemoId && sharedMarkMemoId) {
      const editorCurrentValue = editorRef.current?.getContent();
      const memoLinkText = `${editorCurrentValue ? '\n' : ''}MARK: [@MEMO](${sharedMarkMemoId})`;
      editorRef.current?.insertText(memoLinkText);
      globalStateService.setMarkMemoId('');
    }

    const previousEditMemoId = prevEditMemoIdRef.current;
    if (scope.usesSharedEditMemoId && sharedEditMemoId && sharedEditMemoId !== previousEditMemoId) {
      const editMemo = memoService.getMemoById(sharedEditMemoId);
      if (editMemo) {
        editorRef.current?.setContent(editMemo.content.replace(/<br>/g, '\n').replace(/ \^\S{6}$/, '') ?? '');
        setSelectedTags(editMemo.tags || []);
        editorRef.current?.focus();
      }
    }

    prevEditMemoIdRef.current = sharedEditMemoId;
  }, [captureActions, currentOrigin, scope, sharedEditMemoId, sharedMarkMemoId]);

  const handleUploadFile = useCallback(
    async (file: File, token: LegacyUploadToken) => {
      const { type } = file;
      if (!type.startsWith('image')) return;
      try {
        const image = await resourceService.upload(file);
        if (!captureActions.completeUpload(token) || !mountedRef.current) return;
        if (image) {
          editorRef.current?.insertText(`${image}`);
        }
      } catch (error: any) {
        if (captureActions.failUpload(token)) {
          new Notice(error);
        }
      }
    },
    [captureActions],
  );

  const startUpload = useCallback(
    (file: File) => {
      if (!file.type.startsWith('image')) return;
      const token = captureActions.beginUpload(currentOrigin);
      if (!token) return;
      void handleUploadFile(file, token);
    },
    [captureActions, currentOrigin, handleUploadFile],
  );

  // Paste handler passed to Editor → CMEditor
  const handlePasteEvent = useCallback(
    (event: ClipboardEvent) => {
      if (event.clipboardData && event.clipboardData.files.length > 0) {
        const file = event.clipboardData.files[0];
        event.preventDefault();
        startUpload(file);
      }
    },
    [startUpload],
  );

  // Drop handler passed to Editor → CMEditor
  const handleDropEvent = useCallback(
    (event: DragEvent) => {
      if (event.dataTransfer && event.dataTransfer.files.length > 0) {
        const file = event.dataTransfer.files[0];
        event.preventDefault();
        startUpload(file);
      }
    },
    [startUpload],
  );

  const clearEditor = useCallback(() => {
    if (scope.usesSharedContentCache) {
      setEditorContentCache('');
    }
    editorRef.current?.setContent('');
  }, [scope.usesSharedContentCache]);

  const handleSaveBtnClick = useCallback(
    async (content: string) => {
      if (content === '') {
        new Notice('Content cannot be empty');
        return;
      }

      captureActions.setOrigin(currentOrigin);
      if (!captureActions.beginSubmit()) return;

      const editMemoId = scope.usesSharedEditMemoId ? globalStateService.getState().editMemoId : '';
      content = normalizeLegacyContent(content);

      try {
        if (editMemoId) {
          const prevMemo = memoService.getMemoById(editMemoId);
          if (!prevMemo) {
            throw new Error('Memo not found');
          }
          content = content + (prevMemo.hasId === '' ? '' : ' ^' + prevMemo.hasId);
          if (prevMemo.content !== content) {
            const editedMemo = await memoService.updateMemo(
              prevMemo.id,
              prevMemo.content,
              content,
              prevMemo.memoType,
              prevMemo.path,
              selectedTags,
            );
            editedMemo.updatedAt = utils.getDateTimeString(Date.now());
            memoService.editMemo(editedMemo);
          }
          if (scope.usesSharedEditMemoId) {
            globalStateService.setEditMemoId('');
          }
          setSelectedTags(defaultTags);
          clearEditor();
        } else {
          const newMemo = await memoService.createMemo(content, isListShown, selectedTags);
          memoService.pushMemo(newMemo);
          if (scope.usesSharedEditMemoId) {
            locationService.clearQuery();
          }
          clearEditor();
        }
      } catch (error: any) {
        new Notice(error.message);
        throw error;
      } finally {
        captureActions.finishSubmit();
      }
    },
    [captureActions, clearEditor, currentOrigin, defaultTags, isListShown, scope, selectedTags],
  );

  const handleCancelBtnClick = useCallback(() => {
    if (!captureActions.cancel()) return;
    if (scope.usesSharedEditMemoId) {
      globalStateService.setEditMemoId('');
    }
    clearEditor();
  }, [captureActions, clearEditor, scope.usesSharedEditMemoId]);

  const updateDateSelectorPopupPosition = useCallback(() => {
    if (!editorRef.current || !popperRef.current || !app) return;

    const el = editorRef.current.element;
    if (!el) return;

    // Use the editor element's position as base
    const editorRect = el.getBoundingClientRect();
    const x = editorRect.left;
    const y = editorRect.top;

    const seletorPopupWidth = 280;
    let left: number;
    let top: number;

    if (!Platform.isMobile) {
      left = x + 18;
      top = y + 34;
    } else {
      if (window.innerWidth - x > seletorPopupWidth) {
        left = x + 18;
      } else if (window.innerWidth - x < seletorPopupWidth) {
        left = x + 34;
      } else {
        left = el.clientWidth / 2;
      }
      top = window.innerWidth <= 875 ? y + 36 : y + 34;
    }

    positionX = x;
    popperRef.current.style.left = `${left}px`;
    popperRef.current.style.top = `${top}px`;
  }, [app]);

  const handleContentChange = useCallback(
    (content: string) => {
      if (scope.usesSharedContentCache) {
        setEditorContentCache(content);
      }

      if (!editorRef.current) return;

      const cursorPos = editorRef.current.getCursorPosition();
      const prevString = content.slice(0, cursorPos);
      const nextString = content.slice(cursorPos);

      if (
        (prevString.endsWith('@') || prevString.endsWith('📆')) &&
        (nextString.startsWith(' ') || nextString === '')
      ) {
        updateDateSelectorPopupPosition();
        setIsDatePickerOpen(true);
      } else {
        setIsDatePickerOpen(false);
      }
    },
    [scope.usesSharedContentCache, updateDateSelectorPopupPosition],
  );

  const handleDateInsertTrigger = (date: number) => {
    if (!editorRef.current) return;

    if (date) {
      closePopper();
      setIsListShown(true);
    }

    const currentValue = editorRef.current.getContent();
    const cursorPos = editorRef.current.getCursorPosition();
    const prevString = currentValue.slice(0, cursorPos);
    const nextString = currentValue.slice(cursorPos);
    const todayMoment = moment(date);

    if (!prevString.endsWith('@')) {
      // Insert date at cursor
      const dateStr = todayMoment.format('YYYY-MM-DD');
      const newContent = prevString + dateStr + nextString;
      editorRef.current.setContent(newContent);
      editorRef.current.focus();
      handleContentChange(newContent);
    } else {
      // Replace @ with 📆date format
      const dateStr = '📆' + todayMoment.format('YYYY-MM-DD');
      const newContent = currentValue.slice(0, cursorPos - 1) + dateStr + nextString;
      editorRef.current.setContent(newContent);
      editorRef.current.focus();
      handleContentChange(newContent);
    }
  };

  const showEditStatus = scope.usesSharedEditMemoId && Boolean(sharedEditMemoId);
  const isSubmitting = captureSnapshot.pendingUploads > 0 || captureSnapshot.submitting;

  const editorConfig = useMemo(
    () => ({
      className: 'memo-editor',
      inputerType: 'memo',
      initialContent: scope.usesSharedContentCache ? getEditorContentCache() : '',
      placeholder: 'What do you think now...',
      showConfirmBtn: true,
      showCancelBtn: showEditStatus,
      showTools: true,
      clearOnConfirm: false,
      useContentCache: scope.usesSharedContentCache,
      isSubmitting,
      onConfirmBtnClick: handleSaveBtnClick,
      onCancelBtnClick: handleCancelBtnClick,
      onContentChange: handleContentChange,
      onPaste: handlePasteEvent,
      onDrop: handleDropEvent,
    }),
    [
      handleCancelBtnClick,
      handleContentChange,
      handleDropEvent,
      handlePasteEvent,
      handleSaveBtnClick,
      isSubmitting,
      scope.usesSharedContentCache,
      showEditStatus,
    ],
  );

  return (
    <div className={`memo-editor-wrapper ${showEditStatus ? 'edit-ing' : ''} ${isEditorShown ? 'hidden' : ''}`}>
      <p className={`tip-text ${showEditStatus ? '' : 'hidden'}`}>Modifying...</p>
      {MemoStorageMode === 'individual-files' && app && (
        <TagInput
          app={app}
          selectedTags={selectedTags}
          onTagsChange={setSelectedTags}
          placeholder="Add tags (for individual files mode)..."
        />
      )}
      <Editor
        ref={editorRef}
        {...editorConfig}
        tools={
          <button
            type="button"
            className={`task-toggle-btn ${isListShown ? 'is-active' : ''}`}
            onClick={() => setIsListShown((current) => !current)}
          >
            {isListShown ? '☑ Task' : '☐ Task'}
          </button>
        }
      />
      <div ref={popperRef} className="date-picker">
        {isDatePickerOpen && (
          <div
            tabIndex={-1}
            style={popper.styles.popper}
            {...popper.attributes.popper}
            ref={setPopperElement}
            role="dialog"
          >
            <DatePicker
              className={`editor-date-picker ${isDatePickerOpen ? '' : 'hidden'}`}
              datestamp={currentDateStamp}
              handleDateStampChange={handleDateInsertTrigger}
            />
          </div>
        )}
      </div>
    </div>
  );
};

function getEditorContentCache(): string {
  return storage.get(['editorContentCache']).editorContentCache ?? '';
}

function setEditorContentCache(content: string) {
  storage.set({
    editorContentCache: content,
  });
}

export default LegacyMemoEditor;
