import React, { forwardRef, ReactNode, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import Only from '../common/OnlyWhen';
import '../../less/editor.less';
import { FocusOnEditor } from '../../memos';
import { storage } from '../../helpers/storage';
import MilkdownEditor, { MilkdownEditorRefActions } from './MilkdownEditor';
import { Scope } from 'obsidian';
import appStore from '../../stores/appStore';
import type { Selection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import useState from 'react-usestateref';
import { isSubmitShortcut } from '../../capture/composerActions';
import { applyFormatCommand, findFormatCommand, formattingCommands, type FormatCommandId } from './milkdownCommands';
import { slashCommand } from './milkdownCommands';

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
  onReadyChange?: (ready: boolean) => void;
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

  const engineRef = useRef<MilkdownEditorRefActions>(null);
  const submitLockRef = useRef(false);
  const escapeArmedRef = useRef(false);
  const [formatOpen, setFormatOpen] = React.useState(false);
  const [formatIndex, setFormatIndex] = React.useState(0);
  const formatTriggerRef = useRef<HTMLButtonElement>(null);
  const formatSelectionRef = useRef<Selection | null>(null);
  const formatMenuRef = useRef<HTMLDivElement>(null);
  const formatMenuIdRef = useRef(`lethe-format-menu-${Math.random().toString(36).slice(2)}`);
  const formatIds = Object.keys(formattingCommands) as FormatCommandId[];
  const shortcutMod =
    typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';
  const [editorReady, setEditorReady] = React.useState(false);
  const formatDisabled = !editorReady || isSubmitting || submitLockRef.current || isComposing;
  const [hasContent, setHasContent] = useState(initialContent.length > 0);

  // Set initial content from cache on mount
  useEffect(() => {
    if (!useContentCache) return;
    const cached = getEditorContentCache();
    if (cached && engineRef.current) {
      engineRef.current.setContent(cached);
      setHasContent(cached.length > 0);
    }
  }, [useContentCache]);

  useEffect(() => {
    if (!focusOnMount) return;
    engineRef.current?.focus();
  }, [focusOnMount]);

  const handleConfirmClick = useCallback(async () => {
    if (
      !engineRef.current?.isReady ||
      engineRef.current.isComposing ||
      isComposing ||
      isSubmitting ||
      submitLockRef.current
    )
      return;

    // Lock in the same event turn before reading content or starting async work.
    submitLockRef.current = true;
    try {
      engineRef.current.setEditable(false);
      const content = engineRef.current.getContent();

      await handleConfirmBtnClickCallback(content);

      if (clearOnConfirm) {
        engineRef.current.setContent('');
        setHasContent(false);
      }
    } catch {
      return;
    } finally {
      submitLockRef.current = false;
      try {
        engineRef.current?.setEditable(true);
      } catch {
        // Unlocking is best effort when the editor is being unmounted.
      }
    }
  }, [clearOnConfirm, handleConfirmBtnClickCallback, isComposing, isSubmitting]);

  useEffect(() => {
    const win = engineRef.current?.element.ownerDocument.defaultView;
    if (!win) return;
    const handleSubmitShortcut = (event: KeyboardEvent): void => {
      const view = engineRef.current?.view;
      if (!view || !event.composedPath().includes(view.dom) || !isSubmitShortcut(event, view.composing)) return;
      // Obsidian can stop propagation at window before CM6 sees the shortcut.
      event.preventDefault();
      event.stopPropagation();
      void handleConfirmClick();
    };
    win.addEventListener('keydown', handleSubmitShortcut, true);
    return () => win.removeEventListener('keydown', handleSubmitShortcut, true);
  }, [handleConfirmClick]);

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return engineRef.current?.element as HTMLElement;
      },
      focus: () => {
        if (focusOnMount || FocusOnEditor) {
          engineRef.current?.focus();
        }
      },
      insertText: (text: string) => {
        engineRef.current?.insertText(text);
      },
      setContent: (text: string) => {
        engineRef.current?.setContent(text);
        setHasContent(text.length > 0);
      },
      getContent: (): string => {
        return engineRef.current?.getContent() ?? '';
      },
      confirm: () => handleConfirmClick(),
      setEditable: (editable: boolean) => {
        engineRef.current?.setEditable(editable);
      },
      getCursorPosition: (): number => {
        return engineRef.current?.getCursorPosition() ?? 0;
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

  const closeFormatMenu = useCallback((returnToEditor: boolean) => {
    setFormatOpen(false);
    if (returnToEditor) {
      const view = engineRef.current?.view;
      if (view && formatSelectionRef.current) engineRef.current?.restoreSelection(formatSelectionRef.current);
      engineRef.current?.focus();
    }
    formatSelectionRef.current = null;
  }, []);

  const runFormat = useCallback(
    (id: FormatCommandId) => {
      if (isSubmitting || submitLockRef.current || isComposing) return;
      const view = engineRef.current?.view;
      if (formatSelectionRef.current) engineRef.current?.restoreSelection(formatSelectionRef.current);
      if (view && applyFormatCommand(view, id)) {
        formatSelectionRef.current = null;
        setFormatOpen(false);
      }
    },
    [isComposing, isSubmitting],
  );

  useEffect(() => {
    if (!formatOpen) return;
    const ownerDocument = engineRef.current?.element.ownerDocument;
    const dismiss = (event: PointerEvent) => {
      if (
        !formatMenuRef.current?.contains(event.target as Node) &&
        !formatTriggerRef.current?.contains(event.target as Node)
      ) {
        formatSelectionRef.current = null;
        setFormatOpen(false);
      }
    };
    ownerDocument?.addEventListener('pointerdown', dismiss);
    formatMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => ownerDocument?.removeEventListener('pointerdown', dismiss);
  }, [formatOpen]);

  const handleFocusEscape = useCallback(
    (view: EditorView): boolean => {
      if (isComposing || view.composing) {
        escapeArmedRef.current = false;
        return false;
      }
      if (!escapeArmedRef.current) return false;
      escapeArmedRef.current = false;
      const root = view.dom.closest('.capture-composer') ?? view.dom.parentElement;
      const nextControl = Array.from(
        root?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [],
      ).find((control) => Boolean(control.compareDocumentPosition(view.dom) & Node.DOCUMENT_POSITION_PRECEDING));
      if (!nextControl) return false;
      nextControl.focus();
      return true;
    },
    [isComposing],
  );

  const handleEditorEscape = useCallback(
    (view: EditorView): boolean => {
      if (isComposing || view.composing || view.dom.parentElement?.querySelector('.lethe-completions:not([hidden])'))
        return false;
      escapeArmedRef.current = true;
      return true;
    },
    [isComposing],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      event.stopPropagation();
      const view = engineRef.current?.view;
      const isEditorComposing = Boolean(view?.composing || engineRef.current?.isComposing);

      if (isSubmitting || submitLockRef.current) {
        event.preventDefault();
        return true;
      }
      if (isSubmitShortcut(event, isEditorComposing)) {
        event.preventDefault();
        void handleConfirmClick();
        return true;
      }
      if (event.isComposing || isEditorComposing || event.keyCode === 229 || event.which === 229) return false;

      if (event.key !== 'Tab') escapeArmedRef.current = false;
      if (event.key === 'Escape') {
        if (view?.dom.querySelector('.cm-tooltip-autocomplete')) return false;
        event.preventDefault();
        escapeArmedRef.current = true;
        return true;
      }

      if (event.code === 'Enter' && (event.ctrlKey || event.metaKey) && event.shiftKey) {
        event.preventDefault();
        if (view) {
          slashCommand(view, 'task');
        }
        return true;
      }
      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod) return false;
      const id = findFormatCommand(event.key, event.shiftKey);
      if (!id) return false;
      event.preventDefault();
      if (view) applyFormatCommand(view, id);
      return true;
    },
    [handleConfirmClick, isSubmitting],
  );

  useEffect(() => {
    const element = engineRef.current?.element;
    const app = appStore.getState().dailyNotesState?.app;
    if (!element || !app) return;
    const scope = new Scope();
    let active = false;
    for (const id of formatIds) {
      const command = formattingCommands[id];
      scope.register(command.shift ? ['Mod', 'Shift'] : ['Mod'], command.key, (event) => {
        if (engineRef.current?.view?.hasFocus() && handleKeyDown(event)) return false;
      });
    }
    scope.register(['Mod'], 'Enter', (event) => {
      if (engineRef.current?.view?.hasFocus() && handleKeyDown(event)) return false;
    });
    scope.register(['Mod', 'Shift'], 'Enter', (event) => {
      if (engineRef.current?.view?.hasFocus() && handleKeyDown(event)) return false;
    });
    const activate = () => {
      if (!active) {
        app.keymap.pushScope(scope);
        active = true;
      }
    };
    const deactivate = () => {
      if (active) {
        app.keymap.popScope(scope);
        active = false;
      }
    };
    element.addEventListener('focusin', activate);
    element.addEventListener('focusout', deactivate);
    if (element.contains(element.ownerDocument.activeElement)) activate();
    return () => {
      deactivate();
      element.removeEventListener('focusin', activate);
      element.removeEventListener('focusout', deactivate);
    };
  }, [handleKeyDown]);

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

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (formatIndex + (event.key === 'ArrowDown' ? 1 : formatIds.length - 1)) % formatIds.length;
      setFormatIndex(next);
      formatMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[next]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFormatMenu(true);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      setFormatOpen(false);
      if (event.shiftKey) formatTriggerRef.current?.focus();
      else engineRef.current?.view.dom.focus();
    }
  };

  return (
    <div className={'common-editor-wrapper ' + className}>
      <div className="lethe-format-row">
        <button
          ref={formatTriggerRef}
          className="lethe-format-trigger"
          type="button"
          aria-label="Format"
          aria-haspopup="menu"
          aria-expanded={formatOpen}
          aria-controls={formatMenuIdRef.current}
          disabled={formatDisabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (formatOpen) {
              closeFormatMenu(true);
              return;
            }
            formatSelectionRef.current = engineRef.current?.view?.state.selection ?? null;
            setFormatIndex(0);
            setFormatOpen(true);
          }}
        >
          Format <span aria-hidden="true">▾</span>
        </button>
        {formatOpen && (
          <div
            id={formatMenuIdRef.current}
            ref={formatMenuRef}
            className="lethe-format-menu"
            role="menu"
            aria-label="Format"
            onKeyDown={handleMenuKeyDown}
          >
            {formatIds.map((id, index) => {
              const command = formattingCommands[id];
              const labels: Record<FormatCommandId, string> = {
                bold: 'Bold',
                italic: 'Italic',
                link: 'Link',
                code: 'Inline code',
                strikethrough: 'Strikethrough',
              };
              const shortcut = command.shift ? `${shortcutMod}⇧X` : `${shortcutMod}${command.key.toUpperCase()}`;
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  tabIndex={index === formatIndex ? 0 : -1}
                  disabled={formatDisabled}
                  onFocus={() => setFormatIndex(index)}
                  onClick={() => runFormat(id)}
                >
                  {labels[id]}
                  <span className="lethe-format-shortcut">{shortcut}</span>
                </button>
              );
            })}
            <span className="lethe-format-hint">Esc to return to writing</span>
          </div>
        )}
      </div>
      <MilkdownEditor
        ref={engineRef}
        initialContent={initialContent}
        placeholder={placeholder}
        onContentChange={handleContentChange}
        onKeyDown={handleKeyDown}
        onEscape={handleEditorEscape}
        onFocusEscape={handleFocusEscape}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onCompositionChange={onCompositionChange}
        onReadyChange={(ready) => {
          setEditorReady(ready);
          props.onReadyChange?.(ready);
        }}
        editable={!isSubmitting}
        maxHeight={300}
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
              disabled={!editorReady || !hasContent || isSubmitting || isComposing}
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
