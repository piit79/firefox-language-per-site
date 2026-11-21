/*
 * Shared rule-list UI used by the toolbar popup and the settings page:
 * one row per rule (pattern box + languages), inline editing, delete, add,
 * and reordering by dragging the handle (or ↑/↓ on the focused handle).
 */
(function (root) {
  'use strict';
  /* global LPSRules */
  const R = LPSRules;

  function el(tag, props = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) e.append(c);
    return e;
  }

  function ruleText(pattern, value) {
    return `${pattern.trim()} = ${value.trim() || 'default'}`;
  }

  /** Validate a rule; returns an error message or ''. */
  function ruleError(pattern, value) {
    if (!pattern.trim()) return 'Enter a site pattern';
    const p = R.parseConfig(ruleText(pattern, value));
    return p.errors.length ? p.errors[0].message : '';
  }

  /**
   * Create a rule list inside `container`.
   * opts:
   *   getText()                      current config text
   *   save(text, message, undoable)  persist new config text (and re-render)
   *   setStatus(text, cls)           show a status message
   *   getHost()                      hostname whose matching rule is highlighted ('' for none)
   *   activeLabel                    badge text on the highlighted rule
   *   activeTitle                    badge tooltip
   *   invalidHint                    appended to the "lines could not be understood" message
   */
  function createRuleList(container, opts) {
    const list = el('div', { id: 'list', class: 'list', role: 'list' });
    const newRows = el('div', { id: 'newRows', class: 'list new-rows' });
    const invalid = el('div', { id: 'invalid', class: 'invalid', hidden: true });
    const addBtn = el('button', { type: 'button', id: 'addRule', class: 'add-btn', textContent: '+ Add rule' });
    container.append(list, newRows, invalid, addBtn);

    addBtn.addEventListener('click', () => addRow());

    function addRow(pattern = '', value = '') {
      const row = buildRow({ line: 0, pattern, value });
      newRows.append(row);
      row.querySelector(pattern ? '.val' : '.pat').focus();
      return row;
    }

    function buildRow({ line, pattern, value, active, overriddenBy }) {
      const pat = el('input', { type: 'text', class: 'pat', value: pattern, spellcheck: false, placeholder: '*.example.com', 'aria-label': 'Site pattern' });
      const val = el('input', { type: 'text', class: 'val', value, spellcheck: false, placeholder: 'en-GB, en  or  default', 'aria-label': 'Languages' });
      const row = el('div', { class: 'rule', role: 'listitem' }, [pat, val]);
      if (line) row.dataset.line = line;

      const markKind = () => {
        val.classList.toggle('is-default', /^(default|none|-)?$/i.test(val.value.trim()) && !!line);
        const isRegex = /^\/.+\/$/.test(pat.value.trim());
        pat.classList.toggle('is-regex', isRegex);
        pat.title = isRegex ? `${pat.value.trim()} — regular expression, tested against the hostname` : '';
      };
      markKind();

      if (active) {
        row.classList.add('active');
        row.append(el('span', { class: 'badge', textContent: opts.activeLabel, title: opts.activeTitle || '' }));
      }
      if (overriddenBy) {
        row.classList.add('overridden');
        row.title = `Ignored: line ${overriddenBy} defines the same pattern and wins`;
      }

      const validate = () => {
        const err = ruleError(pat.value, val.value);
        const patBad = err && /pattern/i.test(err);
        pat.classList.toggle('bad', !!patBad);
        val.classList.toggle('bad', !!err && !patBad);
        markKind();
        if (patBad) pat.title = err;
        val.title = err && !patBad ? err : '';
        return err;
      };
      const commit = () => {
        const err = validate();
        if (err) {
          opts.setStatus(`Not saved: ${err}`, 'err');
          return;
        }
        const text = ruleText(pat.value, val.value);
        if (line) {
          if (pat.value === pattern && val.value === value) return;
          opts.save(R.updateLine(opts.getText(), line, text), 'Rule saved');
        } else {
          row.remove();
          opts.save(R.appendLine(opts.getText(), text), 'Rule added');
        }
      };
      for (const input of [pat, val]) {
        input.addEventListener('input', validate);
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') input.blur();
          if (e.key === 'Escape' && line) {
            e.preventDefault();
            pat.value = pattern;
            val.value = value;
            validate();
            input.blur();
          }
        });
      }

      const del = el('button', { type: 'button', class: 'del', textContent: '×', title: 'Delete rule', 'aria-label': 'Delete rule' });
      del.addEventListener('click', () => {
        if (line) opts.save(R.deleteLine(opts.getText(), line), `Deleted "${pattern}"`, true);
        else row.remove();
      });
      row.append(del);

      if (line) {
        const handle = el('button', {
          type: 'button',
          class: 'handle',
          textContent: '⋮⋮',
          title: 'Drag to reorder (or focus and use ↑/↓)',
          'aria-label': `Reorder ${pattern}`,
        });
        handle.addEventListener('pointerdown', (e) => startDrag(e, row));
        handle.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          moveByKey(row, e.key === 'ArrowUp' ? -1 : 1);
        });
        row.append(handle);
      }
      return row;
    }

    function renderRows() {
      const parsed = R.parseConfig(opts.getText());
      const lastLine = new Map();
      for (const e of parsed.entries) lastLine.set(R.entryPattern(e), e.line);
      const host = opts.getHost();
      const match = host ? R.matchHost(parsed.rules, host) : null;
      const activeLine = match ? lastLine.get(match.pattern) : 0;

      list.textContent = '';
      for (const e of parsed.entries) {
        const winner = lastLine.get(R.entryPattern(e));
        list.append(
          buildRow({
            line: e.line,
            pattern: e.rawPattern,
            value: e.rawValue,
            active: e.line === activeLine,
            overriddenBy: winner !== e.line ? winner : 0,
          })
        );
      }

      const badLines = new Set(parsed.errors.map((e) => e.line));
      invalid.hidden = badLines.size === 0;
      invalid.textContent = badLines.size
        ? `${badLines.size} line${badLines.size > 1 ? 's' : ''} of the configuration could not be understood ` +
          `(line ${[...badLines].join(', ')}). ${opts.invalidHint || ''}`
        : '';
    }

    function render() {
      // Keep focus on the same field across re-renders.
      const a = document.activeElement;
      const row = a && a.closest && list.contains(a) ? a.closest('.rule') : null;
      const focus = row ? { line: row.dataset.line, cls: a.className.split(' ')[0] } : null;
      renderRows();
      if (focus) {
        const target = list.querySelector(`.rule[data-line="${focus.line}"] .${focus.cls}`);
        if (target) target.focus();
      }
    }

    /* ---------- reordering ---------- */

    const currentOrder = () => [...list.children].map((r) => Number(r.dataset.line));

    /** Save a new order; returns the new line number of the rule that was on `trackLine`. */
    function commitOrder(order, trackLine) {
      const before = R.parseConfig(opts.getText()).entries.map((e) => e.line);
      if (order.join() === before.join()) return trackLine;
      const slots = order.slice().sort((x, y) => x - y);
      const newLine = slots[order.indexOf(trackLine)];
      opts.save(R.reorderLines(opts.getText(), order), 'Order saved', true);
      return newLine;
    }

    function startDrag(e, row) {
      if (e.button !== 0) return;
      e.preventDefault();
      // Listen on window: moving the row in the DOM would release pointer capture on the handle.
      row.classList.add('dragging');
      document.body.classList.add('is-dragging');
      let lastY = e.clientY;

      const place = (y) => {
        const others = [...list.children].filter((r) => r !== row);
        const before = others.find((r) => {
          const b = r.getBoundingClientRect();
          return y < b.top + b.height / 2;
        });
        if (before) {
          if (row.nextElementSibling !== before) list.insertBefore(row, before);
        } else if (list.lastElementChild !== row) {
          list.append(row);
        }
      };
      // Auto-scroll near the edges of the list (if it scrolls) or of the window.
      const autoScroll = () => {
        const scrollable = list.scrollHeight > list.clientHeight;
        const b = scrollable ? list.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
        const dir = lastY < b.top + 24 ? -1 : lastY > b.bottom - 24 ? 1 : 0;
        if (!dir) return;
        if (scrollable) list.scrollTop += dir * 8;
        else window.scrollBy(0, dir * 8);
        place(lastY);
      };
      const onMove = (ev) => {
        lastY = ev.clientY;
        place(lastY);
      };
      const scrollTimer = setInterval(autoScroll, 30);
      const end = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        clearInterval(scrollTimer);
        row.classList.remove('dragging');
        document.body.classList.remove('is-dragging');
        commitOrder(currentOrder(), Number(row.dataset.line));
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    }

    function moveByKey(row, dir) {
      const order = currentOrder();
      const line = Number(row.dataset.line);
      const i = order.indexOf(line);
      const j = i + dir;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      const newLine = commitOrder(order, line);
      const handle = list.querySelector(`.rule[data-line="${newLine}"] .handle`);
      if (handle) handle.focus();
    }

    return { render, addRow };
  }

  root.LPSRuleUI = { el, ruleText, ruleError, createRuleList };
})(globalThis);
