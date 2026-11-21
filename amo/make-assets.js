'use strict';
// Generates the addons.mozilla.org listing assets:
//   amo/icon-128.png            listing icon (from icons/icon.svg, needs Inkscape or ImageMagick)
//   amo/screenshots/*.png       1280x800 screenshots of the popup and the settings page
//   amo/listing.md              the listing text from amo/metadata.json, ready to paste
// The UI is served over HTTP with the extension APIs stubbed (same approach as test/e2e/popup.js)
// and captured in headless Firefox via WebDriver BiDi.
// Usage: node amo/make-assets.js
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(__dirname, 'screenshots');
const PORT = 8768;
const BIDI_PORT = 9335;
const W = 1280;
const H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RULES = `# Shopping and news in the local language
*.de = de-DE, de, en
*.cz = cs, sk, en
*.co.uk = en-GB, en

# Docs and code always in English
*.github.com = en-US, en
developer.mozilla.org = en-US, en
/^shop\\d*\\.example\\.com$/ = fr-FR, fr, en

# Banking: leave as is
ib.bank.example = default
`;

const stub = (tabUrl) => `() => {
  const store = { rulesText: ${JSON.stringify(RULES)}, intl: true };
  window.browser = {
    storage: { local: { get: async (d) => Object.assign({}, d, store), set: async (o) => { Object.assign(store, o); } },
               onChanged: { addListener() {} } },
    runtime: { sendMessage: async () => ({ defaultConfig: '', browserLanguages: ['en-US', 'en'] }), openOptionsPage() {} },
    tabs: { query: async () => [{ id: 1, url: ${JSON.stringify(tabUrl)} }], reload() {} },
  };
}`;

// A 1280x800 stage with a caption on the left and the popup (in an iframe) on the right.
const stage = (title, lines) => `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; align-items: center; justify-content: center; gap: 72px;
         background: linear-gradient(135deg, #1e4e8c, #2b6cb0 55%, #4a90d9);
         font: 18px/1.5 system-ui, sans-serif; color: #fff; }
  .text { width: 520px; }
  h1 { font-size: 40px; line-height: 1.15; margin: 0 0 20px; }
  ul { margin: 0; padding-left: 22px; } li { margin: 8px 0; }
  code { font: 16px ui-monospace, monospace; background: rgba(255,255,255,.16); padding: 1px 6px; border-radius: 4px; }
  .popup { background: #fff; border-radius: 10px; box-shadow: 0 18px 50px rgba(0,0,0,.35); overflow: hidden; line-height: 0; }
  iframe { border: 0; width: 440px; height: 600px; }
</style>
<div class="text"><h1>${title}</h1><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul></div>
<div class="popup"><iframe id="popup" src="/src/popup.html"></iframe></div>`;

