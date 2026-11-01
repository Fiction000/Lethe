import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import less from 'less';

const stylesheetPath = path.resolve('src/less/capture-composer.less');
const testPath = path.resolve('test/capture-visual-polish.test.ts');

interface LessSelector {
  toCSS: (context: object) => string;
}

interface LessDeclaration {
  type: 'Declaration';
  name: Array<{ value: string }>;
  value: { toCSS: (context: object) => string };
}

interface LessRuleSet {
  type: 'Ruleset';
  selectors: LessSelector[];
  rules: Array<LessDeclaration | { type: string }>;
}

interface LessRoot {
  rules: Array<LessRuleSet | { type: string }>;
}

function isRuleSet(node: LessRoot['rules'][number]): node is LessRuleSet {
  return (
    node.type === 'Ruleset' &&
    'selectors' in node &&
    Array.isArray(node.selectors) &&
    'rules' in node &&
    Array.isArray(node.rules)
  );
}

function isDeclaration(node: LessRuleSet['rules'][number]): node is LessDeclaration {
  return node.type === 'Declaration' && 'name' in node && Array.isArray(node.name) && 'value' in node;
}

async function compiledRules() {
  const source = await readFile(stylesheetPath, 'utf8');
  const { css } = await less.render(source, { filename: stylesheetPath });
  const root = (await less.parse(css, { filename: stylesheetPath })) as LessRoot;
  return root.rules.filter(isRuleSet);
}

function selectors(rule: LessRuleSet) {
  return rule.selectors.map((selector) => selector.toCSS({}).trim());
}

function declarations(rules: Awaited<ReturnType<typeof compiledRules>>, selectorPart: string) {
  const matching = rules.filter((candidate) => selectors(candidate).includes(selectorPart));
  assert.ok(matching.length, `compiled CSS should include ${selectorPart}`);
  return Object.assign(
    {},
    ...matching.map((rule) =>
      Object.fromEntries(
        rule.rules.filter(isDeclaration).map((declaration) => [declaration.name[0].value, declaration.value.toCSS({})]),
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
  assert.equal(button['justify-items'], 'stretch');
  assert.equal(button['min-width'], '0');
  assert.equal(button['text-align'], 'left');
  assert.equal(title['text-overflow'], 'ellipsis');
  assert.equal(path['text-overflow'], 'ellipsis');
  assert.equal(path.color, 'var(--text-muted)');
});

test('keeps exactly one editor focus outline on the focused content', async () => {
  const rules = await compiledRules();
  const outlinedTargets = rules.flatMap((rule) =>
    selectors(rule).filter(
      (selector) =>
        (selector === '.capture-composer .common-editor-wrapper .cm-editor:focus-within' ||
          selector === '.capture-composer .common-editor-wrapper .cm-content:focus-visible') &&
        rule.rules.some((node) => isDeclaration(node) && node.name[0].value === 'outline'),
    ),
  );

  assert.deepEqual(outlinedTargets, ['.capture-composer .common-editor-wrapper .cm-content:focus-visible']);
});

test('parses compiled styles without importing undeclared postcss', async () => {
  const source = await readFile(testPath, 'utf8');
  assert.doesNotMatch(source, /from ['"]postcss['"]/);
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

test('constrains the format menu and row to their local editor width', async () => {
  const rules = await compiledRules();
  const menu = declarations(rules, '.capture-composer .lethe-format-menu');
  const row = declarations(rules, '.capture-composer .lethe-format-row');

  assert.equal(menu.width, 'min(15rem, 100%)');
  assert.equal(menu['min-width'], 'min(11.25rem, 100%)');
  assert.equal(row.width, '100%');
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
