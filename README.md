# Shadow Heading Outliner

Outlines, labels, lists, and audits every heading on a page, including headings
nested arbitrarily deep in **open or closed** shadow roots.

Existing heading extensions typically stop at the first closed root, because a
content script reading `element.shadowRoot` gets `null` there. Extensions have a
privileged API that page scripts don't, and this tool uses it.

Three surfaces over one shadow-piercing walk:

- **In-place overlay** — a colored, labeled box on every heading, for defect
  screenshots.
- **Outline sidebar** — a docked, keyboard-operable tree of the headings in
  reading order; click a row to scroll to it and flash it.
- **Hierarchy audit** — WCAG-keyed flags for empty headings, skipped levels, and
  missing/duplicate `h1`, split into violations and best-practice advisories.

## Privacy

Zero network requests. No `host_permissions`, no content scripts registered
against any URL — the walker is injected only into the tab you click on, only
when you click. Nothing is stored except your label-detail preference in
`chrome.storage.local`. Nothing leaves the browser.

## Install

Unpacked, until it's on the Web Store:

1. `chrome://extensions` → enable Developer mode
2. Load unpacked → select the `extension/` directory
3. Open the puzzle-piece menu and pin **Shadow Heading Outliner** so its icon
   is on the toolbar
4. Click the icon, or press `Alt+Shift+H`, to toggle it on a tab

Load it through `chrome://extensions`, not the `--load-extension` command-line
switch: Chrome 137+ ignores unpacked extensions passed on the command line. For
an install-free look on a page built from *open* shadow roots, open
`demo/standalone.html` — it loads the same walker and overlay as ordinary page
scripts, no extension required (closed roots need the extension).

## Use

Each heading gets an outlined box and a label.

| Encoding | Meaning |
| --- | --- |
| Solid border | Native `h1`–`h6` |
| Dashed border, `·aria` | Level came from `aria-level`, or the element is `role="heading"` |
| Dotted border, `·hidden` | Visually hidden but still in the accessibility tree |
| Border color | Level. Redundant with the label text, so screenshots survive grayscale and CVD reviewers. |

Colors are white-on-color at 5.9:1 minimum. Every box and label carries a 1px
white ring so it stays legible on dark backgrounds — the difference between a
usable defect screenshot and a useless one.

The chip at bottom-left reports counts, including the cases that cannot be drawn
in place: `display:none` headings have no geometry, off-screen headings are
outside the viewport, and headings inside `aria-hidden` or `inert` subtrees are
excluded from annotation by design. They are counted so that a heading missing
from a screenshot is never mistaken for a tool bug.

| Key | Action |
| --- | --- |
| `Esc` | Close |
| `Alt+Shift+M` | Cycle label detail: level → owning component → full chain |
| `Alt+Shift+C` | Copy the outline as indented text |
| `Alt+Shift+Q` | Quiet: make the tool `inert`+`aria-hidden` so the page's own tab order and screen-reader output can be tested clean, then restore |
| `Alt`+click a box | Copy that heading's selector chain and console expression |

## Outline sidebar

A panel docks to the right of the top document. Each heading is one row,
indented by level, in reading order. The rows are real `<button>`s: `Tab` to
them, `Enter`/`Space` to activate. Activating a row scrolls that heading into
view — across shadow boundaries, since `scrollIntoView` on the element works even
inside a closed root — and pulses a highlight over it.

The **Level + text / + Component / + Selector** control sets how much each row
shows. It is a real segmented control, not a hover tooltip, because tooltips are
not an accessible way to expose that detail. The setting is shared with the
overlay's `Alt+Shift+M` cycle, so the two surfaces never disagree, and it
persists in `chrome.storage.local`.

The panel is the one part of the tool that is *not* `aria-hidden`: an auditor who
themselves uses a screen reader or the keyboard has to be able to drive it. The
cost is that it adds a landmark and focus stops to the page under test — which is
exactly what **Quiet** (`Alt+Shift+Q`, or the button in the panel) exists to
remove on demand. The panel is top-frame only; headings inside iframes are boxed
in place but not listed, because a sidebar inside every iframe would be absurd
and cross-origin frames cannot share the data anyway.

The panel occludes the right edge of the page rather than reflowing it. That is
deliberate: reflowing would alter the very layout you are auditing. Collapse it,
resize it by dragging its inner edge, or Quiet it to see what is underneath.

## Hierarchy audit

Findings come in two tiers, because an auditor files one as a defect and the
other as a note:

| Finding | Tier | Basis |
| --- | --- | --- |
| Empty heading (no perceivable accessible name) | **Violation** | WCAG 1.3.1 Info & Relationships (A), 2.4.6 Headings & Labels (AA); axe `empty-heading` |
| Skipped level (e.g. `h2`→`h4`) | Advisory | WCAG 1.3.1, technique G141 — not a strict failure, but a standard audit finding |
| No `h1` on the page | Advisory | Relates to 1.3.1 and 2.4.10 Section Headings (AAA) |
| More than one `h1` | Advisory | HTML permits it; weakens the top-level outline |
| First heading deeper than `h1` | Advisory | Advisory |

"Empty" is judged against an approximate accessible name, not raw text, so a
heading named by `aria-label`, `aria-labelledby`, a captioned image, or `title`
is not a false positive. The hierarchy is computed over headings in the
accessibility tree — `display:none`, `aria-hidden`, and `inert` headings are
excluded from the checks (and from annotation), while off-screen and visually
hidden ones still count.

Violations get a heavier double-red ring on the box and a `✕` in the label and
row; advisories get a single amber ring and a `⚠`. The encoding is redundant with
the label text so a grayscale or CVD screenshot still reads. The chip and the
panel summary count each tier, and the copied record and copied outline cite the
Success Criterion number.