const STAGES = {
  '/stage-popup.html': stage('Pick the languages for the site you’re on', [
    'Save a rule for the exact host, the whole domain, or every site',
    'All rules in one list: edit inline, drag <code>⋮⋮</code> to reorder',
    'The rule that applies to the current tab is highlighted',
  ]),
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  makeIcon();
  writeListing();

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (STAGES[url]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(STAGES[url]);
    }
    const f = path.join(ROOT, path.normalize(url));
    if (!f.startsWith(SRC) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)];
    res.writeHead(200, { 'content-type': type + '; charset=utf-8' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'lps-assets-'));
  const ff = spawn('firefox', ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${BIDI_PORT}`]);
  let log = '';
  await new Promise((r) => { const on = (d) => { log += d; if (/BiDi listening/.test(log)) r(); }; ff.stderr.on('data', on); ff.stdout.on('data', on); });
  const ws = new WebSocket(`ws://127.0.0.1:${BIDI_PORT}/session`);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.type === 'error' ? p.j(new Error(p.method + ': ' + m.message)) : p.r(m.result); } };
  const cmd = (method, params = {}) => new Promise((r, j) => { pending.set(++id, { r, j, method }); ws.send(JSON.stringify({ id, method, params })); });

  try {
    await cmd('session.new', { capabilities: {} });
    const top = (await cmd('browsingContext.getTree', {})).contexts[0].context;
    await cmd('browsingContext.navigate', { context: top, url: `http://127.0.0.1:${PORT}/src/options.css`, wait: 'complete' });
    await cmd('browsingContext.close', { context: top }).catch(() => {});

    // Each shot gets a fresh tab so it can have its own stubbed "current tab" URL.
    const capture = async (name, tabUrl, pageUrl, prepare) => {
      const { context: ctx } = await cmd('browsingContext.create', { type: 'tab' });
      await cmd('browsingContext.navigate', { context: ctx, url: `http://127.0.0.1:${PORT}/src/options.css`, wait: 'complete' });
      const preload = await cmd('script.addPreloadScript', { functionDeclaration: stub(tabUrl), contexts: [ctx] });
      await cmd('browsingContext.setViewport', { context: ctx, viewport: { width: W, height: H } });
      await cmd('browsingContext.navigate', { context: ctx, url: `http://127.0.0.1:${PORT}${pageUrl}`, wait: 'complete' });
      await sleep(400);
      const ev = async (expression) => {
        const r = await cmd('script.evaluate', { expression, target: { context: ctx }, awaitPromise: true });
        if (r.type === 'exception') throw new Error(name + ': ' + r.exceptionDetails.text);
        return r.result.value;
      };
      if (prepare) await prepare(ev);
      await sleep(300);
      const { data } = await cmd('browsingContext.captureScreenshot', { context: ctx, origin: 'viewport' });
      fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
      await cmd('script.removePreloadScript', { script: preload.script });
      await cmd('browsingContext.close', { context: ctx });
      console.log('wrote', path.relative(ROOT, path.join(OUT, name + '.png')));
    };

    // 1. Popup on a German news site, sized to its content.
    await capture('1-popup', 'https://www.zeit.de/index', '/stage-popup.html', async (ev) => {
      await ev(`(async () => {
        const f = document.getElementById('popup');
        for (let i = 0; i < 50 && !(f.contentDocument && f.contentDocument.querySelector('#list .rule')); i++) await new Promise(r => setTimeout(r, 50));
        f.style.height = f.contentDocument.documentElement.scrollHeight + 'px';
      })()`);
    });

    // 2. Settings page with the site tester matching the regex rule.
    await capture('2-settings', 'https://www.example.com/', '/src/options.html', async (ev) => {
      await ev(`(() => {
        const t = document.getElementById('testUrl');
        t.value = 'https://shop2.example.com/cart';
        t.dispatchEvent(new Event('input'));
        document.querySelector('.legend').remove();
        document.querySelector('.precedence').remove();
      })()`);
    });

    // 3. Settings page: edit as text.
    await capture('3-text', 'https://www.example.com/', '/src/options.html', async (ev) => {
      await ev(`(() => {
        const d = document.getElementById('textEditor');
        d.open = true;
        const t = document.getElementById('rules');
        t.rows = 15;
        t.value += '*.fr = fr-FR, fr\\nnews.example.org = d€\\n';
        t.dispatchEvent(new Event('input'));
        d.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -24);
      })()`);
    });
  } finally {
    ff.kill();
    server.close();
    ws.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

const CAPTIONS = {
  '1-popup': 'The toolbar popup: languages for the current site, a quick rule for it, and all your rules',
  '2-settings': 'The settings page with the site tester highlighting the rule that matches a URL',
  '3-text': 'Edit as text for bulk changes and comments, with per-line validation',
};

// amo/listing.md: the metadata.json values in a form that is easy to paste into the AMO website.
function writeListing() {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'metadata.json'), 'utf8'));
  const md = `# AMO listing for ${m.name['en-US']}

Generated from [metadata.json](metadata.json) by \`node amo/make-assets.js\`. Edit metadata.json, not this file.

## Name
${m.name['en-US']}

## Summary (${m.summary['en-US'].length}/250 characters)
${m.summary['en-US']}

## Description
Paste as is. AMO keeps line breaks and allows the HTML tags used here.

\`\`\`html
${m.description['en-US']}
\`\`\`

## Categories
${m.categories.join(', ')}

## Homepage
${m.homepage['en-US']}

## License
${m.version.license}

## Screenshots and captions
${Object.entries(CAPTIONS).map(([f, c]) => `- \`screenshots/${f}.png\`: ${c}`).join('\n')}

## Icon
\`icon-128.png\` (the manifest's SVG icon, rendered at 128×128)

## Notes to reviewer
\`\`\`
${m.version.approval_notes}
\`\`\`

## Other answers in the submission form
- Distribution: **On this site** (listed)
- Source code submission: **No** (no minified, transpiled or generated code)
- Privacy policy: not needed (the extension collects no data)
- Experimental: no. Requires payment: no.
`;
  fs.writeFileSync(path.join(__dirname, 'listing.md'), md);
  console.log('wrote amo/listing.md');
}

function makeIcon() {
  const svg = path.join(ROOT, 'icons/icon.svg');
  const png = path.join(__dirname, 'icon-128.png');
  try {
    execFileSync('inkscape', [svg, '--export-type=png', `--export-filename=${png}`, '-w', '128', '-h', '128'], { stdio: 'ignore' });
  } catch {
    execFileSync('magick', ['-background', 'none', '-density', '384', svg, '-resize', '128x128', png]);
  }
  console.log('wrote', path.relative(ROOT, png));
}

main().catch((e) => { console.error(e); process.exit(1); });
