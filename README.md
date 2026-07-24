# Headings Bookmarklet for Shadow DOM

Outlines, labels, lists, and audits every heading on a page. It finds headings even when they're nested deep inside **open or closed** shadow roots.

Most heading extensions stop at the first closed root, because a content script that reads `element.shadowRoot` gets `null` there. Extensions have a privileged API that page scripts don't, so this tool uses it.

Three surfaces, all built on one shadow-piercing walk:

- **In-place overlay**: a colored, labeled box on every heading, good for defect screenshots.
- **Outline sidebar**: a docked, keyboard-operable tree of the headings in reading order. Click a row to scroll to it and flash it.
- **Hierarchy audit**: WCAG-keyed flags for empty headings, skipped levels, and missing or duplicate `h1`, split into violations and best-practice advisories.

## Privacy

No network requests. No `host_permissions`, no content scripts registered against any URL. The walker only runs in the tab you click on, and only when you click. The one thing stored is your label-detail preference in `chrome.storage.local`. Nothing leaves the browser.

## Install

1. `chrome://extensions` → enable the Developer mode switch
<img width="2218" height="1038" alt="Chrome Extensions page shows "Developer mode" switch and "Load unpacked" button highlighted" src="https://github.com/user-attachments/assets/311a50d2-e458-43a7-a093-d37b0e80969f" />

2. Select the Load unpacked button
3. Select the `extension/` directory
4. Open the puzzle-piece menu and pin **Headings Bookmarklet for Shadow DOM** so its icon
   is on the toolbar
5. Select the icon, or press `Alt+Shift+H`, to toggle it on a tab

Load the extension through `chrome://extensions`, not the `--load-extension` command-line
switch: Chrome 137+ ignores unpacked extensions passed on the command line. For
an install-free look on a page built from *open* shadow roots, open
`demo/standalone.html`. Tt loads the same walker and overlay as ordinary page
scripts, no extension required (closed roots need the extension).

## Use

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
| `Esc` | Close |
| `Alt+Shift+M` | Cycle label detail: level, then owning component, then full chain |
| `Alt+Shift+C` | Copy the outline as indented text |
| `Alt+Shift+Q` | Quiet: make the tool `inert`+`aria-hidden` so you can test the page's own tab order and screen-reader output, then restore |
| `Alt`+click a box | Copy that heading's selector chain and console expression |

## Outline sidebar

A panel docks to the right of the top document. Each heading is one row, indented by level, in reading order. The rows are real `<button>`s, so you can `Tab` to them and hit `Enter`/`Space` to activate. Activating a row scrolls that heading into view and pulses a highlight over it. It works across shadow boundaries, since `scrollIntoView` on the element works even inside a closed root.

The **Level + text / + Component / + Selector** control sets how much each row shows. It's a real segmented control, not a hover tooltip, because tooltips aren't an accessible way to show that detail. The setting is shared with the overlay's `Alt+Shift+M` cycle, so the two surfaces never disagree, and it persists in `chrome.storage.local`.

The panel is the one part of the tool that is *not* `aria-hidden`, because an auditor who uses a screen reader or the keyboard has to be able to drive it. The cost is that it adds a landmark and focus stops to the page under test. That's exactly what **Quiet** (`Alt+Shift+Q`, or the button in the panel) removes on demand. The panel is top-frame only. Headings inside iframes get boxed in place but aren't listed, since a sidebar inside every iframe would be silly and cross-origin frames can't share the data anyway.

The panel sits over the right edge of the page instead of reflowing it. That's on purpose, since reflowing would change the layout you're auditing. Collapse it, resize it by dragging its inner edge, or Quiet it to see what's underneath.

## Hierarchy audit

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
- The sidebar panel is the deliberate exception. It *is* exposed and keyboard-operable, because the tool's own UI has to work for an auditor who uses assistive tech. So it adds a `complementary` landmark and focus stops. **Quiet** (`Alt+Shift+Q`) makes the whole tool `inert`+`aria-hidden` on demand, so you can test the page's own keyboard order and screen-reader output, then it restores. That's how the tool can be accessible and still not contaminate the page under test.
- The panel is theme-aware (`prefers-color-scheme`), so it's legible over light or dark pages without washing out a screenshot.
- `forced-color-adjust: none` on every box and label. Otherwise Windows High Contrast overrides `border-color` and flattens the level encoding.

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

Writes `dist/bookmarklet.html` with a drag-to-install link. This exists because extension installs are blocked by policy in a lot of government and finance environments, which is often exactly where you need to hand a heading tool to someone else's dev team. Open roots only, and the chip says so.

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
- A full page navigation drops the overlay. Toggle it again. That's the cost of `activeTab` instead of blanket host permissions, which is the right trade for a tool that gets run against customer sites under a security review.
- The bookmarklet build is now past ~64KB, which some non-Chromium browsers truncate. Chrome and Edge are the closed-root targets and they handle it fine, and the build still prints the warning so the limit is never a silent surprise.

## License

[MIT](LICENSE). The shadow-piercing walker is meant to be lifted out and reused, and MIT is the least friction for that. Any project, including commercial ones, can embed it with only attribution.
