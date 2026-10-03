import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { Range, EditorState } from '@codemirror/state';

/**
 * Live Preview plugin — hides markdown syntax markers when the cursor
 * is not on the same line, creating an Obsidian-style WYSIWYG experience.
 *
 * When cursor IS on a line: raw markdown shown (for editing)
 * When cursor is NOT on a line: syntax hidden, content styled
 */
function buildDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const { head } = state.selection.main;
  const cursorLine = state.doc.lineAt(head).number;

  syntaxTree(state).iterate({
    enter(node) {
      // Get the line range this node spans
      const fromLine = state.doc.lineAt(node.from).number;
      const toLine = state.doc.lineAt(node.to).number;

      // If cursor is on any line this node spans, show raw markdown
      if (cursorLine >= fromLine && cursorLine <= toLine) {
        return; // Don't hide anything on cursor's line(s)
      }

      switch (node.name) {
        case 'HeaderMark': {
          // Hide # symbols and the space after them
          let hideEnd = node.to;
          const line = state.doc.lineAt(node.from);
          const afterMark = node.to - line.from;
          if (afterMark < line.text.length && line.text[afterMark] === ' ') {
            hideEnd = node.to + 1;
          }
          decorations.push(Decoration.replace({}).range(node.from, hideEnd));
          break;
        }

        case 'EmphasisMark': {
          // Hide * or ** markers for italic/bold
          decorations.push(Decoration.replace({}).range(node.from, node.to));
          break;
        }

        case 'CodeMark': {
          // Hide ` markers for inline code
          decorations.push(Decoration.replace({}).range(node.from, node.to));
          break;
        }

        case 'StrikethroughMark': {
          // Hide ~~ markers for strikethrough
          decorations.push(Decoration.replace({}).range(node.from, node.to));
          break;
        }

        case 'QuoteMark': {
          // Hide > marker for blockquotes
          let hideEnd = node.to;
          const qline = state.doc.lineAt(node.from);
          const afterQ = node.to - qline.from;
          if (afterQ < qline.text.length && qline.text[afterQ] === ' ') {
            hideEnd = node.to + 1;
          }
          decorations.push(Decoration.replace({}).range(node.from, hideEnd));
          break;
        }

        case 'HorizontalRule': {
          // Replace --- with a visual <hr>
          decorations.push(
            Decoration.replace({
              widget: new HRWidget(),
            }).range(node.from, node.to),
          );
          break;
        }
      }
    },
  });

  // Decorations must be sorted by position
  return Decoration.set(decorations, true);
}

/** Simple horizontal rule widget */
export class HRWidget extends WidgetType {
  eq(widget: WidgetType): boolean {
    return widget instanceof HRWidget;
  }

  toDOM(_view: EditorView): HTMLElement {
    const hr = document.createElement('hr');
    hr.style.border = 'none';
    hr.style.borderTop = '1px solid var(--color-border)';
    hr.style.margin = '8px 0';
    return hr;
  }

  get estimatedHeight(): number {
    return 17;
  }

  ignoreEvent(_event: Event): boolean {
    return false;
  }
}

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.state);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);
