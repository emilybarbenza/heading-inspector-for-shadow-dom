# Heading inspector for shadow DOM

This visual tool outlines, labels, lists, and performs accessibility checks for every heading on a webpage. It finds headings even when they're nested deep inside **open or closed** shadow roots, which is common for modern web applications.

Most heading extensions and bookmarlets stop at the first closed root, because a content script that reads `element.shadowRoot` gets `null` there.

This tool was designed with accessibility testers and engineers in mind, and is ideal for capturing heading structure details for defect reports, accessibility demos, and more.

The interface consists of:

- **On-page annotation**: a color-coded, labeled box around each heading, good for defect screenshots.
- **Sidebar**: a docked, keyboard-operable tree of the headings in reading order. Select a heading in the tree to scroll to it and flash it.
- **Hierarchy audit**: WCAG-keyed flags for empty headings, skipped levels, and missing or duplicate `h1`, split into WCAG violations and best-practice advisories.

![Every heading in a demo docs article boxed and labeled by level, with the outline sidebar open on the right showing the same headings as an indented tree](docs/images/overlay-hero.png)

## How to install

1. Navigate to `chrome://extensions`
2. Enable the **Developer mode** switch

   ![The chrome://extensions page with the Developer mode switch on and the Load unpacked button highlighted](docs/images/chrome-extensions-page.png)

3. Select the **Load unpacked** button
4. Select the `extension/` directory
5. Open the puzzle-piece menu and pin **Heading Inspector for Shadow DOM** so its icon
   is on the toolbar
6. Select the icon, or press `Alt+Shift+H`, to toggle it on a tab

Load the extension through `chrome://extensions`, not the `--load-extension` command-line
switch: Chrome 137+ ignores unpacked extensions passed on the command line. For
an install-free look on a page built from *open* shadow roots, open
`demo/standalone.html`. It loads the same walker and overlay as ordinary page
scripts, no extension required (closed roots need the extension).

## How to use

Each heading gets an outlined box and a label.

| Encoding | Meaning |
| --- | --- |
| Solid border | Native `h1` to `h6` |
| Dashed border, `·aria` | Level came from `aria-level`, or the element is `role="heading"` |
| Dotted border, `·hidden` | Visually hidden but still in the accessibility tree |
| Border color | Level. It's redundant with the label text, so screenshots survive grayscale and CVD reviewers. |

Colors are white-on-color at 5.9:1 minimum. Every box and label carries a 1px white ring so it stays legible on dark backgrounds. That's what keeps a defect screenshot usable.

The chip at bottom-left reports counts, including the cases that can't be drawn in place: `display:none` headings have no geometry, off-screen headings are outside the viewport, and headings inside `aria-hidden` or `inert` subtrees are left out of annotation on purpose. They're still counted, so a heading missing from a screenshot doesn't get read as a tool bug.

| Key | Action |
| --- | --- |
| `Esc` | Hide the panel (boxes stay); press again, or with the panel already hidden, to close the whole tool |
| `Alt+Shift+M` | Cycle label detail: level, then owning component, then full chain |
| `Alt+Shift+C` | Copy the outline as indented text |
| `Alt+Shift+P` | Hide or show the outline panel. The boxes stay either way. |
| `Alt`+click a box | Copy that heading's selector chain and console expression |

### Sidebar

A panel docks to the right of the top document. Each heading is one row, indented by level, in reading order. The outline is a `tree`: `Tab` into it, then the arrow keys walk the headings (`Home`/`End` jump to the ends), and `Enter`/`Space` activates a row. Each row carries its heading level as `aria-level`. Activating a row scrolls that heading into view and pulses a highlight over it, across shadow boundaries, since `scrollIntoView` on the element works even inside a closed root.

The **Level + text / + Component / + Selector** control sets how much each row shows. It's a real `radiogroup`: one tab stop, arrow keys move and select, and it isn't conveyed by a hover tooltip since tooltips aren't accessible for that. The setting is shared with the overlay's `Alt+Shift+M` cycle, so the two surfaces never disagree, and it persists in `chrome.storage.local`.

Every control's tooltip shows on keyboard focus as well as hover (a native `title` only shows on hover, so keyboard users never saw it) and is wired with `aria-describedby` so a screen reader reads it too.

The panel is the one part of the tool that is *not* `aria-hidden`, because an auditor who uses a screen reader or the keyboard has to be able to drive it. The cost is that it adds a landmark and focus stops to the page under test while it's open, so to audit the page's own tab order or screen-reader output, close the tool (`Esc`) first. The panel is top-frame only. Headings inside iframes get boxed in place but aren't listed, since a sidebar inside every iframe would be silly and cross-origin frames can't share the data anyway.

The panel sits over the right edge of the page instead of reflowing it. That's on purpose, since reflowing would change the layout you're auditing. Resize it by dragging its inner edge, or hide it entirely while keeping the boxes with the header's Hide button, `Alt+Shift+P`, or the chip, and bring it back the same way.

![The overlay and outline sidebar on the same app in dark mode](docs/images/overlay-dark.png)

*The panel follows the page's light or dark theme.*

### Hierarchy audit

Findings come in two tiers, since an auditor files one as a defect and the other as a note:

| Finding | Tier | Basis |
| --- | --- | --- |
| Empty heading (no perceivable accessible name) | **Violation** | WCAG 1.3.1 Info & Relationships (A), 2.4.6 Headings & Labels (AA); axe `empty-heading` |
| Skipped level (e.g. `h2` to `h4`) | Advisory | WCAG 1.3.1, technique G141. Not a strict failure, but a standard audit finding. |
| No `h1` on the page | Advisory | Relates to 1.3.1 and 2.4.10 Section Headings (AAA) |
| More than one `h1` | Advisory | HTML allows it, but it weakens the top-level outline |
| First heading deeper than `h1` | Advisory | Advisory |

"Empty" is judged against an approximate accessible name, not raw text, so a heading named by `aria-label`, `aria-labelledby`, a captioned image, or `title` isn't a false positive. The hierarchy is computed over headings in the accessibility tree. `display:none`, `aria-hidden`, and `inert` headings are left out of the checks (and out of annotation), while off-screen and visually hidden ones still count.

Violations get a heavier double-red ring on the box and a `✕` in the label and row. Advisories get a single amber ring and a `⚠`. The ring is redundant with the label text, so a grayscale or CVD screenshot still reads. The chip and the panel summary count each tier, and the copied record and copied outline cite the Success Criterion number.

![The outline sidebar listing headings by level, with a skipped-level advisory flagged in amber and an empty-heading violation flagged in red](docs/images/audit-sidebar.png)

### Label detail modes

```
H3
H3 <nav-bar>
H3 app-shell >>> nav-bar >>> h3.site-title
```

Class names inside shadow DOM are usually scoped noise, but the component tag maps to a file in the repo, so `<nav-bar>` is the token a developer greps for. Classes and id only show up in full-chain mode, and only on the leaf.

### The copied record

```
H3 (aria-level)
Regional breakdown
app-shell >>> nav-bar >>> h3.site-title
document.querySelector('app-shell').shadowRoot
  .querySelector('nav-bar').shadowRoot
  .querySelector('h3.site-title')
```

If the chain crosses a closed root, the record says so, because the console expression returns `null` in that case. The DevTools console doesn't have the extension's privileged access. The `>>>` chain is the durable form: Playwright pierces shadow DOM by default, and Puppeteer accepts `>>>`.

## Accessibility of the tool itself

- The annotation layer is `aria-hidden` and `pointer-events: none`. The chip is `aria-hidden` with `tabindex="-1"` buttons. Neither adds a tab stop or an accessibility-tree node, so an axe run or screen-reader pass with the overlay on stays clean.
- The sidebar panel is the deliberate exception. It *is* exposed and keyboard-operable, because the tool's own UI has to work for an auditor who uses assistive tech. So it adds a `complementary` landmark and focus stops while it's open. To audit the page's own keyboard order or screen-reader output, close the tool (`Esc`) first, then the page is clean again.
- Flag colors are theme-aware and clear WCAG AA (4.5:1) as text on both the light and dark panel: violation `#c1121f` / `#ff6b74`, advisory `#8a6300` / `#e0a83a`. The on-page rings sit against a 1px white halo and clear the 3:1 non-text bar, and they're redundant with the `✕`/`⚠` glyphs so color is never the only cue.
- The panel is theme-aware (`prefers-color-scheme`), so it's legible over light or dark pages without washing out a screenshot.
- `forced-color-adjust: none` on every box and label. Otherwise Windows High Contrast overrides `border-color` and flattens the level encoding.

## Privacy

No network requests. No `host_permissions`, no content scripts registered against any URL. The tool runs only in the tab you enable it from, and only when you enable the tool yourself. The one thing stored is your label-detail preference in `chrome.storage.local`. Nothing leaves the browser.

## Browser support

| Environment | API | Closed roots |
| --- | --- | --- |
| Chrome / Edge extension | `chrome.dom.openOrClosedShadowRoot` | yes |
| Firefox extension | `Element.openOrClosedShadowRoot` | yes |
| Safari extension | none | **no** |
| Bookmarklet / page world | `Element.shadowRoot` | **no** |

The chip prints `open roots only` whenever closed roots are out of reach. A heading tool that quietly under-reports is worse than no tool.

Safari would need a different approach: patch `Element.prototype.attachShadow` in the page's main world at `document_start` and record roots as they're created. That only catches roots created after injection, so it's a partial answer and should ship labeled that way.

## Bookmarklet

```
node build/build-bookmarklet.mjs
```

Writes `dist/bookmarklet.html` with a drag-to-install link. This exists because extension installs are blocked by policy in many government and finance environments, which is often exactly where accessibility testing is performed.

## Tests

```
npm i -D @playwright/test && npx playwright install chromium
npx playwright test
```

`test/fixtures/deep-shadow.html` covers six closed roots nested one per level, open roots inside open roots, declarative shadow DOM, slotted headings that `textContent` can't see, `aria-level` overriding the tag, `role="heading"` with and without a level, `role="presentation"` on an `h3`, sr-only and off-screen and `display:none` and `visibility:hidden` headings, `aria-hidden` and `inert` subtrees, a same-origin frame with its own closed root, and a heading appended after load.

The fixtures are worth as much as the code. Existing extensions fail at four levels deep because nobody had a fixture that went four levels deep.

## Structure

`extension/walker.js` has no heading logic in it and is meant to be lifted out as a standalone package. It gives you composed-tree traversal, a `closest` that crosses shadow boundaries (`Element.closest` can't), and a text resolver that expands `<slot>` to its assigned nodes. Every tool that needs to see into shadow DOM needs this part. The heading annotator on top of it is the simpler half.

## Known limitations

- Slot-aware `aria-hidden` inheritance follows the composed ancestor chain, not the full flattened-tree semantics. A heading assigned to a slot inside an `aria-hidden` shadow subtree might not be classified as hidden.
- Reading order is composed pre-order (host, then shadow content, then light children). Slotted light content is ordered at its light-DOM position, not its flattened slot position, so the outline order for slotted headings can differ from what's painted. Level-skip findings use that same order.
- The hierarchy checks include visually-hidden and off-screen headings, since they're in the accessibility tree, but they don't try to model reading order across same-origin iframes. Each frame is audited on its own, and only the top frame's headings show up in the sidebar.
- Selector chains aren't guaranteed unique. `querySelector` returns the first match at each hop.
- Capped at 3000 headings per frame, reported in the chip when it hits the cap.
- The boxes are positioned in document coordinates so they scroll with the page. A heading inside a `position:fixed` or `sticky` container can judder during active scrolling, since the box scrolls with the content and then snaps back to the fixed spot on the next redraw. Its resting position is correct.
- A full page navigation drops the overlay. Toggle it again. That's the cost of `activeTab` instead of blanket host permissions, which is the right trade for a tool that gets run against customer sites under a security review.
- The bookmarklet build is now past ~64KB, which some non-Chromium browsers truncate. Chrome and Edge are the closed-root targets and they handle it fine, and the build still prints the warning so the limit is never a silent surprise.

## License

[MIT](LICENSE). The shadow-piercing walker is meant to be lifted out and reused, and MIT is the least friction for that. Any project, including commercial ones, can embed it with only attribution.
