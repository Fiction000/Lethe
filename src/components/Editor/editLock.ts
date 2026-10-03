import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export interface EditorEditLock {
  readonly extension: Extension;
  setEditable(editable: boolean): readonly StateEffect<unknown>[];
}

/** Keep CM6's DOM editability and command-level read-only state in sync. */
export function createEditorEditLock(): EditorEditLock {
  const editableCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  return {
    extension: [
      editableCompartment.of(EditorView.editable.of(true)),
      readOnlyCompartment.of(EditorState.readOnly.of(false)),
    ],
    setEditable: (editable: boolean) => [
      editableCompartment.reconfigure(EditorView.editable.of(editable)),
      readOnlyCompartment.reconfigure(EditorState.readOnly.of(!editable)),
    ],
  };
}
