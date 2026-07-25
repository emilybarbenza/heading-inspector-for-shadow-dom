import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, copyFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = pathToFileURL(join(root, 'test/fixtures/deep-shadow.html')).href;
const scrollFixture = pathToFileURL(join(root, 'test/fixtures/scroll-pane.html')).href;
const modalFixture = pathToFileURL(join(root, 'test/fixtures/modal.html')).href;
const slottedModalFixture = pathToFileURL(join(root, 'test/fixtures/modal-slotted.html')).href;
const wideFixture = pathToFileURL(join(root, 'test/fixtures/wide-scroller.html')).href;

const walkerSrc = await readFile(join(root, 'extension/walker.js'), 'utf8');
const overlaySrc = await readFile(join(root, 'extension/overlay.js'), 'utf8');

/**
 * Page-world run. No chrome.dom here, so this checks the documented behavior:
 * open roots are found, closed roots aren't.
 */
test.describe('page world (bookmarklet equivalent)', () => {
  test('reaches open roots at depth, reports closed roots as unreachable', async ({ page }) => {
    await page.goto(fixture);
    await page.evaluate(walkerSrc);

    const canPierce = await page.evaluate(() => window.__shadowWalker.canPierceClosed);
    expect(canPierce).toBe(false);

    const found = await page.evaluate(() => {
      const { matches } = window.__shadowWalker.walk({
        match: (el) => /^h[1-6]$/.test(el.localName),
      });
      return matches.map((m) => ({
        tag: m.element.localName,
        depth: m.hosts.length,
        text: window.__shadowWalker.composedText(m.element).trim(),
      }));
    });

    // Two levels of open roots plus a declarative open root.
    expect(found.some((f) => f.tag === 'h3' && f.depth === 1)).toBe(true);
    expect(found.some((f) => f.tag === 'h5' && f.depth === 2)).toBe(true);
    expect(found.some((f) => f.tag === 'h2' && f.depth === 1)).toBe(true);

    // Slotted text resolves through composedText, where textContent gives ''.
    const slotted = found.find((f) => f.tag === 'h4');
    expect(slotted.text).toContain('slotted from light DOM');

    // Nothing from the closed chain.
    expect(found.some((f) => f.text.includes('closed root depth'))).toBe(false);

    // Composed pre-order: the main-document h1 is the first match, not buried
    // after the open-root headings the way the old LIFO stack returned them.
    expect(found[0].text).toContain('Level 1 in the main document');
  });

  test('a heading slotted into an aria-hidden shadow subtree is excluded', async ({ page }) => {
    await page.goto(fixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(600);

    const r = await page.evaluate(() => ({
      outline: window.__shadowHeadingOutliner.outlineText(),
      ariaHidden: window.__shadowHeadingOutliner.stats.ariaHidden,
    }));
    // Its light-DOM parent is the host, so climbing parentNode alone never sees
    // the aria-hidden wrapper it actually renders inside.
    expect(r.outline).not.toContain('Slotted into an aria-hidden shadow subtree');
    expect(r.ariaHidden).toBeGreaterThanOrEqual(3);
  });

  test('text rendered by a child component is not a fabricated empty heading', async ({ page }) => {
    await page.goto(fixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(600);

    const r = await page.evaluate(() => ({
      outline: window.__shadowHeadingOutliner.outlineText(),
      violations: window.__shadowHeadingOutliner.stats.violations,
    }));

    // textContent is '' for all three, so reading only the light children would
    // report each as an empty-heading VIOLATION against WCAG 1.3.1 and 2.4.6 —
    // on exactly the component-built markup this tool exists for.
    expect(r.outline).toContain('Text from a child component');
    expect(r.outline).toContain('Named by an icon');
    expect(r.outline).toContain('Deeply wrapped title');
    // Still exactly one real empty heading in the fixture.
    expect(r.violations).toBe(1);
  });

  test('a display:contents heading is listed and boxed by what it renders', async ({ page }) => {
    await page.goto(fixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(600);

    const r = await page.evaluate(() => {
      const api = window.__shadowHeadingOutliner;
      const target = [...document.querySelectorAll('h2')].find(
        (h) => h.textContent.includes('Contents heading wrapping a block link')
      );
      const box = [...api.hosts.layer.shadowRoot.querySelectorAll('.box')].find(
        (b) => b.style.display !== 'none' && b.__shoItem && b.__shoItem.el === target
      );
      const link = target.querySelector('a').getBoundingClientRect();
      return {
        outline: api.outlineText(),
        ownRects: target.getClientRects().length,
        boxed: !!box,
        // The box has to frame the link, since that is all the heading renders.
        boxWidth: box ? Math.round(box.getBoundingClientRect().width) : 0,
        linkWidth: Math.round(link.width),
      };
    });

    // Zero rects of its own, exactly like display:none — but Chrome reports it
    // as a heading, not ignored, so leaving it out under-reports the page.
    expect(r.ownRects).toBe(0);
    expect(r.outline).toContain('Contents heading wrapping a block link');
    expect(r.boxed).toBe(true);
    expect(Math.abs(r.boxWidth - r.linkWidth)).toBeLessThan(24);

    // The same declaration inside a display:none subtree still renders nothing,
    // and computed display is still 'contents' there, so it must stay excluded.
    expect(r.outline).not.toContain('Contents inside display:none');
  });

  test('boxes scroll with the page and the panel can be hidden on its own', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 380 }); // small, so it scrolls
    await page.goto(fixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(300);

    const read = () =>
      page.evaluate(() => {
        const layer = document.getElementById('sho-layer-host').shadowRoot;
        const box = [...layer.querySelectorAll('.box')].find((b) => b.style.display !== 'none');
        const hr = box.__shoItem.el.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        return { transform: box.style.transform, gapTop: Math.round(br.top - hr.top) };
      });

    const before = await read();
    await page.evaluate(() => window.scrollTo(0, 150));
    await page.waitForTimeout(120);
    const after = await read();

    // Document-positioned: the box's own transform doesn't change on scroll, and
    // it stays glued to its heading (the gap is the padding, both before/after).
    expect(after.transform).toBe(before.transform);
    expect(after.gapTop).toBe(before.gapTop);

    // Alt+Shift+P hides the panel but leaves the boxes and chip in place.
    const hidden = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', altKey: true, shiftKey: true }));
      return {
        panel: document.getElementById('sho-panel-host').style.display,
        boxes: document.getElementById('sho-layer-host').shadowRoot.querySelectorAll('.box').length,
        chip: !!document.getElementById('sho-chip-host'),
      };
    });
    expect(hidden.panel).toBe('none');
    expect(hidden.boxes).toBeGreaterThan(0);
    expect(hidden.chip).toBe(true);
  });

  test('detail control is a radio group and Esc dismisses progressively', async ({ page }) => {
    await page.goto(fixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(300);

    // The detail picker is a radio group with exactly one checked radio, not a
    // set of independent toggle buttons.
    const radio = await page.evaluate(() => {
      const seg = document.getElementById('sho-panel-host').shadowRoot.querySelector('.seg:not(.dockseg)');
      const btns = [...seg.querySelectorAll('button')];
      return {
        group: seg.getAttribute('role'),
        roles: btns.map((b) => b.getAttribute('role')),
        checked: btns.map((b) => b.getAttribute('aria-checked')),
      };
    });
    expect(radio.group).toBe('radiogroup');
    expect(radio.roles).toEqual(['radio', 'radio', 'radio']);
    expect(radio.checked.filter((c) => c === 'true')).toHaveLength(1);

    // Progressive Esc: first hides the panel (boxes stay), second closes the tool.
    const esc1 = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return {
        panel: document.getElementById('sho-panel-host').style.display,
        boxes: document.getElementById('sho-layer-host').shadowRoot.querySelectorAll('.box').length,
      };
    });
    expect(esc1.panel).toBe('none');
    expect(esc1.boxes).toBeGreaterThan(0);

    const esc2 = await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return { layerGone: !document.getElementById('sho-layer-host') };
    });
    expect(esc2.layerGone).toBe(true);
  });

  test('arrow-key navigation and focus-triggered tooltips', async ({ page }) => {
    await page.goto(fixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(300);
    const sr = 'document.getElementById("sho-panel-host").shadowRoot';

    // Radio group: roving tabindex (only the checked one is tabbable), and an
    // arrow key moves the selection.
    const rovingBefore = await page.evaluate(
      (sr) => [...eval(sr).querySelectorAll('.seg:not(.dockseg) button')].map((b) => b.tabIndex),
      sr
    );
    expect(rovingBefore).toEqual([0, -1, -1]);
    await page.evaluate((sr) => eval(sr).querySelector('.seg:not(.dockseg) button[aria-checked="true"]').focus(), sr);
    await page.keyboard.press('ArrowRight');
    const radioAfter = await page.evaluate((sr) => {
      const btns = [...eval(sr).querySelectorAll('.seg:not(.dockseg) button')];
      return {
        checkedIdx: btns.findIndex((b) => b.getAttribute('aria-checked') === 'true'),
        focusedIdx: btns.indexOf(eval(sr).activeElement),
      };
    }, sr);
    expect(radioAfter).toEqual({ checkedIdx: 1, focusedIdx: 1 });

    // Outline is a tree; rows are treeitems with aria-level; ArrowDown moves focus.
    const tree = await page.evaluate((sr) => {
      const rows = [...eval(sr).querySelectorAll('.row')];
      return { ul: eval(sr).querySelector('ul').getAttribute('role'), role: rows[0].getAttribute('role'), level: rows[0].getAttribute('aria-level') };
    }, sr);
    expect(tree.ul).toBe('tree');
    expect(tree.role).toBe('treeitem');
    expect(tree.level).toBe('1');
    await page.evaluate((sr) => eval(sr).querySelector('.row').focus(), sr);
    await page.keyboard.press('ArrowDown');
    const rowFocus = await page.evaluate(
      (sr) => [...eval(sr).querySelectorAll('.row')].indexOf(eval(sr).activeElement),
      sr
    );
    expect(rowFocus).toBe(1);

    // Tooltip appears on keyboard focus (native title never does) and wires
    // aria-describedby.
    const tip = await page.evaluate((sr) => {
      const hide = eval(sr).querySelector('header .iconbtn');
      hide.focus();
      const t = eval(sr).getElementById('sho-tip');
      return { hidden: t.hidden, hasText: t.textContent.length > 0, describedby: hide.getAttribute('aria-describedby') };
    }, sr);
    expect(tip.hidden).toBe(false);
    expect(tip.hasText).toBe(true);
    expect(tip.describedby).toBe('sho-tip');
  });
});

