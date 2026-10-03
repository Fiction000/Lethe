import assert from 'node:assert/strict';
import test from 'node:test';

import { createCaptureId, createDraftSnapshot, type CaptureSnapshot } from '../src/capture/core';
import { OrganizationExecutor, type FrontmatterPort, type OrganizationVaultPort } from '../src/organization/executor';
import type { OrganizationDecision } from '../src/organization/types';

class JsonFrontmatterPort implements FrontmatterPort {
  public parseCalls = 0;

  public parse(content: string) {
    this.parseCalls += 1;
    if (!content.startsWith('---\n')) {
      throw new Error('frontmatter missing');
    }
    const close = content.indexOf('\n---\n', 4);
    if (close < 0) {
      throw new Error('frontmatter unterminated');
    }
    const raw = content.slice(4, close);
    const frontmatter = JSON.parse(raw) as Record<string, unknown>;
    return { frontmatter, body: content.slice(close + 5) };
  }

  public serialize(document: { frontmatter: Readonly<Record<string, unknown>>; body: string }): string {
    return `---\n${JSON.stringify(document.frontmatter)}\n---\n${document.body}`;
  }
}

class FakeVault implements OrganizationVaultPort {
  public readonly files = new Map<string, string>();
  public readonly writes: Array<{ path: string; content: string }> = [];
  public readonly renames: Array<{ from: string; to: string }> = [];
  public failRenameAfterMove = false;
  public failWrite = false;

  public async list(folder: string): Promise<readonly string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(`${folder}/`));
  }

  public async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  public async write(path: string, content: string): Promise<void> {
    if (this.failWrite) {
      this.failWrite = false;
      throw new Error('temporary write failure');
    }
    if (!this.files.has(path)) {
      throw new Error(`missing file: ${path}`);
    }
    this.writes.push({ path, content });
    this.files.set(path, content);
  }

  public async rename(from: string, to: string): Promise<void> {
    if (!this.files.has(from)) {
      throw new Error(`missing source: ${from}`);
    }
    if (this.files.has(to)) {
      throw new Error(`target exists: ${to}`);
    }
    const content = this.files.get(from) as string;
    this.files.delete(from);
    this.files.set(to, content);
    this.renames.push({ from, to });
    if (this.failRenameAfterMove) {
      this.failRenameAfterMove = false;
      throw new Error('rename response lost');
    }
  }
}

function snapshot(body = 'body'): CaptureSnapshot {
  return createDraftSnapshot({
    id: createCaptureId(() => 'exec'),
    body,
    now: () => '2026-09-23T00:00:00.000Z',
  });
}

function noteContent(frontmatter: Record<string, unknown>, body = 'body'): string {
  return `---\n${JSON.stringify(frontmatter)}\n---\n${body}`;
}

function decision(properties: Record<string, string | number | boolean> = { author: 'AI' }): OrganizationDecision {
  return { outcome: 'certain', properties, tags: ['ai/suggested'] };
}

async function apply(
  executor: OrganizationExecutor,
  capture: CaptureSnapshot,
  vault: FakeVault,
  path = 'Inbox/body-cap_exec.md',
  selectedDecision = decision(),
) {
  const content = (await vault.read(path)) as string;
  return executor.apply({
    capture,
    baseline: { path, folder: path.startsWith('Notes/') ? 'notes' : 'inbox', content },
    notePath: path,
    decision: selectedDecision,
    overrides: {},
    signal: new AbortController().signal,
  });
}

