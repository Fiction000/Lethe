import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder, ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { obsidianEditorTheme, obsidianHighlightStyle } from './editorTheme';
import { livePreviewPlugin } from './livePreview';
import { editorAutocompletion } from './completions';
import { createEditorEditLock, type EditorEditLock } from './editLock';

export interface CMEditorRefActions {
  /** The CM6 editor container element (for event listeners) */
  element: HTMLDivElement;
  /** The CM6 EditorView instance */
  view: EditorView | null;
  focus: () => void;
  insertText: (text: string) => void;
  setContent: (text: string) => void;
  getContent: () => string;
  setEditable: (editable: boolean) => void;
}

interface CMEditorProps {
  initialContent?: string;
  placeholder?: string;
  onContentChange?: (content: string) => void;
  onKeyDown?: (event: KeyboardEvent) => boolean;
  onPaste?: (event: ClipboardEvent) => boolean;
  onDrop?: (event: DragEvent) => boolean;
  onCompositionChange?: (composing: boolean) => void;
  editable?: boolean;
  maxHeight?: number;
}

// eslint-disable-next-line react/display-name
const CMEditor = forwardRef<CMEditorRefActions, CMEditorProps>((props, ref) => {
  const {
    initialContent = '',
    placeholder = '',
    onContentChange,
    onKeyDown,
    onPaste,
    onDrop,
    onCompositionChange,
    editable = true,
    maxHeight = 300,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editLockRef = useRef<EditorEditLock | null>(null);
  if (editLockRef.current === null) {
    editLockRef.current = createEditorEditLock();
  }
  const editLock = editLockRef.current;
  const onContentChangeRef = useRef(onContentChange);
  const onKeyDownRef = useRef(onKeyDown);
  const onPasteRef = useRef(onPaste);
  const onDropRef = useRef(onDrop);
  const onCompositionChangeRef = useRef(onCompositionChange);

  // Keep refs up to date without recreating the editor
  useEffect(() => {
    onContentChangeRef.current = onContentChange;
  }, [onContentChange]);

  useEffect(() => {
    onKeyDownRef.current = onKeyDown;
  }, [onKeyDown]);

  useEffect(() => {
    onPasteRef.current = onPaste;
  }, [onPaste]);

  useEffect(() => {
    onDropRef.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    onCompositionChangeRef.current = onCompositionChange;
  }, [onCompositionChange]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: editLock.setEditable(editable) });
  }, [editLock, editable]);

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const updateListener = EditorView.updateListener.of((update: ViewUpdate) => {
      if (update.docChanged) {
        const content = update.state.doc.toString();
        onContentChangeRef.current?.(content);
      }
    });

    const customEventHandlers = EditorView.domEventHandlers({
      keydown: (event: KeyboardEvent) => {
        if (onKeyDownRef.current) {
          return onKeyDownRef.current(event);
        }
        return false;
      },
      paste: (event: ClipboardEvent) => {
        if (onPasteRef.current) {
          return onPasteRef.current(event);
        }
        return false;
      },
      drop: (event: DragEvent) => {
        if (onDropRef.current) {
          return onDropRef.current(event);
        }
        return false;
      },
      compositionstart: () => {
        onCompositionChangeRef.current?.(true);
        return false;
      },
      compositionend: () => {
        onCompositionChangeRef.current?.(false);
        return false;
      },
    });

    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        editLock.extension,
        // Core
        history(),
        keymap.of([
          { key: 'Tab', run: indentMore },
          { key: 'Shift-Tab', run: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        // Markdown
        markdown(),
        // Theme
        obsidianEditorTheme,
        obsidianHighlightStyle,
        // Behavior
        cmPlaceholder(placeholder),
        updateListener,
        customEventHandlers,
        // Autocomplete (#tags, [[files]])
        editorAutocompletion,
        // Live preview (WYSIWYG)
        livePreviewPlugin,
        // Line wrapping
        EditorView.lineWrapping,
        // Dynamic max height
        EditorView.theme({
          '.cm-scroller': {
            maxHeight: `${maxHeight}px`,
          },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;
    view.dispatch({ effects: editLock.setEditable(editable) });

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The parent rotates this editor with a new key when immutable inputs change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Mount once — content updates go through setContent

  // Expose imperative API
  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return containerRef.current as HTMLDivElement;
      },
      get view() {
        return viewRef.current;
      },
      focus: () => {
        viewRef.current?.focus();
      },
      insertText: (text: string) => {
        const view = viewRef.current;
        if (!view) return;
        const { from } = view.state.selection.main;
        view.dispatch({
          changes: { from, insert: text },
          selection: { anchor: from + text.length },
        });
      },
      setContent: (text: string) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
        });
      },
      getContent: (): string => {
        return viewRef.current?.state.doc.toString() ?? '';
      },
      setEditable: (nextEditable: boolean) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: editLock.setEditable(nextEditable) });
      },
    }),
    [editLock],
  );

  return <div ref={containerRef} className="cm-editor-container" />;
});

export default CMEditor;
