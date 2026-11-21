'use strict';
/* global LPSRules, LPSRuleUI */

const $ = (id) => document.getElementById(id);
const R = LPSRules;
const { el, ruleError } = LPSRuleUI;

let rulesText = '';
let host = '';
let tab = null;
let undoText = null;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = cls;
}

async function save(text, message, undoable = false) {
  const prev = rulesText;
  rulesText = text;
  await browser.storage.local.set({ rulesText });
  render();
  setStatus(message, 'ok');
  undoText = undoable ? prev : null;
  $('undo').hidden = !undoable;
  $('reload').hidden = !host;
}

const ruleList = LPSRuleUI.createRuleList($('rulesBox'), {
  getText: () => rulesText,
  save,
  setStatus,
  getHost: () => host,
  activeLabel: 'this site',
  activeTitle: 'This rule applies to the current tab',
  invalidHint: 'Open settings to fix.',
});

/* ---------- current site ---------- */

function patternChoices(h) {
  const out = [h];
  if (!/^[\d.]+$/.test(h) && !h.startsWith('[')) {
    const labels = h.split('.');
    for (let i = 0; i < labels.length - 1; i++) out.push('*.' + labels.slice(i).join('.'));
  }
  out.push('*');
  return out;
}

function renderSite() {
  if (!host) return;
  const m = R.matchHost(R.parseConfig(rulesText).rules, host);
  const box = $('siteMatch');
  box.textContent = '';
  if (!m) box.append('No rule — Firefox default languages');
  else if (!m.langs) box.append(`Rule "${m.pattern}" — Firefox default`);
  else box.append(el('span', { class: 'ok', textContent: m.langs.join(', ') }), ` via "${m.pattern}"`);
}

function fillSiteForm() {
  const pat = R.normalizePattern($('pattern').value);
  const entry = R.parseConfig(rulesText)
    .entries.filter((e) => e.kind === pat.kind && e.host === pat.host)
    .pop();
  $('langs').value = entry ? entry.rawValue : '';
}

function render() {
  renderSite();
  ruleList.render();
}

/* ---------- init ---------- */

async function init() {
  $('openOptions').addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });
  $('undo').addEventListener('click', () => {
    if (undoText !== null) save(undoText, 'Undone');
  });
  $('reload').addEventListener('click', () => {
    if (tab) browser.tabs.reload(tab.id);
    window.close();
  });

  const defaults = await browser.runtime.sendMessage({ type: 'getDefaults' });
  rulesText = (await browser.storage.local.get({ rulesText: defaults.defaultConfig })).rulesText;

  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  host = (tab && R.hostFromUrl(tab.url)) || '';

  if (host) {
    $('site').hidden = false;
    $('siteHost').textContent = host;
    const sel = $('pattern');
    for (const p of patternChoices(host)) sel.append(new Option(p, p));
    const m = R.matchHost(R.parseConfig(rulesText).rules, host);
    sel.value = m && patternChoices(host).includes(m.pattern) ? m.pattern : host;
    sel.addEventListener('change', fillSiteForm);
    fillSiteForm();

    $('form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = $('langs').value.trim() || 'default';
      const err = ruleError(sel.value, value);
      if (err) {
        setStatus(err, 'err');
        return;
      }
      save(R.upsertRule(rulesText, sel.value, value), `Saved rule for ${sel.value}`);
    });
  } else {
    $('noSite').hidden = false;
  }

  render();

  // Stay in sync with the settings page.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.rulesText && changes.rulesText.newValue !== rulesText) {
      rulesText = changes.rulesText.newValue || '';
      render();
      if (host) fillSiteForm();
    }
  });
}

init();
