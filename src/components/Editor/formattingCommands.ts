import { isolateHistory } from '@codemirror/commands';
import { EditorState, type EditorSelection, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export const formattingCommands = {
  bold: { key: 'b', shift: false, before: '**', after: '**', placeholder: 'bold text' },
  italic: { key: 'i', shift: false, before: '*', after: '*', placeholder: 'italic text' },
  link: { key: 'k', shift: false, before: '[', after: ']()', placeholder: 'link text' },
  code: { key: 'e', shift: false, before: '`', after: '`', placeholder: 'code' },
  strikethrough: { key: 'x', shift: true, before: '~~', after: '~~', placeholder: 'strikethrough' },
} as const;

export type FormatCommandId = keyof typeof formattingCommands;

export function findFormatCommand(key: string, shift: boolean): FormatCommandId | undefined {
  return (Object.keys(formattingCommands) as FormatCommandId[]).find((id) => {
    const command = formattingCommands[id];
    return command.key === key.toLowerCase() && command.shift === shift;
  });
}

export function formatTransaction(
  state: EditorState,
  id: FormatCommandId,
  selection: EditorSelection = state.selection,
): TransactionSpec {
  const command = formattingCommands[id];
  const { from, to } = selection.main;
  const selectedText = state.sliceDoc(from, to);
  const textToWrap = selectedText || command.placeholder;
  const wrapped = command.before + textToWrap + command.after;

  return {
    changes: { from, to, insert: wrapped },
    selection: selectedText
      ? { anchor: from, head: from + wrapped.length }
      : { anchor: from + command.before.length, head: from + command.before.length + textToWrap.length },
    annotations: isolateHistory.of('full'),
  };
}

export function applyFormatCommand(
  view: EditorView,
  id: FormatCommandId,
  selection: EditorSelection = view.state.selection,
): boolean {
  if (view.composing || view.state.facet(EditorState.readOnly) || !view.state.facet(EditorView.editable)) return false;
  view.dispatch(formatTransaction(view.state, id, selection));
  view.focus();
  return true;
}
