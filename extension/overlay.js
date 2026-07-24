/**
 * Heading annotator. Needs walker.js to have run first.
 *
 * Re-running this file toggles the overlay off and on. That's how both the
 * toolbar action and the bookmarklet work.
 */
(() => {
  const KEY = '__shadowHeadingOutliner';
  if (window[KEY]) {
    window[KEY].toggle();
    return;
  }

  const walker = window.__shadowWalker;
  if (!walker) {
    console.error('Heading Inspector for Shadow DOM: walker.js did not load.');
    return;
  }

  const LAYER_ID = 'sho-layer-host';
  const CHIP_ID = 'sho-chip-host';
  const PANEL_ID = 'sho-panel-host';
  const MIN_BOX = 16;
  // Breathing room between a heading's tight bounding box and the drawn outline,
  // so the box frames the heading instead of hugging the text.
  const BOX_PAD = 5;
  const MAX_HEADINGS = 3000;
  const LABEL_MODES = ['level', 'component', 'chain'];
  // Coalesce mutation bursts, but never let a busy page postpone a rescan past
  // the ceiling.
  const RESCAN_DEBOUNCE = 250;
  const RESCAN_MAX_WAIT = 1000;
  // A custom element already sitting in the markup can be upgraded at any time.
  // Its connectedCallback attaches a shadow root and fills it, all of which
  // happens inside a root nothing is observing yet, so no mutation fires
  // anywhere and the headings it renders would never be noticed. Design systems
  // that load their definitions asynchronously do this on every page.
  const SAFETY_SCAN = 1500;

  // Two tiers, keyed to WCAG. A violation is something an automated checker
  // (like axe) reports as a failure. An advisory is a best-practice finding
  // that isn't strictly a Success Criterion failure. They're kept apart since
  // an auditor files the first as a defect and the second as a note.
  const VIOLATION = 'violation';
  const ADVISORY = 'advisory';
  // Each finding names the equivalent axe-core rule where one exists, so the
  // output drops into axe-based workflows. axe-core itself isn't bundled: it
  // can't reach closed shadow roots (no page-world API can), which is the whole
  // reason this tool exists, and it would miss exactly the headings we're after.
  const PROBLEMS = {
    empty: {
      tier: VIOLATION,
      short: 'empty',
      sc: '1.3.1, 2.4.6',
      axe: 'empty-heading',
      desc: 'Heading has no perceivable text (WCAG 1.3.1 Info & Relationships, 2.4.6 Headings & Labels).',
    },
    skipped: {
      tier: ADVISORY,
      short: 'skipped level',
      sc: '1.3.1',
      axe: 'heading-order',
      desc: 'Heading level jumps down by more than one from the previous heading (WCAG 1.3.1, technique G141).',
    },
    'multiple-h1': {
      tier: ADVISORY,
      short: 'extra h1',
      sc: '1.3.1',
      desc: 'More than one level-1 heading on the page (advisory; HTML permits it but it weakens the top-level outline).',
    },
    'no-h1': {
      tier: ADVISORY,
      short: 'no h1',
      sc: '1.3.1',
      axe: 'page-has-heading-one',
      desc: 'Page has no level-1 heading (advisory; relates to WCAG 1.3.1 and 2.4.10 Section Headings).',
    },
    'first-not-h1': {
      tier: ADVISORY,
      short: 'starts below h1',
      sc: '1.3.1',
      desc: 'The first heading in reading order is deeper than level 1 (advisory).',
    },
  };

  // Tag for a finding in copied text, e.g. "WCAG 1.3.1, 2.4.6 · axe: empty-heading".
  function findingTag(p) {
    return `WCAG ${p.sc}${p.axe ? ` · axe: ${p.axe}` : ''}`;
  }

  // White text on each of these clears 5.9:1, and most clear 6.5:1. The label
  // text also carries the level, so the palette is redundant, not load-bearing.
  const COLORS = {
    1: '#b00050',
    2: '#7b1fa2',
    3: '#0b5fbe',
    4: '#00695c',
    5: '#a34a00',
    6: '#4e342e',
  };
  const OUT_OF_RANGE = '#37474f';

  let on = false;
  let labelMode = 'level';
  let layerHost = null;
  let layer = null;
  let chipHost = null;
  let chipText = null;
  let chipNote = null;
  let chipPanelBtn = null;
  let panelHost = null;
  let panelList = null;
  let panelSummary = null;
  let panelStatus = null;
  let tipEl = null;
  let panelHidden = false;
  let items = [];
  let modalEl = null;
  let pageProblems = [];
  let stats = emptyStats();
  const boxes = [];
  const labels = [];
  let rafPending = false;
  let rescanTimer = 0;
  let rescanDeadline = 0;
  let safetyTimer = 0;
  let modalHome = null;
  let observers = [];
  let altHeld = false;
  let flashEl = null;

  function emptyStats() {
    return {
      total: 0,
      srOnly: 0,
      hidden: 0,
      notRendered: 0,
      ariaHidden: 0,
      behindModal: 0,
      violations: 0,
      advisories: 0,
      truncated: false,
    };
  }

  // ------------------------------------------------------------------ storage

  function loadMode() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ labelMode: 'level' }, (v) => {
          if (v && LABEL_MODES.includes(v.labelMode)) {
            labelMode = v.labelMode;
            updateDetailControl();
            renderPanel();
            schedule();
          }
        });
      }
    } catch (_) {
      /* bookmarklet: just keep it in memory */
    }
  }

  function saveMode() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ labelMode });
      }
    } catch (_) {
      /* no-op */
    }
  }

  // ----------------------------------------------------------------- headings

  // WAI-ARIA 1.2 role names. A role attribute is a fallback list and the browser
  // takes the FIRST token it recognises, so telling a known role from a typo is
  // the only way to know which one wins. Without this, role="none heading" and
  // role="button heading" both read as headings when the browser says they are
  // a presentational element and a button.
  const ARIA_ROLES = new Set(
    ('alert alertdialog application article associationlist associationlistitemkey ' +
      'associationlistitemvalue banner blockquote button caption cell checkbox code ' +
      'columnheader combobox command comment complementary composite contentinfo ' +
      'definition deletion dialog directory document emphasis feed figure form ' +
      'generic grid gridcell group heading image img input insertion landmark link ' +
      'list listbox listitem log main mark marquee math menu menubar menuitem ' +
      'menuitemcheckbox menuitemradio meter navigation none note option paragraph ' +
      'presentation progressbar radio radiogroup range region roletype row rowgroup ' +
      'rowheader scrollbar search searchbox section sectionhead select separator ' +
      'slider spinbutton status strong structure subscript suggestion superscript ' +
      'switch tab table tablist tabpanel term textbox time timer toolbar tooltip ' +
      'tree treegrid treeitem widget window').split(' ')
  );

  // The role the browser actually computes from a fallback list: the first
  // recognised token. Unknown tokens are skipped, not treated as a role.
  function effectiveRole(el) {
    const attr = (el.getAttribute('role') || '').trim().toLowerCase();
    if (!attr) return '';
    for (const token of attr.split(/\s+/)) {
      if (ARIA_ROLES.has(token)) return token;
    }
    return '';
  }

  function headingInfo(el) {
    const native = /^h([1-6])$/.exec(el.localName || '');
    const role = effectiveRole(el);
    const isRoleHeading = role === 'heading';

    // An explicit non-heading role beats the native tag.
    if (native && role && !isRoleHeading) return null;
    if (!native && !isRoleHeading) return null;

    // Strictly an integer. parseInt would read aria-level="9e2" as 9 and invent
    // a heading level the browser never computes, which then manufactures a
    // skipped-level advisory out of nothing.
    const raw = el.getAttribute('aria-level');
    const parsed = raw !== null && /^\s*\d+\s*$/.test(raw) ? parseInt(raw, 10) : NaN;
    const hasAria = Number.isInteger(parsed) && parsed > 0;

    if (native) {
      const tagLevel = Number(native[1]);
      return { level: hasAria ? parsed : tagLevel, fromAria: hasAria && parsed !== tagLevel };
    }
    // role="heading" with no aria-level computes to level 2.
    return { level: hasAria ? parsed : 2, fromAria: true };
  }

  function isNativeModal(el) {
    if (!el) return false;
    try {
      return el.matches(':modal');
    } catch (_) {
      return false;
    }
  }

  /**
   * A `showModal()` dialog lives in the top layer, which paints above every
   * z-index and makes everything outside it inert. Left alone that means the
   * outline boxes are drawn *underneath* the dialog and the panel and chip can't
   * be clicked or focused — the tool goes blind and dead at exactly the moment
   * it scopes itself to the dialog.
   *
   * Only a shadow-including descendant of the topmost modal escapes that. The
   * top layer alone is not enough: a popover shown after the dialog is still
   * inert and still hit-tests below the backdrop, in both Chromium and Gecko.
   * So while a native modal is open the tool moves house into the dialog, and
   * moves back out when it closes.
   *
   * The boxes need no repositioning for this. draw() measures the layer host
   * every frame and works relative to it, so the same arithmetic yields document
   * coordinates in the normal case and viewport coordinates once the host is
   * fixed inside the dialog — and draw() already re-runs on scroll, including
   * scrolling inside the dialog, because the listener is a capturing one.
   */
  function syncModalHome() {
    const target = on && isNativeModal(modalEl) ? modalEl : null;
    const hosts = [layerHost, chipHost, panelHost].filter(Boolean);

    if (target) {
      for (const h of hosts) {
        // Re-assert on every scan: a framework re-rendering its dialog will
        // happily drop our nodes on the floor.
        if (h.parentNode !== target) target.appendChild(h);
      }
      if (layerHost) layerHost.dataset.mode = 'modal';
    } else {
      for (const h of hosts) {
        if (modalHome && h.parentNode === modalHome) mount(h);
      }
      if (layerHost) delete layerHost.dataset.mode;
    }
    modalHome = target;
  }

  function isOurs(el) {
    return (
      el === layerHost ||
      el === chipHost ||
      el === panelHost ||
      el.id === LAYER_ID ||
      el.id === CHIP_ID ||
      el.id === PANEL_ID
    );
  }

  /**
   * Layout position with every ancestor's scrolling added back, so it does not
   * move when anything scrolls.
   *
   * getBoundingClientRect() is scroll-adjusted, so a heading sitting at a
   * perfectly ordinary place inside a scrolled pane reports a negative top. Page
   * scroll alone can't be subtracted back out: in the common app-shell layout
   * (fixed chrome, `overflow:auto` main) the window never scrolls at all, so
   * scrollY is 0 while the content underneath has moved hundreds of pixels. Only
   * the sum over every scroll container tells a heading deliberately parked
   * off-canvas from one the reader has simply scrolled past.
   */
  function layoutPosition(el) {
    const r = el.getBoundingClientRect();
    let left = r.left + scrollX;
    let top = r.top + scrollY;
    // The same flattened-tree climb closestFlattened makes, and it has to be the
    // flattened one: a slotted heading renders inside the scroll containers of
    // the component it lands in, not the ones around its light-DOM parent.
    // documentElement and body are skipped because scrollX/scrollY above already
    // account for page scroll.
    for (
      let n = el.assignedSlot || el.parentNode || el.host || null;
      n;
      n = n.assignedSlot || n.parentNode || n.host || null
    ) {
      if (n.nodeType !== 1 || n === document.documentElement || n === document.body) continue;
      left += n.scrollLeft || 0;
      top += n.scrollTop || 0;
    }
    return { left, top };
  }

  /**
   * The split that matters here is the accessibility tree, not the screen.
   * 'rendered' and 'sr-only' are both in the tree, so both are part of the
   * outline a screen-reader user navigates and both belong in the panel.
   * 'hidden' and 'not-rendered' are out of the tree: nothing announces them.
   *
   * Nothing here decides what gets *drawn*. Geometry changes on every scroll,
   * and draw() already culls by viewport, so keeping geometry out of this
   * classification is what stops a scrolled-away heading from vanishing from
   * the outline as well as from the screen.
   *
   * @returns {'rendered'|'sr-only'|'hidden'|'not-rendered'}
   */
  function visibility(el) {
    let rects;
    try {
      rects = el.getClientRects();
    } catch (_) {
      return 'not-rendered';
    }
    if (!rects.length) return 'not-rendered';

    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return 'hidden';

    // Clipped to nothing: the modern sr-only recipe (1px box plus overflow
    // hidden or clip-path). Still announced, so it stays in the outline.
    // Both dimensions have to be small. An empty heading is full-width and
    // zero-height, and it is an ordinary rendered heading that happens to have
    // no content, not a deliberately hidden one.
    if (r.width <= 4 && r.height <= 4) return 'sr-only';

    // Parked outside the document: the older sr-only recipe (left:-9999px).
    // Only the negative side is tested. Layout coordinates inside a scroll
    // container are never negative, so this can't fire on ordinary content,
    // whereas comparing against the document width flagged every heading in a
    // horizontally scrolling kanban board or wide table as screen-reader only.
    // Parking an element to the *right* is a rare enough recipe to miss.
    const pos = layoutPosition(el);
    if (pos.left + r.width < 0 || pos.top + r.height < 0) return 'sr-only';

    return 'rendered';
  }

  /**
   * Is this element a modal that takes over the accessibility tree?
   *
   * Both mechanisms make everything outside themselves unreachable to assistive
   * tech, and neither sets an attribute the aria-hidden/inert check can see:
   * showModal() gets its inertness implicitly from the top layer, and
   * aria-modal="true" implicitly hides its siblings.
   */
  function isModal(el) {
    // Cheap gate first: this runs on every element of every root.
    const isDialogTag = el.localName === 'dialog';
    if (!isDialogTag && el.getAttribute('aria-modal') !== 'true') return false;

    if (isDialogTag) {
      try {
        // Also matches a fullscreen element, which takes over the tree the same way.
        if (el.matches(':modal')) return true;
      } catch (_) {
        /* engine without :modal; fall through to the ARIA check */
      }
    }
    // A <dialog open> that isn't modal, or a plain container, scopes nothing
    // unless it claims modality to assistive tech itself.
    if (el.getAttribute('aria-modal') !== 'true') return false;
    const role = effectiveRole(el);
    if (!isDialogTag && role !== 'dialog' && role !== 'alertdialog') return false;
    // An aria-modal container that isn't rendered is a closed dialog.
    try {
      return el.getClientRects().length > 0;
    } catch (_) {
      return false;
    }
  }

  function topmostModal(list) {
    if (!list.length) return null;
    // The native top layer is authoritative, so a showModal() dialog outranks an
    // ARIA one. Within a tier the last in composed order is the best available
    // guess at the most recently opened.
    const native = list.filter((el) => {
      try {
        return el.matches(':modal');
      } catch (_) {
        return false;
      }
    });
    const pool = native.length ? native : list;
    return pool[pool.length - 1];
  }

  /**
   * Alt text from images inside a heading, descending the flattened tree the
   * same way composedText does. querySelectorAll stops dead at a shadow
   * boundary, and an icon rendered by a child component is the common case.
   */
  function imageNames(node, depth = 0) {
    if (depth > 64 || !node || node.nodeType !== 1) return '';
    const el = /** @type {Element} */ (node);
    let out = '';
    if (
      (el.localName === 'img' && el.hasAttribute('alt')) ||
      (effectiveRole(el) === 'img' && el.hasAttribute('aria-label'))
    ) {
      out += ` ${(el.getAttribute('alt') || el.getAttribute('aria-label') || '').trim()}`;
    }

    if (el.localName === 'slot' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) {
        for (const n of assigned) out += imageNames(n, depth + 1);
        return out;
      }
    }

    // A host renders its shadow content; light children arrive through slots.
    const sub = walker.shadowRootOf(el);
    for (const child of sub ? sub.children : el.children) {
      out += imageNames(child, depth + 1);
    }
    return out;
  }

  /**
   * The accessible name, close enough to tell a genuinely empty heading from one
   * named by aria-label/labelledby/title or a captioned image. Without this,
   * icon-only and aria-labelled headings would falsely flag as empty-heading
   * violations.
   */
  function accName(el) {
    // Spec order: aria-labelledby outranks aria-label, and every reference in
    // the list contributes, joined by spaces — not just the first one that
    // resolves. IDREFs don't cross shadow boundaries, so each is resolved
    // against the heading's own root.
    const ref = el.getAttribute('aria-labelledby');
    if (ref) {
      const root = el.getRootNode();
      const parts = [];
      for (const id of ref.trim().split(/\s+/)) {
        const t = root && root.getElementById ? root.getElementById(id) : null;
        if (t) {
          const txt = walker.composedText(t).replace(/\s+/g, ' ').trim();
          if (txt) parts.push(txt);
        }
      }
      if (parts.length) return parts.join(' ');
    }

    const label = (el.getAttribute('aria-label') || '').trim();
    if (label) return label;

    const text = walker.composedText(el).replace(/\s+/g, ' ').trim();
    if (text) return text;

    // An image with alt text gives the heading a name even with no text node.
    let imgAlt = '';
    try {
      imgAlt = imageNames(el);
    } catch (_) {
      /* ignore */
    }
    if (imgAlt.trim()) return imgAlt.replace(/\s+/g, ' ').trim();

    return (el.getAttribute('title') || '').trim();
  }

  /**
   * Builds the outline: every heading in the accessibility tree, in reading
   * order. This is deliberately the only list. It used to also filter by
   * on-screen geometry, which meant a heading scrolled out of an `overflow:auto`
   * pane was dropped from the outline entirely while still being counted, so the
   * panel and the chip disagreed. Geometry belongs in draw(), which re-runs on
   * every scroll and culls to the viewport there.
   */
  function collect() {
    stats = emptyStats();

    // Modals are collected in the same pass rather than a second walk: this
    // traversal already visits every element of every root, including the shadow
    // roots a design-system dialog usually lives in.
    //
    // The heading cap is applied below rather than by walk(), so that dialogs
    // never consume it. Letting them share the budget means a page at the cap
    // can lose the open dialog and silently fail to scope the outline to it.
    const { matches } = walker.walk({
      match: (el) => !isOurs(el) && (!!headingInfo(el) || isModal(el)),
      skip: (el) => isOurs(el),
    });

    const headings = [];
    const modals = [];
    for (const m of matches) {
      if (!headingInfo(m.element)) {
        modals.push(m.element);
      } else if (headings.length >= MAX_HEADINGS) {
        stats.truncated = true;
      } else {
        headings.push(m);
      }
    }
    modalEl = topmostModal(modals);

    const seq = [];

    for (const m of headings) {
      const info = headingInfo(m.element);
      stats.total++;

      // With a modal open, everything behind it is out of the accessibility
      // tree, so it is no more part of the reachable outline than an
      // aria-hidden subtree is. Counted, so the drop in the outline is visible
      // rather than looking like a tool bug.
      if (modalEl && !walker.closestFlattened(m.element, (el) => el === modalEl)) {
        stats.behindModal++;
        continue;
      }

      const hiddenAncestor = walker.closestFlattened(
        m.element,
        (el) => el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')
      );
      if (hiddenAncestor) {
        stats.ariaHidden++;
        continue;
      }

      // display:none and visibility:hidden are out of the accessibility tree:
      // nothing announces them, so they are not part of the outline. They're
      // still counted, because a collapsed accordion or an inactive tab panel
      // is full of headings an auditor wants to know exist.
      const vis = visibility(m.element);
      if (vis === 'not-rendered') {
        stats.notRendered++;
        continue;
      }
      if (vis === 'hidden') {
        stats.hidden++;
        continue;
      }

      if (vis === 'sr-only') stats.srOnly++;

      seq.push({
        el: m.element,
        level: info.level,
        fromAria: info.fromAria,
        srOnly: vis === 'sr-only',
        name: accName(m.element),
        empty: accName(m.element) === '',
        hosts: m.hosts,
        closed: m.closed,
        problems: [],
      });
    }

    validate(seq, !!modalEl);
    for (const item of seq) {
      for (const code of item.problems) {
        if (PROBLEMS[code].tier === VIOLATION) stats.violations++;
        else stats.advisories++;
      }
    }
    return seq;
  }

  /**
   * Runs the hierarchy checks over the reading-order sequence, tagging each
   * item's `problems` and recording page-level findings in `pageProblems`.
   */
  function validate(seq, scoped) {
    pageProblems = [];
    let h1s = 0;
    let prevLevel = 0;

    for (const item of seq) {
      if (item.empty) item.problems.push('empty');
      if (item.level === 1) h1s++;

      if (prevLevel === 0) {
        // A dialog is a section of the page, not a document of its own, so
        // opening at h2 is correct there. Flagging it would be a false positive
        // on every well-built modal.
        if (item.level > 1 && !scoped) item.problems.push('first-not-h1');
      } else if (item.level > prevLevel + 1) {
        item.problems.push('skipped');
      }
      prevLevel = item.level;
    }

    // Page-level h1 findings are about the page, and a modal is not one. Running
    // them over a dialog's headings would report "no h1" on every dialog.
    if (seq.length && !scoped) {
      if (h1s === 0) pageProblems.push('no-h1');
      else if (h1s > 1) pageProblems.push('multiple-h1');
    }
  }

  function worstTier(item) {
    if (item.problems.some((c) => PROBLEMS[c].tier === VIOLATION)) return VIOLATION;
    if (item.problems.length) return ADVISORY;
    return '';
  }

  // ----------------------------------------------------------- label building

  function leafDescriptor(el) {
    let s = el.localName || 'element';
    if (!/^h[1-6]$/.test(s) && effectiveRole(el) === 'heading') {
      s += '[role=heading]';
    }
    if (el.id) s += `#${el.id}`;
    const classes = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (classes.length) s += '.' + classes.slice(0, 3).join('.');
    return s;
  }

  function chainString(item) {
    const parts = item.hosts.map((h) => h.localName);
    parts.push(leafDescriptor(item.el));
    return parts.join(' >>> ');
  }

  function middleTruncate(s, limit) {
    if (s.length <= limit) return s;
    const head = Math.ceil((limit - 1) * 0.4);
    const tail = limit - 1 - head;
    return `${s.slice(0, head)}\u2026${s.slice(s.length - tail)}`;
  }

  function labelFor(item) {
    let text = `H${item.level}`;
    if (labelMode === 'component' && item.hosts.length) {
      text += ` <${item.hosts[item.hosts.length - 1].localName}>`;
    } else if (labelMode === 'chain') {
      text += ` ${middleTruncate(chainString(item), 48)}`;
    }
    if (item.fromAria) text += ' \u00b7aria';
    if (item.srOnly) text += ' \u00b7sr-only';
    // A \u2715 for a violation, a \u26a0 for an advisory, then the short name of each
    // finding, so the box screenshot carries the defect on its own without the
    // sidebar.
    for (const code of item.problems) {
      const p = PROBLEMS[code];
      text += `  ${p.tier === VIOLATION ? '\u2715' : '\u26a0'} ${p.short}`;
    }
    return text;
  }

  function consoleExpression(item) {
    let expr = 'document';
    for (const h of item.hosts) {
      expr += `.querySelector('${h.localName}').shadowRoot`;
    }
    expr += `\n  .querySelector('${leafDescriptor(item.el)}')`;
    return expr;
  }

  function record(item) {
    const flags = [];
    if (item.fromAria) flags.push('aria-level');
    if (item.srOnly) flags.push('screen-reader only');
    const lines = [
      `H${item.level}${flags.length ? ` (${flags.join(', ')})` : ''}`,
      walker.composedText(item.el).replace(/\s+/g, ' ').trim().slice(0, 120),
      chainString(item),
      consoleExpression(item),
    ];
    for (const code of item.problems) {
      const p = PROBLEMS[code];
      lines.push(`${p.tier === VIOLATION ? 'VIOLATION' : 'ADVISORY'} [${findingTag(p)}]: ${p.desc}`);
    }
    if (item.closed) {
      lines.push(
        'NOTE: this chain crosses a closed shadow root. The console expression ' +
          'returns null, because .shadowRoot is null for closed roots outside an ' +
          'extension context. Use the >>> chain with Playwright instead.'
      );
    }
    return lines.filter(Boolean).join('\n');
  }

  function outlineText() {
    const lines = [];
    lines.push(`Heading outline: ${location.href}`);
    lines.push(new Date().toISOString());
    lines.push(countsLine());
    if (modalEl) {
      lines.push(
        'SCOPE: a modal dialog is open, so this outline covers the dialog only. ' +
          'Assistive tech cannot reach the page behind it.'
      );
    }
    if (!walker.canPierceClosed) {
      lines.push('WARNING: closed shadow roots were not traversed in this environment.');
    }
    for (const code of pageProblems) {
      const p = PROBLEMS[code];
      lines.push(`ADVISORY [${findingTag(p)}]: ${p.desc}`);
    }
    lines.push('');
    for (const item of items) {
      const indent = '  '.repeat(Math.max(0, Math.min(item.level, 12) - 1));
      const flags = [];
      if (item.fromAria) flags.push('aria-level');
      if (item.srOnly) flags.push('sr-only');
      for (const code of item.problems) {
        flags.push(`${PROBLEMS[code].tier === VIOLATION ? '✕' : '⚠'} ${PROBLEMS[code].short}`);
      }
      const text = walker.composedText(item.el).replace(/\s+/g, ' ').trim().slice(0, 80);
      const shown = text || (item.name ? `${item.name.slice(0, 80)} (from label)` : '(no text)');
      lines.push(
        `${indent}H${item.level}  ${shown}${flags.length ? `  [${flags.join(', ')}]` : ''}`
      );
    }
    return lines.join('\n');
  }

  /**
   * Cross-origin frames this run almost certainly did not reach.
   *
   * Injection asks for allFrames, but activeTab grants host access for the tab's
   * own origin only, so cross-origin frames are skipped and the per-frame
   * denials never surface as an error anyone can catch. Staying quiet about that
   * would make an audit tool under-report silently, which is the one failure
   * mode it must not have. Counting the frames whose document we can't touch is
   * the closest honest approximation available from inside the page.
   */
  function unreachableFrames() {
    if (!isTopFrame()) return 0;
    let n = 0;
    let frames;
    try {
      frames = document.querySelectorAll('iframe, frame');
    } catch (_) {
      return 0;
    }
    for (const f of frames) {
      try {
        if (!f.contentDocument) n++;
      } catch (_) {
        n++;
      }
    }
    return n;
  }

  // Reasons a heading was found but left out of the outline, in the order they're
  // tested in collect(). Together with the outline count these sum to stats.total.
  function exclusions() {
    const out = [];
    if (stats.behindModal) out.push(`${stats.behindModal} behind the modal`);
    if (stats.ariaHidden) out.push(`${stats.ariaHidden} in aria-hidden`);
    if (stats.notRendered) out.push(`${stats.notRendered} display:none`);
    if (stats.hidden) out.push(`${stats.hidden} visibility:hidden`);
    return out;
  }

  // The lead number is what the outline actually lists, so the count and the
  // rows can never disagree. Anything found but not listed is named with its
  // reason, and the parts add back up to every heading on the page.
  function countsLine() {
    const n = items.length;
    const parts = [`${n} heading${n === 1 ? '' : 's'}`];
    if (stats.violations) parts.push(`\u2715 ${stats.violations} violation${stats.violations === 1 ? '' : 's'}`);
    const adv = stats.advisories + pageProblems.length;
    if (adv) parts.push(`\u26a0 ${adv} advisor${adv === 1 ? 'y' : 'ies'}`);
    if (stats.srOnly) parts.push(`incl. ${stats.srOnly} screen-reader only`);
    parts.push(...exclusions());
    const frames = unreachableFrames();
    if (frames) parts.push(`${frames} cross-origin frame${frames === 1 ? '' : 's'} not covered`);
    if (stats.truncated) parts.push(`capped at ${MAX_HEADINGS}`);
    return parts.join(' \u00b7 ');
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      flash('Copied');
      return;
    } catch (_) {
      /* fall through */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      flash('Copied');
    } catch (_) {
      flash('Copy failed, see console');
      console.log(text);
    }
  }

  let flashTimer = 0;
  function flash(msg) {
    // Announce to screen readers too: the chip note is aria-hidden, so a
    // visually-hidden live region in the panel carries the confirmation.
    if (panelStatus) panelStatus.textContent = msg;
    if (!chipNote) return;
    chipNote.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = 0;
      if (chipNote) chipNote.textContent = defaultNote();
    }, 1800);
  }

  function defaultNote() {
    // Kept short so it never truncates next to the buttons. The shortcut hints
    // moved to the button tooltips; the one status worth showing here is when
    // the environment can only reach open roots.
    return walker.canPierceClosed ? '' : 'open roots only';
  }

  // ---------------------------------------------------------------- rendering

  function buildLayer() {
    layerHost = document.createElement('div');
    layerHost.id = LAYER_ID;
    // Kept out of the page's accessibility tree so an axe run or screen reader
    // pass with outlines on stays clean. Not inert, since inert would also block
    // the alt+click copy, and there's nothing focusable in here anyway.
    layerHost.setAttribute('aria-hidden', 'true');

    const shadow = layerHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      /* Absolute, anchored at the document origin and zero-sized, so the boxes
         are positioned in document coordinates. That way the browser scrolls
         them in lockstep with the page instead of us repainting them a frame
         behind on every scroll. */
      :host {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 0 !important;
        height: 0 !important;
        pointer-events: none !important;
        z-index: 2147483645 !important;
        forced-color-adjust: none;
      }
      /* Set while the host lives inside an open modal dialog (see enterModal).
         Fixed rather than absolute for two reasons: it re-anchors the boxes to
         the viewport, which is the space the dialog's contents are measured in,
         and a fixed child adds nothing to an ancestor's scrollable overflow, so
         a full-size layer can't give the dialog its own scrollbars. */
      :host([data-mode="modal"]) {
        position: fixed !important;
      }
      /* Sized to the document and clipped, so a padded box overhanging a
         full-width heading can't extend the page's scrollable area and add a
         horizontal scrollbar to the very layout being audited. Clipping also
         makes the measurement stable: our own boxes stop contributing to
         scrollWidth, so reading it back doesn't creep. */
      .layer {
        position: absolute;
        top: 0;
        left: 0;
        overflow: hidden;
        overflow: clip;
      }
      .box, .tag {
        position: absolute;
        top: 0;
        left: 0;
        box-sizing: border-box;
        forced-color-adjust: none;
      }
      /* The 1px white ring keeps the outline legible on dark pages, which is
         what makes a defect screenshot usable. */
      .box {
        border: 2px solid var(--c);
        border-radius: 2px;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.95),
                    inset 0 0 0 1px rgba(255,255,255,0.95);
      }
      .box[data-style="aria"]    { border-style: dashed; }
      /* Dotted reads as "announced but not painted": the heading is in the
         accessibility tree, there's just nothing on screen at this spot. */
      .box[data-style="sr-only"] { border-style: dotted; }
      /* A flagged heading keeps its level color (still the load-bearing
         encoding) and gets a second ring: solid amber for an advisory, a
         heavier double red for a violation. It's redundant with the label's
         ⚠/✕, so a grayscale or CVD screenshot still reads. */
      .box[data-flag="advisory"] {
        box-shadow: 0 0 0 1px rgba(255,255,255,0.95),
                    0 0 0 4px #946200,
                    inset 0 0 0 1px rgba(255,255,255,0.95);
      }
      .box[data-flag="violation"] {
        box-shadow: 0 0 0 1px rgba(255,255,255,0.95),
                    0 0 0 4px #c1121f,
                    0 0 0 6px rgba(255,255,255,0.95),
                    inset 0 0 0 1px rgba(255,255,255,0.95);
      }
      .tag[data-flag="advisory"]  { box-shadow: 0 0 0 1px rgba(255,255,255,0.95), 0 0 0 3px #946200; }
      .tag[data-flag="violation"] { box-shadow: 0 0 0 1px rgba(255,255,255,0.95), 0 0 0 3px #c1121f; }
      .tag {
        font: 700 12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: 0.02em;
        color: #fff;
        background: var(--c);
        padding: 1px 5px;
        border-radius: 2px;
        white-space: nowrap;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.95);
        text-shadow: none;
      }
      .clickable { pointer-events: auto; cursor: copy; }
      .flash {
        position: absolute; top: 0; left: 0; box-sizing: border-box;
        /* Neutral high-contrast pulse (dark ring plus a white halo) so it stands
           apart from every level color and the red/amber flags, and reads on a
           light or dark page. The motion gets the attention, not a hue. */
        border: 3px solid rgba(17,17,17,0.92); border-radius: 3px;
        background: rgba(255,255,255,0.12);
        box-shadow: 0 0 0 3px rgba(255,255,255,0.95), 0 0 16px 4px rgba(0,0,0,0.45);
        animation: shoPulse 1.4s ease-out 1;
        forced-color-adjust: none;
      }
      @keyframes shoPulse {
        0% { opacity: 0; }
        12% { opacity: 1; }
        100% { opacity: 0.55; }
      }
      /* No pulse for people who've asked the OS for less motion. The highlight
         still appears, it just doesn't animate. */
      @media (prefers-reduced-motion: reduce) {
        .flash { animation: none; opacity: 0.8; }
      }
    `;
    layer = document.createElement('div');
    layer.className = 'layer';
    shadow.append(style, layer);
    mount(layerHost);
  }

  function buildChip() {
    chipHost = document.createElement('div');
    chipHost.id = CHIP_ID;
    // aria-hidden but not inert, so it's mouse-operable and invisible to
    // assistive tech. Its buttons carry tabindex="-1" so the page's tab order
    // stays untouched.
    chipHost.setAttribute('aria-hidden', 'true');

    const shadow = chipHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        position: fixed !important;
        left: 8px !important;
        bottom: 8px !important;
        z-index: 2147483647 !important;
        forced-color-adjust: none;
      }
      .chip {
        display: flex;
        align-items: center;
        /* Wraps instead of overflowing, so the counts and buttons stack on a
           phone-width viewport. */
        flex-wrap: wrap;
        gap: 6px 10px;
        max-width: min(92vw, 720px);
        padding: 7px 10px;
        background: #10161c;
        color: #fff;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        font: 400 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        forced-color-adjust: none;
      }
      .counts { font-weight: 700; white-space: nowrap; }
      .note { color: #b8c4cf; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .actions { display: flex; gap: 6px; margin-left: auto; }
      button {
        font: inherit;
        color: #fff;
        background: rgba(255,255,255,0.12);
        border: 1px solid rgba(255,255,255,0.3);
        border-radius: 4px;
        padding: 3px 9px;
        cursor: pointer;
        forced-color-adjust: none;
      }
      button:hover { background: rgba(255,255,255,0.24); border-color: rgba(255,255,255,0.5); }
    `;

    const chip = document.createElement('div');
    chip.className = 'chip';

    chipText = document.createElement('span');
    chipText.className = 'counts';

    chipNote = document.createElement('span');
    chipNote.className = 'note';

    // Chip buttons mirror the panel's controls and use the same labels and
    // tooltips, so the two surfaces read as one tool.
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button('Detail', 'Cycle row detail: level, then component, then selector (Alt+Shift+M)', cycleMode)
    );
    // The panel only exists in the top frame, so only offer its toggle there.
    // The chip stays visible when the panel is hidden, so it's the way back.
    if (isTopFrame()) {
      chipPanelBtn = button(
        panelHidden ? 'Show panel' : 'Hide panel',
        panelHidden
          ? 'Show the outline panel (Alt+Shift+P)'
          : 'Hide the panel, keep the boxes (Alt+Shift+P)',
        togglePanel
      );
      actions.append(chipPanelBtn);
    }
    actions.append(
      button(
        'Copy outline',
        'Copy the whole outline as indented text: the page URL, the counts, and ' +
          'every heading by level with its flags. Good for pasting into a bug report ' +
          'or audit note. (Alt+Shift+C)',
        () => copy(outlineText())
      ),
      button('Close', 'Close the whole tool (Esc when the panel is hidden)', off)
    );

    chip.append(chipText, chipNote, actions);
    shadow.append(style, chip);
    mount(chipHost);
  }

  function button(label, title, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.tabIndex = -1;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    return b;
  }

  function mount(node) {
    (document.body || document.documentElement).appendChild(node);
  }

  function isTopFrame() {
    try {
      return window.top === window.self;
    } catch (_) {
      // A cross-origin ancestor throws on window.top access, which by itself
      // means this is a sub-frame.
      return false;
    }
  }

  // ------------------------------------------------------------------- sidebar

  const DETAILS = [
    { mode: 'level', label: 'Level + text' },
    { mode: 'component', label: '+ Component' },
    { mode: 'chain', label: '+ Selector' },
  ];

  // Unlike the overlay and chip, the panel is the tool's own operable UI, so
  // it's NOT aria-hidden. An auditor who uses a screen reader or the keyboard
  // has to be able to drive it. The cost is that it adds focus stops and a
  // landmark to the page under test while it's open, so to audit the page's own
  // tab order or screen-reader output, close the tool (Esc) first.
  function buildPanel() {
    panelHost = document.createElement('div');
    panelHost.id = PANEL_ID;

    const shadow = panelHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        position: fixed !important;
        top: 0 !important;
        right: 0 !important;
        height: 100vh !important;
        z-index: 2147483646 !important;
        forced-color-adjust: none;
        --bg: #ffffff; --fg: #14181d; --muted: #5a6672; --line: #d7dde3;
        /* Caps at 88vw so the panel never swallows a phone-width viewport. */
        --rowhover: #eef2f6; --panelw: min(340px, 88vw);
        /* Flag text colors, darkened enough to clear 4.5:1 on the white panel.
           The lighter shades used before failed contrast in the light theme. */
        --flag-v: #c1121f; --flag-a: #8a6300;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --bg: #10161c; --fg: #eef2f6; --muted: #9aa7b3; --line: #2a343d;
          --rowhover: #1b2530;
          /* Lightened for the dark panel, where they clear 4.5:1 the other way. */
          --flag-v: #ff6b74; --flag-a: #e0a83a;
        }
      }
      * { box-sizing: border-box; }
      .panel {
        display: flex; flex-direction: column;
        width: var(--panelw); height: 100%;
        background: var(--bg); color: var(--fg);
        border-left: 1px solid var(--line);
        box-shadow: -1px 0 6px rgba(0,0,0,0.14);
        font: 400 13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
        forced-color-adjust: none;
      }
      .grip {
        position: absolute; left: -3px; top: 0; width: 6px; height: 100%;
        cursor: ew-resize; touch-action: none;
      }
      header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border-bottom: 1px solid var(--line);
      }
      .title { font-weight: 700; font-size: 12px; white-space: nowrap; }
      .spacer { margin-left: auto; }
      .iconbtn {
        font: inherit; font-size: 12px; color: var(--fg);
        background: transparent; border: 1px solid var(--line);
        border-radius: 4px; padding: 3px 7px; cursor: pointer;
      }
      .iconbtn:hover { background: var(--rowhover); }
      /* One consistent focus ring on every button, matching the rows. */
      .iconbtn:focus-visible, .seg button:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
      .controls { padding: 8px 10px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
      .detail { display: flex; align-items: center; gap: 8px; }
      .detail-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
      .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
      .seg button {
        font: inherit; font-size: 12px; color: var(--fg); background: transparent;
        border: 0; border-right: 1px solid var(--line); padding: 4px 8px; cursor: pointer;
      }
      .seg button:last-child { border-right: 0; }
      /* Neutral inverted fill for the chosen radio. */
      .seg button[aria-checked="true"] { background: var(--fg); color: var(--bg); }
      .sr-only {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
      }
      .summary { font-size: 12px; color: var(--muted); }
      .summary .v { color: var(--flag-v); font-weight: 700; }
      .summary .a { color: var(--flag-a); font-weight: 700; }
      .summary .scope { color: var(--fg); font-weight: 700; }
      .body { overflow: auto; flex: 1 1 auto; }
      ul { list-style: none; margin: 0; padding: 4px 0; }
      .row {
        display: flex; align-items: baseline; gap: 8px; width: 100%;
        text-align: left; font: inherit; color: var(--fg);
        background: transparent; border: 0; border-left: 3px solid transparent;
        padding: 4px 10px 4px 0; cursor: pointer;
      }
      .row:hover { background: var(--rowhover); }
      .row:focus-visible { outline: 2px solid var(--fg); outline-offset: -2px; }
      .row[data-flag="advisory"] { border-left-color: var(--flag-a); }
      .row[data-flag="violation"] { border-left-color: var(--flag-v); }
      .lvl {
        flex: none; min-width: 26px; text-align: center;
        color: #fff; border-radius: 3px; font: 700 11px/1.5 ui-monospace, Menlo, monospace;
        padding: 0 4px;
      }
      .txt { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .txt.empty { color: var(--muted); font-style: italic; }
      /* Named by a label or an icon rather than by its own text. */
      .txt.named { font-style: italic; }
      .srmark {
        flex: none; color: var(--muted); border: 1px solid var(--line);
        border-radius: 3px; padding: 0 4px;
        font: 400 10px/1.6 ui-monospace, Menlo, monospace;
      }
      .more { flex: none; color: var(--muted); font: 400 11px/1.5 ui-monospace, Menlo, monospace; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rowflags { flex: none; font-size: 11px; font-weight: 700; white-space: nowrap; }
      .rowflags.violation { color: var(--flag-v); }
      .rowflags.advisory { color: var(--flag-a); }
      .foot {
        border-top: 1px solid var(--line); padding: 7px 10px;
        display: flex; gap: 16px; font-size: 11px; color: var(--muted);
      }
      .foot .k { display: inline-flex; align-items: center; gap: 5px; }
      .foot .g { font-weight: 700; font-family: ui-monospace, Menlo, monospace; }
      .foot .g.v { color: var(--flag-v); }
      .foot .g.a { color: var(--flag-a); }
      .empty-list { padding: 16px 12px; color: var(--muted); }
      /* Tooltip that appears on hover AND keyboard focus (native title only
         fires on hover, so keyboard users never saw it). */
      .tip {
        position: fixed; z-index: 3; max-width: 240px;
        background: var(--fg); color: var(--bg);
        padding: 5px 8px; border-radius: 4px; font-size: 11px; line-height: 1.4;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3); pointer-events: none;
      }
      .tip[hidden] { display: none; }
      @media (forced-colors: active) {
        .lvl { forced-color-adjust: none; }
      }
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'Shadow heading outline');

    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to resize the panel';
    grip.addEventListener('pointerdown', startResize);

    // Header: title, then Hide (dismiss the panel, keep the boxes) and Close
    // (shut the whole tool). Collapse used to live here too, but it did nearly
    // the same job as Hide, so there's now one dismiss concept, not two.
    const head = document.createElement('header');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = 'Heading outline';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const hideBtn = iconButton('Hide', togglePanel);
    hideBtn.dataset.tip = 'Hide the panel, keep the boxes (Alt+Shift+P)';
    const closeBtn = iconButton('Close', off);
    closeBtn.dataset.tip = 'Close the whole tool (Esc when the panel is hidden)';
    head.append(title, spacer, hideBtn, closeBtn);

    // Controls: labeled detail segmented control, then Copy outline.
    const controls = document.createElement('div');
    controls.className = 'controls';

    // A one-of-three picker, so it's a radio group, not toggle buttons. Radios
    // tell assistive tech that choosing one clears the others; aria-pressed
    // (toggle) would say each is independently on or off.
    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'radiogroup');
    for (const d of DETAILS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.textContent = d.label;
      b.dataset.mode = d.mode;
      b.dataset.tip = `Row detail: ${d.label} (arrow keys move, Alt+Shift+M cycles)`;
      b.addEventListener('click', () => setMode(d.mode));
      seg.append(b);
    }
    // Radio-group arrow keys: move and select, so the group is a single tab stop.
    seg.addEventListener('keydown', (e) => {
      const btns = [...seg.querySelectorAll('button')];
      const i = btns.indexOf(panelHost.shadowRoot.activeElement);
      if (i < 0) return;
      let ni = i;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') ni = (i + 1) % btns.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ni = (i - 1 + btns.length) % btns.length;
      else if (e.key === 'Home') ni = 0;
      else if (e.key === 'End') ni = btns.length - 1;
      else return;
      e.preventDefault();
      setMode(btns[ni].dataset.mode);
      btns[ni].focus();
    });
    // A visible label, tied to the group so it is the group's accessible name.
    // A tooltip would not be, since tooltips aren't an accessible way to convey it.
    const detail = document.createElement('div');
    detail.className = 'detail';
    const detailLabel = document.createElement('span');
    detailLabel.className = 'detail-label';
    detailLabel.id = 'sho-detail-label';
    detailLabel.textContent = 'Detail';
    seg.setAttribute('aria-labelledby', detailLabel.id);
    detail.append(detailLabel, seg);

    const copyBtn = iconButton('Copy outline', () => copy(outlineText()));
    copyBtn.dataset.tip =
      'Copy the whole outline as indented text: the page URL, the counts, and ' +
      'every heading by level with its flags. Good for pasting into a bug report ' +
      'or audit note. (Alt+Shift+C)';

    const controlRow = document.createElement('div');
    controlRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    controlRow.append(detail, copyBtn);

    // Not a live region: it re-renders on every rescan, and announcing the
    // counts on each mutation would make a screen reader chatty on dynamic pages.
    panelSummary = document.createElement('div');
    panelSummary.className = 'summary';

    // Visually-hidden live region for one-off confirmations (Copied, etc.). The
    // flash chip is aria-hidden, so this is how a screen-reader user hears them.
    panelStatus = document.createElement('div');
    panelStatus.className = 'sr-only';
    panelStatus.setAttribute('aria-live', 'polite');

    controls.append(controlRow, panelSummary, panelStatus);

    const body = document.createElement('div');
    body.className = 'body';
    panelList = document.createElement('ul');
    panelList.setAttribute('role', 'tree');
    panelList.setAttribute('aria-label', 'Heading outline');
    // Tree arrow keys: move focus between rows, so the list is one tab stop and
    // Up/Down walk the headings. Enter/Space still activate (scroll to it).
    panelList.addEventListener('keydown', (e) => {
      const rows = [...panelList.querySelectorAll('.row')];
      if (!rows.length) return;
      const i = rows.indexOf(panelHost.shadowRoot.activeElement);
      let ni = i;
      if (e.key === 'ArrowDown') ni = i < 0 ? 0 : Math.min(i + 1, rows.length - 1);
      else if (e.key === 'ArrowUp') ni = i < 0 ? 0 : Math.max(i - 1, 0);
      else if (e.key === 'Home') ni = 0;
      else if (e.key === 'End') ni = rows.length - 1;
      else return;
      e.preventDefault();
      rows.forEach((r, j) => (r.tabIndex = j === ni ? 0 : -1));
      rows[ni].focus();
    });
    body.append(panelList);

    // Legend: what the two flag tiers mean. A violation is a WCAG failure an
    // automated checker reports; an advisory is a best-practice finding.
    // Built with DOM calls, not innerHTML, so store linters stay quiet.
    const foot = document.createElement('footer');
    foot.className = 'foot';
    const legendItem = (glyphClass, glyph, text) => {
      const k = document.createElement('span');
      k.className = 'k';
      const g = document.createElement('span');
      g.className = `g ${glyphClass}`;
      g.setAttribute('aria-hidden', 'true');
      g.textContent = glyph;
      k.append(g, ` ${text}`);
      return k;
    };
    foot.append(
      legendItem('v', '✕', 'Violation (WCAG fail)'),
      legendItem('a', '⚠', 'Advisory (best practice)')
    );

    // A tooltip that fires on hover AND keyboard focus, for any [data-tip]
    // control. Native title only shows on hover, so keyboard users never saw it.
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.id = 'sho-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.hidden = true;
    const showTip = (t) => {
      if (!t || !t.dataset.tip) return;
      tipEl.textContent = t.dataset.tip;
      tipEl.hidden = false;
      const r = t.getBoundingClientRect();
      const tr = tipEl.getBoundingClientRect();
      let top = r.top - tr.height - 6;
      if (top < 4) top = r.bottom + 6; // flip below if no room above
      const left = Math.max(6, Math.min(r.left, innerWidth - tr.width - 6));
      tipEl.style.top = `${top}px`;
      tipEl.style.left = `${left}px`;
      t.setAttribute('aria-describedby', tipEl.id);
    };
    const hideTip = (t) => {
      tipEl.hidden = true;
      if (t && t.removeAttribute) t.removeAttribute('aria-describedby');
    };
    const tipTarget = (e) => (e.target.closest ? e.target.closest('[data-tip]') : null);
    panel.addEventListener('focusin', (e) => showTip(tipTarget(e)));
    panel.addEventListener('focusout', (e) => hideTip(tipTarget(e)));
    panel.addEventListener('pointerover', (e) => showTip(tipTarget(e)));
    panel.addEventListener('pointerout', (e) => hideTip(tipTarget(e)));

    panel.append(grip, head, controls, body, foot, tipEl);
    shadow.append(style, panel);
    mount(panelHost);
    updateDetailControl();
  }

  function iconButton(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'iconbtn';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
    return b;
  }

  function togglePanel() {
    setPanelHidden(!panelHidden);
  }

  // Hide the sidebar entirely while leaving the boxes and chip in place. This
  // removes the panel from view completely; the chip button and Alt+Shift+P
  // bring it back.
  function setPanelHidden(v, opts) {
    panelHidden = v;
    if (panelHost) panelHost.style.display = v ? 'none' : '';
    if (chipPanelBtn) {
      chipPanelBtn.textContent = v ? 'Show panel' : 'Hide panel';
      chipPanelBtn.title = v
        ? 'Show the outline panel (Alt+Shift+P)'
        : 'Hide the panel, keep the boxes (Alt+Shift+P)';
    }
    // When the panel comes back, land focus on it so a keyboard user returns to
    // the panel rather than being stranded on the body where they hid it. Not on
    // start(), though: opening the tool shouldn't yank focus off the page.
    if (!v && panelHost && !(opts && opts.focus === false)) {
      const first = panelHost.shadowRoot.querySelector('header .iconbtn');
      if (first) first.focus();
    }
  }

  // Resizing the panel by dragging its inner edge. Width lives on the host var.
  let resizeStartX = 0;
  let resizeStartW = 0;
  function startResize(e) {
    if (!panelHost) return;
    e.preventDefault();
    resizeStartX = e.clientX;
    // Measure the rendered width; the CSS var may hold a min() expression.
    const panelEl = panelHost.shadowRoot.querySelector('.panel');
    resizeStartW = panelEl ? Math.round(panelEl.getBoundingClientRect().width) : 340;
    const move = (ev) => {
      const cap = Math.min(720, Math.floor(innerWidth * 0.92));
      const w = Math.min(cap, Math.max(240, resizeStartW + (resizeStartX - ev.clientX)));
      panelHost.style.setProperty('--panelw', `${w}px`);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  function updateDetailControl() {
    if (!panelHost) return;
    for (const b of panelHost.shadowRoot.querySelectorAll('.seg button')) {
      const on = b.dataset.mode === labelMode;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      // Roving tabindex: only the chosen radio is in the tab order; arrows reach
      // the rest. That's the radio-group keyboard pattern.
      b.tabIndex = on ? 0 : -1;
    }
  }

  function panelMoreText(item) {
    if (labelMode === 'component') {
      return item.hosts.length ? `<${item.hosts[item.hosts.length - 1].localName}>` : '';
    }
    if (labelMode === 'chain') return chainString(item);
    return '';
  }

  function renderPanel() {
    if (!panelList) return;
    panelList.textContent = '';

    // Summary line: violations, advisories, page-level findings. DOM calls,
    // not innerHTML, so store linters stay quiet.
    panelSummary.textContent = '';
    const colored = (cls, text) => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      return s;
    };
    panelSummary.append(`${items.length} heading${items.length === 1 ? '' : 's'}`);
    if (stats.violations) panelSummary.append(' · ', colored('v', `✕ ${stats.violations}`));
    const adv = stats.advisories + pageProblems.length;
    if (adv) panelSummary.append(' · ', colored('a', `⚠ ${adv}`));
    if (stats.srOnly) panelSummary.append(` · incl. ${stats.srOnly} screen-reader only`);
    if (!walker.canPierceClosed) panelSummary.append(' · open roots only');

    // Always say why the list is shorter than the page. An unexplained short
    // outline is exactly what makes the tool look like it's losing headings.
    if (modalEl) {
      panelSummary.append(
        document.createElement('br'),
        colored('scope', 'Scoped to the open dialog.'),
        ' Assistive tech can’t reach the page behind it. Close it to outline the page.'
      );
    }
    const excluded = exclusions();
    if (excluded.length) {
      panelSummary.append(
        document.createElement('br'),
        `${stats.total - items.length} more found, none of them in the accessibility tree: ${excluded.join(', ')}.`
      );
    }

    const frames = unreachableFrames();
    if (frames) {
      panelSummary.append(
        document.createElement('br'),
        colored('a', '⚠'),
        ` ${frames} cross-origin frame${frames === 1 ? '' : 's'} on this page. ` +
          'Their headings are audited separately or not at all, and are never ' +
          'listed here. Open a frame in its own tab to audit it.'
      );
    }

    for (const code of pageProblems) {
      panelSummary.append(
        document.createElement('br'),
        colored('a', '⚠'),
        ` ${PROBLEMS[code].short}: ${PROBLEMS[code].desc}`
      );
    }

    if (!items.length) {
      const li = document.createElement('li');
      const div = document.createElement('div');
      div.className = 'empty-list';
      div.textContent = 'No headings found on this page.';
      li.append(div);
      panelList.append(li);
      return;
    }

    let rowIdx = 0;
    for (const item of items) {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row';
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(item.level));
      // Roving tabindex: the first row is the list's single tab stop, arrows
      // reach the rest.
      row.tabIndex = rowIdx === 0 ? 0 : -1;
      const tier = worstTier(item);
      if (tier) row.dataset.flag = tier;
      row.style.paddingLeft = `${8 + (Math.min(item.level, 6) - 1) * 14}px`;

      const lvl = document.createElement('span');
      lvl.className = 'lvl';
      lvl.style.background = COLORS[item.level] || OUT_OF_RANGE;
      lvl.textContent = `H${item.level}`;

      const txt = document.createElement('span');
      txt.className = 'txt';
      // A heading can be named by a label or an icon's alt text and have no text
      // of its own. Saying "(no text)" there contradicts the tool's own verdict
      // that it isn't an empty heading, so show the name it actually computed.
      const name = walker.composedText(item.el).replace(/\s+/g, ' ').trim();
      if (name) {
        txt.textContent = name;
      } else if (item.name) {
        txt.classList.add('named');
        txt.textContent = item.name;
      } else {
        txt.classList.add('empty');
        txt.textContent = '(no text)';
      }

      row.append(lvl, txt);

      if (item.srOnly) {
        const s = document.createElement('span');
        s.className = 'srmark';
        s.textContent = 'sr-only';
        row.append(s);
      }

      const more = panelMoreText(item);
      if (more) {
        const m = document.createElement('span');
        m.className = 'more';
        m.textContent = more;
        row.append(m);
      }

      if (item.problems.length) {
        const f = document.createElement('span');
        f.className = `rowflags ${tier}`;
        f.textContent =
          (tier === VIOLATION ? '✕ ' : '⚠ ') +
          item.problems.map((c) => PROBLEMS[c].short).join(', ');
        row.append(f);
      }

      // Accessible name for the row button: level, text, and any findings, as
      // one string so a screen-reader auditor hears the defect.
      const aria = [
        `Heading level ${item.level}`,
        name || (item.name ? `${item.name}, from its label` : 'no text'),
      ];
      for (const c of item.problems) {
        aria.push(`${PROBLEMS[c].tier === VIOLATION ? 'violation' : 'advisory'}: ${PROBLEMS[c].short}`);
      }
      if (item.fromAria) aria.push('level from aria-level');
      if (item.srOnly) aria.push('screen-reader only');
      row.setAttribute('aria-label', aria.join(', '));
      row.title = 'Scroll to this heading';

      row.__shoItem = item;
      row.addEventListener('click', () => goTo(item));
      li.append(row);
      panelList.append(li);
      rowIdx++;
    }
  }

  // Scroll a heading into view, crossing shadow boundaries (scrollIntoView on
  // the element itself works even when it's in a closed root), then pulse a
  // highlight over it.
  function goTo(item) {
    const el = item.el;
    if (!el || !el.isConnected) return;
    // Jump instead of glide when the OS asks for reduced motion.
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    } catch (_) {
      try {
        el.scrollIntoView();
      } catch (_) {
        /* ignore */
      }
    }
    flashEl = el;
    schedule();
    clearTimeout(flashTimer2);
    flashTimer2 = setTimeout(() => {
      flashEl = null;
      schedule();
    }, 1400);
  }
  let flashTimer2 = 0;

  function poolAt(pool, cls) {
    const el = document.createElement('div');
    el.className = cls;
    layer.appendChild(el);
    pool.push(el);
    return el;
  }

  // Rects here are {l, t, r, b} in viewport coordinates.
  function overlaps(a, b) {
    return !(a.r <= b.l || a.l >= b.r || a.b <= b.t || a.t >= b.b);
  }

  function draw() {
    rafPending = false;
    if (!on) return;

    const placed = [];
    let used = 0;

    // The layer is anchored at the document origin, but a positioned ancestor or
    // a body margin can offset where it actually landed, so measure it and take
    // that out. Everything below is in document coordinates — except inside an
    // open dialog, where the host is pinned to the viewport and the same
    // arithmetic yields viewport coordinates. draw() re-runs on scroll either way.
    const lr = layerHost.getBoundingClientRect();
    const originX = lr.left + scrollX;
    const originY = lr.top + scrollY;

    // Match the clip region to whichever space we're drawing in. Inside a dialog
    // the host is viewport-pinned and contributes nothing to document scroll, so
    // it only needs to cover the culling window.
    const clipW = modalHome ? innerWidth : document.documentElement.scrollWidth;
    const clipH = modalHome ? innerHeight : document.documentElement.scrollHeight;
    layer.style.width = `${clipW}px`;
    layer.style.height = `${clipH}px`;

    for (const item of items) {
      const el = item.el;
      if (!el.isConnected) continue;

      let r;
      try {
        if (!el.getClientRects().length) continue;
        r = el.getBoundingClientRect();
      } catch (_) {
        continue;
      }

      // Inflate the tight bounding box by BOX_PAD on every side, so the outline
      // frames the heading with a margin instead of hugging the text.
      const w = Math.max(r.width, MIN_BOX) + BOX_PAD * 2;
      const h = Math.max(r.height, MIN_BOX) + BOX_PAD * 2;
      // Document coordinates, so the box lives in the scrolled page and the
      // browser moves it with the content instead of us chasing it on scroll.
      const bx = Math.round(r.left + scrollX - originX) - BOX_PAD;
      const by = Math.round(r.top + scrollY - originY) - BOX_PAD;
      // Cull to the viewport plus a one-screen buffer on each side, so boxes are
      // already placed before they scroll in, without laying out a huge page.
      if (r.bottom < -innerHeight || r.top > innerHeight * 2) continue;
      if (r.right < -innerWidth || r.left > innerWidth * 2) continue;

      const color = COLORS[item.level] || OUT_OF_RANGE;
      const tier = worstTier(item);
      const box = boxes[used] || poolAt(boxes, 'box');
      box.style.setProperty('--c', color);
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
      box.style.transform = `translate(${bx}px, ${by}px)`;
      box.dataset.style = item.srOnly ? 'sr-only' : item.fromAria ? 'aria' : 'native';
      if (tier) box.dataset.flag = tier;
      else box.removeAttribute('data-flag');
      box.style.display = '';
      box.classList.toggle('clickable', altHeld);
      box.__shoItem = item;

      const tag = labels[used] || poolAt(labels, 'tag');
      tag.style.setProperty('--c', color);
      if (tier) tag.dataset.flag = tier;
      else tag.removeAttribute('data-flag');
      tag.textContent = labelFor(item);
      tag.style.display = '';

      // Collision avoidance. Without it, stacked headings produce overlapping
      // labels, which ruins the screenshot the tool exists to produce.
      const tw = tag.textContent.length * 7.3 + 12;
      const th = 18;
      // Anchor the label to the padded box, not the raw rect, so it rides just
      // above the outline.
      const homeX = Math.max(2, bx);
      let lx = homeX;
      let ly = by < 22 ? by + 1 : by - th;
      for (let attempt = 0; attempt < 24; attempt++) {
        const hit = placed.find((p) => overlaps({ l: lx, t: ly, r: lx + tw, b: ly + th }, p));
        if (!hit) break;
        if (attempt % 2 === 0) {
          lx = hit.r + 4;
        } else {
          lx = homeX;
          ly = hit.b + 2;
        }
      }
      // Keep the label inside the clip region. Sidestepping a collision can walk
      // it rightwards, and past the edge it would now be clipped away entirely
      // rather than merely overflowing.
      lx = Math.max(0, Math.min(lx, clipW - tw));
      placed.push({ l: lx, t: ly, r: lx + tw, b: ly + th });
      tag.style.transform = `translate(${lx}px, ${ly}px)`;

      used++;
    }

    for (let i = used; i < boxes.length; i++) boxes[i].style.display = 'none';
    for (let i = used; i < labels.length; i++) labels[i].style.display = 'none';

    drawFlash();

    if (chipText) chipText.textContent = countsLine();
    if (chipNote && !flashTimer) chipNote.textContent = defaultNote();
  }

  // The pulse drawn over a heading the user jumped to from the sidebar.
  let flashBox = null;
  function drawFlash() {
    if (!flashBox) {
      flashBox = document.createElement('div');
      flashBox.className = 'flash';
      layer.appendChild(flashBox);
    }
    if (!flashEl || !flashEl.isConnected) {
      flashBox.style.display = 'none';
      return;
    }
    let r;
    try {
      if (!flashEl.getClientRects().length) {
        flashBox.style.display = 'none';
        return;
      }
      r = flashEl.getBoundingClientRect();
    } catch (_) {
      flashBox.style.display = 'none';
      return;
    }
    // Sit just outside the padded outline so the pulse frames the heading too.
    // Document coordinates, same as the boxes, so it scrolls with the page.
    const lr = layerHost.getBoundingClientRect();
    const originX = lr.left + scrollX;
    const originY = lr.top + scrollY;
    const pad = BOX_PAD + 2;
    const w = Math.max(r.width, MIN_BOX) + pad * 2;
    const h = Math.max(r.height, MIN_BOX) + pad * 2;
    const fx = Math.round(r.left + scrollX - originX) - pad;
    const fy = Math.round(r.top + scrollY - originY) - pad;
    flashBox.style.width = `${w}px`;
    flashBox.style.height = `${h}px`;
    flashBox.style.transform = `translate(${fx}px, ${fy}px)`;
    flashBox.style.display = '';
  }

  function schedule() {
    if (rafPending || !on) return;
    rafPending = true;
    requestAnimationFrame(draw);
  }

  // ---------------------------------------------------------------- observing

  /**
   * Mutations the tool caused itself. Our three hosts are children of body, and
   * the observer watches `style` and `class`, so hiding the panel or dragging
   * its resize grip would otherwise schedule a full rescan of the page — and,
   * during a drag, starve the debounce below for as long as the drag lasts.
   */
  function selfInflicted(records) {
    for (const r of records) {
      if (r.target && r.target.nodeType === 1 && isOurs(r.target)) continue;
      if (r.type === 'childList') {
        const nodes = [...r.addedNodes, ...r.removedNodes];
        if (nodes.length && nodes.every((n) => n.nodeType === 1 && isOurs(n))) continue;
      }
      return false;
    }
    return true;
  }

  // MutationObserver doesn't cross shadow boundaries, so every root needs one.
  function observeAll() {
    disconnectAll();
    const { roots } = walker.walk({ skip: (el) => isOurs(el) });
    for (const entry of roots) {
      try {
        const mo = new MutationObserver((records) => {
          if (!selfInflicted(records)) rescanSoon();
        });
        mo.observe(entry.root, {
          childList: true,
          subtree: true,
          attributes: true,
          // `open` and `aria-modal` are here because a dialog usually exists in
          // the markup all along and only toggles an attribute to open, which
          // changes the scope of the whole outline.
          attributeFilter: [
            'role',
            'aria-level',
            'aria-hidden',
            'inert',
            'hidden',
            'open',
            'aria-modal',
            'class',
            'style',
          ],
        });
        observers.push(mo);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function disconnectAll() {
    for (const mo of observers) mo.disconnect();
    observers = [];
  }

  /**
   * Coalesce bursts of mutations, but never postpone indefinitely. A plain
   * resetting debounce is starved forever by anything that mutates faster than
   * the delay — a progress bar, a marquee, a scroll-driven style write — and the
   * outline silently stops updating while the page keeps changing.
   */
  function rescanSoon() {
    if (!on) return;
    const now = Date.now();
    if (!rescanDeadline) rescanDeadline = now + RESCAN_MAX_WAIT;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(rescan, Math.max(0, Math.min(RESCAN_DEBOUNCE, rescanDeadline - now)));
  }

  /**
   * True when two outlines are the same to the user. Used to skip re-rendering
   * the panel on the periodic safety scan, which would otherwise throw away
   * keyboard focus and the panel's scroll position every couple of seconds.
   */
  function sameOutline(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (
        a[i].el !== b[i].el ||
        a[i].level !== b[i].level ||
        a[i].srOnly !== b[i].srOnly ||
        a[i].empty !== b[i].empty ||
        a[i].problems.join() !== b[i].problems.join()
      ) {
        return false;
      }
    }
    return true;
  }

  function rescan() {
    rescanDeadline = 0;
    if (!on) return;
    const prev = items;
    const prevModal = modalEl;
    const prevPage = pageProblems.join();
    items = collect();
    // observeAll() every time: it is what picks up shadow roots that have
    // appeared since the last scan.
    observeAll();
    syncModalHome();
    if (!sameOutline(prev, items) || prevModal !== modalEl || prevPage !== pageProblems.join()) {
      renderPanel();
    }
    schedule();
  }

  // ----------------------------------------------------------------- controls

  function setMode(mode) {
    if (!LABEL_MODES.includes(mode)) return;
    labelMode = mode;
    saveMode();
    updateDetailControl();
    renderPanel();
    schedule();
  }

  function cycleMode() {
    setMode(LABEL_MODES[(LABEL_MODES.indexOf(labelMode) + 1) % LABEL_MODES.length]);
  }

  function onKeyDown(e) {
    if (!on) return;
    if (e.key === 'Alt' || e.altKey) setAlt(true);
    if (e.key === 'Escape') {
      // While a native dialog is open, Esc belongs to the dialog: the browser
      // closes it, and swallowing that into "hide the panel" would dismiss our
      // UI on a keystroke the user aimed at the page. A second Esc, once the
      // dialog is gone, does the normal thing.
      if (isNativeModal(modalEl)) return;
      // Progressive dismiss: first Esc hides the panel (boxes stay), so a user
      // who tabbed into the panel doesn't lose everything. A second Esc, or Esc
      // with the panel already hidden, closes the whole tool.
      if (isTopFrame() && panelHost && !panelHidden) setPanelHidden(true);
      else off();
      return;
    }
    if (e.altKey && e.shiftKey) {
      const k = (e.key || '').toLowerCase();
      if (k === 'm') {
        e.preventDefault();
        cycleMode();
      } else if (k === 'c') {
        e.preventDefault();
        copy(outlineText());
      } else if (k === 'p') {
        e.preventDefault();
        togglePanel();
      }
    }
  }

  function onKeyUp(e) {
    if (e.key === 'Alt' || !e.altKey) setAlt(false);
  }

  function setAlt(v) {
    if (altHeld === v) return;
    altHeld = v;
    for (const b of boxes) b.classList.toggle('clickable', v);
  }

  function onLayerClick(e) {
    const box = e.target && e.target.closest ? e.target.closest('.box') : null;
    if (!box || !box.__shoItem) return;
    e.preventDefault();
    e.stopPropagation();
    copy(record(box.__shoItem));
  }

  // ---------------------------------------------------------------- lifecycle

  function onWindowBlur() {
    setAlt(false);
  }

  function start() {
    on = true;
    if (!layerHost) buildLayer();
    if (!chipHost) buildChip();
    if (!layerHost.isConnected) mount(layerHost);
    if (!chipHost.isConnected) mount(chipHost);

    // The overlay boxes are drawn in every frame, so each iframe outlines its
    // own headings in its own coordinate space. The outline PANEL is top-frame
    // only, since a full-height sidebar inside every iframe would be silly and
    // cross-origin frames can't share JS to aggregate anyway. Sub-frame headings
    // get boxed in place but aren't listed in the top panel. (renderPanel is a
    // no-op without the panel.)
    if (isTopFrame()) {
      if (!panelHost) buildPanel();
      if (!panelHost.isConnected) mount(panelHost);
    }

    // Restore the panel through setPanelHidden rather than just resetting the
    // flag. off() leaves the inline display:none behind, so a tool that was
    // closed with the panel hidden would come back believing the panel is shown
    // while it is still invisible and the chip button still says "Show panel" —
    // and the first click would then toggle it back to hidden, doing nothing.
    setPanelHidden(false, { focus: false });

    items = collect();
    observeAll();
    syncModalHome();
    renderPanel();

    addEventListener('scroll', schedule, true);
    addEventListener('resize', schedule, true);
    addEventListener('keydown', onKeyDown, true);
    addEventListener('keyup', onKeyUp, true);
    addEventListener('blur', onWindowBlur);
    layer.addEventListener('click', onLayerClick, true);

    clearInterval(safetyTimer);
    safetyTimer = setInterval(rescan, SAFETY_SCAN);

    loadMode();
    schedule();
  }

  function off() {
    on = false;
    altHeld = false;
    flashEl = null;
    clearTimeout(rescanTimer);
    clearTimeout(flashTimer);
    clearTimeout(flashTimer2);
    clearInterval(safetyTimer);
    safetyTimer = 0;
    rescanDeadline = 0;
    flashTimer = 0;
    disconnectAll();
    removeEventListener('scroll', schedule, true);
    removeEventListener('resize', schedule, true);
    removeEventListener('keydown', onKeyDown, true);
    removeEventListener('keyup', onKeyUp, true);
    removeEventListener('blur', onWindowBlur);
    items = [];
    modalEl = null;
    // Move back out of any dialog before unmounting, so the next toggle starts
    // from the body rather than from a dialog that may since have closed.
    syncModalHome();
    if (layerHost && layerHost.isConnected) layerHost.remove();
    if (chipHost && chipHost.isConnected) chipHost.remove();
    if (panelHost && panelHost.isConnected) panelHost.remove();
  }

  window[KEY] = {
    toggle() {
      if (on) off();
      else start();
    },
    // The toolbar drives every frame to the same state through this, so that a
    // frame which appeared mid-session can't stay inverted relative to the rest.
    set(v) {
      if (v && !on) start();
      else if (!v && on) off();
    },
    get on() {
      return on;
    },
    get stats() {
      return { ...stats };
    },
    // The hosts relocate into an open dialog (see syncModalHome), where
    // document.getElementById can't reach them — the dialog is usually inside a
    // shadow root. Anything driving the tool from outside needs them by
    // reference rather than by id.
    get hosts() {
      return { layer: layerHost, chip: chipHost, panel: panelHost };
    },
    outlineText,
  };

  start();
})();