/**
 * The outline is the accessibility tree, and nothing about where the page
 * happens to be scrolled may change it. Geometry only decides what gets drawn.
 */
test.describe('outline is independent of scroll position', () => {
  const readCounts = (page) =>
    page.evaluate(() => ({
      total: window.__shadowHeadingOutliner.stats.total,
      rows: document.getElementById('sho-panel-host').shadowRoot.querySelectorAll('.row').length,
      srOnly: window.__shadowHeadingOutliner.stats.srOnly,
      boxes: [...document.getElementById('sho-layer-host').shadowRoot.querySelectorAll('.box')].filter(
        (b) => b.style.display !== 'none'
      ).length,
      windowScroll: window.scrollY,
    }));

  test('headings scrolled out of an inner pane stay listed', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 500 });
    await page.goto(scrollFixture);

    // Scroll the pane BEFORE switching the tool on, which is what happens when
    // someone reading mid-document clicks the toolbar button. The window never
    // scrolls in this layout, so scrollY stays 0 while the content has moved:
    // headings above the pane's top used to be read as parked off-canvas and
    // dropped from the outline while still being counted.
    await page.evaluate(() => {
      document.getElementById('pane').scrollTop = 2000;
      // The same situation one shadow boundary away, reachable only via assignedSlot.
      window.scrollShadowPane(1200);
    });
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(300);

    const scrolled = await readCounts(page);
    expect(scrolled.windowScroll).toBe(0);
    expect(scrolled.total).toBe(8);
    expect(scrolled.rows).toBe(8);
    // A slotted heading renders inside its slot's scroll containers, not its
    // light-DOM parent's, so the position climb has to follow assignedSlot too.
    // Missing that reads it as parked off-canvas and badges it screen-reader only.
    expect(scrolled.srOnly).toBe(0);
    // Only the headings near the viewport are drawn. That's draw()'s culling
    // doing its job, and it must not feed back into the list above.
    expect(scrolled.boxes).toBeLessThan(scrolled.rows);

    // A rescan while still scrolled must reach the same answer.
    await page.evaluate(() => document.getElementById('last').setAttribute('class', 'poke'));
    await page.waitForTimeout(500);
    const rescanned = await readCounts(page);
    expect(rescanned.rows).toBe(8);
    expect(rescanned.total).toBe(8);

    // And back at the top, where nothing was ever wrong.
    await page.evaluate(() => {
      document.getElementById('pane').scrollTop = 0;
    });
    await page.evaluate(() => document.getElementById('last').setAttribute('class', 'poke2'));
    await page.waitForTimeout(500);
    expect((await readCounts(page)).rows).toBe(8);
  });

  test('wide horizontally scrolled content is not mistaken for screen-reader only', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(wideFixture);
    await page.evaluate(() => {
      document.getElementById('board').scrollLeft = 1400;
    });
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => {
      const sr = document.getElementById('sho-panel-host').shadowRoot;
      return {
        rows: [...sr.querySelectorAll('.row')].map((x) => x.querySelector('.txt').textContent),
        srMarked: [...sr.querySelectorAll('.row')].filter((x) => x.querySelector('.srmark')).length,
        srOnly: window.__shadowHeadingOutliner.stats.srOnly,
      };
    });
    // Columns past the document's width are laid out at x > document.scrollWidth
    // but are perfectly ordinary visible headings.
    expect(r.rows).toHaveLength(7);
    expect(r.srOnly).toBe(0);
    expect(r.srMarked).toBe(0);
  });

  test('the chip count always equals the number of rows', async ({ page }) => {
    await page.goto(fixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(600);

    const { lead, rows } = await page.evaluate(() => {
      const chip = document.getElementById('sho-chip-host').shadowRoot.querySelector('.counts');
      return {
        lead: Number(/^(\d+)/.exec(chip.textContent)[1]),
        rows: document.getElementById('sho-panel-host').shadowRoot.querySelectorAll('.row').length,
      };
    });
    expect(lead).toBe(rows);
  });
});

