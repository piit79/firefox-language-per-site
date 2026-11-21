/*
 * Background page:
 *  - keeps the parsed configuration
 *  - rewrites the Accept-Language header of every request according to the site it belongs to
 *  - injects the navigator/Intl patch into worker scripts loaded from the network
 *  - (re)registers the isolated content script with the current configuration embedded
 */
'use strict';
/* global LPSRules, LPSInstallPatches */

const DEFAULT_CONFIG = `# One rule per line:  site-pattern = language, language, ...
#
#   example.com     = en-GB, en, de   only example.com itself
#   *.example.com   = de, en          example.com and all of its subdomains
#   *               = en-US, en       every other site
#   foo.example.com = default         no override, use Firefox's setting
#
# The most specific rule wins. Lines starting with # are comments.
`;

const WORKER_DESTS = new Set(['worker', 'sharedworker', 'serviceworker']);
const { splicePrelude } = LPSInstallPatches(null);
const PATCH_SRC = Function.prototype.toString.call(LPSInstallPatches).replace(/\s*[\r\n]\s*/g, ' ');

let settings = { rules: LPSRules.parseConfig('').rules, intl: true };
let registration = null;
let browserDefaultKeys = new Set(['en-us,en']); // privacy.spoof_english value
const workerRequests = new Map(); // requestId -> langs

/* ---------- configuration ---------- */

async function loadSettings() {
  const stored = await browser.storage.local.get({ rulesText: DEFAULT_CONFIG, intl: true });
  settings = {
    rules: LPSRules.parseConfig(stored.rulesText).rules,
    intl: stored.intl !== false,
  };
  await registerContentScript();
}

async function registerContentScript() {
  const config = JSON.stringify({ rules: settings.rules, intl: settings.intl });
  const old = registration;
  registration = await browser.contentScripts.register({
    matches: ['<all_urls>'],
    js: [
      { file: 'src/rules.js' },
      { code: `var LPS_CONFIG = ${config};` },
      { file: 'src/content-isolated.js' },
    ],
    runAt: 'document_start',
    allFrames: true,
    matchAboutBlank: true,
  });
  if (old) await old.unregister();
}

async function refreshBrowserDefaults() {
  try {
    const langs = await browser.i18n.getAcceptLanguages();
    browserDefaultKeys = new Set([
      'en-us,en',
      langs.map((l) => l.toLowerCase()).join(','),
    ]);
  } catch (e) {
    /* keep previous */
  }
}

const ready = Promise.all([loadSettings(), refreshBrowserDefaults()]).catch((e) =>
  console.error('Language per site: failed to load settings', e)
);
setInterval(refreshBrowserDefaults, 60 * 1000);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.rulesText || changes.intl)) loadSettings();
});

/* ---------- resolving the site a request belongs to ---------- */

/**
 * The language of a request follows the document it belongs to, so that HTTP requests and the
 * JavaScript environment of that document are always consistent:
 *  - navigations (top-level and frames) and worker scripts: the URL being loaded
 *  - everything else: the document (or worker) that issued the request
 */
function contextHost(details, isWorkerScript) {
  if (details.type === 'main_frame' || details.type === 'sub_frame' || isWorkerScript) {
    return LPSRules.hostFromUrl(details.url);
  }
  const candidates = [details.documentUrl, details.originUrl];
  if (details.frameAncestors && details.frameAncestors.length) {
    candidates.push(details.frameAncestors[0].url); // about:blank / srcdoc frames
  }
  candidates.push(details.url);
  for (const url of candidates) {
    const host = LPSRules.hostFromUrl(url);
    if (host) return host;
  }
  return '';
}

function langsFor(details, isWorkerScript) {
  const host = contextHost(details, isWorkerScript);
  if (!host) return null;
  const m = LPSRules.matchHost(settings.rules, host);
  return m && m.langs ? m.langs : null;
}

/* ---------- Accept-Language header ---------- */

function rewriteHeaders(details) {
  const headers = details.requestHeaders;
  let dest = '';
  let langHeader = null;
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (name === 'sec-fetch-dest') dest = (h.value || '').toLowerCase();
    else if (name === 'accept-language') langHeader = h;
  }
  const isWorkerScript = WORKER_DESTS.has(dest);
  const langs = langsFor(details, isWorkerScript);

  if (isWorkerScript) {
    if (langs) workerRequests.set(details.requestId, langs);
    else workerRequests.delete(details.requestId);
  }
  if (!langs) return {};

  // fetch()/XHR may set Accept-Language explicitly; only replace the browser-generated value.
  if (langHeader && details.type === 'xmlhttprequest') {
    const key = LPSRules.parseAcceptLanguage(langHeader.value).join(',');
    if (!browserDefaultKeys.has(key)) return {};
  }

  const value = LPSRules.formatAcceptLanguage(langs);
  if (langHeader) langHeader.value = value;
  else headers.push({ name: 'Accept-Language', value });
  return { requestHeaders: headers };
}

let settingsLoaded = false;
ready.then(() => {
  settingsLoaded = true;
});
// Until the settings are loaded (browser startup), requests wait for them instead of leaking
// the default language.
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => (settingsLoaded ? rewriteHeaders(details) : ready.then(() => rewriteHeaders(details))),
  { urls: ['<all_urls>'] },
  ['blocking', 'requestHeaders']
);

/* ---------- worker scripts: prepend the navigator/Intl patch ---------- */

function workerPrelude(langs) {
  return `;(${PATCH_SRC})(self,${JSON.stringify(langs)},${JSON.stringify({ intl: settings.intl })});`;
}

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const langs = workerRequests.get(details.requestId);
    if (!langs) return;
    workerRequests.delete(details.requestId);
    if (details.statusCode < 200 || details.statusCode >= 300) return;

    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];
    filter.ondata = (e) => chunks.push(new Uint8Array(e.data));
    filter.onstop = () => {
      try {
        // Worker scripts are always decoded as UTF-8 (HTML spec), so this is lossless.
        const decoder = new TextDecoder('utf-8');
        let text = '';
        for (const c of chunks) text += decoder.decode(c, { stream: true });
        text += decoder.decode();
        filter.write(new TextEncoder().encode(splicePrelude(text, workerPrelude(langs))));
      } catch (e) {
        for (const c of chunks) filter.write(c);
      }
      filter.close();
    };
    filter.onerror = () => {};
  },
  { urls: ['<all_urls>'] },
  ['blocking', 'responseHeaders']
);

const forget = (details) => workerRequests.delete(details.requestId);
browser.webRequest.onErrorOccurred.addListener(forget, { urls: ['<all_urls>'] });
browser.webRequest.onCompleted.addListener(forget, { urls: ['<all_urls>'] });

/* ---------- messages from popup / options ---------- */

browser.runtime.onMessage.addListener(async (msg) => {
  if (msg && msg.type === 'getDefaults') {
    await ready;
    return { defaultConfig: DEFAULT_CONFIG, browserLanguages: await browser.i18n.getAcceptLanguages() };
  }
  return undefined;
});
