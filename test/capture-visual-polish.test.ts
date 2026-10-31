import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import less from 'less';
import postcss from 'postcss';

const stylesheetPath = path.resolve('src/less/capture-composer.less');

async function compiledRules() {
  const source = await readFile(stylesheetPath, 'utf8');
  const { css } = await less.render(source, { filename: stylesheetPath });
  return postcss.parse(css).nodes.filter((node): node is postcss.Rule => node.type === 'rule');
}

function declarations(rules: postcss.Rule[], selectorPart: string) {
  const matching = rules.filter((candidate) =>
    candidate.selector.split(',').some((selector) => selector.trim() === selectorPart),
  );
  assert.ok(matching.length, `compiled CSS should include ${selectorPart}`);
  return Object.assign(
    {},
    ...matching.map((rule) =>
      Object.fromEntries(
        rule.nodes
          .filter((node): node is postcss.Declaration => node.type === 'decl')
          .map(({ prop, value }) => [prop, value]),
      ),
    ),
  );
}

test('keeps every recent title on the same left edge while preserving narrow ellipsis', async () => {
  const rules = await compiledRules();
  const button = declarations(rules, ".capture-composer .capture-composer__recent-open[type='button']");
  const title = declarations(rules, '.capture-composer__recent-title');
  const path = declarations(rules, '.capture-composer__recent-path');
  const header = declarations(rules, '.capture-composer__recent-header');

  assert.equal(header['flex-wrap'], 'wrap');
  assert.equal(header['min-width'], '0');
  assert.equal(button['grid-template-columns'], 'minmax(0, 1fr)');
  assert.equal(button['justify-content'], 'stretch');
  assert.equal(button['justify-items'], 'start');
  assert.equal(button['min-width'], '0');
  assert.equal(button['text-align'], 'left');
  assert.equal(title['text-overflow'], 'ellipsis');
  assert.equal(path['text-overflow'], 'ellipsis');
  assert.equal(path.color, 'var(--text-muted)');
});

test('gives the capture editor a persistent native-contrast boundary and an instant focus indicator', async () => {
  const rules = await compiledRules();
  const editor = declarations(rules, '.capture-composer .common-editor-wrapper .cm-editor');
  const content = declarations(rules, '.capture-composer .common-editor-wrapper .cm-content');
  const focus = declarations(rules, '.capture-composer .common-editor-wrapper .cm-content:focus-visible');

  assert.equal(editor.border, '1px solid var(--text-normal)');
  assert.equal(content.padding, 'var(--size-4-3) var(--size-4-3) var(--size-4-5)');
  assert.equal(focus.outline, '2px solid var(--text-normal)');
  assert.equal(focus['outline-offset'], '2px');
  assert.equal(focus.transition, undefined);
});

test('gives disabled recent items legible state channels and pressed feedback', async () => {
  const rules = await compiledRules();
  const disabled = declarations(rules, ".capture-composer .capture-composer__recent-open[type='button']:disabled");
  const active = declarations(rules, '.capture-composer .capture-composer__recent-open:active:not(:disabled)');

  assert.equal(disabled.color, 'var(--text-muted)');
  assert.equal(disabled['background-color'], 'var(--background-primary)');
  assert.equal(disabled.cursor, 'default');
  assert.ok(active['background-color']);
});
