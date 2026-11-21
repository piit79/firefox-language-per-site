# AMO listing for Language per Site

Generated from [metadata.json](metadata.json) by `node amo/make-assets.js`. Edit metadata.json, not this file.

## Name
Language per Site

## Summary (216/250 characters)
Choose which languages each website gets. Overrides the Accept-Language header, navigator.language(s) in pages, frames and workers, and the JavaScript Intl locale. Supports *.domain wildcards and regular expressions.

## Description
Paste as is. AMO keeps line breaks and allows the HTML tags used here.

```html
Firefox sends every website the same preferred languages. Language per Site lets you choose them per site: German for German shops, English for documentation, your own language everywhere else.

<b>How it works</b>
Rules are one line each: a site pattern and a comma-separated list of languages.
<code>example.com = en-GB, en, de</code>   only this exact host
<code>*.example.com = de, en</code>   the domain and all its subdomains
<code>/^shop\d+\.example\.com$/ = fr</code>   a regular expression on the hostname
<code>* = en-US, en</code>   every other site
<code>login.example.com = default</code>   no override, use Firefox's own setting

The most specific rule wins: exact host, then regular expressions (first match from the top), then the longest *.domain, then *.

<b>Toolbar popup</b>
<ul><li>See which languages the current tab gets, and which rule gives them.</li><li>Save a rule for the current site at any level: the exact host, the whole domain, or every site.</li><li>Edit, delete (with Undo) and drag to reorder all your rules.</li></ul>
<b>Settings page</b>
<ul><li>The same rule list, plus a tester: type a URL to see which rule matches and the exact Accept-Language header it sends.</li><li>Edit as text for bulk changes and comments, with per-line validation.</li></ul>
<b>What gets overridden</b>
Not just the Accept-Language header. Sites can also read your languages from JavaScript, so the extension makes all of these agree:
<ul><li>The Accept-Language header on page loads, frames, images, scripts, fetch/XHR, WebSocket and worker requests. A header that a page sets itself on fetch/XHR is left alone.</li><li>navigator.language and navigator.languages in pages, iframes (including about:blank ones) and popups.</li><li>Dedicated, shared and service workers, including workers created from blob: and data: URLs.</li><li>The JavaScript default locale: Intl.DateTimeFormat, Intl.NumberFormat and the other Intl formatters, toLocaleString() on dates and numbers, localeCompare() and more. You can turn this part off.</li></ul>
<b>Limitations</b>
<ul><li>Things Firefox draws itself (date pickers, form validation messages, the PDF viewer) stay in Firefox's UI language. Extensions can't change them.</li><li>Changes apply to pages loaded after saving. Reload open tabs to update them.</li></ul>
<b>Privacy</b>
The extension collects nothing and makes no network requests of its own. Your rules are stored locally in Firefox. The source code is on GitHub.
```

## Categories
language-support, privacy-security

## Homepage
https://github.com/piit79/firefox-language-per-site

## License
MIT

## Screenshots and captions
- `screenshots/1-popup.png`: The toolbar popup: languages for the current site, a quick rule for it, and all your rules
- `screenshots/2-settings.png`: The settings page with the site tester highlighting the rule that matches a URL
- `screenshots/3-text.png`: Edit as text for bulk changes and comments, with per-line validation

## Icon
`icon-128.png` (the manifest's SVG icon, rendered at 128×128)

## Notes to reviewer
```
Language per Site overrides the user's preferred languages per website.

No remote code, no minification, no build step: the package is the repository's manifest.json, src/ and icons/ zipped with `web-ext build`. Source: https://github.com/piit79/firefox-language-per-site

Why each permission and API is used:
- <all_urls>, webRequest, webRequestBlocking: onBeforeSendHeaders rewrites the Accept-Language request header on sites that have a rule (src/background.js).
- webRequest.filterResponseData: worker scripts (recognised by the Sec-Fetch-Dest: worker / sharedworker / serviceworker request header) get a small prelude prepended so navigator.languages and Intl inside the worker match the header. The prelude is the function installPatches from src/patch.js, serialised with Function.prototype.toString, followed by the language list as JSON. Nothing is fetched or generated from external input; any "use strict" directive prologue is kept first. Non-worker responses are never filtered.
- contentScripts.register: registers src/rules.js and src/content-isolated.js with the current settings embedded as `var LPS_CONFIG = <JSON>;` (JSON.stringify of the parsed rules). This is how the config reaches document_start synchronously, before any page script runs.
- MAIN-world content script (src/patch.js): wraps navigator.language(s), Intl constructors and toLocale* methods with Proxies. It receives its configuration from the isolated content script through a one-time CustomEvent handshake.
- storage: the rules text and one option, stored locally.

The extension makes no network requests of its own and collects no data (data_collection_permissions: none).

How to test:
1. Open the toolbar popup on https://httpbin.org/headers, choose "httpbin.org", enter "de-AT, de" and press Save.
2. Reload the page: the Accept-Language header shown is "de-AT,de;q=0.9".
3. In the web console, navigator.languages is ["de-AT", "de"] and new Intl.DateTimeFormat().resolvedOptions().locale is "de-AT".
4. Other sites keep Firefox's default languages.
```

## Other answers in the submission form
- Distribution: **On this site** (listed)
- Source code submission: **No** (no minified, transpiled or generated code)
- Privacy policy: not needed (the extension collects no data)
- Experimental: no. Requires payment: no.
