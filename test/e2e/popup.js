'use strict';
// Popup UI test in headless Firefox: real pointer drag, keyboard reorder, inline edit, delete + undo.
// The extension APIs are stubbed via a BiDi preload script; the popup is served over HTTP.
// Usage: node test/e2e/popup.js [screenshot-dir]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const SRC = path.resolve(__dirname, '../../src');
const SHOTS = process.argv[2];
const PORT = 8767;
const BIDI_PORT = 9334;
const RULES = `# My rules
example.com = en-GB, en, de  # main site
*.example.com = de, en

*.co.uk = en-GB
/^(www\\.)?example\\.(com|org)$/ = it
*.example.com = fr
* = default
`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STUB = `() => {
  const store = { rulesText: ${JSON.stringify(RULES)} };
  window.__store = store;
  window.browser = {
    storage: { local: { get: async (d) => Object.assign({}, d, store), set: async (o) => { Object.assign(store, o); } },
               onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({ defaultConfig: '', browserLanguages: ['en-US'] }), openOptionsPage() {} },
    tabs: { query: async () => [{ id: 1, url: 'https://www.example.com/page' }], reload() {} },
  };
}`;

async function main() {
  const server = http.createServer((req, res) => {
    const f = path.join(SRC, path.normalize(req.url.split('?')[0]));
    if (!f.startsWith(SRC) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)];
    res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'lps-popup-'));
  const ff = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${BIDI_PORT}`]);
  let log = '';
  await new Promise((r) => { const on = (d) => { log += d; if (/BiDi listening/.test(log)) r(); }; ff.stderr.on('data', on); ff.stdout.on('data', on); });
  const ws = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.type === 'error' ? p.j(new Error(p.method + ': ' + m.message)) : p.r(m.result); } };
  const cmd = (method, params = {}) => new Promise((r, j) => { pending.set(++id, { r, j, method }); ws.send(JSON.stringify({ id, method, params })); });
  let ctx;
  const ev = async (expression) => {
    const r = await cmd('script.evaluate', { expression, target: { context: ctx }, awaitPromise: true });
    if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    if (!SHOTS) return;
    const { data } = await cmd('browsingContext.captureScreenshot', { context: ctx, origin: 'document' });
    fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };
  const stored = () => ev('window.__store.rulesText');
  const patterns = () => ev(`JSON.stringify([...document.querySelectorAll('#list .rule .pat')].map(i => i.value))`).then(JSON.parse);
  const center = (sel) => ev(`JSON.stringify((() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })())`).then(JSON.parse);

  try {
    await cmd('session.new', { capabilities: {} });
    ctx = (await cmd('browsingContext.getTree', {})).contexts[0].context;
    // Leave the initial about:blank first (preload scripts can't target it without system access).
    await cmd('browsingContext.navigate', { context: ctx, url: `http://127.0.0.1:${PORT}/options.css`, wait: 'complete' });
    await cmd('script.addPreloadScript', { functionDeclaration: STUB, contexts: [ctx] });
    await cmd('browsingContext.setViewport', { context: ctx, viewport: { width: 440, height: 560 } });
    await cmd('browsingContext.navigate', { context: ctx, url: `http://127.0.0.1:${PORT}/popup.html`, wait: 'complete' });
    await sleep(300);
    await shot('1-initial');

    assert.deepEqual(await patterns(), ['example.com', '*.example.com', '*.co.uk', '/^(www\\.)?example\\.(com|org)$/', '*.example.com', '*']);
    // The regex (line 6) beats *.example.com for www.example.com; line 3 is an overridden duplicate.
    assert.equal(await ev(`document.querySelector('.rule.active .pat').value + '|' + document.querySelector('.rule.active').dataset.line`), '/^(www\\.)?example\\.(com|org)$/|6');
    assert.equal(await ev(`document.querySelector('.rule.active .pat').classList.contains('is-regex')`), true);
    assert.equal(await ev(`document.querySelectorAll('.rule.overridden').length`), 1);
    assert.equal(await ev(`document.getElementById('siteMatch').textContent`), 'it via "/^(www\\.)?example\\.(com|org)$/"');

    // Drag the last rule ("*") to the top with a real pointer.
    const from = await center('#list .rule:last-child .handle');
    const to = await center('#list .rule:first-child');
    const steps = [];
    for (let i = 1; i <= 10; i++) steps.push({ type: 'pointerMove', x: from.x, y: Math.round(from.y + ((to.y - 8 - from.y) * i) / 10), duration: 20 });
    await cmd('input.performActions', { context: ctx, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', x: from.x, y: from.y }, { type: 'pointerDown', button: 0 }, ...steps, { type: 'pointerUp', button: 0 }] }] });
    await sleep(200);
    assert.deepEqual(await patterns(), ['*', 'example.com', '*.example.com', '*.co.uk', '/^(www\\.)?example\\.(com|org)$/', '*.example.com']);
    assert.equal(await stored(), `# My rules
* = default
example.com = en-GB, en, de  # main site

*.example.com = de, en
*.co.uk = en-GB
/^(www\\.)?example\\.(com|org)$/ = it
*.example.com = fr
`);
    await shot('2-after-drag');

    // Keyboard: move "*.co.uk" up one step with the handle focused.
    await ev(`document.querySelectorAll('#list .rule')[3].querySelector('.handle').focus()`);
    await cmd('input.performActions', { context: ctx, actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: '' }, { type: 'keyUp', value: '' }] }] });
    await sleep(100);
    assert.deepEqual(await patterns(), ['*', 'example.com', '*.co.uk', '*.example.com', '/^(www\\.)?example\\.(com|org)$/', '*.example.com']);
    assert.equal(await ev(`document.activeElement.closest('.rule').querySelector('.pat').value`), '*.co.uk');

    // Inline edit languages of example.com, keeping its comment.
    await ev(`(() => { const v = document.querySelectorAll('#list .rule')[1].querySelector('.val'); v.focus(); v.value = 'cs, en'; v.dispatchEvent(new Event('input')); v.dispatchEvent(new Event('change')); })()`);
    await sleep(100);
    assert.match(await stored(), /^example\.com = cs, en  # main site$/m);

    // Invalid value is flagged and not saved.
    await ev(`(() => { const v = document.querySelectorAll('#list .rule')[1].querySelector('.val'); v.value = 'en, !!'; v.dispatchEvent(new Event('input')); v.dispatchEvent(new Event('change')); })()`);
    assert.equal(await ev(`document.querySelectorAll('#list .rule')[1].querySelector('.val').classList.contains('bad')`), true);
    assert.match(await stored(), /^example\.com = cs, en/m);
    await shot('3-invalid');

    // Delete + undo.
    const before = await stored();
    await ev(`document.querySelectorAll('#list .rule')[2].querySelector('.del').click()`);
    await sleep(100);
    assert.ok(!(await stored()).includes('*.co.uk'));
    await ev(`document.getElementById('undo').click()`);
    await sleep(100);
    assert.equal(await stored(), before);

    // Add a new rule via "+ Add rule".
    await ev(`document.getElementById('addRule').click()`);
    await ev(`(() => { const r = document.querySelector('#newRows .rule'); r.querySelector('.pat').value = '*.example.org'; const v = r.querySelector('.val'); v.value = 'it'; v.dispatchEvent(new Event('change')); })()`);
    await sleep(100);
    assert.match(await stored(), /\*\.example\.org = it\n$/);

    // Current-site form: save for "www.example.com" exact.
    await ev(`(() => { const s = document.getElementById('pattern'); s.value = 'www.example.com'; s.dispatchEvent(new Event('change')); document.getElementById('langs').value = 'ja'; document.querySelector('#form button').click(); })()`);
    await sleep(100);
    assert.equal(await ev(`document.querySelector('.rule.active .pat').value`), 'www.example.com');
    await shot('4-final');
    assert.match(await ev(`document.querySelector('.regex-note').textContent`), /regular expression/);
    console.log('Popup E2E: all assertions passed');

    /* ---------- settings page: same rule list UI ---------- */
    await cmd('browsingContext.setViewport', { context: ctx, viewport: { width: 900, height: 1100 } });
    await cmd('browsingContext.navigate', { context: ctx, url: `http://127.0.0.1:${PORT}/options.html`, wait: 'complete' });
    await sleep(300);
    assert.deepEqual(await patterns(), ['example.com', '*.example.com', '*.co.uk', '/^(www\\.)?example\\.(com|org)$/', '*.example.com', '*']);
    assert.equal(await ev(`document.querySelectorAll('.rule .handle').length`), 6);
    assert.equal(await ev(`document.querySelector('.rule.active') === null`), true);

    // Tester highlights the matching rule.
    await ev(`(() => { const t = document.getElementById('testUrl'); t.value = 'https://www.example.org/x'; t.dispatchEvent(new Event('input')); })()`);
    assert.equal(await ev(`document.querySelector('.rule.active .pat').value`), '/^(www\\.)?example\\.(com|org)$/');
    assert.match(await ev(`document.getElementById('testResult').textContent`), /→ it.*Accept-Language: it/);
    await shot('5-options');

    // Pointer drag: first rule to the bottom.
    const f2 = await center('#list .rule:first-child .handle');
    const t2 = await center('#list .rule:last-child');
    const steps2 = [];
    for (let i = 1; i <= 10; i++) steps2.push({ type: 'pointerMove', x: f2.x, y: Math.round(f2.y + ((t2.y + 12 - f2.y) * i) / 10), duration: 20 });
    await cmd('input.performActions', { context: ctx, actions: [{ type: 'pointer', id: 'mouse2', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', x: f2.x, y: f2.y }, { type: 'pointerDown', button: 0 }, ...steps2, { type: 'pointerUp', button: 0 }] }] });
    await sleep(200);
    assert.deepEqual(await patterns(), ['*.example.com', '*.co.uk', '/^(www\\.)?example\\.(com|org)$/', '*.example.com', '*', 'example.com']);
    assert.match(await stored(), /^\* = default\nexample\.com = en-GB, en, de  # main site\n$/m);
    // The (closed) text editor follows list edits.
    assert.equal(await ev(`document.getElementById('rules').value === window.__store.rulesText`), true);

    // Text editor: invalid text can't be saved, valid text updates the list.
    await ev(`document.getElementById('textEditor').open = true`);
    await ev(`(() => { const t = document.getElementById('rules'); t.value += 'bad = !!\\n'; t.dispatchEvent(new Event('input')); })()`);
    assert.equal(await ev(`document.getElementById('saveText').disabled`), true);
    assert.match(await ev(`document.getElementById('messages').textContent`), /Invalid language tag/);
    await shot('6-options-text');
    await ev(`(() => { const t = document.getElementById('rules'); t.value = t.value.replace('bad = !!', 'new.example.net = sv'); t.dispatchEvent(new Event('input')); document.getElementById('saveText').click(); })()`);
    await sleep(100);
    assert.match(await stored(), /new\.example\.net = sv/);
    assert.equal((await patterns()).at(-1), 'new.example.net');

    // Intl option saves immediately.
    await ev(`document.getElementById('intl').click()`);
    await sleep(100);
    assert.equal(await ev(`window.__store.intl`), false);
    console.log('Options E2E: all assertions passed');
  } finally {
    ff.kill();
    server.close();
    ws.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
