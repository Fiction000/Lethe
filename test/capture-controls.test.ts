import assert from 'node:assert/strict';
import test from 'node:test';

import { getProfileRadioNextIndex, getSendShortcutLabels } from '../src/components/captureControls';

test('profile radio navigation wraps in either direction and supports Home and End', () => {
  assert.equal(getProfileRadioNextIndex(0, 'ArrowRight', 4), 1);
  assert.equal(getProfileRadioNextIndex(3, 'ArrowRight', 4), 0);
  assert.equal(getProfileRadioNextIndex(0, 'ArrowDown', 4), 1);
  assert.equal(getProfileRadioNextIndex(0, 'ArrowLeft', 4), 3);
  assert.equal(getProfileRadioNextIndex(3, 'ArrowUp', 4), 2);
  assert.equal(getProfileRadioNextIndex(2, 'Home', 4), 0);
  assert.equal(getProfileRadioNextIndex(1, 'End', 4), 3);
  assert.equal(getProfileRadioNextIndex(1, 'Escape', 4), undefined);
  assert.equal(getProfileRadioNextIndex(0, 'ArrowRight', 0), undefined);
});

test('shows platform-correct Send shortcut labels', () => {
  assert.deepEqual(getSendShortcutLabels(true), { key: '⌘↵', title: 'Send (⌘+Enter)' });
  assert.deepEqual(getSendShortcutLabels(false), { key: 'Ctrl↵', title: 'Send (Ctrl+Enter)' });
});
