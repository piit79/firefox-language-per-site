'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules.js');

const CONFIG = `
# comment
example.com = en-GB, en, de
*.example.com = de,en
foo.example.com = default
*.co.uk = en-gb
* = cs, en   # trailing comment
https://www.münchen.de/path = de-AT
bad line here = xx-!!
`;

test('parses rules and reports errors', () => {
  const p = R.parseConfig(CONFIG);
  assert.deepEqual(p.rules.exact['example.com'], ['en-GB', 'en', 'de']);
  assert.deepEqual(p.rules.wild['example.com'], ['de', 'en']);
  assert.equal(p.rules.exact['foo.example.com'], null);
  assert.deepEqual(p.rules.wild['co.uk'], ['en-GB']);
  assert.deepEqual(p.rules.all, ['cs', 'en']);
  assert.deepEqual(p.rules.exact['www.xn--mnchen-3ya.de'], ['de-AT']);
  assert.equal(p.errors.length, 1);
  assert.equal(p.errors[0].line, 9);
});

test('matching precedence', () => {
  const { rules } = R.parseConfig(CONFIG);
  assert.deepEqual(R.matchHost(rules, 'example.com'), { pattern: 'example.com', langs: ['en-GB', 'en', 'de'] });
  assert.deepEqual(R.matchHost(rules, 'www.example.com').pattern, '*.example.com');
  assert.deepEqual(R.matchHost(rules, 'a.b.EXAMPLE.com.').langs, ['de', 'en']);
  assert.deepEqual(R.matchHost(rules, 'foo.example.com'), { pattern: 'foo.example.com', langs: null });
  assert.deepEqual(R.matchHost(rules, 'x.foo.example.com').pattern, '*.example.com');
  assert.deepEqual(R.matchHost(rules, 'bbc.co.uk').langs, ['en-GB']);
  assert.deepEqual(R.matchHost(rules, 'notexample.com').pattern, '*');
  assert.equal(R.matchHost(R.parseConfig('').rules, 'a.com'), null);
});

test('wildcard includes apex', () => {
  const { rules } = R.parseConfig('*.example.com = fr');
  assert.deepEqual(R.matchHost(rules, 'example.com').langs, ['fr']);
  assert.deepEqual(R.matchHost(rules, 'deep.sub.example.com').langs, ['fr']);
  assert.equal(R.matchHost(rules, 'badexample.com'), null);
});

test('duplicates: later wins with warning', () => {
  const p = R.parseConfig('a.com = en\na.com = de');
  assert.deepEqual(p.rules.exact['a.com'], ['de']);
  assert.equal(p.warnings.length, 1);
});

test('Accept-Language formatting matches Firefox 159', () => {
  assert.equal(R.formatAcceptLanguage(['en-US']), 'en-US');
  assert.equal(R.formatAcceptLanguage(['en-US', 'en']), 'en-US,en;q=0.9');
  assert.equal(R.formatAcceptLanguage(['cs', 'en-US', 'en']), 'cs,en-US;q=0.9,en;q=0.8');
  assert.equal(
    R.formatAcceptLanguage('abcdefghijkl'.split('')),
    'a,b;q=0.9,c;q=0.8,d;q=0.7,e;q=0.6,f;q=0.5,g;q=0.4,h;q=0.3,i;q=0.2,j;q=0.1,k;q=0.1,l;q=0.1'
  );
});

test('hostFromUrl', () => {
  assert.equal(R.hostFromUrl('https://Sub.Example.com:8443/x'), 'sub.example.com');
  assert.equal(R.hostFromUrl('blob:https://example.com/1234'), 'example.com');
  assert.equal(R.hostFromUrl('wss://example.com/'), 'example.com');
  assert.equal(R.hostFromUrl('about:blank'), '');
  assert.equal(R.hostFromUrl('moz-extension://abc/x'), '');
});

test('text editing keeps comments and layout', () => {
  const text = '# header\na.com = en  # mine\n\n# group\nb.com = de\nc.com = fr\n';
  assert.equal(R.updateLine(text, 2, 'a.com = cs'), '# header\na.com = cs  # mine\n\n# group\nb.com = de\nc.com = fr\n');
  assert.equal(R.deleteLine(text, 5), '# header\na.com = en  # mine\n\n# group\nc.com = fr\n');
  assert.equal(R.appendLine(text, 'd.com = it'), text + 'd.com = it\n');
  // Move c.com to the top: rules permute within their slots, comments stay put.
  assert.equal(R.reorderLines(text, [6, 2, 5]), '# header\nc.com = fr\n\n# group\na.com = en  # mine\nb.com = de\n');
  assert.equal(R.upsertRule('x.com = en\nx.com = de\n', 'x.com', 'fr'), 'x.com = fr\n');
  assert.equal(R.upsertRule('x.com = en\n', '*.x.com', 'fr'), 'x.com = en\n*.x.com = fr\n');
  const e = R.parseConfig('*.Example.com = de').entries[0];
  assert.equal(e.rawPattern, '*.Example.com');
  assert.equal(R.entryPattern(e), '*.example.com');
});

test('regular expression rules', () => {
  const p = R.parseConfig(`
*.example.com = de
/^shop\\d+\\.example\\.com$/ = fr
/^(.+\\.)?google\\.[a-z.]+$/ = en-GB
/(?=.*test)^[a-z.]+ $/ = it
shop1.example.com = cs
/\\.CO\\.UK$/ = en
*.co.uk = en-GB, en
/[/ = de
`);
  assert.equal(p.errors.length, 1);
  assert.match(p.errors[0].message, /Invalid regular expression pattern \/\[\//);
  assert.equal(p.entries[3].rawPattern, '/(?=.*test)^[a-z.]+ $/');
  const m = (h) => R.matchHost(p.rules, h);
  assert.deepEqual(m('shop1.example.com'), { pattern: 'shop1.example.com', langs: ['cs'] }); // exact beats regex
  assert.deepEqual(m('shop22.example.com'), { pattern: '/^shop\\d+\\.example\\.com$/', langs: ['fr'] }); // regex beats wildcard
  assert.equal(m('shopx.example.com').pattern, '*.example.com');
  assert.deepEqual(m('www.google.co.uk').langs, ['en-GB']); // first regex in file order wins
  assert.deepEqual(m('bbc.co.uk').langs, ['en']); // case-insensitive
  assert.equal(R.entryPattern(p.entries[1]), '/^shop\\d+\\.example\\.com$/');
  // Duplicate regex: later wins and moves to the later position.
  const d = R.parseConfig('/a/ = de\n/b/ = fr\n/a/ = it');
  assert.deepEqual(R.matchHost(d.rules, 'ab.com').langs, ['fr']);
  assert.equal(d.warnings.length, 1);
  // Survives JSON round-trip (as embedded in the content script).
  const j = JSON.parse(JSON.stringify(p.rules));
  assert.deepEqual(R.matchHost(j, 'shop5.example.com').langs, ['fr']);
});