test('merges metadata through the parser port, preserves exact body and promotes with a safe rename', async () => {
  const capture = snapshot('  exact body\n\n');
  const vault = new FakeVault();
  const frontmatter = new JsonFrontmatterPort();
  const path = 'Inbox/body-cap_exec.md';
  vault.files.set(
    path,
    noteContent(
      {
        lethe_capture_id: capture.id,
        lethe_capture_revision: capture.revision,
        user_field: 'keep',
        tags: ['user/tag'],
        unknown: { nested: true },
      },
      capture.body,
    ),
  );
  const executor = new OrganizationExecutor({
    vault,
    frontmatter,
    inboxFolder: 'Inbox',
    notesFolder: 'Notes',
  });

  const result = await apply(executor, capture, vault);

  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') return;
  assert.equal(result.notePath.startsWith('Notes/'), true);
  const promoted = await vault.read(result.notePath);
  assert.ok(promoted);
  const parsed = frontmatter.parse(promoted);
  assert.equal(parsed.body, capture.body);
  assert.equal(parsed.frontmatter.user_field, 'keep');
  assert.deepEqual(parsed.frontmatter.tags, ['user/tag', 'ai/suggested']);
  assert.deepEqual(parsed.frontmatter.unknown, { nested: true });
  assert.equal(parsed.frontmatter.author, 'AI');
  assert.deepEqual(result.applied.promotion, { from: path, to: result.notePath });
});

test('declines changed note content and never overwrites a user edit', async () => {
  const capture = snapshot();
  const vault = new FakeVault();
  const frontmatter = new JsonFrontmatterPort();
  const path = 'Inbox/body-cap_exec.md';
  vault.files.set(
    path,
    noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0, user: 'changed' }, 'user body'),
  );
  const executor = new OrganizationExecutor({ vault, frontmatter });
  const baseline = noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0, user: 'original' });

  const result = await executor.apply({
    capture,
    baseline: { path, folder: 'inbox', content: baseline },
    notePath: path,
    decision: decision({ generated: 'value' }),
    overrides: {},
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, { status: 'conflict', code: 'changed-baseline', notePath: path });
  assert.equal(vault.writes.length, 0);
  assert.equal(vault.renames.length, 0);
});

test('scans marker matches after a user rename and never recreates a missing source', async () => {
  const capture = snapshot();
  const vault = new FakeVault();
  const frontmatter = new JsonFrontmatterPort();
  const renamed = 'Inbox/user-renamed.md';
  vault.files.set(renamed, noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0 }));
  const executor = new OrganizationExecutor({ vault, frontmatter });
  const result = await executor.apply({
    capture,
    baseline: {
      path: 'Inbox/body-cap_exec.md',
      folder: 'inbox',
      content: noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0 }),
    },
    notePath: 'Inbox/body-cap_exec.md',
    decision: decision({ generated: 'value' }),
    overrides: {},
    signal: new AbortController().signal,
  });

  assert.equal(result.status, 'applied');
  if (result.status !== 'applied') return;
  assert.equal(result.notePath.startsWith('Notes/'), true);
  assert.equal(vault.files.has('Inbox/body-cap_exec.md'), false);
  assert.equal(vault.files.has(renamed), false);
  assert.equal(vault.writes.length, 1);

  const promotedContent = (await vault.read(result.notePath)) as string;
  const deleted = await executor.apply({
    capture,
    baseline: {
      path: result.notePath,
      folder: 'notes',
      content: promotedContent,
    },
    notePath: result.notePath,
    decision: decision({ another: 'value' }),
    overrides: {},
    signal: new AbortController().signal,
  });
  vault.files.delete(result.notePath);
  const afterDelete = await executor.apply({
    capture,
    baseline: {
      path: result.notePath,
      folder: 'notes',
      content: promotedContent,
    },
    notePath: result.notePath,
    decision: decision({ another: 'value' }),
    overrides: {},
    signal: new AbortController().signal,
  });
  assert.equal(deleted.status, 'applied');
  assert.equal(afterDelete.status, 'deleted');
  assert.equal(vault.renames.length, 1);
});

