# Language per Site (Firefox extension)

Override Firefox's preferred languages for individual sites.

## Disclaimer

This extension was created by Claude Code.

## Configuration

The settings page (Add-ons → Language per Site → Preferences, or the gear in the toolbar popup)
and the toolbar popup show the same rule list. The settings page adds a site tester that
highlights the matching rule, the JavaScript-locale option, and *Edit as text* for bulk changes
and comments. In text form, each rule is one line:

```
# site-pattern = languages
example.com       = en-GB, en, de    # only example.com
*.example.com     = de, en           # example.com AND all its subdomains
*                 = en-US, en        # every site without a more specific rule
login.example.com = default          # no override, use Firefox's own setting
/^shop\d+\.example\.com$/ = fr        # regular expression (in slashes)
```

- Precedence: exact host, then regular expressions (the first matching one from the top),
  then the longest matching `*.domain`, then `*`.
- A rule in slashes, `/…/`, is a JavaScript regular expression tested against the hostname
  (for example `www.example.com`, without scheme, port or path). Matching ignores case and
  is not anchored, so use `^…$` to match the whole hostname. International domain names
  appear in punycode form (`xn--…`).
- You can paste full URLs (`https://www.example.com/x`), which become `www.example.com`.
  International domain names are supported.
- Language tags are validated and their case is normalised (`en-gb` → `en-GB`).
- **Toolbar popup:** shows the languages the current tab gets and lets you save a rule for it at
  any level (`www.example.com`, `*.example.com`, `*.com`, `*`). Below that it lists all rules:
  click a site pattern or language list to edit it (Enter saves, Esc reverts), `×` deletes (with
  Undo), `+ Add rule` adds one, and the `⋮⋮` handle on the right reorders by dragging (or focus it
  and press ↑/↓). The rule that applies to the current tab is highlighted. A duplicate pattern
  that is overridden by a later line is dimmed. Comments and blank lines in the text are kept.
- Order only matters among regular-expression rules (the first match wins). For the other rules
  the most specific one always wins, so reordering them is only for readability.
- Changes apply to pages loaded after saving. Reload open tabs to pick them up.

## What gets overridden

| Surface | How |
|---|---|
| `Accept-Language` header on navigations, frames, subresources, `fetch`/XHR, WebSocket, EventSource, beacons, and worker script loads | `webRequest.onBeforeSendHeaders`, using the same q-value format Firefox uses (`de,en;q=0.9,…`) |
| `navigator.language` / `navigator.languages` in pages and iframes | main-world content script installed at `document_start`, before any page script runs |
| Same-origin `about:blank` iframes and `window.open()` popups that are accessed synchronously | `contentWindow`, `contentDocument` and `open()` are hooked so the child is patched before it is returned |
| Dedicated, shared and service workers loaded from the network | the patch is spliced into the worker script with `webRequest.filterResponseData`, after any `"use strict"` prologue |
| Workers created from `blob:` and `data:` URLs, including nested workers | the `Worker`/`SharedWorker` constructors rewrite the script |
| JavaScript default locale: `Intl.*` constructors, `Date`/`Number`/`BigInt`/`Temporal` `toLocale*String()`, `localeCompare()`, `toLocaleUpper/LowerCase()` | wrapped so that a missing or empty `locales` argument means your languages. You can turn this off in the settings. |

Overrides are done with `Proxy` wrappers. `toString()` still reports native code, prototype and
`constructor` links are kept, and `navigator.languages` stays frozen and returns the same object
on every read.

**Which rule applies to a request?** The rule of the document (frame or worker) that made it.
Navigations and worker scripts use the URL being loaded. This keeps a document's HTTP requests
consistent with what its JavaScript sees. So an embedded third-party iframe uses the rule for its
own host, and a `fetch()` from `example.com` to an API on another domain uses `example.com`'s
rule. If a page sets `Accept-Language` on a `fetch()`/XHR itself, that value is kept.

## Limitations

- Firefox draws some things itself (date pickers, form validation messages, the PDF viewer,
  spell-checking) in its own UI language. Extensions cannot change these.
- `window[0]` / `frames[0]` indexed access to a just-created `about:blank` iframe is not hooked.
  `iframe.contentWindow` is.
- Static `import`s in module workers run before the patch.
- A service worker keeps the languages it was installed with until the browser updates it.
- Worker scripts served over plain `http://` (not localhost) are not patched, because Firefox
  only sends the `Sec-Fetch-Dest` header used to recognise them to secure origins.
- A classic `blob:` worker built from non-string parts gets the patch prepended, so its
  `"use strict"` directive no longer applies.

## Install

- **Try it out:** `about:debugging` → *This Firefox* → *Load Temporary Add-on…* → choose
  `manifest.json`. Or run `npm start`.
- **Permanent:** `npm run build` creates a zip in `web-ext-artifacts/`. Sign it via
  [addons.mozilla.org](https://addons.mozilla.org/developers/) (as unlisted for personal use)
  and install the signed `.xpi`.
- Requires Firefox 128 or newer (for `world: "MAIN"` content scripts). To use it in private
  windows, allow it there in the add-on's settings.

## Development

```
npm test           # unit tests (rules, header format, patches in a vm realm)
npm run test:e2e   # headless Firefox via WebDriver BiDi + local server
npm run test:popup # popup + settings UI in headless Firefox: drag, keyboard, edit, delete/undo, text editor
npm run lint       # web-ext lint
npm run assets     # regenerate the AMO listing assets in amo/ (screenshots, icon, listing.md)
```

The addons.mozilla.org listing lives in [amo/](amo/): edit the text in
[amo/metadata.json](amo/metadata.json), then run `npm run assets` to refresh
[amo/listing.md](amo/listing.md) and the screenshots.

Files: [src/rules.js](src/rules.js) parses and matches rules,
[src/rules-ui.js](src/rules-ui.js) is the rule list shared by the popup and the settings page,
[src/patch.js](src/patch.js) holds the page and worker patches,
[src/content-isolated.js](src/content-isolated.js) passes the config to the page,
and [src/background.js](src/background.js) handles headers, worker scripts and content script
registration.
