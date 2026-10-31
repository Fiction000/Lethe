import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Run against a disposable Obsidian instance only, using Node 22+.
// node scripts/verify-capture-ui.mjs <CDP port> <scratch vault> <result.json>
const [port, vaultPath, output] = process.argv.slice(2);
assert(/^\d+$/.test(port ?? ''), 'A localhost CDP port is required');
assert(vaultPath?.includes('/.hermes/cache/scratch/lethe-qa-'), 'Refusing a non-QA vault');
assert(output, 'An evidence output path is required');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find((t) => t.type === 'page' && t.url.startsWith('app://'));
assert(target, 'Obsidian renderer not found');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let sequence = 0;
const pending = new Map();
const events = new EventEmitter();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method) events.emit(message.method, message.params);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timeout);
  if (message.error) entry.reject(Error(JSON.stringify(message.error)));
  else entry.resolve(message.result);
};
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(Error(`${method} timed out`));
    }, 10000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (fn, ...args) => {
  const expression = `(() => { if (typeof app === 'undefined') throw Error('Obsidian not ready'); if (app.vault.adapter.basePath !== ${JSON.stringify(
    vaultPath,
  )}) throw Error('Wrong vault'); return (${fn})(...${JSON.stringify(args)}); })()`;
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails)
    throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
};
const wait = async (fn, ...args) => {
  const deadline = Date.now() + 7000;
  let last;
  do {
    try {
      const result = await evaluate(fn, ...args);
      if (result) return result;
    } catch (error) {
      if (error.message.includes('Wrong vault')) throw error;
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw Error(`UI condition timed out${last ? `: ${last.message}` : ''}`);
};
const selector = (surface) => `.capture-composer--${surface} .cm-content`;
const state = (surface) =>
  evaluate((surface) => {
    const content = document.querySelector(`.capture-composer--${surface} .cm-content`);
    const send = document.querySelector(`.capture-composer--${surface} .capture-composer__send`);
    return {
      body: content.cmView.view.state.doc.toString(),
      focus: content === document.activeElement,
      editable: content.contentEditable,
      disabled: send.disabled,
    };
  }, surface);
const type = async (text) => {
  await evaluate(() => true);
  await cdp('Input.insertText', { text });
};
const key = async (key, modifiers = 0) => {
  await evaluate(() => true);
  const code = key === 'Enter' ? 'Enter' : 'Escape';
  const windowsVirtualKeyCode = key === 'Enter' ? 13 : 27;
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode });
};
const click = async (css) => {
  const point = await evaluate((css) => {
    const el = document.querySelector(css);
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, css);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
};
const results = { measurement: 'Synthetic CDP interaction latency, not native typing speed', captures: [] };
try {
  await evaluate(async () => {
    if (!document.querySelector('.capture-composer--main')) await app.plugins.plugins.lethe.openMemos();
  });
  await wait(() => !!document.querySelector('.capture-composer--main .cm-content'));
  assert.equal((await state('main')).body, '', 'Refusing to replace an existing main draft');
  const modifier = await evaluate(() => (/Mac/.test(navigator.platform) ? 4 : 2));
  for (const surface of ['main', 'quick']) {
    if (surface === 'quick') await evaluate(() => app.plugins.plugins.lethe.quickCapture());
    await wait((surface) => !!document.querySelector(`.capture-composer--${surface} .cm-content`), surface);
    assert.equal((await state(surface)).body, '', 'Expected an empty fixture draft');
    assert.equal((await state(surface)).focus, true, 'Editor must receive initial focus');
    for (let i = 0; i < 3; i++) {
      const body = `  Capture UI ${Date.now()} ${surface} ${i}\n日本語 [[Connections]] #ideas  \n`;
      await type(body);
      await wait(
        (surface) => !document.querySelector(`.capture-composer--${surface} .capture-composer__send`).disabled,
        surface,
      );
      if (i === 0) {
        const composing = await evaluate((surface) => {
          const el = document.querySelector(`.capture-composer--${surface} .cm-content`);
          el.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              metaKey: true,
              ctrlKey: true,
              isComposing: true,
              bubbles: true,
            }),
          );
          return el.cmView.view.state.doc.toString();
        }, surface);
        assert.equal(composing, body, 'IME confirmation must not send');
        assert.equal((await state(surface)).body, body);
      }
      const started = performance.now();
      if (i === 1) await click(`.capture-composer--${surface} .capture-composer__send`);
      else await key('Enter', modifier);
      await wait((surface) => {
        const el = document.querySelector(`.capture-composer--${surface} .cm-content`);
        return el?.cmView.view.state.doc.length === 0 && el === document.activeElement && el.contentEditable === 'true';
      }, surface);
      const nextInputMs = performance.now() - started;
      const record = await wait(
        async (body) =>
          (
            await app.plugins.plugins.lethe.captureRuntime.recent()
          ).find((record) => record.snapshot.body === body && record.write.state === 'written'),
        body,
      );
      const markdown = fs.readFileSync(path.join(vaultPath, record.write.note.path), 'utf8');
      assert(markdown.includes(body), 'Literal body must reach Markdown');
      results.captures.push({
        surface,
        method: i === 1 ? 'pointer' : 'shortcut',
        nextInputMs,
        path: record.write.note.path,
        exactBody: true,
        focus: true,
        requiredMetadataActions: 0,
      });
    }
    if (surface === 'quick') await key('Escape');
  }
  await click(selector('main'));
  const draft = `Restart draft ${Date.now()} 日本語 [[Connections]]`;
  await type(draft);
  const dataFile = path.join(vaultPath, '.obsidian/plugins/lethe/data.json');
  const containsBody = (value, body) =>
    value &&
    typeof value === 'object' &&
    (value.body === body || Object.values(value).some((child) => containsBody(child, body)));
  const deadline = Date.now() + 7000;
  while (!containsBody(JSON.parse(fs.readFileSync(dataFile, 'utf8')), draft)) {
    assert(Date.now() < deadline, 'Draft never reached disk');
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await evaluate(() => true);
  await cdp('Page.enable');
  const loaded = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Renderer reload timed out')), 10000);
    events.once('Page.loadEventFired', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  await cdp('Page.reload');
  await loaded;
  await wait(
    (draft) =>
      document.querySelector('.capture-composer--main .cm-content')?.cmView.view.state.doc.toString() === draft,
    draft,
  );
  results.rendererRestartDraftRestored = true;
  await click(selector('main'));
  await key('Enter', modifier);
  await wait(() => document.querySelector('.capture-composer--main .cm-content')?.cmView.view.state.doc.length === 0);
  results.syntheticCompositionGuard = true;
  results.nativeJapaneseIME = 'Not exercised by this CDP script';
  results.success = true;
} catch (error) {
  results.success = false;
  results.error = error.stack;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(output, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  ws.close();
}
