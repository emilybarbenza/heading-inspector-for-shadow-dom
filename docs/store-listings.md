# Store listing copy and form answers

Everything to paste into the Chrome Web Store and addons.mozilla.org forms.
Upload packages are built by `npm run build` scripts:

```
node build/build-store-zips.mjs
```

That writes `dist/chrome-store.zip` (upload to Chrome Web Store) and
`dist/firefox-amo.zip` (upload to AMO). Screenshots and the promo tile are in
`docs/store/`.

## Both stores

- Name: `Heading Inspector for Shadow DOM`
- Summary (132 chars max, fits both stores):
  `Outlines, lists, and audits every heading on a page, including inside closed shadow roots, with WCAG-keyed hierarchy flags.`
- Homepage: `https://emilybarbenza.github.io/heading-inspector-for-shadow-dom/`
- Support / source: `https://github.com/emilybarbenza/heading-inspector-for-shadow-dom`
- License: MIT
- Detailed description:

```
Most heading tools stop at the first closed shadow root, because page scripts
reading element.shadowRoot get null there. Extensions have a privileged API
that reaches inside, and this tool uses it. If your app is built from web
components, this shows you the heading structure you actually shipped.

What you get when you toggle it on a tab:

- An in-place overlay: a colored, labeled box on every heading, level color
  plus H1 to H6 text, built for defect screenshots. Boxes scroll with the page.
- An outline sidebar: every heading as an indented tree in reading order.
  It's fully keyboard operable (arrow keys walk the rows), and clicking a row
  scrolls to that heading and highlights it, even inside a closed root.
- A hierarchy audit: empty headings are flagged as WCAG violations (1.3.1,
  2.4.6, the axe empty-heading rule), and skipped levels, missing h1, and
  duplicate h1 are flagged as best-practice advisories. Violations and
  advisories look different and the legend says which is which.
- Copy tools: copy the whole outline as indented text for a bug report, or
  alt+click any box to copy that heading's selector chain and a console
  expression. Chains use the >>> form that Playwright and Puppeteer accept.

The tool's own UI is accessible: the sidebar is a landmark with a real tree
and radio group, tooltips show on keyboard focus, copy actions are announced
to screen readers, all colors pass WCAG AA contrast in light and dark themes,
and prefers-reduced-motion is respected.

Privacy: no network requests, no analytics, no host permissions. It runs only
in the tab you click, only when you click. Nothing leaves the browser.
```

## Chrome Web Store forms

- Category: Developer Tools (Accessibility also fits if you prefer)
- Language: English
- Single purpose description:
  `Inspects and audits the heading structure of the page in the current tab, including headings inside shadow DOM.`
- Permission justifications:
  - `activeTab`: The tool runs only in the tab where the user clicks the
    toolbar icon. This avoids asking for access to all sites.
  - `scripting`: Injects the heading walker and overlay scripts into the
    active tab when the user clicks. That injection is the entire product.
  - `storage`: Remembers one display preference (how much detail each outline
    row shows). Nothing else is stored.
- Data usage: does not collect or transmit any user data. Check "This item
  does not collect user data" and certify the disclosures.
- Assets: `docs/store/screenshot-1-overlay.png`, `screenshot-2-dark.png`,
  `screenshot-3-selector.png` (all 1280x800), small promo tile
  `docs/store/promo-tile-440x280.png`.

## addons.mozilla.org forms

- Categories: Accessibility, Web Development
- Firefox compatibility: 140.0 and later (Android 142.0 and later). The
  manifest declares this.
- Data collection: none. The manifest declares
  `data_collection_permissions: { required: ["none"] }`.
- Notes to reviewer (paste as is):

```
The addons-linter shows two UNSUPPORTED_API warnings for
chrome.dom.openOrClosedShadowRoot in walker.js. That API is Chrome-only and
the code feature-detects it: in Firefox that branch is never taken, and the
walker uses Firefox's own Element.openOrClosedShadowRoot instead (walker.js,
hasGeckoProp). One codebase serves both browsers.

To test: load the add-on, open
https://emilybarbenza.github.io/heading-inspector-for-shadow-dom/demo/standalone.html
and click the toolbar icon (or Alt+Shift+H). Every heading gets a labeled box
and the sidebar lists them; the demo has one planted violation (empty h3) and
one advisory (h2 to h4 skip). The extension makes no network requests.
```

## After either store approves

- Update the README install section to link the store listing instead of (or
  in addition to) the unpacked/temporary flow.
- AMO approval makes Firefox installs permanent and enables Firefox for
  Android from the same listing.
