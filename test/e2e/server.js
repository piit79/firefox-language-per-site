'use strict';
// Test server: echoes Accept-Language and serves a page that collects every language signal.
const http = require('node:http');

const PAGE = `<!doctype html><meta charset="utf-8"><title>pending</title>
<script>
const results = {};
const done = (k, v) => { results[k] = v; };
done('navigator', [navigator.language, Array.from(navigator.languages)]);
done('intl', new Intl.DateTimeFormat().resolvedOptions().locale);
done('numberToLocale', (1234.5).toLocaleString());

// about:blank iframe accessed synchronously
const f = document.createElement('iframe');
document.documentElement.appendChild(f);
done('aboutBlankIframe', f.contentWindow.navigator.languages[0]);

const waits = [];
waits.push(fetch('/echo').then(r => r.text()).then(t => done('fetchHeader', t)));
waits.push(fetch('/echo', { headers: { 'Accept-Language': 'fr' } }).then(r => r.text()).then(t => done('fetchExplicit', t)));

function workerResult(w) {
  return new Promise((res) => { w.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 4000); });
}
const WCODE = "postMessage([navigator.languages[0], new Intl.DateTimeFormat().resolvedOptions().locale, (function(){return this})() === undefined]);";
waits.push(workerResult(new Worker('/worker.js')).then(v => done('networkWorker', v)));
const bu = URL.createObjectURL(new Blob(['"use strict";' + WCODE], { type: 'text/javascript' }));
waits.push(workerResult(new Worker(bu)).then(v => done('blobWorker', v)));
URL.revokeObjectURL(bu);
waits.push(workerResult(new Worker('/worker.js', { type: 'module' })).then(v => done('moduleWorker', v)));
const sw = new SharedWorker('/shared.js');
waits.push(new Promise((res) => { sw.port.onmessage = (e) => res(e.data); setTimeout(() => res('timeout'), 4000); }).then(v => done('sharedWorker', v)));

const fr = document.createElement('iframe');
fr.src = '/frame';
waits.push(new Promise((res) => { window.addEventListener('message', (e) => { if (e.data && e.data.frame) res(e.data.frame); }); }).then(v => done('sameOriginFrame', v)));
document.documentElement.appendChild(fr);

Promise.all(waits).then(() => { document.title = 'done'; window.__results = results; });
</script>`;

const WORKER = `"use strict";
postMessage([navigator.languages[0], new Intl.DateTimeFormat().resolvedOptions().locale, (function(){return this})() === undefined]);`;
const SHARED = `onconnect = (e) => e.ports[0].postMessage([navigator.languages[0], new Intl.DateTimeFormat().resolvedOptions().locale]);`;
const FRAME = `<!doctype html><script>parent.postMessage({frame: [navigator.languages[0], document.referrer ? 1 : 0]}, '*');</script>`;

const lastHeaders = {};
const server = http.createServer((req, res) => {
  const host = req.headers.host.split(':')[0];
  const al = req.headers['accept-language'] || '';
  lastHeaders[host + ' ' + req.url] = al;
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  if (req.url === '/') return send('text/html', PAGE);
  if (req.url === '/frame') return send('text/html', FRAME);
  if (req.url === '/echo') return send('text/plain', al);
  if (req.url === '/worker.js') return send('text/javascript', WORKER);
  if (req.url === '/shared.js') return send('text/javascript', SHARED);
  if (req.url === '/headers') return send('application/json', JSON.stringify(lastHeaders));
  res.writeHead(404);
  res.end();
});

module.exports = { server, lastHeaders };