test('uses a collision suffix and reconciles a lost rename response idempotently', async () => {
  const capture = snapshot();
  const vault = new FakeVault();
  const frontmatter = new JsonFrontmatterPort();
  const source = 'Inbox/body-cap_exec.md';
  const collision = 'Notes/body-cap_exec.md';
  vault.files.set(source, noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0 }));
  vault.files.set(collision, 'unrelated note');
  const executor = new OrganizationExecutor({ vault, frontmatter });

  const firstContent = (await vault.read(source)) as string;
  vault.failRenameAfterMove = true;
  await assert.rejects(
    executor.apply({
      capture,
      baseline: { path: source, folder: 'inbox', content: firstContent },
      notePath: source,
      decision: decision({ generated: 'value' }),
      overrides: {},
      signal: new AbortController().signal,
    }),
    /rename response lost/,
  );

  const second = await executor.apply({
    capture,
    baseline: { path: source, folder: 'inbox', content: firstContent },
    notePath: source,
    decision: decision({ generated: 'value' }),
    overrides: {},
    signal: new AbortController().signal,
  });

  assert.equal(second.status, 'applied');
  if (second.status !== 'applied') return;
  assert.equal(second.notePath, 'Notes/body-cap_exec-1.md');
  assert.equal(vault.writes.length, 1);
  assert.equal(vault.renames.length, 1);
  assert.equal(await vault.read(collision), 'unrelated note');
});

test('declines a destination that already carries the same marker instead of making another duplicate', async () => {
  const capture = snapshot();
  const vault = new FakeVault();
  const frontmatter = new JsonFrontmatterPort();
  const source = 'Inbox/body-cap_exec.md';
  vault.files.set(source, noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0 }));
  vault.files.set('Notes/body-cap_exec.md', noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0 }));
  const executor = new OrganizationExecutor({ vault, frontmatter });

  const result = await apply(executor, capture, vault, source, decision({ generated: 'value' }));

  assert.deepEqual(result, { status: 'conflict', code: 'duplicate-marker', notePath: source });
  assert.equal(vault.renames.length, 0);
  assert.equal(vault.files.has(source), true);
  assert.equal(vault.files.has('Notes/body-cap_exec.md'), true);
});

test('undo safely demotes a promotion only when the original path is still free', async () => {
  const capture = snapshot();
  const vault = new FakeVault();
  const frontmatter = new JsonFrontmatterPort();
  const source = 'Inbox/body-cap_exec.md';
  const original = noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0 });
  vault.files.set(source, original);
  const executor = new OrganizationExecutor({ vault, frontmatter });
  const applied = await executor.apply({
    capture,
    baseline: { path: source, folder: 'inbox', content: original },
    notePath: source,
    decision: decision({ generated: 'value' }),
    overrides: {},
    signal: new AbortController().signal,
  });
  assert.equal(applied.status, 'applied');
  if (applied.status !== 'applied') return;

  const undone = await executor.undo({
    capture,
    baseline: { path: source, folder: 'inbox', content: original },
    notePath: applied.notePath,
    applied: applied.applied,
    signal: new AbortController().signal,
  });

  assert.deepEqual(undone, { status: 'undone', notePath: source });
  assert.equal(vault.files.has(source), true);
  assert.equal(vault.files.has(applied.notePath), false);
  const restored = frontmatter.parse((await vault.read(source)) as string);
  assert.equal(restored.frontmatter.generated, undefined);
  assert.deepEqual(restored.frontmatter.tags, []);
});

test('undo preserves legacy tags without an ownership snapshot and later user fields', async () => {
  const capture = snapshot();
  const vault = new FakeVault();
  const frontmatter = new JsonFrontmatterPort();
  const path = 'Notes/body-cap_exec.md';
  vault.files.set(
    path,
    noteContent({
      lethe_capture_id: capture.id,
      lethe_capture_revision: 0,
      user: 'later edit',
      generated: 'value',
      tags: ['user/tag', 'ai/suggested'],
    }),
  );
  const executor = new OrganizationExecutor({ vault, frontmatter });
  const result = await executor.undo({
    capture,
    baseline: {
      path,
      folder: 'inbox',
      content: noteContent({ lethe_capture_id: capture.id, lethe_capture_revision: 0 }),
    },
    notePath: path,
    applied: {
      path,
      body: 'body',
      properties: {
        generated: { before: { present: false }, after: 'value' },
      },
      addedTags: ['ai/suggested'],
    },
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, { status: 'undone', notePath: path });
  const parsed = frontmatter.parse((await vault.read(path)) as string);
  assert.equal(parsed.frontmatter.generated, undefined);
  assert.equal(parsed.frontmatter.user, 'later edit');
  assert.deepEqual(parsed.frontmatter.tags, ['user/tag', 'ai/suggested']);
});