/**
 * A modal takes over the accessibility tree, so the outline has to follow it
 * there rather than listing headings nobody can reach.
 */
test.describe('modal dialog scoping', () => {
  // While a native dialog is open the tool relocates into it, so the hosts are
  // no longer reachable by id — the dialog is usually inside a shadow root.
  const snapshot = (page) =>
    page.evaluate(() => {
      const panel = window.__shadowHeadingOutliner.hosts.panel;
      return {
        stats: window.__shadowHeadingOutliner.stats,
        outline: window.__shadowHeadingOutliner.outlineText(),
        rows: [...panel.shadowRoot.querySelectorAll('.row')].map((r) => r.querySelector('.txt').textContent),
        summary: panel.shadowRoot.querySelector('.summary').textContent,
      };
    });

  test('scopes to an open dialog and counts what it hides', async ({ page }) => {
    await page.goto(modalFixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(300);

    const before = await snapshot(page);
    expect(before.stats.behindModal).toBe(0);
    expect(before.rows).toContain('Page title');
    expect(before.rows).not.toContain('Dialog title');

    await page.evaluate(() => window.openDialog());
    await page.waitForTimeout(500); // past the 250ms rescan debounce

    const open = await snapshot(page);
    // The dialog is in a shadow root, so finding it at all exercises the walker.
    expect(open.rows).toEqual(['Dialog title', 'Dialog detail, skipping level three']);
    expect(open.stats.behindModal).toBe(4);
    expect(open.stats.total).toBe(6);
    expect(open.summary).toContain('Scoped to the open dialog');
    expect(open.outline).toContain('SCOPE:');

    // Real findings inside the dialog still surface: h2 -> h4 is a skipped level.
    expect(open.outline).toContain('skipped level');
    // Page-level h1 rules are about the page, not a dialog. A dialog opening at
    // h2 with no h1 is correct and must not be reported.
    expect(open.outline).not.toContain('no h1');
    expect(open.outline).not.toContain('starts below h1');

    // Closing it puts the page back.
    await page.evaluate(() => window.closeDialog());
    await page.waitForTimeout(500);
    const after = await snapshot(page);
    expect(after.stats.behindModal).toBe(0);
    expect(after.rows).toContain('Page title');
    expect(after.rows).not.toContain('Dialog title');
  });

  test('a dialog title slotted in from light DOM counts as inside the dialog', async ({ page }) => {
    await page.goto(slottedModalFixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(300);

    await page.evaluate(() => window.openDialog());
    await page.waitForTimeout(500);

    const open = await snapshot(page);
    // The title's light-DOM parent is <ui-dialog>, so only a flattened-tree
    // climb (through assignedSlot) finds the <dialog> it actually renders in.
    // Getting this wrong hides the dialog's own title, which is the one heading
    // scoping to the dialog exists to show.
    expect(open.rows).toContain('Slotted dialog title');
    expect(open.rows).toContain('Shadow-side subheading');
    expect(open.stats.behindModal).toBe(2);
  });

  test('the tool stays visible and operable while a native dialog is open', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(slottedModalFixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.openDialog());
    await page.waitForTimeout(600);

    const r = await page.evaluate(() => {
      // Resolve through shadow roots to whatever is really painted on top.
      const deepAt = (x, y) => {
        let n = document.elementFromPoint(x, y);
        for (let i = 0; n && n.shadowRoot && i < 20; i++) {
          const inner = n.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === n) break;
          n = inner;
        }
        return n;
      };
      const hosts = window.__shadowHeadingOutliner.hosts;
      const pr = hosts.panel.getBoundingClientRect();
      const cr = hosts.chip.getBoundingClientRect();
      const btn = [...hosts.panel.shadowRoot.querySelectorAll('.iconbtn')].find(
        (b) => b.textContent === 'Copy outline'
      );
      btn.focus();
      const boxes = [...hosts.layer.shadowRoot.querySelectorAll('.box')].filter(
        (b) => b.style.display !== 'none'
      );
      return {
        // A showModal() dialog paints above every z-index and inerts everything
        // outside itself, so both of these fail unless the tool has moved into
        // the dialog's own subtree.
        panelOnTop: hosts.panel.shadowRoot.contains(deepAt(pr.left + 20, pr.top + 60)),
        chipOnTop: hosts.chip.shadowRoot.contains(deepAt(cr.left + 10, cr.top + 10)),
        panelFocusable: hosts.panel.shadowRoot.activeElement === btn,
        boxesDrawn: boxes.length,
      };
    });

    expect(r.panelOnTop).toBe(true);
    expect(r.chipOnTop).toBe(true);
    expect(r.panelFocusable).toBe(true);
    expect(r.boxesDrawn).toBe(2);

    // Closing the dialog moves the tool back out to the body, where it is
    // reachable by id again.
    await page.evaluate(() => document.getElementById('d').__dlg.close());
    await page.waitForTimeout(600);
    const home = await page.evaluate(() => ({
      backInBody: document.getElementById('sho-panel-host') !== null,
      layerMode: document.getElementById('sho-layer-host').dataset.mode,
    }));
    expect(home.backInBody).toBe(true);
    expect(home.layerMode).toBeUndefined();
  });
});

