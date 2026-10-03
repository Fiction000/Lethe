import assert from 'node:assert/strict';
import test from 'node:test';

import { WidgetType } from '@codemirror/view';
import { HRWidget } from '../src/components/Editor/livePreview';

test('horizontal rule widget implements the CodeMirror WidgetType contract', () => {
  const widget = new HRWidget();

  assert.ok(widget instanceof WidgetType);
  assert.equal(widget.eq(new HRWidget()), true);
  assert.equal(widget.eq({} as WidgetType), false);
  assert.equal(widget.estimatedHeight, 17);
  assert.equal(widget.ignoreEvent(new Event('click')), false);
  assert.equal(typeof widget.toDOM, 'function');
});
