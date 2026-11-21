/*
 * Isolated-world content script, registered dynamically by the background page with
 * contentScripts.register() so the current configuration (LPS_CONFIG) is embedded in it and
 * available synchronously at document_start.
 *
 * It resolves the languages for this frame and passes them to patch.js in the page's main world.
 */
(function () {
  'use strict';
  /* global LPS_CONFIG, LPSRules */
  if (typeof LPS_CONFIG === 'undefined') return;

  const CFG_EVENT = 'lps-config-6c1f0e';
  const REQ_EVENT = 'lps-request-6c1f0e';

  function frameHost() {
    try {
      if (/^https?:$/.test(location.protocol)) return location.hostname;
      // about:blank, about:srcdoc, blob: ... inherit the origin of their creator.
      const origin = window.origin;
      if (origin && origin !== 'null') return LPSRules.hostFromUrl(origin);
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  const host = frameHost();
  const match = host ? LPSRules.matchHost(LPS_CONFIG.rules, host) : null;
  const langs = match && match.langs ? match.langs : null;
  const payload = JSON.stringify({ langs, opts: { intl: LPS_CONFIG.intl !== false } });

  function send() {
    window.dispatchEvent(new CustomEvent(CFG_EVENT, { detail: payload }));
  }
  function onRequest() {
    window.removeEventListener(REQ_EVENT, onRequest, true);
    send();
  }

  window.addEventListener(REQ_EVENT, onRequest, true);
  send();
  window.addEventListener(
    'DOMContentLoaded',
    () => window.removeEventListener(REQ_EVENT, onRequest, true),
    true
  );
})();