/**
 * Frames. The extension injects with allFrames, so every same-origin iframe runs
 * its own copy of the tool in its own coordinate space.
 */
test.describe('iframes', () => {
  const injectEverywhere = async (page) => {
    await page.goto(fixture);
    await page.waitForTimeout(500);
    for (const f of page.frames()) {
      await f.evaluate(walkerSrc);
      await f.evaluate(overlaySrc);
    }
    await page.waitForTimeout(500);
  };

  test('only the top frame draws the chip', async ({ page }) => {
    await injectEverywhere(page);

    const perFrame = await Promise.all(
      page.frames().map((f) =>
        f.evaluate(() => ({
          top: window.top === window.self,
          chip: !!document.getElementById('sho-chip-host'),
          panel: !!document.getElementById('sho-panel-host'),
          layer: !!document.getElementById('sho-layer-host'),
        }))
      )
    );

    expect(perFrame.length).toBeGreaterThan(1);
    // One bar for the page, not one per frame. A visible iframe used to put a
    // second bar at its own bottom-left, which reads as the tool rendering twice.
    expect(perFrame.filter((f) => f.chip)).toHaveLength(1);
    expect(perFrame.filter((f) => f.panel)).toHaveLength(1);
    expect(perFrame.find((f) => f.chip).top).toBe(true);
    // Sub-frames still outline their own headings.
    expect(perFrame.every((f) => f.layer)).toBe(true);
  });

  test('closing from the top frame clears the frames too', async ({ page, browserName }) => {
    // Needs a page that can script its own same-origin iframe; Firefox gives
    // file:// documents unique origins with no launch flag to opt out.
    test.skip(browserName !== 'chromium', 'needs same-origin file:// frames');
    await injectEverywhere(page);

    const states = () =>
      Promise.all(
        page.frames().map((f) => f.evaluate(() => !!(window.__shadowHeadingOutliner || {}).on))
      );
    expect(await states()).toEqual([true, true]);

    await page.evaluate(() => {
      const sr = document.getElementById('sho-chip-host').shadowRoot;
      [...sr.querySelectorAll('button')].find((b) => b.textContent === 'Close').click();
    });
    await page.waitForTimeout(400);

    // Sub-frames no longer have a chip of their own, so a close that stopped at
    // the top frame would strand their boxes on screen with nothing to dismiss.
    expect(await states()).toEqual([false, false]);
  });
});

