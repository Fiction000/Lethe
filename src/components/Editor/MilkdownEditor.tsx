import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { EditorView } from '@milkdown/kit/prose/view';
import type { Selection } from '@milkdown/kit/prose/state';
import appStore from '../../stores/appStore';
import { MilkdownEngine, type Completion, type EngineOptions } from './milkdownEngine';

export interface MilkdownEditorRefActions {
  element: HTMLDivElement;
  view: EditorView | null;
  isReady: boolean;
  isComposing: boolean;
  focus(): void;
  insertText(text: string): void;
  setContent(text: string): void;
  getContent(): string;
  setEditable(editable: boolean): void;
  restoreSelection(selection: Selection): void;
  getCursorPosition(): number;
}
interface Props {
  initialContent: string;
  placeholder: string;
  editable: boolean;
  maxHeight: number;
  onContentChange(content: string): void;
  onKeyDown(event: KeyboardEvent): boolean;
  onEscape(view: EditorView): boolean;
  onFocusEscape(view: EditorView): boolean;
  onPaste(event: ClipboardEvent): boolean;
  onDrop(event: DragEvent): boolean;
  onCompositionChange?: (composing: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
}
function suggestions(kind: 'wiki' | 'tag', query: string): Completion[] {
  const app = appStore.getState().dailyNotesState?.app;
  if (!app) return [];
  if (kind === 'wiki')
    return app.vault
      .getFiles()
      .filter(
        (file) =>
          /^(md|png|jpg|jpeg|gif|pdf)$/i.test(file.extension) && file.path.toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 10)
      .map((file) => ({
        label: file.path,
        markdown: app.fileManager.generateMarkdownLink(file, ''),
      }));
  const tags = new Set<string>();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    cache?.tags?.forEach((tag) => tags.add(tag.tag.replace(/^#/, '')));
    const frontmatterTags: unknown = cache?.frontmatter?.tags;
    if (Array.isArray(frontmatterTags))
      frontmatterTags
        .filter((tag): tag is string => typeof tag === 'string')
        .forEach((tag) => tags.add(tag.replace(/^#/, '')));
  }
  return Array.from(tags)
    .sort()
    .filter((tag) => tag.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 15)
    .map((tag) => ({ label: `#${tag}`, markdown: `#${tag} ` }));
}

const MilkdownEditor = forwardRef<MilkdownEditorRefActions, Props>(function MilkdownEditor(props, ref) {
  const root = useRef<HTMLDivElement>(null);
  const engine = useRef<MilkdownEngine | null>(null);
  const current = useRef(props);
  current.current = props;
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    const options = (): EngineOptions => ({
      ...current.current,
      onChange: current.current.onContentChange,
      onComposition: (value) => current.current.onCompositionChange?.(value),
      suggestions,
    });
    const instance = new MilkdownEngine(root.current, options);
    engine.current = instance;
    let disposed = false;
    void instance.ready
      .then(() => {
        if (!disposed) current.current.onReadyChange?.(true);
      })
      .catch(() => {
        if (!disposed) {
          setError(true);
          current.current.onReadyChange?.(false);
        }
      });
    return () => {
      disposed = true;
      instance.destroy();
      engine.current = null;
    };
  }, []);
  useEffect(() => {
    engine.current?.setEditable(props.editable);
  }, [props.editable]);
  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return root.current!;
      },
      get view() {
        return engine.current?.view ?? null;
      },
      get isReady() {
        return engine.current?.isReady ?? false;
      },
      get isComposing() {
        return engine.current?.isComposing ?? false;
      },
      focus: () => engine.current?.focus(),
      insertText: (text) => engine.current?.insertText(text),
      setContent: (text) => engine.current?.setContent(text),
      getContent: () => engine.current?.getContent() ?? current.current.initialContent,
      setEditable: (value) => engine.current?.setEditable(value && current.current.editable),
      restoreSelection: (selection) => engine.current?.restoreSelection(selection),
      getCursorPosition: () => engine.current?.getCursorPosition() ?? 0,
    }),
    [],
  );
  return (
    <div
      className="milkdown-editor-container"
      style={{ '--lethe-editor-max-height': `${props.maxHeight}px` } as React.CSSProperties}
    >
      <div ref={root} className="lethe-milkdown" />
      {error && <div role="alert">Editor could not start. Your draft has not been changed.</div>}
    </div>
  );
});
export default MilkdownEditor;
