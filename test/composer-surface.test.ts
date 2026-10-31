import assert from 'node:assert/strict';
import test from 'node:test';
import { availableNativeNoteSearch, openNativeNoteSearch } from '../src/capture/nativeSearch';

import {
  composerPlaceholder,
  composerSectionOrder,
  formatCaptureAge,
  recentRowAction,
  shouldOfferKeepProfile,
  shouldShowMemosShell,
  noteWriteLabel,
} from '../src/capture/composerSurface';

test('puts the writing surface before send, then metadata, and omits the stream in Quick Capture', () => {
  assert.deepEqual(composerSectionOrder('main'), ['editor', 'action', 'details', 'recent']);
  assert.deepEqual(composerSectionOrder('quick'), ['editor', 'action', 'details']);
});

test('hides the memo shell only on the writing surface', () => {
  assert.equal(shouldShowMemosShell('/', false), false);
  assert.equal(shouldShowMemosShell('/', true), true);
  assert.equal(shouldShowMemosShell('/setting', false), true);
  assert.equal(shouldShowMemosShell('/recycle', false), true);
  assert.equal(shouldShowMemosShell('/timeline', false), true);
});

test('offers Keep profile for the active Book or Movie profile', () => {
  assert.equal(shouldOfferKeepProfile(undefined), false);
  assert.equal(shouldOfferKeepProfile('auto'), false);
  assert.equal(shouldOfferKeepProfile('plain'), false);
  assert.equal(shouldOfferKeepProfile('book'), true);
  assert.equal(shouldOfferKeepProfile('movie'), true);
});

test('shows a recent action only when a person needs to act', () => {
  assert.equal(recentRowAction('written', 'skipped'), undefined);
  assert.equal(recentRowAction('written', undefined), undefined);
  assert.equal(recentRowAction('written', 'applied'), 'undo');
  assert.equal(recentRowAction('failed', undefined), 'retry');
  assert.equal(recentRowAction('pending', undefined), 'retry');
  for (const organization of [undefined, 'failed', 'queued', 'applied'] as const) {
    assert.equal(recentRowAction('conflict', organization), undefined);
  }
  assert.equal(recentRowAction('written', 'failed'), 'retry');
  assert.equal(recentRowAction('written', 'queued'), 'skip');
});

test('formats a capture age without a receipt sentence', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');
  assert.equal(formatCaptureAge('2026-10-18T12:00:00.000Z', now), 'just now');
  assert.equal(formatCaptureAge('2026-10-18T11:49:00.000Z', now), '11m');
  assert.equal(formatCaptureAge('2026-10-18T10:00:00.000Z', now), '2h');
  assert.equal(formatCaptureAge('not-a-date', now), '');
});

test('names the send shortcut in the placeholder', () => {
  assert.equal(composerPlaceholder(true), 'Write. Cmd+Enter sends.');
  assert.equal(composerPlaceholder(false), 'Write. Ctrl+Enter sends.');
});

test('keeps durable capture acceptance distinct from a written note', () => {
  assert.equal(noteWriteLabel('pending'), 'Queued');
  assert.equal(noteWriteLabel('written'), 'Saved');
  assert.equal(noteWriteLabel('failed'), 'Write failed');
  assert.equal(noteWriteLabel('conflict'), 'Write conflict');
  assert.equal(noteWriteLabel('deleted'), 'Note deleted');
  assert.equal(noteWriteLabel('not-started'), 'Waiting to write');
});

test('uses only registered native note search commands and reports a missing bridge', () => {
  const executed: string[] = [];
  const commands = {
    findCommand: (id: string) => (id === 'switcher:open' ? { id } : null),
    executeCommandById: (id: string) => {
      executed.push(id);
      return true;
    },
  };
  assert.equal(availableNativeNoteSearch(commands), 'switcher:open');
  assert.equal(openNativeNoteSearch(commands), true);
  assert.deepEqual(executed, ['switcher:open']);
  assert.equal(availableNativeNoteSearch({ findCommand: () => null, executeCommandById: () => false }), undefined);
});

test('reports registered native search failures without throwing', () => {
  for (const id of ['global-search:open', 'switcher:open']) {
    for (const throws of [false, true]) {
      const commands = {
        findCommand: (candidate: string) => candidate === id,
        executeCommandById: () => {
          if (throws) throw new Error('search launch failed');
          return false;
        },
      };
      assert.equal(availableNativeNoteSearch(commands), id);
      assert.equal(openNativeNoteSearch(commands), false);
    }
  }
});