/**
 * Docking. The panel overlays the page from whichever edge it's on — it never
 * reflows the layout being audited, which is the same reason the right dock has
 * always overlaid rather than pushed.
 */
test.describe('panel docking', () => {
  const boot = async (page) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto(scrollFixture);
    await page.evaluate(walkerSrc);
    await page.evaluate(overlaySrc);
    await page.waitForTimeout(350);
  };
  const sr = () => document.getElementById('sho-panel-host').shadowRoot;
  const pick = (page, dock) =>
    page.evaluate((d) => {
      document
        .getElementById('sho-panel-host')
        .shadowRoot.querySelector(`.dockseg button[data-dock="${d}"]`)
        .click();
    }, dock);

  test('each dock fills the edge it names, and never covers the chip', async ({ page }) => {
    await boot(page);

    const geometry = async () =>
      page.evaluate(() => {
        const host = document.getElementById('sho-panel-host');
        const p = host.getBoundingClientRect();
        const c = document.getElementById('sho-chip-host').getBoundingClientRect();
        return {
          dock: host.dataset.dock,
          box: [p.left, p.top, p.width, p.height].map(Math.round),
          overlapsChip: !(p.right <= c.left || p.left >= c.right || p.bottom <= c.top || p.top >= c.bottom),
          checked: [...host.shadowRoot.querySelectorAll('.dockseg button')].filter(
            (b) => b.getAttribute('aria-checked') === 'true'
          ).length,
        };
      });

    for (const [dock, expected] of [
      ['right', [660, 0, 340, 700]],
      ['left', [0, 0, 340, 700]],
      ['top', [0, 0, 1000, 300]],
      ['bottom', [0, 400, 1000, 300]],
      ['float', [24, 24, 340, 300]],
    ]) {
      await pick(page, dock);
      await page.waitForTimeout(200);
      const g = await geometry();
      expect(g.dock).toBe(dock);
      expect(g.box).toEqual(expected);
      // Exactly one radio checked, and the chip stays readable. A left or bottom
      // dock lands exactly where the chip lives, so it has to move aside.
      expect(g.checked).toBe(1);
      expect(g.overlapsChip).toBe(false);
    }
  });

  test('the dock picker is a keyboard-operable radio group', async ({ page }) => {
    await boot(page);
    const state = () =>
      page.evaluate(() => {
        const s = document.getElementById('sho-panel-host').shadowRoot;
        const btns = [...s.querySelectorAll('.dockseg button')];
        return {
          role: s.querySelector('.dockseg').getAttribute('role'),
          roles: btns.map((b) => b.getAttribute('role')),
          // Icon-only buttons still need a name for assistive tech.
          named: btns.every((b) => (b.getAttribute('aria-label') || '').length > 3),
          tabindex: btns.map((b) => b.tabIndex),
          checkedIdx: btns.findIndex((b) => b.getAttribute('aria-checked') === 'true'),
          focusedIdx: btns.indexOf(s.activeElement),
        };
      });

    const before = await state();
    expect(before.role).toBe('radiogroup');
    expect(before.roles).toEqual(['radio', 'radio', 'radio', 'radio', 'radio']);
    expect(before.named).toBe(true);
    // Roving tabindex: one tab stop for the whole group.
    expect(before.tabindex.filter((t) => t === 0)).toHaveLength(1);
    expect(before.checkedIdx).toBe(1); // 'right' is the default

    await page.evaluate(
      () =>
        document
          .getElementById('sho-panel-host')
          .shadowRoot.querySelector('.dockseg button[aria-checked="true"]')
          .focus()
    );
    await page.keyboard.press('ArrowRight');
    const after = await state();
    expect(after.checkedIdx).toBe(2);
    expect(after.focusedIdx).toBe(2);

    // Alt+Shift+D cycles through the same set.
    await page.evaluate(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', altKey: true, shiftKey: true }))
    );
    expect(await page.evaluate(() => document.getElementById('sho-panel-host').dataset.dock)).toBe('bottom');
  });

  test('the resize handle is a separator that arrow keys drive', async ({ page }) => {
    await boot(page);

    const grip = await page.evaluate(() => {
      const g = document.getElementById('sho-panel-host').shadowRoot.querySelector('.grip');
      return { role: g.getAttribute('role'), orientation: g.getAttribute('aria-orientation'), tabIndex: g.tabIndex };
    });
    expect(grip.role).toBe('separator');
    expect(grip.orientation).toBe('vertical');
    expect(grip.tabIndex).toBe(0);

    const width = () =>
      page.evaluate(() => Math.round(document.getElementById('sho-panel-host').getBoundingClientRect().width));
    const start = await width();

    await page.evaluate(() => document.getElementById('sho-panel-host').shadowRoot.querySelector('.grip').focus());
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(80);
    // On a right dock the handle is on the panel's left edge, so rightwards
    // shrinks it — the direction the drag would go.
    expect(await width()).toBeLessThan(start);

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(80);
    expect(await width()).toBeGreaterThan(start);

    // A top dock resizes vertically instead, and says so.
    await pick(page, 'top');
    await page.waitForTimeout(150);
    const h0 = await page.evaluate(() =>
      Math.round(document.getElementById('sho-panel-host').getBoundingClientRect().height)
    );
    expect(
      await page.evaluate(() =>
        document.getElementById('sho-panel-host').shadowRoot.querySelector('.grip').getAttribute('aria-orientation')
      )
    ).toBe('horizontal');
    await page.evaluate(() => document.getElementById('sho-panel-host').shadowRoot.querySelector('.grip').focus());
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(80);
    expect(
      await page.evaluate(() =>
        Math.round(document.getElementById('sho-panel-host').getBoundingClientRect().height)
      )
    ).toBeGreaterThan(h0);
  });

  test('a floating panel drags by its header and is kept on screen', async ({ page }) => {
    await boot(page);
    await pick(page, 'float');
    await page.waitForTimeout(200);

    const at = () =>
      page.evaluate(() => {
        const r = document.getElementById('sho-panel-host').getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      });

    const from = await at();
    const head = await page.evaluate(() => {
      const r = document
        .getElementById('sho-panel-host')
        .shadowRoot.querySelector('header')
        .getBoundingClientRect();
      // Left of the buttons, so the drag isn't swallowed by a control.
      return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move(head.x + 260, head.y + 180, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);

    const moved = await at();
    expect(moved.x).toBeGreaterThan(from.x + 200);
    expect(moved.y).toBeGreaterThan(from.y + 120);

    // Narrowing the window must not strand it off-canvas with no way back.
    await page.setViewportSize({ width: 420, height: 420 });
    await page.waitForTimeout(250);
    const clamped = await at();
    expect(clamped.x).toBeGreaterThanOrEqual(0);
    expect(clamped.y).toBeGreaterThanOrEqual(0);
    expect(clamped.x + clamped.w).toBeLessThanOrEqual(420);
    expect(clamped.y + clamped.h).toBeLessThanOrEqual(420);
  });
});

/**
 * The shipped bookmarklet, not the sources it is built from. Nothing else runs
 * the minified, percent-encoded artifact — CI builds it and throws it away — so
 * a minification or escaping regression would reach GitHub Pages unnoticed.
 */
test.describe('built bookmarklet', () => {
  test('the generated artifact runs and outlines the page', async ({ page }) => {
    const txt = join(root, 'dist/bookmarklet.txt');
    let raw;
    try {
      raw = await readFile(txt, 'utf8');
    } catch (_) {
      test.skip(true, 'run `npm run build:bookmarklet` first');
      return;
    }

    expect(raw.startsWith('javascript:')).toBe(true);
    // A browser percent-decodes the URL before running it, so decoding here is
    // what the address bar would hand to the JS engine.
    const source = decodeURIComponent(raw.slice('javascript:'.length));

    await page.goto(fixture);
    await page.evaluate(source);
    await page.waitForTimeout(400);

    const r = await page.evaluate(() => {
      const api = window.__shadowHeadingOutliner;
      return {
        mounted: !!api && api.on,
        rows: api.hosts.panel.shadowRoot.querySelectorAll('.row').length,
        outline: api.outlineText(),
      };
    });
    expect(r.mounted).toBe(true);
    expect(r.rows).toBeGreaterThan(0);
    expect(r.outline).toContain('Level 1 in the main document');

    // Re-running toggles it off: that idiom is how the bookmarklet works.
    await page.evaluate(source);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__shadowHeadingOutliner.on)).toBe(false);
  });
});

