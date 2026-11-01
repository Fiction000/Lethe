import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { obsidianRemark } from '../../src/components/Editor/obsidianSyntax';
import { syntaxSpans } from '../../src/components/Editor/obsidianTokens';

test('Obsidian syntax distinguishes active tokens from intentional literals', () => {
  const value = '[[note#Heading|alias]] ![[image.png]] #タグ \\[[literal]] \\#literal';
  assert.deepEqual(
    syntaxSpans(value, { blockquoteStart: true }).map(({ from, to, kind }) => [value.slice(from, to), kind]),
    [
      ['[[note#Heading|alias]]', 'wiki'],
      ['![[image.png]]', 'embed'],
      ['#タグ', 'tag'],
      ['\\[[literal]]', 'literal'],
      ['\\#literal', 'literal'],
    ],
  );
});

test('callout markers require blockquote-start context', () => {
  const prose = 'This document uses [!NOTE] markers.';
  assert.deepEqual(syntaxSpans(prose), []);
  assert.equal(syntaxSpans('[!NOTE]', { blockquoteStart: true })[0]?.kind, 'callout');
  assert.deepEqual(
    syntaxSpans('[!NOTE] body [!TIP]', { blockquoteStart: true }).map(({ kind }) => kind),
    ['callout'],
  );
  assert.deepEqual(syntaxSpans('&#91;!NOTE]', { blockquoteStart: true }), []);
});

test('pending syntax and URL fragments are not completed tags or links', () => {
  assert.deepEqual(syntaxSpans('[[ a#fragment https://example.test/#anchor #123'), []);
  assert.equal(syntaxSpans('#tag')[0]?.kind, 'tag');
  assert.equal(syntaxSpans('日本語 #階層/タグ')[0]?.kind, 'tag');
});

// Resolve remark from Milkdown's transformer: this is a framework-owned dependency.
async function productionRemark() {
  const require = createRequire(new URL('../../node_modules/@milkdown/transformer/package.json', import.meta.url));
  const { remark } = require('remark');
  const remarkStringify = require('remark-stringify').default;
  let rawPlugin: ((...args: unknown[]) => unknown) | undefined;
  const ctx = {
    wait: async () => undefined,
    get: () => undefined,
    update: (_key: unknown, update: (plugins: unknown[]) => unknown[]) => {
      const registered = update([]) as Array<{ plugin?: typeof rawPlugin }>;
      if (registered.some((item) => item.plugin)) rawPlugin = registered.find((item) => item.plugin)?.plugin;
    },
  };
  const cleanup = await obsidianRemark.plugin(ctx as never)();
  return { processor: remark().use(rawPlugin).use(remarkStringify), cleanup };
}

test('production remark preserves callout scope across sibling AST nodes', async () => {
  const { processor, cleanup } = await productionRemark();
  try {
    const cases: Array<[string, boolean]> = [
      ['This document uses [!NOTE] markers.', false],
      ['> [!NOTE] title', true],
      ['> **bold**[!NOTE] markers.', false],
      ['> [label](https://example.test)[!NOTE] markers.', false],
      ['> ![image](https://example.test/image.png)[!NOTE] markers.', false],
      ['> text\n\n> [!TIP] later paragraph', true],
      ['> &#91;!NOTE] entity', false],
      ['> ` [!NOTE] ` code', false],
    ];
    for (const [markdown, expected] of cases) {
      const tree = processor.runSync(processor.parse(markdown), { value: markdown });
      const kinds = JSON.stringify(tree).match(/"kind":"callout"/g)?.length ?? 0;
      assert.equal(kinds > 0, expected, markdown);
      const serialized = String(processor.stringify(tree));
      assert.equal(
        JSON.stringify(processor.parse(serialized)).includes('"type":"blockquote"'),
        markdown.startsWith('>'),
      );
    }
  } finally {
    cleanup?.();
  }
});

test('production remark decodes visible escaped literals but keeps them literal on serialization', async () => {
  const { processor, cleanup } = await productionRemark();
  try {
    for (const [markdown, visible] of [
      [String.raw`\[[literal]]`, '[[literal]]'],
      [String.raw`\#literal`, '#literal'],
      [String.raw`\![[embed]]`, '![[embed]]'],
    ]) {
      const tree = processor.runSync(processor.parse(markdown), { value: markdown });
      const serializedTree = JSON.stringify(tree);
      assert.ok(serializedTree.includes(`"value":"${visible}"`), serializedTree);
      assert.ok(serializedTree.includes('"kind":"literal"'), serializedTree);
      const serialized = String(processor.stringify(tree));
      assert.ok(serialized.startsWith('\\'), serialized);
      const reparsed = processor.runSync(processor.parse(serialized), { value: serialized });
      assert.ok(JSON.stringify(reparsed).includes('"kind":"literal"'), serialized);
    }
  } finally {
    cleanup?.();
  }
});
