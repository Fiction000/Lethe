import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/components/LegacyMemoEditor.tsx', import.meta.url), 'utf8');
const componentStart = source.indexOf('const LegacyMemoEditor: React.FC<Props> =');
const componentEnd = source.indexOf('\nfunction getEditorContentCache()', componentStart);
const component = source.slice(componentStart, componentEnd);

test('main and Quick Capture keep task/list selection independent per editor instance', () => {
  assert.doesNotMatch(source, /^let isList\s*:/mu);
  assert.match(component, /const \[isListShown, setIsListShown\] = useState\(DefaultPrefix !== 'List'\);/u);
  assert.match(component, /setIsListShown\(\(current\) => !current\)/u);
  assert.match(component, /setIsListShown\(true\)/u);
  assert.match(component, /memoService\.createMemo\(content, isListShown, selectedTags\)/u);
});
