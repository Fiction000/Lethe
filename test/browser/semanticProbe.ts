import { Crepe, CrepeFeature } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { TextSelection } from '@milkdown/kit/prose/state';
import { toggleMark } from '@milkdown/kit/prose/commands';
import { undo, redo } from '@milkdown/kit/prose/history';
import { obsidianSyntax } from '../../src/components/Editor/obsidianSyntax';

const features = Object.fromEntries(Object.values(CrepeFeature).map((key) => [key, false]));
export async function create(source: string) {
  const root = document.createElement('section');
  root.className = 'semantic-editor';
  document.body.append(root);
  const engine = new Crepe({ root, defaultValue: source, features });
  engine.editor.use(obsidianSyntax);
  await engine.create();
  const view = engine.editor.action((ctx) => ctx.get(editorViewCtx));
  return {
    engine,
    view,
    root,
    destroy: async () => {
      await engine.destroy();
      root.remove();
    },
  };
}

const fixtures = [
  { name: 'wiki', source: '[[wiki]]', expected: ['wiki'] },
  { name: 'alias-heading', source: '[[note#Heading|alias]]', expected: ['wiki'] },
  { name: 'embed', source: '![[image.png]]', expected: ['embed'] },
  { name: 'tag', source: '#タグ/test', expected: ['tag'] },
  { name: 'callout', source: '> [!NOTE] title\n> body', expected: ['callout'] },
  { name: 'checklist', source: '- [ ] todo\n- [x] done', expected: [] },
  { name: 'escaped-wiki', source: '\\[[literal]]', expected: ['literal'] },
  { name: 'escaped-tag', source: '\\#not-a-tag', expected: ['literal'] },
  {
    name: 'mixed',
    source: '[[active]] and \\[[literal]] #active \\#literal',
    expected: ['wiki', 'literal', 'tag', 'literal'],
  },
  { name: 'inline-code', source: '`[[literal]] #code [!NOTE]`', expected: [] },
  { name: 'fenced-code', source: '```md\n[[literal]] #code [!NOTE]\n```', expected: [] },
  { name: 'bold-wiki', source: '**[[note]]**', expected: ['wiki'] },
];
function kinds(view: Awaited<ReturnType<typeof create>>['view']) {
  const values: string[] = [];
  view.state.doc.descendants((node) => {
    if (node.isText)
      node.marks.filter((mark) => mark.type.name === 'letheObsidian').forEach((mark) => values.push(mark.attrs.kind));
  });
  return values;
}
export async function matrix() {
  const results = [];
  for (const fixture of fixtures) {
    const editor = await create(fixture.source);
    try {
      const before = editor.engine.getMarkdown();
      const initialKinds = kinds(editor.view);
      let end = 1;
      editor.view.state.doc.descendants((node, pos) => {
        if (node.isTextblock) end = pos + 1 + node.content.size;
      });
      editor.view.dispatch(editor.view.state.tr.insertText(' X', end));
      const edited = editor.engine.getMarkdown();
      const reparsed = await create(edited);
      try {
        results.push({
          name: fixture.name,
          source: fixture.source,
          before,
          initialKinds,
          edited,
          parsedKinds: kinds(reparsed.view),
          expected: fixture.expected,
          pass:
            JSON.stringify(initialKinds) === JSON.stringify(fixture.expected) &&
            JSON.stringify(kinds(reparsed.view)) === JSON.stringify(fixture.expected) &&
            edited.includes('X'),
        });
      } finally {
        await reparsed.destroy();
      }
    } finally {
      await editor.destroy();
    }
  }
  for (const text of ['a', 'ab', '#tag', '[[wiki]]', 'hello [[note]]']) {
    const editor = await create('');
    try {
      const steps = [];
      for (const character of text) {
        editor.view.dispatch(editor.view.state.tr.insertText(character));
        steps.push({ character, saved: editor.engine.getMarkdown() });
      }
      const saved = editor.engine.getMarkdown();
      results.push({ name: `typing-${text}`, saved, steps, pass: saved.trimEnd() === text });
    } finally {
      await editor.destroy();
    }
  }
  return results;
}
Object.assign(window, { semanticProbe: { create, matrix, TextSelection, toggleMark, undo, redo, kinds } });
