import { MilkdownEngine, type EngineOptions } from '../../src/components/Editor/milkdownEngine';
import { findFormatCommand, applyFormatCommand } from '../../src/components/Editor/milkdownCommands';
import { TextSelection } from '@milkdown/kit/prose/state';
import { undo, redo } from '@milkdown/kit/prose/history';
import { matrix } from './semanticProbe';

export async function actor(source = '') {
  const root = document.createElement('div');
  root.className = 'common-editor-wrapper';
  document.body.append(root);
  const changes: string[] = [];
  const compositions: boolean[] = [];
  const options: EngineOptions = {
    initialContent: source,
    placeholder: 'Capture Markdown',
    editable: true,
    onChange: (value) => changes.push(value),
    onComposition: (value) => compositions.push(value),
    onKeyDown: (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return false;
      const id = findFormatCommand(event.key, event.shiftKey);
      return id ? applyFormatCommand(engine.view!, id) : false;
    },
    onEscape: () => true,
    onFocusEscape: () => false,
    onPaste: () => false,
    onDrop: () => false,
    suggestions: (kind, query) =>
      kind === 'wiki'
        ? [{ label: 'Folder/Fixture.md', markdown: '[[Folder/Fixture]]' }].filter((item) =>
            item.label.toLowerCase().includes(query.toLowerCase()),
          )
        : [{ label: '#fixture', markdown: '#fixture ' }],
  };
  const engine = new MilkdownEngine(root, () => options);
  await engine.ready;
  engine.focus();
  return {
    engine,
    root,
    changes,
    compositions,
    destroy: () => {
      engine.destroy();
      root.remove();
    },
  };
}
export async function invariants() {
  const results = [];
  const a = await actor('alpha');
  const b = await actor('beta');
  try {
    const view = a.engine.view!;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    applyFormatCommand(view, 'bold');
    const bold = a.engine.getContent();
    applyFormatCommand(view, 'bold');
    const normal = a.engine.getContent();
    applyFormatCommand(view, 'italic');
    const italic = a.engine.getContent();
    results.push({
      name: 'real-mark-toggles',
      bold,
      normal,
      italic,
      pass: bold.trim() === '**alpha**' && normal.trim() === 'alpha' && italic.trim() === '*alpha*',
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)).insertText(' X'));
    const changed = a.engine.getContent();
    undo(view.state, view.dispatch);
    const undone = a.engine.getContent();
    redo(view.state, view.dispatch);
    const redone = a.engine.getContent();
    results.push({ name: 'history', changed, undone, redone, pass: changed === redone && changed !== undone });
    const independent = b.engine.getContent();
    results.push({
      name: 'independent-views',
      independent,
      pass: independent.trim() === 'beta' && b.changes.length === 0,
    });
    a.engine.setEditable(false);
    const locked = a.engine.getContent();
    view.dispatch(view.state.tr.insertText('FORBIDDEN'));
    const lockResult = a.engine.getContent();
    results.push({
      name: 'synchronous-lock',
      dom: view.dom.getAttribute('contenteditable'),
      locked,
      lockResult,
      pass: view.dom.getAttribute('contenteditable') === 'false' && locked === lockResult,
    });
    a.engine.setContent('programmatic reset');
    results.push({
      name: 'authorized-reset',
      saved: a.engine.getContent(),
      pass: a.engine.getContent().trim() === 'programmatic reset',
    });
  } finally {
    a.destroy();
    b.destroy();
  }
  const root = document.createElement('div');
  document.body.append(root);
  const pending = new MilkdownEngine(root, () => ({
    initialContent: 'initial',
    placeholder: 'x',
    editable: true,
    onChange: () => undefined,
    onKeyDown: () => false,
    onEscape: () => false,
    onFocusEscape: () => false,
    onPaste: () => false,
    onDrop: () => false,
    onComposition: () => undefined,
    suggestions: () => [],
  }));
  pending.setContent('pending replacement');
  pending.focus();
  pending.setEditable(false);
  await pending.ready;
  results.push({
    name: 'pending-intents',
    saved: pending.getContent(),
    editable: pending.view?.editable,
    pass: pending.getContent().trim() === 'pending replacement' && pending.view?.editable === false,
  });
  pending.destroy();
  root.remove();
  const racingRoot = document.createElement('div');
  document.body.append(racingRoot);
  const racing = new MilkdownEngine(racingRoot, () => ({
    initialContent: 'late',
    placeholder: 'x',
    editable: true,
    onChange: () => undefined,
    onKeyDown: () => false,
    onEscape: () => false,
    onFocusEscape: () => false,
    onPaste: () => false,
    onDrop: () => false,
    onComposition: () => undefined,
    suggestions: () => [],
  }));
  racing.destroy();
  await racing.ready;
  results.push({
    name: 'late-create-dispose',
    pass: !racing.isReady && racingRoot.querySelector('.ProseMirror') === null,
  });
  racingRoot.remove();
  return results;
}
Object.assign(window, { engineProbe: { actor, invariants, matrix, TextSelection } });
