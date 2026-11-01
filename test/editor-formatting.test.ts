import assert from 'node:assert/strict';
import test from 'node:test';
import { history, redo, undo, undoDepth } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  applyFormatCommand,
  findFormatCommand,
  formatTransaction,
  formattingCommands,
  type FormatCommandId,
} from '../src/components/Editor/formattingCommands';

const ids = Object.keys(formattingCommands) as FormatCommandId[];

test('the shared registry exposes all five existing shortcut bindings', () => {
  assert.deepEqual(ids, ['bold', 'italic', 'link', 'code', 'strikethrough']);
  assert.deepEqual(
    ids.map((id) => findFormatCommand(formattingCommands[id].key, formattingCommands[id].shift)),
    ids,
  );
  assert.equal(findFormatCommand('x', false), undefined);
  assert.equal(findFormatCommand('b', true), undefined);
});

test('each command wraps a non-empty selection literally and selects the complete Markdown result', () => {
  for (const id of ids) {
    const state = EditorState.create({ doc: 'A B [[Note]] #tag  ' });
    const selected = state.update({ selection: { anchor: 2, head: 10 } }).state;
    const transaction = selected.update(formatTransaction(selected, id));
    const command = formattingCommands[id];
    const expected = `A ${command.before}B [[Note${command.after}]] #tag  `;

    assert.equal(transaction.state.doc.toString(), expected, id);
    assert.equal(
      transaction.state.sliceDoc(transaction.state.selection.main.from, transaction.state.selection.main.to),
      `${command.before}B [[Note${command.after}`,
      id,
    );
    assert.equal(transaction.state.doc.toString().slice(-2), '  ', `${id} preserves trailing spaces`);
  }
});

test('each command inserts its placeholder inside markers when the selection is empty', () => {
  for (const id of ids) {
    const state = EditorState.create({ doc: 'left right', selection: { anchor: 4 } });
    const transaction = state.update(formatTransaction(state, id));
    const command = formattingCommands[id];
    const expected = `left${command.before}${command.placeholder}${command.after} right`;
    const selected = transaction.state.selection.main;

    assert.equal(transaction.state.doc.toString(), expected, id);
    assert.equal(transaction.state.sliceDoc(selected.from, selected.to), command.placeholder, id);
  }
});

test('format is a separate history event: one undo restores the original and redo reapplies it', () => {
  let state = EditorState.create({ doc: 'Draft', selection: { anchor: 0, head: 5 }, extensions: [history()] });
  const fakeView = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState['update']>[0]) {
      state = state.update(spec).state;
    },
    composing: false,
    focusCount: 0,
    focus() {
      this.focusCount += 1;
    },
  };
  fakeView.dispatch({ changes: { from: 5, insert: ' typed' } });
  state = state.update({ selection: { anchor: 0, head: 5 } }).state;
  const view = fakeView as unknown as EditorView;

  assert.equal(applyFormatCommand(view, 'bold'), true);
  assert.equal(state.doc.toString(), '**Draft** typed');
  assert.equal(fakeView.focusCount, 1);
  assert.equal(undoDepth(state), 2);
  assert.equal(undo(view), true);
  assert.equal(state.doc.toString(), 'Draft typed');
  assert.equal(redo(view), true);
  assert.equal(state.doc.toString(), '**Draft** typed');
});

test('locked, read-only, and composing views reject formatting without dispatching or stealing focus', () => {
  for (const mode of ['locked', 'readOnly', 'composing'] as const) {
    const extensions =
      mode === 'readOnly' ? [EditorState.readOnly.of(true)] : mode === 'locked' ? [EditorView.editable.of(false)] : [];
    const state = EditorState.create({ doc: 'Draft', extensions });
    let dispatches = 0;
    let focuses = 0;
    const view = {
      state,
      composing: mode === 'composing',
      dispatch() {
        dispatches += 1;
      },
      focus() {
        focuses += 1;
      },
    } as unknown as EditorView;

    assert.equal(applyFormatCommand(view, 'italic'), false, mode);
    assert.equal(dispatches, 0, mode);
    assert.equal(focuses, 0, mode);
  }
});
