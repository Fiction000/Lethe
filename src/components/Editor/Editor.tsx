import React, { forwardRef, ReactNode, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import Only from '../common/OnlyWhen';
import '../../less/editor.less';
import { FocusOnEditor } from '../../memos';
import { storage } from '../../helpers/storage';
import { MEMOS_VIEW_TYPE } from '../../constants';
import CMEditor, { CMEditorRefActions } from './CMEditor';
import useState from 'react-usestateref';
import { isSubmitShortcut } from '../../capture/composerActions';

export interface EditorRefActions {
  /** The editor container element */
  element: HTMLElement;
  focus: FunctionType;
  insertText: (text: string) => void;
  setContent: (text: string) => void;
  getContent: () => string;
  confirm: () => Promise<void>;
  setEditable: (editable: boolean) => void;
  /** Get cursor offset from start of document */
  getCursorPosition: () => number;
}

interface EditorProps {
  className: string;
  inputerType: string;
  initialContent: string;
  placeholder: string;
  showConfirmBtn: boolean;
  showCancelBtn: boolean;
  showTools: boolean;
  tools?: ReactNode;
  onConfirmBtnClick: (content: string) => void | Promise<void>;
  onCancelBtnClick: () => void;
  onContentChange: (content: string) => void;
  onPaste?: (event: ClipboardEvent) => void;
  onDrop?: (event: DragEvent) => void;
  onCompositionChange?: (composing: boolean) => void;
  isSubmitting?: boolean;
  isComposing?: boolean;
  clearOnConfirm?: boolean;
  useContentCache?: boolean;
  focusOnMount?: boolean;
}

// eslint-disable-next-line react/display-name
const Editor = forwardRef((props: EditorProps, ref: React.ForwardedRef<EditorRefActions>) => {
  const {
    className,
    initialContent,
    placeholder,
    showConfirmBtn,
    showCancelBtn,
    onConfirmBtnClick: handleConfirmBtnClickCallback,
    onCancelBtnClick: handleCancelBtnClickCallback,
    onContentChange: handleContentChangeCallback,
    onPaste,
    onDrop,
    onCompositionChange,
    isSubmitting = false,
    isComposing = false,
    clearOnConfirm = true,
    useContentCache = true,
    focusOnMount = FocusOnEditor,
  } = props;

  const cmRef = useRef<CMEditorRefActions>(null);
  const submitLockRef = useRef(false);
  const [hasContent, setHasContent] = useState(initialContent.length > 0);
  const [, setHeight, currentHeightRef] = useState(0);

  useEffect(() => {
    const leaves = typeof app === 'undefined' ? [] : app.workspace.getLeavesOfType(MEMOS_VIEW_TYPE);
    let memosHeight;
    if (leaves.length > 0) {
      const leaf = leaves[0];
      memosHeight = leaf.view.containerEl.offsetHeight;
    } else {
      memosHeight = typeof window === 'undefined' ? 300 : window.outerHeight;
    }
    setHeight(memosHeight);
  }, [setHeight]);

  // Set initial content from cache on mount
  useEffect(() => {
    if (!useContentCache) return;
    const cached = getEditorContentCache();
    if (cached && cmRef.current) {
      cmRef.current.setContent(cached);
      setHasContent(cached.length > 0);
    }
  }, [useContentCache]);

  useEffect(() => {
    if (!focusOnMount) return;
    cmRef.current?.focus();
  }, [focusOnMount]);

  const handleConfirmClick = useCallback(async () => {
    if (!cmRef.current || isSubmitting || submitLockRef.current) return;

    // Lock in the same event turn before reading content or starting async work.
    submitLockRef.current = true;
    try {
      cmRef.current.setEditable(false);
      const cached = useContentCache ? getEditorContentCache() : '';
      const content = cached || cmRef.current.getContent();

      await handleConfirmBtnClickCallback(content);

      if (clearOnConfirm) {
        cmRef.current.setContent('');
        setHasContent(false);
      }
    } catch {
      return;
    } finally {
      submitLockRef.current = false;
      try {
        cmRef.current?.setEditable(true);
      } catch {
        // Unlocking is best effort when the editor is being unmounted.
      }
    }
  }, [clearOnConfirm, handleConfirmBtnClickCallback, isSubmitting, useContentCache]);

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return cmRef.current?.element as HTMLElement;
      },
      focus: () => {
        if (focusOnMount || FocusOnEditor) {
          cmRef.current?.focus();
        }
      },
      insertText: (text: string) => {
        cmRef.current?.insertText(text);
      },
      setContent: (text: string) => {
        cmRef.current?.setContent(text);
        setHasContent(text.length > 0);
      },
      getContent: (): string => {
        return cmRef.current?.getContent() ?? '';
      },
      confirm: () => handleConfirmClick(),
      setEditable: (editable: boolean) => {
        cmRef.current?.setEditable(editable);
      },
      getCursorPosition: (): number => {
        const view = cmRef.current?.view;
        if (!view) return 0;
        return view.state.selection.main.from;
      },
    }),
    [focusOnMount, handleConfirmClick],
  );

  const handleContentChange = useCallback(
    (content: string) => {
      setHasContent(content.length > 0);
      handleContentChangeCallback(content);
    },
    [handleContentChangeCallback],
  );

  const handleCancelClick = useCallback(() => {
    handleCancelBtnClickCallback();
  }, [handleCancelBtnClickCallback]);

  /** Wrap selected text (or insert placeholder) with before/after markers in CM6 */
  const wrapCMSelection = useCallback((before: string, after: string, placeholderText: string) => {
    const view = cmRef.current?.view;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    const selectedText = view.state.sliceDoc(from, to);
    const textToWrap = selectedText || placeholderText;
    const wrapped = before + textToWrap + after;

    view.dispatch({
      changes: { from, to, insert: wrapped },
      selection: selectedText
        ? { anchor: from, head: from + wrapped.length }
        : { anchor: from + before.length, head: from + before.length + textToWrap.length },
    });
    view.focus();
  }, []);

  // CM6 keydown handler — return true to prevent CM6 default handling
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      event.stopPropagation();

      const isMod = event.metaKey || event.ctrlKey;
      const isShift = event.shiftKey;

      const view = cmRef.current?.view;
      const isEditorComposing = Boolean(view?.composing);

      if (isSubmitting || submitLockRef.current) {
        event.preventDefault();
        return true;
      }

      // Cmd/Ctrl+Enter submits only after IME composition has settled.
      if (isSubmitShortcut(event, isEditorComposing)) {
        event.preventDefault();
        void handleConfirmClick();
        return true;
      }

      if (event.isComposing || isEditorComposing || event.keyCode === 229 || event.which === 229) {
        return false;
      }

      // Ctrl+Shift+Enter to insert task checkbox
      if (event.code === 'Enter' && (event.ctrlKey || event.metaKey) && isShift) {
        event.preventDefault();
        if (view) {
          const { from } = view.state.selection.main;
          const insert = '- [ ] ';
          view.dispatch({ changes: { from, insert }, selection: { anchor: from + insert.length } });
        }
        return true;
      }

      // Markdown formatting hotkeys
      if (isMod && !isShift) {
        switch (event.key.toLowerCase()) {
          case 'b':
            event.preventDefault();
            wrapCMSelection('**', '**', 'bold text');
            return true;
          case 'i':
            event.preventDefault();
            wrapCMSelection('*', '*', 'italic text');
            return true;
          case 'k':
            event.preventDefault();
            wrapCMSelection('[', ']()', 'link text');
            return true;
          case 'e':
            event.preventDefault();
            wrapCMSelection('`', '`', 'code');
            return true;
        }
      }

      if (isMod && isShift) {
        switch (event.key.toLowerCase()) {
          case 'x':
            event.preventDefault();
            wrapCMSelection('~~', '~~', 'strikethrough');
            return true;
        }
      }

      return false;
    },
    [handleConfirmClick, isSubmitting, wrapCMSelection],
  );

  // Handle paste events for image upload
  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      if (isSubmitting) {
        event.preventDefault();
        return true;
      }
      if (onPaste && event.clipboardData && event.clipboardData.files.length > 0) {
        event.preventDefault();
        onPaste(event);
        return true;
      }
      return false;
    },
    [isSubmitting, onPaste],
  );

  // Handle drop events for image upload
  const handleDrop = useCallback(
    (event: DragEvent) => {
      if (isSubmitting) {
        event.preventDefault();
        return true;
      }
      if (onDrop && event.dataTransfer && event.dataTransfer.files.length > 0) {
        event.preventDefault();
        onDrop(event);
        return true;
      }
      return false;
    },
    [isSubmitting, onDrop],
  );

  const maxHeight = currentHeightRef.current > 400 ? currentHeightRef.current - 400 : 300;

  return (
    <div className={'common-editor-wrapper ' + className}>
      <CMEditor
        ref={cmRef}
        initialContent={initialContent}
        placeholder={placeholder}
        onContentChange={handleContentChange}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onCompositionChange={onCompositionChange}
        editable={!isSubmitting}
        maxHeight={maxHeight}
      />

      <div className="common-tools-wrapper">
        <div className="common-tools-container">
          <Only when={props.tools !== undefined}>{props.tools}</Only>
        </div>
        <div className="btns-container">
          <Only when={showCancelBtn}>
            <button className="action-btn cancel-btn" onClick={handleCancelClick}>
              CANCEL EDIT
            </button>
          </Only>
          <Only when={showConfirmBtn}>
            <button
              className="action-btn confirm-btn"
              disabled={!hasContent || isSubmitting || isComposing}
              onClick={() => void handleConfirmClick()}
              title="Submit (⌘+Enter)"
            >
              NOTE
              <span className="shortcut-hint">⌘↵</span>
            </button>
          </Only>
        </div>
      </div>
    </div>
  );
});

function getEditorContentCache(): string {
  return storage.get(['editorContentCache']).editorContentCache ?? '';
}

export default Editor;
