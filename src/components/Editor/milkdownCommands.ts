import { toggleMark, setBlockType, wrapIn } from '@milkdown/kit/prose/commands';
import { wrapInList } from '@milkdown/kit/prose/schema-list';
import type { Command } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';

export const formattingCommands = {
  bold: { key: 'b', shift: false, label: 'Bold', mark: 'strong' },
  italic: { key: 'i', shift: false, label: 'Italic', mark: 'emphasis' },
  link: { key: 'k', shift: false, label: 'Link', mark: 'link' },
  code: { key: 'e', shift: false, label: 'Inline code', mark: 'inlineCode' },
  strikethrough: { key: 'x', shift: true, label: 'Strikethrough', mark: 'strike_through' },
} as const;
export type FormatCommandId = keyof typeof formattingCommands;
export const slashCommands = [
  { id: 'heading', label: 'Heading' },
  { id: 'bullet', label: 'Bullet list' },
  { id: 'ordered', label: 'Numbered list' },
  { id: 'task', label: 'Checklist' },
  { id: 'quote', label: 'Quote' },
  { id: 'code-block', label: 'Code block' },
] as const;
export type SlashCommandId = typeof slashCommands[number]['id'];
export function findFormatCommand(key: string, shift: boolean): FormatCommandId | undefined {
  return (Object.keys(formattingCommands) as FormatCommandId[]).find(
    (id) => formattingCommands[id].key === key.toLowerCase() && formattingCommands[id].shift === shift,
  );
}
export function applyFormatCommand(view: EditorView, id: FormatCommandId): boolean {
  if (view.composing || !view.editable) return false;
  const type = view.state.schema.marks[formattingCommands[id].mark];
  if (!type) return false;
  if (
    id === 'link' &&
    !view.state.selection.empty &&
    !view.state.doc.rangeHasMark(view.state.selection.from, view.state.selection.to, type)
  ) {
    const text = view.state.doc.textBetween(view.state.selection.from, view.state.selection.to);
    const href = /^https?:\/\//i.test(text) ? text : 'https://';
    view.dispatch(view.state.tr.addMark(view.state.selection.from, view.state.selection.to, type.create({ href })));
    view.focus();
    return true;
  }
  const applied = toggleMark(type)(view.state, view.dispatch, view);
  if (applied) view.focus();
  return applied;
}
export function slashCommand(view: EditorView, id: SlashCommandId): boolean {
  const nodes = view.state.schema.nodes;
  const command: Command =
    id === 'heading'
      ? setBlockType(nodes.heading, { level: 2 })
      : id === 'code-block'
      ? setBlockType(nodes.code_block)
      : id === 'quote'
      ? wrapIn(nodes.blockquote)
      : wrapInList(id === 'ordered' ? nodes.ordered_list : nodes.bullet_list);
  if (!command(view.state, view.dispatch, view)) return false;
  if (id === 'task') {
    const { $from } = view.state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      if ($from.node(depth).type.name === 'list_item') {
        view.dispatch(
          view.state.tr.setNodeMarkup($from.before(depth), undefined, { ...$from.node(depth).attrs, checked: false }),
        );
        break;
      }
    }
  }
  view.focus();
  return true;
}
