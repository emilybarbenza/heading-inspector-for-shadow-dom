import { test, expect, chromium } from '@playwright/test';
import { readFile, writeFile, copyFile, mkdtemp } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = pathToFileURL(join(root, 'test/fixtures/deep-shadow.html')).href;

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
});

/**
 * Extension context. This is the test that matters: six closed roots deep.
 */
test.describe('extension context', () => {
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
    expect(stats.offscreen).toBeGreaterThan(0);
    expect(stats.ariaHidden).toBeGreaterThanOrEqual(2);

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

    // Quiet mode makes the tool inert + aria-hidden for a clean page audit.
    const quieted = await page.evaluate(() => {
      const host = document.getElementById('sho-panel-host');
      host.shadowRoot.querySelector('[data-role="quiet"]').click();
      return {
        inert: host.hasAttribute('inert'),
        ariaHidden: host.getAttribute('aria-hidden'),
      };
    });
    expect(quieted.inert).toBe(true);
    expect(quieted.ariaHidden).toBe('true');

    await context.close();
  });
});
