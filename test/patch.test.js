'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installPatches } = require('../src/patch.js');

const { splicePrelude } = installPatches(null);
const P = ';PRELUDE();';

test('splicePrelude keeps directive prologues intact', () => {
  assert.equal(splicePrelude('var a;', P), P + 'var a;');
  assert.equal(splicePrelude('"use strict";\nvar a;', P), '"use strict";' + P + '\nvar a;');
  assert.equal(splicePrelude("/* lic */\n'use strict'\nfoo()", P), "/* lic */\n'use strict'" + P + '\nfoo()');
  assert.equal(splicePrelude('"use strict"; "x";a', P), '"use strict"; "x";' + P + 'a');
  // Not directives: string used in an expression
  assert.equal(splicePrelude('"abc".length;', P), P + '"abc".length;');
  assert.equal(splicePrelude('"a"\n+ b', P), P + '"a"\n+ b');
  assert.equal(splicePrelude('#!/bin/x\nfoo()', P), '#!/bin/x\n' + P + 'foo()');
  assert.equal(splicePrelude('// c\n"use strict";x', P), '// c\n"use strict";' + P + 'x');
});

function makeContext() {
  const ctx = vm.createContext({});
  vm.runInContext(
    `class Navigator { get language() { return 'xx'; } get languages() { return ['xx']; } }
     globalThis.Navigator = Navigator;
     globalThis.navigator = new Navigator();`,
    ctx
  );
  return ctx;
}

test('patches navigator and Intl in a fresh realm', () => {
  const ctx = makeContext();
  installPatches(vm.runInContext('globalThis', ctx), ['de-AT', 'de', 'en'], { intl: true });
  const r = (code) => vm.runInContext(code, ctx);

  assert.equal(r('navigator.language'), 'de-AT');
  assert.deepEqual(Array.from(r('navigator.languages')), ['de-AT', 'de', 'en']);
  assert.equal(r('navigator.languages === navigator.languages'), true);
  assert.equal(r('Object.isFrozen(navigator.languages)'), true);
  assert.equal(r('Array.isArray(navigator.languages) && navigator.languages instanceof Array'), true);

  assert.equal(r('new Intl.DateTimeFormat().resolvedOptions().locale'), 'de-AT');
  assert.equal(r('Intl.NumberFormat().resolvedOptions().locale'), 'de-AT');
  assert.equal(r('new Intl.NumberFormat([]).resolvedOptions().locale'), 'de-AT');
  assert.equal(r('new Intl.NumberFormat("fr").resolvedOptions().locale'), 'fr');
  assert.equal(r('new Intl.Collator(undefined, {sensitivity: "base"}).resolvedOptions().sensitivity'), 'base');
  assert.equal(r('(1234.5).toLocaleString()'), (1234.5).toLocaleString('de-AT'));
  assert.equal(r('(1234.5).toLocaleString("en-US")'), '1,234.5');
  assert.equal(r('new Date(0).toLocaleDateString(undefined, {timeZone: "UTC"})'), new Date(0).toLocaleDateString('de-AT', { timeZone: 'UTC' }));
  assert.equal(r('"a".localeCompare("b")'), -1);
  assert.equal(r('"i".toLocaleUpperCase()'), 'I');
  assert.equal(r('Intl.DateTimeFormat.prototype.constructor === Intl.DateTimeFormat'), true);
  assert.equal(r('new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat'), true);
  assert.equal(r('typeof Intl.DateTimeFormat.supportedLocalesOf'), 'function');
  assert.equal(r('class X extends Intl.NumberFormat {}; new X().resolvedOptions().locale'), 'de-AT');
  assert.match(r('Function.prototype.toString.call(Intl.DateTimeFormat)'), /native code/);
  assert.match(r('Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Navigator.prototype, "languages").get)'), /native code/);
});

test('intl:false leaves Intl alone', () => {
  const ctx = makeContext();
  const before = vm.runInContext('Intl.DateTimeFormat', ctx);
  installPatches(vm.runInContext('globalThis', ctx), ['de'], { intl: false });
  assert.equal(vm.runInContext('Intl.DateTimeFormat', ctx), before);
  assert.equal(vm.runInContext('navigator.language', ctx), 'de');
});

test('serialised worker prelude runs standalone in a worker-like realm', () => {
  const src = Function.prototype.toString.call(installPatches).replace(/\s*[\r\n]\s*/g, ' ');
  assert.ok(!src.includes('\n'));
  const prelude = `;(${src})(self,["ja","en"],{"intl":true});`;
  const ctx = vm.createContext({});
  vm.runInContext(
    `class WorkerNavigator { get language() { return 'xx'; } get languages() { return ['xx']; } }
     globalThis.WorkerNavigator = WorkerNavigator; globalThis.navigator = new WorkerNavigator();
     globalThis.self = globalThis;`,
    ctx
  );
  const worker = splicePrelude('"use strict";\nvar out = [navigator.language, new Intl.DateTimeFormat().resolvedOptions().locale, (function(){ return this; })()];', prelude);
  vm.runInContext(worker, ctx);
  const out = vm.runInContext('out', ctx);
  assert.equal(out[0], 'ja');
  assert.equal(out[1], 'ja');
  assert.equal(out[2], undefined, 'strict mode preserved');
});

test('blob: and data: worker URLs are rewritten', () => {
  const ctx = makeContext();
  vm.runInContext(
    `globalThis.created = [];
     globalThis.Worker = class Worker { constructor(url, opts) { created.push(String(url)); } };
     globalThis.Blob = class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } };
     let n = 0; const store = new Map();
     globalThis.URL = class URL {};
     URL.createObjectURL = (b) => { const u = 'blob:https://ex.com/' + (n++); store.set(u, b); return u; };
     URL.revokeObjectURL = (u) => {};
     globalThis.getBlob = (u) => store.get(u);
     globalThis.setTimeout = () => {};
     globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');`,
    Object.assign(ctx, { Buffer, TextDecoder })
  );
  installPatches(vm.runInContext('globalThis', ctx), ['fr'], { intl: true });
  const r = (code) => vm.runInContext(code, ctx);
  r(`const u = URL.createObjectURL(new Blob(['"use strict";', 'postMessage(1)'], {type: 'text/javascript'}));
     new Worker(u); URL.revokeObjectURL(u);`);
  const blobUrl = r('created[0]');
  assert.notEqual(blobUrl, 'blob:https://ex.com/0');
  const text = r(`getBlob(created[0]).parts[0]`);
  assert.ok(text.startsWith('"use strict";;('), text.slice(0, 40));
  assert.ok(text.endsWith('postMessage(1)'));

  r(`new Worker('data:text/javascript;base64,' + Buffer.from('postMessage("é")').toString('base64'))`);
  const dataUrl = r('created[1]');
  assert.ok(dataUrl.startsWith('data:text/javascript;charset=utf-8,'));
  assert.ok(decodeURIComponent(dataUrl.split(',').slice(1).join(',')).endsWith('postMessage("é")'));

  r(`new Worker('/worker.js')`);
  assert.equal(r('created[2]'), '/worker.js');
});
