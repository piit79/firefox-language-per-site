'use strict';
// End-to-end test: drives headless Firefox over WebDriver BiDi (built into Firefox, no geckodriver).
// Usage: node test/e2e/run.js [path-to-firefox]
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { server } = require('./server.js');

const FIREFOX = process.argv[2] || 'firefox';
const PORT = 8765;
const BIDI_PORT = 9333;
const UUID = '0f0e7c4e-3d52-4b1a-9a59-2a6f1e3c9d11';
const SRC_DIR = path.resolve(__dirname, '../..');
const RULES = `*.localhost = de-AT, de, en
/^s.b\.local(?=host$)/ = pt-BR, pt
127.0.0.1 = default
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'lps-profile-'));
  fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'language-per-site@fatsoft.cz': UUID }))});`,
    'user_pref("intl.accept_languages", "en-US, en");',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("network.proxy.type", 0);',
  ].join('\n'));

  // Temp copy of the extension with the test rules as its default configuration.
  const extDir = path.join(profile, 'ext');
  for (const f of ['manifest.json', 'icons', 'src']) fs.cpSync(path.join(SRC_DIR, f), path.join(extDir, f), { recursive: true });
  const bgPath = path.join(extDir, 'src/background.js');
  const bg = fs.readFileSync(bgPath, 'utf8').replace(/const DEFAULT_CONFIG = `[^`]*`;/, `const DEFAULT_CONFIG = ${JSON.stringify(RULES)};`);
  assert.ok(bg.includes(JSON.stringify(RULES)));
  fs.writeFileSync(bgPath, bg);

  const ff = spawn(FIREFOX, ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${BIDI_PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Firefox did not start:\n' + log)), 30000);
    const on = (d) => { log += d; if (/WebDriver BiDi listening/.test(log)) { clearTimeout(t); resolve(); } };
    ff.stderr.on('data', on); ff.stdout.on('data', on);
  });

  const ws = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.type === 'error' ? reject(new Error(msg.error + ': ' + msg.message)) : resolve(msg.result);
    }
  };
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (context, expression) => {
    const r = await cmd('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  try {
    await cmd('session.new', { capabilities: {} });
    await cmd('webExtension.install', { extensionData: { type: 'path', path: extDir } });
    const { contexts } = await cmd('browsingContext.getTree', {});
    const ctx = contexts[0].context;

    await sleep(1500); // let the background register its content script

    const results = {};
    for (const host of ['localhost', 'sub.localhost', '127.0.0.1']) {
      await cmd('browsingContext.navigate', { context: ctx, url: `http://${host}:${PORT}/`, wait: 'complete' });
      let r;
      for (let i = 0; i < 60; i++) {
        r = await evaluate(ctx, `document.title === 'done' ? JSON.stringify(window.__results) : null`);
        if (r) break;
        await sleep(200);
      }
      results[host] = JSON.parse(r || '{}');
    }
    const headers = await (await fetch(`http://127.0.0.1:${PORT}/headers`)).json();
    console.log(JSON.stringify({ results, headers }, null, 2));

    // intlLang null = not overridden (follows the OS locale), so not asserted.
    const expect = (host, lang, header, intlLang = lang) => {
      const r = results[host];
      assert.deepEqual(r.navigator[0], lang, `${host} navigator.language`);
      assert.equal(r.navigator[1][0], lang, `${host} navigator.languages`);
      if (intlLang) assert.equal(r.intl, intlLang, `${host} Intl`);
      assert.equal(r.aboutBlankIframe, lang, `${host} about:blank iframe`);
      assert.equal(r.fetchHeader, header, `${host} fetch header`);
      assert.equal(r.fetchExplicit, 'fr', `${host} explicit fetch header untouched`);
      for (const k of ['networkWorker', 'blobWorker', 'moduleWorker']) {
        assert.equal(r[k][0], lang, `${host} ${k} navigator`);
        if (intlLang) assert.equal(r[k][1], intlLang, `${host} ${k} Intl`);
        assert.equal(r[k][2], true, `${host} ${k} strict mode kept`);
      }
      assert.equal(r.sharedWorker[0], lang, `${host} sharedWorker`);
      assert.equal(r.sameOriginFrame[0], lang, `${host} iframe`);
      for (const p of ['/', '/worker.js', '/shared.js', '/frame']) {
        assert.equal(headers[`${host} ${p}`], header, `${host} ${p} request header`);
      }
    };
    expect('localhost', 'de-AT', 'de-AT,de;q=0.9,en;q=0.8');
    expect('sub.localhost', 'pt-BR', 'pt-BR,pt;q=0.9');
    expect('127.0.0.1', 'en-US', 'en-US,en;q=0.9', null);
    console.log('\nE2E: all assertions passed');
  } finally {
    try { await cmd('session.end'); } catch (e) { /* ignore */ }
    ws.close();
    ff.kill();
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
