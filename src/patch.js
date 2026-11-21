/*
 * Page-world patches.
 *
 * This file is loaded in three places:
 *  1. As a MAIN-world content script in every frame (see manifest.json). It waits for the
 *     isolated content script to tell it the languages for this frame, then installs patches.
 *  2. In the background page, where it only exposes installPatches() so that its source can be
 *     injected into worker scripts (see background.js).
 *  3. In Node for the unit tests.
 *
 * installPatches() is serialised with Function.prototype.toString and run inside workers, so it
 * must be fully self-contained, use explicit semicolons and contain no line comments
 * (its source is collapsed onto one line so that worker line numbers / source maps stay intact).
 */
(function () {
  'use strict';

  function installPatches(G, langs, opts) {
    'use strict';
    /* Reusable string helper, also exported for the background page. */
    var PROLOGUE_RE = new RegExp(
      '^(?:#![^\\n\\r]*(?:\\r\\n|[\\n\\r]))?' +
      '(?:(?:\\s|/\\*[\\s\\S]*?\\*/|/(?=/)/[^\\n\\r]*)*' +
      '(?:\'(?:[^\'\\\\\\n\\r]|\\\\[\\s\\S])*\'|"(?:[^"\\\\\\n\\r]|\\\\[\\s\\S])*")' +
      '(?=[ \\t]*;|[ \\t]*(?:/(?=/)/[^\\n\\r]*)?[\\r\\n]+\\s*[A-Za-z_$\'"])' +
      '[ \\t]*;?)*'
    );
    function splicePrelude(text, prelude) {
      var m = PROLOGUE_RE.exec(text);
      var at = m ? m[0].length : 0;
      return text.slice(0, at) + prelude + text.slice(at);
    }
    if (G === null) {
      return { splicePrelude: splicePrelude };
    }
    if (!G || !langs || !langs.length) {
      return;
    }
    opts = opts || {};

    var R = G.Reflect;
    var P = G.Proxy;
    var O = G.Object;
    var apply = R.apply;
    var construct = R.construct;
    var getDesc = O.getOwnPropertyDescriptor;
    var defProp = O.defineProperty;
    var isArray = G.Array.isArray;
    var fnToString = G.Function.prototype.toString;
    var stringify = G.JSON.stringify;

    var list = O.freeze(G.Array.from(langs));
    var first = list[0];

    function copyArgs(args) {
      var a = [];
      for (var i = 0; i < args.length; i++) {
        a[i] = args[i];
      }
      return a;
    }

    function withLocales(args, idx) {
      var l = args[idx];
      if (args.length > idx && !(l === undefined || (isArray(l) && l.length === 0))) {
        return args;
      }
      var a = copyArgs(args);
      while (a.length < idx) {
        a.push(undefined);
      }
      a[idx] = list;
      return a;
    }

    function replaceValue(holder, name, value) {
      var d = getDesc(holder, name);
      d.value = value;
      defProp(holder, name, d);
    }

    function wrapGetter(proto, name, handler) {
      if (!proto) {
        return;
      }
      var d = getDesc(proto, name);
      if (!d || typeof d.get !== 'function') {
        return;
      }
      d.get = new P(d.get, { apply: handler });
      defProp(proto, name, d);
    }

    function constantGetter(value) {
      return function (target, self, args) {
        apply(target, self, args);
        return value;
      };
    }

    function wrapMethod(holder, name, idx) {
      var orig = holder && holder[name];
      if (typeof orig !== 'function') {
        return;
      }
      replaceValue(holder, name, new P(orig, {
        apply: function (t, self, args) {
          return apply(t, self, withLocales(args, idx));
        }
      }));
    }

    function wrapCtor(holder, name, idx, extra) {
      var orig = holder && holder[name];
      if (typeof orig !== 'function') {
        return;
      }
      var px = new P(orig, {
        apply: function (t, self, args) {
          return apply(t, self, idx < 0 ? args : withLocales(args, idx));
        },
        construct: function (t, args, nt) {
          var a = idx < 0 ? args : withLocales(args, idx);
          if (extra) {
            a = extra(a);
          }
          return construct(t, a, nt);
        }
      });
      replaceValue(holder, name, px);
      var proto = orig.prototype;
      var cd = proto && getDesc(proto, 'constructor');
      if (cd && cd.value === orig) {
        cd.value = px;
        defProp(proto, 'constructor', cd);
      }
      return px;
    }

    /* ---- navigator.language / navigator.languages ---- */
    [G.Navigator, G.WorkerNavigator].forEach(function (N) {
      var proto = N && N.prototype;
      wrapGetter(proto, 'languages', constantGetter(list));
      wrapGetter(proto, 'language', constantGetter(first));
    });

    /* ---- Intl default locale and toLocale*() ---- */
    if (opts.intl !== false && G.Intl) {
      ['Collator', 'DateTimeFormat', 'NumberFormat', 'PluralRules', 'RelativeTimeFormat',
        'ListFormat', 'DisplayNames', 'Segmenter', 'DurationFormat'].forEach(function (name) {
        wrapCtor(G.Intl, name, 0);
      });
      var dp = G.Date && G.Date.prototype;
      wrapMethod(dp, 'toLocaleString', 0);
      wrapMethod(dp, 'toLocaleDateString', 0);
      wrapMethod(dp, 'toLocaleTimeString', 0);
      wrapMethod(G.Number && G.Number.prototype, 'toLocaleString', 0);
      wrapMethod(G.BigInt && G.BigInt.prototype, 'toLocaleString', 0);
      var sp = G.String && G.String.prototype;
      wrapMethod(sp, 'localeCompare', 1);
      wrapMethod(sp, 'toLocaleUpperCase', 0);
      wrapMethod(sp, 'toLocaleLowerCase', 0);
      if (G.Temporal) {
        ['Instant', 'ZonedDateTime', 'PlainDate', 'PlainTime', 'PlainDateTime', 'PlainYearMonth',
          'PlainMonthDay', 'Duration'].forEach(function (name) {
          var T = G.Temporal[name];
          wrapMethod(T && T.prototype, 'toLocaleString', 0);
        });
      }
    }

    /* ---- Workers created from blob: and data: URLs (network ones are handled by the background) ---- */
    var srcFn = apply(fnToString, installPatches, []).replace(/\s*[\r\n]\s*/g, ' ');
    var prelude = ';(' + srcFn + ')(self,' + stringify(langs) + ',' + stringify(opts) + ');';
    var OrigBlob = G.Blob;
    var origCreateURL = G.URL && G.URL.createObjectURL;
    var origRevokeURL = G.URL && G.URL.revokeObjectURL;
    var setTimeout_ = G.setTimeout;
    var blobText = new G.WeakMap();
    var urlBlob = new G.Map();
    var wmGet = G.WeakMap.prototype.get;
    var wmSet = G.WeakMap.prototype.set;
    var mGet = G.Map.prototype.get;
    var mSet = G.Map.prototype.set;
    var mDel = G.Map.prototype['delete'];

    if ((G.Worker || G.SharedWorker) && OrigBlob && origCreateURL) {
      var blobProxy = new P(OrigBlob, {
        construct: function (t, args, nt) {
          var b = construct(t, args, nt);
          try {
            var parts = args[0];
            var type = args[1] && args[1].type;
            if (isArray(parts) && parts.length && (!type || /script/i.test(String(type)))) {
              var s = '';
              for (var i = 0; i < parts.length; i++) {
                if (typeof parts[i] !== 'string') {
                  return b;
                }
                s += parts[i];
              }
              if (s.length < 16777216) {
                apply(wmSet, blobText, [b, s]);
              }
            }
          } catch (e) {}
          return b;
        }
      });
      replaceValue(G, 'Blob', blobProxy);
      var bcd = getDesc(OrigBlob.prototype, 'constructor');
      if (bcd && bcd.value === OrigBlob) {
        bcd.value = blobProxy;
        defProp(OrigBlob.prototype, 'constructor', bcd);
      }

      replaceValue(G.URL, 'createObjectURL', new P(origCreateURL, {
        apply: function (t, self, args) {
          var u = apply(t, self, args);
          try {
            if (args[0] instanceof OrigBlob) {
              apply(mSet, urlBlob, [u, args[0]]);
            }
          } catch (e) {}
          return u;
        }
      }));
      if (origRevokeURL) {
        replaceValue(G.URL, 'revokeObjectURL', new P(origRevokeURL, {
          apply: function (t, self, args) {
            try {
              apply(mDel, urlBlob, [String(args[0])]);
            } catch (e) {}
            return apply(t, self, args);
          }
        }));
      }
    }

    function rewriteWorkerURL(url) {
      var s = String(url);
      var lower = s.slice(0, 5).toLowerCase();
      if (lower === 'blob:') {
        var blob = apply(mGet, urlBlob, [s]);
        if (!blob) {
          return null;
        }
        var text = apply(wmGet, blobText, [blob]);
        var nb = typeof text === 'string'
          ? new OrigBlob([splicePrelude(text, prelude)], { type: 'text/javascript' })
          : new OrigBlob([prelude, blob], { type: 'text/javascript' });
        var nu = apply(origCreateURL, G.URL, [nb]);
        if (setTimeout_ && origRevokeURL) {
          apply(setTimeout_, G, [function () { apply(origRevokeURL, G.URL, [nu]); }, 60000]);
        }
        return nu;
      }
      if (lower === 'data:') {
        var comma = s.indexOf(',');
        if (comma < 0) {
          return null;
        }
        var meta = s.slice(5, comma);
        var body = s.slice(comma + 1);
        var src;
        if (/;base64$/i.test(meta)) {
          var bin = G.atob(body.replace(/%([0-9a-f]{2})/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }));
          var bytes = new G.Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
          }
          src = new G.TextDecoder('utf-8').decode(bytes);
        } else {
          src = G.decodeURIComponent(body);
        }
        return 'data:text/javascript;charset=utf-8,' + G.encodeURIComponent(splicePrelude(src, prelude));
      }
      return null;
    }

    ['Worker', 'SharedWorker'].forEach(function (name) {
      wrapCtor(G, name, -1, function (a) {
        try {
          if (a.length) {
            var nu = rewriteWorkerURL(a[0]);
            if (nu) {
              a = copyArgs(a);
              a[0] = nu;
            }
          }
        } catch (e) {}
        return a;
      });
    });

    /* ---- Same-origin child windows accessed synchronously (about:blank iframes, popups) ---- */
    if (G.HTMLIFrameElement) {
      var patched = new G.WeakSet();
      var wsHas = G.WeakSet.prototype.has;
      var wsAdd = G.WeakSet.prototype.add;
      var patchChild = function (w) {
        try {
          if (!w) {
            return;
          }
          var realmKey = w.Object;
          if (!realmKey || realmKey === O || apply(wsHas, patched, [realmKey])) {
            return;
          }
          apply(wsAdd, patched, [realmKey]);
          installPatches(w, langs, opts);
        } catch (e) {}
      };
      var childGetter = function (isDoc) {
        return function (t, self, args) {
          var r = apply(t, self, args);
          if (r) {
            patchChild(isDoc ? r.defaultView : r);
          }
          return r;
        };
      };
      [G.HTMLIFrameElement, G.HTMLFrameElement, G.HTMLObjectElement].forEach(function (E) {
        var proto = E && E.prototype;
        wrapGetter(proto, 'contentWindow', childGetter(false));
        wrapGetter(proto, 'contentDocument', childGetter(true));
      });
      if (typeof G.open === 'function') {
        replaceValue(G, 'open', new P(G.open, {
          apply: function (t, self, args) {
            var w = apply(t, self, args);
            patchChild(w);
            return w;
          }
        }));
      }
    }
  }

  /* Background page / tests: just expose the function. */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { installPatches: installPatches };
    return;
  }
  if (typeof location !== 'undefined' && location.protocol === 'moz-extension:') {
    globalThis.LPSInstallPatches = installPatches;
    return;
  }

  /*
   * MAIN-world content script: handshake with the isolated content script, which holds the
   * configuration. Both run at document_start before any page script, in unspecified order,
   * so whichever runs second completes the exchange synchronously.
   */
  var CFG_EVENT = 'lps-config-6c1f0e';
  var REQ_EVENT = 'lps-request-6c1f0e';
  var done = false;
  function onConfig(e) {
    if (done) {
      return;
    }
    done = true;
    e.stopImmediatePropagation();
    window.removeEventListener(CFG_EVENT, onConfig, true);
    var cfg;
    try {
      cfg = JSON.parse(e.detail);
    } catch (err) {
      return;
    }
    if (cfg && cfg.langs && cfg.langs.length) {
      try {
        installPatches(window, cfg.langs, cfg.opts);
      } catch (err) {
        /* never break the page */
      }
    }
  }
  window.addEventListener(CFG_EVENT, onConfig, true);
  window.dispatchEvent(new CustomEvent(REQ_EVENT));
  window.addEventListener('DOMContentLoaded', function () {
    if (!done) {
      done = true;
      window.removeEventListener(CFG_EVENT, onConfig, true);
    }
  }, true);
})();
