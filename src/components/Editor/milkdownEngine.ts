import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx, editorViewOptionsCtx, parserCtx, serializerCtx } from '@milkdown/kit/core';
import { $prose, $view } from '@milkdown/kit/utils';
import { Plugin, TextSelection } from '@milkdown/kit/prose/state';
import type { Selection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { imageSchema, linkSchema, paragraphSchema } from '@milkdown/kit/preset/commonmark';
import { sinkListItem, liftListItem } from '@milkdown/kit/prose/schema-list';
import { obsidianSyntax } from './obsidianSyntax';
import { slashCommand, slashCommands } from './milkdownCommands';
import type { SlashCommandId } from './milkdownCommands';

export type Completion = { label: string; markdown: string };
export type EngineOptions = {
  initialContent: string;
  placeholder: string;
  editable: boolean;
  onChange: (source: string) => void;
  onKeyDown: (event: KeyboardEvent) => boolean;
  onEscape: (view: EditorView) => boolean;
  onFocusEscape: (view: EditorView) => boolean;
  onPaste: (event: ClipboardEvent) => boolean;
  onDrop: (event: DragEvent) => boolean;
  onComposition: (composing: boolean) => void;
  suggestions: (kind: 'wiki' | 'tag', query: string) => Completion[];
};
type Phase =
  | { status: 'starting'; content: string; focus: boolean }
  | { status: 'ready'; view: EditorView }
  | { status: 'destroyed' }
  | { status: 'failed'; error: Error };
type Popup = {
  from: number;
  to: number;
  key: string;
  items: { label: string; markdown?: string; command?: SlashCommandId }[];
  index: number;
};

export class MilkdownEngine {
  private phase: Phase;
  private editable: boolean;
  private composing = false;
  private crepe: Crepe;
  private popup: Popup | null = null;
  private dismissed = '';
  private popupDOM: HTMLDivElement;
  private popupID = `lethe-completion-${Math.random().toString(36).slice(2)}`;
  readonly ready: Promise<void>;

  constructor(readonly root: HTMLElement, private options: () => EngineOptions) {
    const initial = options();
    this.phase = { status: 'starting', content: initial.initialContent, focus: false };
    this.editable = initial.editable;
    this.popupDOM = root.ownerDocument.createElement('div');
    this.popupDOM.className = 'lethe-completions';
    this.popupDOM.id = this.popupID;
    this.popupDOM.setAttribute('role', 'listbox');
    this.popupDOM.hidden = true;
    root.append(this.popupDOM);
    this.crepe = new Crepe({
      root,
      defaultValue: initial.initialContent,
      features: Object.fromEntries(Object.values(CrepeFeature).map((feature) => [feature, false])),
    });
    this.crepe.editor.config((ctx) => {
      ctx.update(paragraphSchema.key, (previous) => (schemaContext) => ({
        ...previous(schemaContext),
        toMarkdown: {
          match: (node) => node.type.name === 'paragraph',
          runner: (state, node) => {
            state.openNode('paragraph');
            state.next(node.content);
            state.closeNode();
          },
        },
      }));
      ctx.update(linkSchema.key, (previous) => (schemaContext) => ({
        ...previous(schemaContext),
        toDOM: (mark) => {
          const href = String(mark.attrs.href ?? '');
          const normalized = Array.from(href)
            .filter((character) => character.charCodeAt(0) > 0x20 && character.charCodeAt(0) !== 0x7f)
            .join('')
            .toLowerCase();
          const safe = !normalized.includes(':') || /^(https?:|mailto:|obsidian:)/.test(normalized);
          return ['a', { ...(safe ? { href } : {}), title: mark.attrs.title || undefined }, 0];
        },
      }));
      ctx.update(editorViewOptionsCtx, (previous) => ({
        ...previous,
        editable: () => this.editable,
        handleKeyDown: (view, event) => this.handleKeyDown(view, event),
        attributes: {
          role: 'textbox',
          'aria-label': initial.placeholder || 'Markdown',
          'aria-multiline': 'true',
          'aria-autocomplete': 'list',
          'data-placeholder': initial.placeholder,
        },
        handleDOMEvents: {
          compositionstart: () => {
            this.composing = true;
            options().onComposition(true);
            return false;
          },
          compositionend: () => {
            queueMicrotask(() => {
              if (this.phase.status !== 'destroyed') {
                this.composing = false;
                options().onComposition(false);
                this.refreshPopup();
              }
            });
            return false;
          },
          paste: (_view, event: ClipboardEvent) => {
            if (!this.editable) {
              event.preventDefault();
              return true;
            }
            if (options().onPaste(event)) return true;
            event.preventDefault();
            if (event.clipboardData?.files.length) return true;
            const source = event.clipboardData?.getData('text/plain');
            if (source) this.insertMarkdown(source);
            return true;
          },
          drop: (_view, event: DragEvent) => {
            if (!this.editable) {
              event.preventDefault();
              return true;
            }
            if (options().onDrop(event)) return true;
            if (event.dataTransfer?.files.length) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          click: (_view, event) => {
            const anchor = (event.target as Element)?.closest?.('a');
            if (anchor) {
              event.preventDefault();
              return true;
            }
            return false;
          },
          beforeinput: (_view, event) => {
            if (!this.editable) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      }));
    });
    this.crepe.editor
      .use(obsidianSyntax)
      .use(
        $view(imageSchema.node, () => (node) => {
          const dom = root.ownerDocument.createElement('span');
          dom.className = 'lethe-image-placeholder';
          dom.textContent = `![${node.attrs.alt || 'image'}](${node.attrs.src})`;
          return { dom };
        }),
      )
      .use(
        $prose(
          () =>
            new Plugin({
              filterTransaction: (tr) => !tr.docChanged || this.editable || tr.getMeta('lethe-replace') === true,
              props: {
                handleTextInput: (view, from, to, text) => {
                  if (!this.editable || this.composing || view.composing) return false;
                  const $from = view.state.doc.resolve(from);
                  if (
                    $from.parent.type.spec.code ||
                    $from.marks().some((mark) => mark.type.spec.code || mark.attrs.kind === 'literal')
                  )
                    return false;
                  const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
                  const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, '', '\ufffc');
                  if (text === '[' && before.endsWith('[') && !before.endsWith('\\[')) {
                    const tr = view.state.tr.insertText('[]]', from, to);
                    tr.setSelection(TextSelection.create(tr.doc, from + 1));
                    view.dispatch(tr);
                    return true;
                  }
                  if (text === ']' && after.startsWith(']') && /\[\[[^\]\n]*\]?$/.test(before)) {
                    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from + 1)));
                    return true;
                  }
                  return false;
                },
              },
              view: () => ({
                update: (view, previous) => {
                  view.dom.dataset.empty = String(
                    view.state.doc.childCount === 1 &&
                      view.state.doc.firstChild?.type.name === 'paragraph' &&
                      view.state.doc.firstChild?.content.size === 0,
                  );
                  if (!view.state.doc.eq(previous.doc)) options().onChange(this.crepe.getMarkdown());
                  this.refreshPopup();
                },
              }),
            }),
        ),
      );
    this.ready = this.crepe
      .create()
      .then(async () => {
        if (this.phase.status === 'destroyed') {
          await this.crepe.destroy();
          return;
        }
        if (this.phase.status !== 'starting') return;
        const pending = this.phase;
        const view = this.crepe.editor.action((ctx) => ctx.get(editorViewCtx));
        this.phase = { status: 'ready', view };
        view.dom.dataset.empty = String(
          view.state.doc.childCount === 1 &&
            view.state.doc.firstChild?.type.name === 'paragraph' &&
            view.state.doc.firstChild?.content.size === 0,
        );
        this.setEditable(this.editable);
        if (pending.content !== initial.initialContent) this.setContent(pending.content);
        if (pending.focus) view.focus();
      })
      .catch((error: unknown) => {
        if (this.phase.status !== 'destroyed')
          this.phase = { status: 'failed', error: error instanceof Error ? error : new Error(String(error)) };
        throw error;
      });
  }
  private handleKeyDown(view: EditorView, event: KeyboardEvent): boolean {
    if (!this.editable) {
      event.preventDefault();
      return true;
    }
    if (this.composing || view.composing || event.isComposing || event.keyCode === 229) return false;
    if (this.popup) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.popup.index =
          (this.popup.index + (event.key === 'ArrowDown' ? 1 : this.popup.items.length - 1)) % this.popup.items.length;
        this.renderPopup();
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        this.acceptPopup();
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.dismissed = this.popup.key;
        this.hidePopup();
        return true;
      }
    }
    if (this.options().onKeyDown(event)) return true;
    if (event.key === 'Escape') return this.options().onEscape(view);
    if (event.key === 'Tab') {
      event.preventDefault();
      if (this.options().onFocusEscape(view)) return true;
      const command = event.shiftKey
        ? liftListItem(view.state.schema.nodes.list_item)
        : sinkListItem(view.state.schema.nodes.list_item);
      return command(view.state, view.dispatch, view) || true;
    }
    return false;
  }
  get view(): EditorView | null {
    return this.phase.status === 'ready' ? this.phase.view : null;
  }
  get isReady(): boolean {
    return this.phase.status === 'ready';
  }
  get isComposing(): boolean {
    return this.composing || Boolean(this.view?.composing);
  }
  focus() {
    if (this.phase.status === 'starting') this.phase.focus = true;
    else this.view?.focus();
  }
  getContent(): string {
    return this.phase.status === 'starting' ? this.phase.content : this.view ? this.crepe.getMarkdown() : '';
  }
  setEditable(editable: boolean) {
    this.editable = editable;
    this.view?.setProps({ editable: () => this.editable });
    if (!editable) this.hidePopup();
  }
  setContent(source: string) {
    if (this.phase.status === 'starting') {
      this.phase.content = source;
      return;
    }
    const view = this.view;
    if (!view) return;
    const doc = this.crepe.editor.action((ctx) => ctx.get(parserCtx)(source));
    if (!doc) throw new Error('Markdown could not be parsed');
    view.dispatch(
      view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content).setMeta('lethe-replace', true),
    );
  }
  insertText(text: string) {
    this.insertMarkdown(text);
  }
  private insertMarkdown(source: string, from = this.view?.state.selection.from, to = this.view?.state.selection.to) {
    const view = this.view;
    if (!view || !this.editable || this.isComposing || from === undefined || to === undefined) return;
    const doc = this.crepe.editor.action((ctx) => ctx.get(parserCtx)(source));
    if (!doc) return;
    const tr = view.state.tr;
    const single = doc.childCount === 1 && doc.firstChild?.type.name === 'paragraph';
    if (single) tr.replaceWith(from, to, doc.firstChild!.content);
    else tr.replaceRange(from, to, doc.slice(0, doc.content.size));
    view.dispatch(tr.scrollIntoView());
    view.focus();
  }
  restoreSelection(selection: Selection) {
    const view = this.view;
    if (view && selection.$from.doc === view.state.doc) view.dispatch(view.state.tr.setSelection(selection));
  }
  getCursorPosition(): number {
    const view = this.view;
    if (!view) return this.getContent().length;
    const marker = `LETHECURSOR${Math.random().toString(36).slice(2).toUpperCase()}`;
    const probe = view.state.tr.insertText(marker, view.state.selection.from).doc;
    const saved = this.crepe.editor.action((ctx) => ctx.get(serializerCtx)(probe));
    return Math.min(saved.indexOf(marker), this.getContent().length);
  }
  private refreshPopup() {
    const view = this.view;
    if (!view || !this.editable || this.isComposing || !view.state.selection.empty || !view.hasFocus()) {
      this.hidePopup();
      return;
    }
    const { $from } = view.state.selection;
    if (
      $from.parent.type.spec.code ||
      $from.marks().some((mark) => mark.type.spec.code || mark.attrs.kind === 'literal')
    ) {
      this.hidePopup();
      return;
    }
    const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
    const after = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, '', '\ufffc');
    const wiki = /(?<!\\)\[\[([^\]\n]*)$/.exec(before);
    const tag = /(?:^|\s)#([\p{L}\p{N}_/-]*)$/u.exec(before);
    const slash = /^\/([^\s/]*)$/.exec(before);
    let items: Popup['items'] = [];
    let from = $from.pos;
    let to = $from.pos;
    if (wiki) {
      from -= wiki[0].length;
      if (after.startsWith(']]')) to += 2;
      items = this.options().suggestions('wiki', wiki[1]);
    } else if (tag) {
      from -= tag[1].length + 1;
      items = this.options().suggestions('tag', tag[1]);
    } else if (slash) {
      from -= slash[0].length;
      items = slashCommands
        .filter((item) => item.label.toLowerCase().includes(slash[1].toLowerCase()))
        .map((item) => ({ label: item.label, command: item.id }));
    }
    const key = `${from}:${to}:${before}`;
    if (!items.length || key === this.dismissed) {
      this.hidePopup();
      return;
    }
    const index = this.popup?.key === key ? Math.min(this.popup.index, items.length - 1) : 0;
    this.popup = { from, to, key, items, index };
    this.renderPopup();
  }
  private renderPopup() {
    const popup = this.popup;
    if (!popup) return;
    this.popupDOM.replaceChildren();
    this.popupDOM.hidden = false;
    this.view?.dom.setAttribute('aria-controls', this.popupID);
    this.view?.dom.setAttribute('aria-activedescendant', `${this.popupID}-${popup.index}`);
    popup.items.forEach((item, index) => {
      const button = this.root.ownerDocument.createElement('button');
      button.type = 'button';
      button.id = `${this.popupID}-${index}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === popup.index));
      button.tabIndex = -1;
      button.textContent = item.label;
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        if (this.popup) this.popup.index = index;
        this.acceptPopup();
      });
      this.popupDOM.append(button);
    });
  }
  private acceptPopup() {
    const popup = this.popup;
    const view = this.view;
    if (!popup || !view || !this.editable || this.isComposing) return;
    const item = popup.items[popup.index];
    this.dismissed = popup.key;
    this.hidePopup();
    if (item.command) {
      view.dispatch(view.state.tr.delete(popup.from, popup.to));
      slashCommand(view, item.command);
    } else if (item.markdown) this.insertMarkdown(item.markdown, popup.from, popup.to);
  }
  private hidePopup() {
    this.popup = null;
    this.popupDOM.hidden = true;
    this.view?.dom.removeAttribute('aria-activedescendant');
  }
  destroy() {
    const ready = this.phase.status === 'ready';
    this.phase = { status: 'destroyed' };
    this.hidePopup();
    if (ready) void this.crepe.destroy();
    this.popupDOM.remove();
  }
}