/**
 * Extension context. This is the test that matters: six closed roots deep.
 */
test.describe('extension context', () => {
  // This test launches its own chromium with the extension loaded, so running
  // it under the firefox project would just test chromium twice.
  test.skip(({ browserName }) => browserName !== 'chromium', 'chromium-only');

  test('reaches headings six closed roots deep', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'sho-'));

    // The shipped manifest has no host_permissions on purpose. Access is granted
    // per click by activeTab. A headless test can't do that click, so it runs the
    // same walker/overlay/background code from a temp copy whose manifest adds
    // host access. What ships stays clean.
    const extPath = await mkdtemp(join(tmpdir(), 'sho-ext-'));
    for (const f of ['walker.js', 'overlay.js', 'background.js']) {
      await copyFile(join(root, 'extension', f), join(extPath, f));
    }
    const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
    manifest.host_permissions = ['<all_urls>'];
    // The real manifest references icons, but they aren't copied into this temp
    // dir, so drop the references or the missing files fail extension load. This
    // test is about closed-root traversal, not icons.
    delete manifest.icons;
    delete manifest.action.default_icon;
    await writeFile(join(extPath, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      args: [
        '--headless=new',
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
        '--allow-file-access-from-files',
      ],
    });

    const page = await context.newPage();
    await page.goto(fixture);

    // Trigger the action the same way a click would. Playwright can't click a
    // toolbar icon, so drive the service worker directly.
    const [worker] = context.serviceWorkers();
    const sw = worker ?? (await context.waitForEvent('serviceworker'));
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['walker.js', 'overlay.js'],
      });
    });

    // The walker runs in the extension's ISOLATED world, the only world with
    // chrome.dom, so it's the only one that reaches closed roots. page.evaluate
    // runs in the MAIN world and can't see window.__shadow*, so the tool's own
    // state is read back through executeScript, which targets the isolated world.
    // (The overlay DOM it builds is shared across worlds, so those checks stay in
    // page.evaluate.) A named prop picks what to return, so we avoid new Function,
    // since the MV3 service worker CSP forbids eval.
    const inTool = (prop) =>
      sw.evaluate(async (p) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          args: [p],
          func: (key) => {
            const api = window.__shadowHeadingOutliner;
            if (!api) return undefined;
            if (key === 'on') return api.on;
            if (key === 'stats') return api.stats;
            if (key === 'outline') return api.outlineText();
            return undefined;
          },
        });
        return res.result;
      }, prop);

    await expect.poll(() => inTool('on'), { timeout: 10000 }).toBe(true);
    const outline = await inTool('outline');

    for (let depth = 1; depth <= 6; depth++) {
      expect(outline).toContain(`closed root depth ${depth}`);
    }

    const stats = await inTool('stats');
    expect(stats.notRendered).toBeGreaterThan(0);
    expect(stats.ariaHidden).toBeGreaterThanOrEqual(2);
    // Both sr-only recipes in the fixture (a 1px clip-path box and one parked at
    // left:-9999px). They're announced, so they belong in the outline, not in
    // the excluded counts.
    expect(stats.srOnly).toBe(2);
    expect(outline).toContain('Visually hidden, still in the accessibility tree');
    expect(outline).toContain('Parked off-screen at left:-9999px');
    // visibility:hidden is not in the accessibility tree, so it is counted only.
    expect(stats.hidden).toBe(1);
    expect(outline).not.toContain('Visibility hidden');

    // role=presentation on an h3 must not count as a heading.
    expect(outline).not.toContain('role=presentation');

    // Hierarchy validation. The empty h2 is a violation and the h2->h4 jump is an
    // advisory, so both must show. The aria-labelled empty h3 must NOT be flagged
    // empty, since accName sees the label.
    expect(stats.violations).toBe(1);
    expect(stats.advisories).toBeGreaterThanOrEqual(1);
    expect(outline).toContain('skipped level');

    // The sidebar panel exists, is exposed to assistive tech (not aria-hidden),
    // and has one focusable row per drawn heading.
    const panel = await page.evaluate(() => {
      const host = document.getElementById('sho-panel-host');
      if (!host) return null;
      return {
        ariaHidden: host.getAttribute('aria-hidden'),
        rows: host.shadowRoot.querySelectorAll('.row').length,
        landmark: !!host.shadowRoot.querySelector('[role="complementary"]'),
      };
    });
    expect(panel).not.toBeNull();
    expect(panel.ariaHidden).toBeNull();
    expect(panel.landmark).toBe(true);
    expect(panel.rows).toBeGreaterThan(0);

    await context.close();
  });
});
