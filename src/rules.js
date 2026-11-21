/*
 * Rule parsing, matching and Accept-Language formatting.
 * Shared by the background page, options page, popup and the isolated content script.
 *
 * Config format, one rule per line:
 *
 *   # comment
 *   example.com        = en-GB, en, de    exact host only
 *   *.example.com      = de, en           example.com and all of its subdomains
 *   *                  = en-US, en        every site without a more specific rule
 *   intranet.corp.com  = default          no override (use Firefox's own setting)
 *   /^shop\d+\.example\.com$/ = fr      regular expression, tested against the hostname
 *
 * Precedence: exact host > regular expressions (first match from the top) >
 *             *.longest.domain > ... > *.tld > *
 */
(function (root) {
  'use strict';

  const DEFAULT_KEYWORDS = new Set(['', 'default', 'none', '-']);

  /** Normalise the case of a BCP 47 tag the way Firefox does (en-gb -> en-GB, zh-hant-tw -> zh-Hant-TW). */
  function normalizeTagCase(tag) {
    return tag
      .split('-')
      .map((part, i) => {
        if (i === 0) return part.toLowerCase();
        if (part.length === 2) return part.toUpperCase(); // region
        if (part.length === 4 && /^[a-z]+$/i.test(part)) {
          return part[0].toUpperCase() + part.slice(1).toLowerCase(); // script
        }
        return part.toLowerCase();
      })
      .join('-');
  }

  /** Validate and normalise one language tag. Returns null if invalid. */
  function normalizeLanguage(raw) {
    const tag = String(raw).trim().replace(/_/g, '-');
    if (!tag || !/^[A-Za-z0-9-]+$/.test(tag)) return null;
    try {
      Intl.getCanonicalLocales(tag); // throws RangeError on structurally invalid tags
    } catch (e) {
      return null;
    }
    return normalizeTagCase(tag);
  }

  const isRegexPattern = (p) => p.length > 2 && p.startsWith('/') && p.endsWith('/');

  /** Compile a regex rule's source. Hostnames are lower-case, so matching is case-insensitive. */
  function compileRegex(source) {
    return new RegExp(source, 'i');
  }

  /**
   * Normalise a host pattern. Returns { kind: 'all'|'exact'|'wild'|'regex', host } or null.
   * For 'regex', host is the expression source (between the slashes).
   */
  function normalizePattern(raw) {
    const trimmed = String(raw).trim();
    if (isRegexPattern(trimmed)) {
      const source = trimmed.slice(1, -1);
      try {
        compileRegex(source);
      } catch (e) {
        return null;
      }
      return { kind: 'regex', host: source };
    }
    let p = trimmed.toLowerCase();
    if (!p) return null;
    if (p === '*') return { kind: 'all', host: '*' };

    // Allow pasting full URLs: https://www.example.com/path -> www.example.com
    const urlMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/.exec(p);
    if (urlMatch) p = urlMatch[1].replace(/^[^@]*@/, '');
    p = p.replace(/:\d+$/, ''); // ignore port
    p = p.replace(/\.$/, '');

    let kind = 'exact';
    if (p.startsWith('*.')) {
      kind = 'wild';
      p = p.slice(2);
    }
    if (!p || p.includes('*')) return null;

    // Use the URL parser to validate and to convert IDN to punycode, matching what Firefox reports.
    let host;
    try {
      host = new URL('http://' + p + '/').hostname;
    } catch (e) {
      return null;
    }
    if (!host || host !== host.trim()) return null;
    return { kind, host };
  }

  /**
   * Parse the configuration text.
   * Returns { rules: {exact, wild, regex, all}, errors: [{line, message}], warnings: [...], entries: [...] }.
   * In rules, a value of null means "explicitly do not override".
   */
  function parseConfig(text) {
    const exact = Object.create(null);
    const wild = Object.create(null);
    let regex = []; // [{ source, langs }] in file order
    let all; // undefined = no rule, null = explicit default
    const errors = [];
    const warnings = [];
    const entries = [];
    const seen = new Map();

    String(text || '')
      .split(/\r?\n/)
      .forEach((rawLine, idx) => {
        const lineNo = idx + 1;
        const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
        if (!line) return;

        // A regex may itself contain "=" or spaces, so it is matched up to the closing slash.
        const m =
          (line.startsWith('/') && /^(\/(?:\\.|[^\\])+?\/)\s*=\s*(.*)$/.exec(line)) ||
          /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
        if (!m) {
          errors.push({ line: lineNo, message: `Expected "pattern = languages", got "${line}"` });
          return;
        }
        const pat = normalizePattern(m[1]);
        if (!pat) {
          let message = `Invalid site pattern "${m[1]}"`;
          if (isRegexPattern(m[1])) {
            try {
              compileRegex(m[1].slice(1, -1));
            } catch (e) {
              message = `Invalid regular expression pattern ${m[1]}: ${e.message}`;
            }
          }
          errors.push({ line: lineNo, message });
          return;
        }

        const value = m[2].trim();
        let langs = null;
        if (!DEFAULT_KEYWORDS.has(value.toLowerCase())) {
          langs = [];
          let invalid = 0;
          const lineSeen = new Set();
          for (const part of value.split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const tag = normalizeLanguage(trimmed.replace(/;q=[\d.]+$/i, ''));
            if (!tag) {
              errors.push({ line: lineNo, message: `Invalid language tag "${trimmed}"` });
              invalid++;
              continue;
            }
            if (lineSeen.has(tag.toLowerCase())) continue;
            lineSeen.add(tag.toLowerCase());
            langs.push(tag);
          }
          if (!langs.length) {
            if (invalid) return;
            errors.push({ line: lineNo, message: 'No valid languages given (use "default" for no override)' });
            return;
          }
        }

        const key = pat.kind + ':' + pat.host;
        if (seen.has(key)) {
          warnings.push({
            line: lineNo,
            message: `Duplicate of line ${seen.get(key)}; this later line wins`,
          });
        }
        seen.set(key, lineNo);

        if (pat.kind === 'regex') {
          // Later duplicate wins and takes the later position.
          regex = regex.filter((r) => r.source !== pat.host);
          regex.push({ source: pat.host, langs });
        } else if (pat.kind === 'all') all = langs;
        else if (pat.kind === 'wild') wild[pat.host] = langs;
        else exact[pat.host] = langs;
        entries.push({ line: lineNo, kind: pat.kind, host: pat.host, langs, rawPattern: m[1], rawValue: value });
      });

    return { rules: { exact, wild, regex, all }, errors, warnings, entries };
  }

  const regexCache = new WeakMap();
  function compiledRegexes(list) {
    let compiled = regexCache.get(list);
    if (!compiled) {
      compiled = list.map((r) => {
        try {
          return compileRegex(r.source);
        } catch (e) {
          return null;
        }
      });
      regexCache.set(list, compiled);
    }
    return compiled;
  }

  /**
   * Find the rule for a hostname.
   * Returns { pattern, langs } (langs null = explicit "default") or null if no rule matches.
   */
  function matchHost(rules, hostname) {
    if (!rules) return null;
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (host) {
      if (Object.prototype.hasOwnProperty.call(rules.exact, host)) {
        return { pattern: host, langs: rules.exact[host] };
      }
      if (rules.regex && rules.regex.length) {
        const compiled = compiledRegexes(rules.regex);
        for (let i = 0; i < compiled.length; i++) {
          if (compiled[i] && compiled[i].test(host)) {
            return { pattern: '/' + rules.regex[i].source + '/', langs: rules.regex[i].langs };
          }
        }
      }
      // Walk up the labels: a.b.example.com -> *.a.b.example.com, *.b.example.com, *.example.com, *.com
      let h = host;
      for (;;) {
        if (Object.prototype.hasOwnProperty.call(rules.wild, h)) {
          return { pattern: '*.' + h, langs: rules.wild[h] };
        }
        const dot = h.indexOf('.');
        if (dot < 0 || h.startsWith('[')) break;
        h = h.slice(dot + 1);
      }
    }
    if (rules.all !== undefined) return { pattern: '*', langs: rules.all };
    return null;
  }

  /** Extract a matchable hostname from a URL (handles blob: URLs). Returns '' if none. */
  function hostFromUrl(url) {
    if (!url) return '';
    try {
      let u = new URL(url);
      if (u.protocol === 'blob:') u = new URL(u.pathname);
      if (/^(https?|wss?|ftp):$/.test(u.protocol)) return u.hostname;
    } catch (e) {
      /* ignore */
    }
    return '';
  }

  /**
   * Format an Accept-Language header value exactly like Firefox does (verified against
   * Firefox 159): the first language has no q-value, then q drops by 0.1 per position, min 0.1.
   */
  function formatAcceptLanguage(langs) {
    return langs
      .map((lang, i) => (i === 0 ? lang : `${lang};q=0.${Math.max(10 - i, 1)}`))
      .join(',');
  }

  /** Parse an Accept-Language header to a list of lower-cased tags (ignores q-values). */
  function parseAcceptLanguage(value) {
    return String(value || '')
      .split(',')
      .map((s) => s.split(';')[0].trim().toLowerCase())
      .filter(Boolean);
  }

  /* ---------- editing the config text (used by the popup) ---------- */

  const splitLines = (text) => String(text || '').split(/\r?\n/);

  /** Split a line into its rule part and trailing "# comment". */
  function splitComment(line) {
    const m = /(^|\s)(#.*)$/.exec(line);
    if (!m) return { body: line, comment: '' };
    return { body: line.slice(0, m.index + m[1].length).trimEnd(), comment: m[2] };
  }

  /** Replace the rule on a line (1-based), keeping its trailing comment and indentation. */
  function updateLine(text, lineNo, newRule) {
    const lines = splitLines(text);
    const old = lines[lineNo - 1] || '';
    const { comment } = splitComment(old);
    const indent = /^\s*/.exec(old)[0];
    lines[lineNo - 1] = indent + newRule + (comment ? '  ' + comment : '');
    return lines.join('\n');
  }

  function deleteLine(text, lineNo) {
    const lines = splitLines(text);
    lines.splice(lineNo - 1, 1);
    return lines.join('\n');
  }

  function appendLine(text, newRule) {
    const lines = splitLines(text);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(newRule, '');
    return lines.join('\n');
  }

  /**
   * Reorder rule lines. `order` lists the line numbers of the rules in their new order; the rules
   * are placed into the same set of line slots, so comments and blank lines stay where they are.
   */
  function reorderLines(text, order) {
    const lines = splitLines(text);
    const slots = order.slice().sort((a, b) => a - b);
    const moved = order.map((n) => lines[n - 1]);
    slots.forEach((n, i) => {
      lines[n - 1] = moved[i];
    });
    return lines.join('\n');
  }

  /** Set the rule for a pattern: replace its effective line (dropping duplicates) or append. */
  function upsertRule(text, pattern, value) {
    const pat = normalizePattern(pattern);
    const newRule = `${pattern} = ${value}`;
    const existing = parseConfig(text).entries.filter((e) => e.kind === pat.kind && e.host === pat.host);
    if (!existing.length) return appendLine(text, newRule);
    const last = existing.pop();
    let out = updateLine(text, last.line, newRule);
    for (const e of existing.reverse()) out = deleteLine(out, e.line);
    return out;
  }

  /** The pattern string matchHost() reports for an entry. */
  function entryPattern(e) {
    if (e.kind === 'regex') return '/' + e.host + '/';
    return e.kind === 'all' ? '*' : e.kind === 'wild' ? '*.' + e.host : e.host;
  }

  const api = {
    splitComment,
    updateLine,
    deleteLine,
    appendLine,
    reorderLines,
    upsertRule,
    entryPattern,
    normalizeLanguage,
    normalizePattern,
    parseConfig,
    matchHost,
    hostFromUrl,
    formatAcceptLanguage,
    parseAcceptLanguage,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LPSRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