### Label detail modes

```
H3
H3 <nav-bar>
H3 app-shell >>> nav-bar >>> h3.site-title
```

Class names inside shadow DOM are usually scoped noise, but the component tag
maps to a file in the repo, so `<nav-bar>` is the token a developer greps for.
Classes and id appear in the full-chain mode on the leaf only.

### The copied record

```
H3 (aria-level)
Regional breakdown
app-shell >>> nav-bar >>> h3.site-title
document.querySelector('app-shell').shadowRoot
  .querySelector('nav-bar').shadowRoot
  .querySelector('h3.site-title')
```

If the chain crosses a closed root, the record says so explicitly, because the
console expression returns `null` in that case — the DevTools console has no
equivalent of the extension's privileged access. The `>>>` chain is the durable
form: Playwright pierces shadow DOM by default, and Puppeteer accepts `>>>`.

## Accessibility of the tool itself

- The annotation layer is `aria-hidden` and `pointer-events: none`. The chip is
  `aria-hidden` with `tabindex="-1"` buttons. Neither injects a tab stop or an
  accessibility-tree node, so an axe run or screen-reader pass with the overlay
  on is uncontaminated.
- The sidebar panel is the deliberate exception: it *is* exposed and keyboard-
  operable, because the tool's own UI has to work for an auditor who uses
  assistive tech. It therefore adds a `complementary` landmark and focus stops.
  **Quiet** (`Alt+Shift+Q`) makes the whole tool `inert`+`aria-hidden` on demand
  so the page's own keyboard order and screen-reader output can be tested clean,
  then restores it. This is the reconciliation of "the tool must be accessible"
  with "the tool must not contaminate the page under test."
- The panel is theme-aware (`prefers-color-scheme`), so it is legible over both
  light and dark pages without washing out a screenshot.
- `forced-color-adjust: none` on every box and label. Windows High Contrast
  otherwise overrides `border-color` and flattens the level encoding.

## Browser support

| Environment | API | Closed roots |
| --- | --- | --- |
| Chrome / Edge extension | `chrome.dom.openOrClosedShadowRoot` | yes |
| Firefox extension | `Element.openOrClosedShadowRoot` | yes |
| Safari extension | none | **no** |
| Bookmarklet / page world | `Element.shadowRoot` | **no** |

The chip prints `open roots only` whenever closed roots are unreachable. A
heading tool that quietly under-reports is worse than no tool.

Safari would need a different approach: patching `Element.prototype.attachShadow`
in the page's main world at `document_start` and recording roots as they're
created. That only catches roots created after injection, so it is a partial
answer and should ship labeled as one.

## Bookmarklet

```
node build/build-bookmarklet.mjs
```

Writes `dist/bookmarklet.html` with a drag-to-install link. This target exists
because extension installs are blocked by policy in many government and finance
environments, which is where you most need to hand a heading tool to somebody
else's dev team. Open roots only, and the chip says so.

## Tests

```
npm i -D @playwright/test && npx playwright install chromium
npx playwright test
```

`test/fixtures/deep-shadow.html` covers six closed roots nested one per level,
open roots inside open roots, declarative shadow DOM, slotted headings whose text
`textContent` cannot see, `aria-level` overriding the tag, `role="heading"` with
and without a level, `role="presentation"` on an `h3`, sr-only and off-screen and
`display:none` and `visibility:hidden` headings, `aria-hidden` and `inert`
subtrees, a same-origin frame with its own closed root, and a heading appended
after load.

The fixtures are worth as much as the code. The reason existing extensions fail
at four levels deep is that nobody had a fixture that went four levels deep.

## Structure

`extension/walker.js` has no heading logic in it and is meant to be lifted out as
a standalone package. It exports composed-tree traversal, a `closest` that
crosses shadow boundaries (`Element.closest` cannot), and a text resolver that
expands `<slot>` to its assigned nodes. Every tool that needs to see into shadow
DOM needs this part; the heading annotator on top of it is the easy half.

## Known limitations

- Slot-aware `aria-hidden` inheritance follows the composed ancestor chain, not
  the full flattened-tree semantics. A heading assigned to a slot inside an
  `aria-hidden` shadow subtree may not be classified as hidden.
- Reading order is composed pre-order (host, then shadow content, then light
  children). Slotted light content is ordered at its light-DOM position, not its
  flattened slot position, so the outline order for slotted headings can differ
  from what is painted. Level-skip findings are computed on that same order.
- The hierarchy checks include visually-hidden and off-screen headings, which
  are in the accessibility tree, but do not attempt to model reading order across
  same-origin iframes — each frame is audited independently and only the top
  frame's headings appear in the sidebar.
- Selector chains are not guaranteed unique; `querySelector` returns the first
  match at each hop.
- Capped at 3000 headings per frame, reported in the chip when hit.
- Full page navigation drops the overlay. Toggle again. This is the cost of
  `activeTab` instead of blanket host permissions, which is the right trade for
  a tool that gets run against customer sites under a security review.
- The bookmarklet build is now past ~64KB, which some non-Chromium browsers
  truncate. Chrome and Edge — the closed-root targets — handle it; the build
  still prints the warning so the limit is never a silent surprise.

## License

Not yet chosen. The relevant fork: MPL-2.0 is what
[axe-core](https://github.com/dequelabs/axe-core) uses — per-file copyleft that
commercial vendors can embed without relicensing their product, which is part of
why it's everywhere. MIT maximizes the odds the walker becomes the default
implementation. GPL-3.0 if the priority is that it not be absorbed uncredited
into a paid extension.
