'use strict';
/* global LPSRules, LPSRuleUI */

const $ = (id) => document.getElementById(id);
const R = LPSRules;
const { el } = LPSRuleUI;

let rulesText = '';
let testHost = '';
let undoText = null;
let statusTimer = null;

function setStatus(text, cls = '') {
  clearTimeout(statusTimer);
  $('status').textContent = text;
  $('status').className = cls;
  if (cls === 'ok') {
    statusTimer = setTimeout(() => {
      $('status').textContent = '';
      $('undo').hidden = true;
    }, 8000);
  }
}

async function save(text, message, undoable = false) {
  const prev = rulesText;
  const textWasClean = $('rules').value === rulesText;
  rulesText = text;
  await browser.storage.local.set({ rulesText });
  if (textWasClean) $('rules').value = rulesText;
  render();
  setStatus(message, 'ok');
  undoText = undoable ? prev : null;
  $('undo').hidden = !undoable;
}

const ruleList = LPSRuleUI.createRuleList($('rulesBox'), {
  getText: () => rulesText,
  save,
  setStatus,
  getHost: () => testHost,
  activeLabel: 'test',
  activeTitle: 'This rule applies to the URL in "Test a site"',
  invalidHint: 'Fix them in "Edit as text" below.',
});

/* ---------- tester ---------- */

function renderTest() {
  const out = $('testResult');
  out.textContent = '';
  const raw = $('testUrl').value.trim();
  testHost = '';
  if (!raw) return;
  testHost = R.hostFromUrl(/^[a-z]+:\/\//i.test(raw) ? raw : 'https://' + raw);
  if (!testHost) {
    out.append(el('div', { class: 'err', textContent: 'Not a valid http(s) URL or host name' }));
    return;
  }
  const m = R.matchHost(R.parseConfig(rulesText).rules, testHost);
  if (!m) out.append(el('div', { textContent: `${testHost}: no rule matches — Firefox default` }));
  else if (!m.langs) out.append(el('div', { textContent: `${testHost}: rule "${m.pattern}" — Firefox default (explicit)` }));
  else {
    out.append(el('div', { class: 'ok', textContent: `${testHost}: rule "${m.pattern}" → ${m.langs.join(', ')}` }));
    out.append(el('div', { class: 'note', textContent: `Accept-Language: ${R.formatAcceptLanguage(m.langs)}` }));
  }
}

/* ---------- text editor ---------- */

function validateText() {
  const parsed = R.parseConfig($('rules').value);
  const box = $('messages');
  box.textContent = '';
  for (const e of parsed.errors) box.append(el('div', { class: 'err', textContent: `Line ${e.line}: ${e.message}` }));
  for (const w of parsed.warnings) box.append(el('div', { class: 'warn', textContent: `Line ${w.line}: ${w.message}` }));
  const dirty = $('rules').value !== rulesText;
  $('saveText').disabled = parsed.errors.length > 0 || !dirty;
  $('revertText').disabled = !dirty;
  return parsed;
}

function saveText() {
  if (validateText().errors.length || $('rules').value === rulesText) return;
  save($('rules').value, 'Rules saved', true);
}

/* ---------- render / init ---------- */

function render() {
  renderTest();
  ruleList.render();
  validateText();
}

async function init() {
  const defaults = await browser.runtime.sendMessage({ type: 'getDefaults' });
  const stored = await browser.storage.local.get({ rulesText: defaults.defaultConfig, intl: true });
  rulesText = stored.rulesText;
  $('rules').value = rulesText;
  $('intl').checked = stored.intl !== false;
  $('browserLangs').textContent = defaults.browserLanguages.join(', ') || '(none)';

  $('testUrl').addEventListener('input', render);
  $('rules').addEventListener('input', validateText);
  $('saveText').addEventListener('click', saveText);
  $('revertText').addEventListener('click', () => {
    $('rules').value = rulesText;
    validateText();
  });
  $('rules').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveText();
    }
  });
  $('intl').addEventListener('change', async () => {
    await browser.storage.local.set({ intl: $('intl').checked });
    setStatus($('intl').checked ? 'JavaScript locale override on' : 'JavaScript locale override off', 'ok');
    $('undo').hidden = true;
  });
  $('undo').addEventListener('click', () => {
    if (undoText !== null) save(undoText, 'Undone');
  });

  render();

  // Stay in sync with the popup.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.rulesText && changes.rulesText.newValue !== rulesText) {
      const textWasClean = $('rules').value === rulesText;
      rulesText = changes.rulesText.newValue || '';
      if (textWasClean) $('rules').value = rulesText;
      render();
    }
    if (changes.intl) $('intl').checked = changes.intl.newValue !== false;
  });
}

init();
