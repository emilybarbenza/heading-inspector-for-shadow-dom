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
    console.error('Headings Bookmarklet for Shadow DOM: walker.js did not load.');
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

  // Two tiers, keyed to WCAG. A violation is something an automated checker
  // (like axe) reports as a failure. An advisory is a best-practice finding
  // that isn't strictly a Success Criterion failure. They're kept apart since
  // an auditor files the first as a defect and the second as a note.
  const VIOLATION = 'violation';
  const ADVISORY = 'advisory';
  const PROBLEMS = {
    empty: {
      tier: VIOLATION,
      short: 'empty',
      sc: '1.3.1, 2.4.6',
      desc: 'Heading has no perceivable text (WCAG 1.3.1 Info & Relationships, 2.4.6 Headings & Labels).',
    },
    skipped: {
      tier: ADVISORY,
      short: 'skipped level',
      sc: '1.3.1',
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
      desc: 'Page has no level-1 heading (advisory; relates to WCAG 1.3.1 and 2.4.10 Section Headings).',
    },
    'first-not-h1': {
      tier: ADVISORY,
      short: 'starts below h1',
      sc: '1.3.1',
      desc: 'The first heading in reading order is deeper than level 1 (advisory).',
    },
  };

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
  let quiet = false;
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
  let panelCollapsed = false;
  let panelHidden = false;
  let items = [];
  let pageProblems = [];
  let stats = emptyStats();
  const boxes = [];
  const labels = [];
  let rafPending = false;
  let rescanTimer = 0;
  let observers = [];
  let altHeld = false;
  let flashEl = null;

  function emptyStats() {
    return {
      total: 0,
      hidden: 0,
      notRendered: 0,
      offscreen: 0,
      ariaHidden: 0,
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

  function headingInfo(el) {
    const native = /^h([1-6])$/.exec(el.localName || '');
    const roleAttr = (el.getAttribute('role') || '').trim().toLowerCase();
    const roles = roleAttr ? roleAttr.split(/\s+/) : [];
    const isRoleHeading = roles.includes('heading');

    // An explicit non-heading role beats the native tag.
    if (native && roles.length && !isRoleHeading) return null;
    if (!native && !isRoleHeading) return null;

    const raw = el.getAttribute('aria-level');
    const parsed = raw === null ? NaN : parseInt(raw, 10);
    const hasAria = Number.isInteger(parsed) && parsed > 0;

    if (native) {
      const tagLevel = Number(native[1]);
      return { level: hasAria ? parsed : tagLevel, fromAria: hasAria && parsed !== tagLevel };
    }
    // role="heading" with no aria-level computes to level 2.
    return { level: hasAria ? parsed : 2, fromAria: true };
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
   * @returns {'rendered'|'hidden'|'not-rendered'|'offscreen'}
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
    if (r.width <= 4 || r.height <= 4) return 'hidden';

    // Absolute document coordinates, so we can tell an sr-only heading parked at
    // left:-9999px from an ordinary heading below the fold.
    const docLeft = r.left + scrollX;
    const docTop = r.top + scrollY;
    const docW = document.documentElement.scrollWidth;
    if (docLeft + r.width < 0 || docTop + r.height < 0 || docLeft > docW) return 'offscreen';

    return 'rendered';
  }

  /**
   * The accessible name, close enough to tell a genuinely empty heading from one
   * named by aria-label/labelledby/title or a captioned image. Without this,
   * icon-only and aria-labelled headings would falsely flag as empty-heading
   * violations.
   */
  function accName(el) {
    const label = (el.getAttribute('aria-label') || '').trim();
    if (label) return label;

    const ref = el.getAttribute('aria-labelledby');
    if (ref) {
      const root = el.getRootNode();
      for (const id of ref.split(/\s+/)) {
        const t = root && root.getElementById ? root.getElementById(id) : null;
        if (t) {
          const txt = walker.composedText(t).replace(/\s+/g, ' ').trim();
          if (txt) return txt;
        }
      }
    }

    const text = walker.composedText(el).replace(/\s+/g, ' ').trim();
    if (text) return text;

    // An image with alt text gives the heading a name even with no text node.
    let imgAlt = '';
    try {
      for (const img of el.querySelectorAll('img[alt], [role="img"][aria-label]')) {
        imgAlt += (img.getAttribute('alt') || img.getAttribute('aria-label') || '').trim();
      }
    } catch (_) {
      /* ignore */
    }
    if (imgAlt.trim()) return imgAlt.trim();

    return (el.getAttribute('title') || '').trim();
  }

  function collect() {
    stats = emptyStats();

    const { matches, truncated } = walker.walk({
      match: (el) => !isOurs(el) && !!headingInfo(el),
      skip: (el) => isOurs(el),
      max: MAX_HEADINGS,
    });
    stats.truncated = truncated;

    // Two sequences in reading order. `seq` is every heading in the
    // accessibility tree, used for the hierarchy checks. `out` is the subset
    // that has drawable on-page geometry. display:none and aria-hidden/inert
    // headings are in neither, but they're counted for the chip so a gap in a
    // screenshot doesn't get read as a tool bug.
    const seq = [];
    const out = [];

    for (const m of matches) {
      const info = headingInfo(m.element);
      stats.total++;

      const hiddenAncestor = walker.closestComposed(
        m.element,
        (el) => el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')
      );
      if (hiddenAncestor) {
        stats.ariaHidden++;
        continue;
      }

      const vis = visibility(m.element);
      if (vis === 'not-rendered') {
        stats.notRendered++;
        continue;
      }

      const item = {
        el: m.element,
        level: info.level,
        fromAria: info.fromAria,
        hidden: vis === 'hidden',
        offscreen: vis === 'offscreen',
        empty: accName(m.element) === '',
        hosts: m.hosts,
        closed: m.closed,
        problems: [],
      };
      seq.push(item);

      if (vis === 'offscreen') {
        stats.offscreen++;
        continue;
      }
      if (vis === 'hidden') stats.hidden++;
      out.push(item);
    }

    validate(seq);
    for (const item of seq) {
      for (const code of item.problems) {
        if (PROBLEMS[code].tier === VIOLATION) stats.violations++;
        else stats.advisories++;
      }
    }
    return out;
  }

  /**
   * Runs the hierarchy checks over the reading-order sequence, tagging each
   * item's `problems` and recording page-level findings in `pageProblems`.
   */
  function validate(seq) {
    pageProblems = [];
    let h1s = 0;
    let prevLevel = 0;

    for (const item of seq) {
      if (item.empty) item.problems.push('empty');
      if (item.level === 1) h1s++;

      if (prevLevel === 0) {
        if (item.level > 1) item.problems.push('first-not-h1');
      } else if (item.level > prevLevel + 1) {
        item.problems.push('skipped');
      }
      prevLevel = item.level;
    }

    if (seq.length) {
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
    if (!/^h[1-6]$/.test(s) && (el.getAttribute('role') || '').includes('heading')) {
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
    if (item.hidden) text += ' \u00b7hidden';
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
    if (item.hidden) flags.push('visually hidden');
    if (item.offscreen) flags.push('off-screen');
    const lines = [
      `H${item.level}${flags.length ? ` (${flags.join(', ')})` : ''}`,
      walker.composedText(item.el).replace(/\s+/g, ' ').trim().slice(0, 120),
      chainString(item),
      consoleExpression(item),
    ];
    for (const code of item.problems) {
      const p = PROBLEMS[code];
      lines.push(`${p.tier === VIOLATION ? 'VIOLATION' : 'ADVISORY'} [WCAG ${p.sc}]: ${p.desc}`);
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
    if (!walker.canPierceClosed) {
      lines.push('WARNING: closed shadow roots were not traversed in this environment.');
    }
    for (const code of pageProblems) {
      const p = PROBLEMS[code];
      lines.push(`ADVISORY [WCAG ${p.sc}]: ${p.desc}`);
    }
    lines.push('');
    for (const item of items) {
      const indent = '  '.repeat(Math.max(0, Math.min(item.level, 12) - 1));
      const flags = [];
      if (item.fromAria) flags.push('aria-level');
      if (item.hidden) flags.push('hidden');
      for (const code of item.problems) {
        flags.push(`${PROBLEMS[code].tier === VIOLATION ? '✕' : '⚠'} ${PROBLEMS[code].short}`);
      }
      const text = walker.composedText(item.el).replace(/\s+/g, ' ').trim().slice(0, 80);
      lines.push(
        `${indent}H${item.level}  ${text || '(no text)'}${flags.length ? `  [${flags.join(', ')}]` : ''}`
      );
    }
    return lines.join('\n');
  }

  function countsLine() {
    const parts = [`${stats.total} heading${stats.total === 1 ? '' : 's'}`];
    if (stats.violations) parts.push(`\u2715 ${stats.violations} violation${stats.violations === 1 ? '' : 's'}`);
    const adv = stats.advisories + pageProblems.length;
    if (adv) parts.push(`\u26a0 ${adv} advisor${adv === 1 ? 'y' : 'ies'}`);
    if (stats.hidden) parts.push(`${stats.hidden} hidden`);
    if (stats.notRendered) parts.push(`${stats.notRendered} display:none`);
    if (stats.offscreen) parts.push(`${stats.offscreen} off-screen`);
    if (stats.ariaHidden) parts.push(`${stats.ariaHidden} in aria-hidden`);
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
    if (!chipNote) return;
    chipNote.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = 0;
      if (chipNote) chipNote.textContent = defaultNote();
    }, 1800);
  }

  function defaultNote() {
    const mode = labelMode === 'level' ? 'level' : labelMode === 'component' ? 'component' : 'chain';
    const degraded = walker.canPierceClosed ? '' : ' \u00b7 open roots only';
    return `${mode}${degraded} \u00b7 alt+click a box to copy \u00b7 esc to close`;
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
      .layer { position: absolute; top: 0; left: 0; }
      .box, .tag {
        position: absolute;
        top: 0;
        left: 0;
        box-sizing: border-box;
        forced-color-adjust: none;
        will-change: transform;
      }
      /* The 1px white ring keeps the outline legible on dark pages, which is
         what makes a defect screenshot usable. */
      .box {
        border: 2px solid var(--c);
        border-radius: 2px;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.95),
                    inset 0 0 0 1px rgba(255,255,255,0.95);
      }
      .box[data-style="aria"]   { border-style: dashed; }
      .box[data-style="hidden"] { border-style: dotted; }
      /* A flagged heading keeps its level color (still the load-bearing
         encoding) and gets a second ring: solid amber for an advisory, a
         heavier double red for a violation. It's redundant with the label's
         ⚠/✕, so a grayscale or CVD screenshot still reads. */
      .box[data-flag="advisory"] {
        box-shadow: 0 0 0 1px rgba(255,255,255,0.95),
                    0 0 0 4px #b8860b,
                    inset 0 0 0 1px rgba(255,255,255,0.95);
      }
      .box[data-flag="violation"] {
        box-shadow: 0 0 0 1px rgba(255,255,255,0.95),
                    0 0 0 4px #c1121f,
                    0 0 0 6px rgba(255,255,255,0.95),
                    inset 0 0 0 1px rgba(255,255,255,0.95);
      }
      .tag[data-flag="advisory"]  { box-shadow: 0 0 0 1px rgba(255,255,255,0.95), 0 0 0 3px #b8860b; }
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
        border: 3px solid #0b5fbe; border-radius: 3px;
        background: rgba(11,95,190,0.18);
        box-shadow: 0 0 0 2px rgba(255,255,255,0.95), 0 0 14px 3px rgba(11,95,190,0.7);
        animation: shoPulse 1.4s ease-out 1;
        forced-color-adjust: none;
      }
      @keyframes shoPulse {
        0% { opacity: 0; }
        12% { opacity: 1; }
        100% { opacity: 0.55; }
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
        gap: 10px;
        max-width: min(92vw, 720px);
        padding: 7px 10px;
        background: #10161c;
        color: #fff;
        border: 1px solid #fff;
        border-radius: 4px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.45);
        font: 400 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        forced-color-adjust: none;
      }
      .counts { font-weight: 700; white-space: nowrap; }
      .note { color: #b8c4cf; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .actions { display: flex; gap: 6px; margin-left: auto; }
      button {
        font: inherit;
        color: #10161c;
        background: #fff;
        border: 1px solid #fff;
        border-radius: 3px;
        padding: 2px 7px;
        cursor: pointer;
        forced-color-adjust: none;
      }
      button:hover { background: #dbe4ec; }
    `;

    const chip = document.createElement('div');
    chip.className = 'chip';

    chipText = document.createElement('span');
    chipText.className = 'counts';

    chipNote = document.createElement('span');
    chipNote.className = 'note';

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(button('mode', 'alt+shift+m', cycleMode));
    // The panel only exists in the top frame, so only offer its toggle there.
    // The chip stays visible when the panel is hidden, so it's the way back.
    if (isTopFrame()) {
      chipPanelBtn = button(panelHidden ? 'show panel' : 'hide panel', 'alt+shift+p', togglePanel);
      actions.append(chipPanelBtn);
    }
    actions.append(
      button('copy outline', 'alt+shift+c', () => copy(outlineText())),
      button('close', 'esc', off)
    );

    chip.append(chipText, chipNote, actions);
    shadow.append(style, chip);
    mount(chipHost);
  }

  function button(label, hint, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = `${label} (${hint})`;
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
  // landmark to the page under test. The Quiet toggle (Alt+Shift+Q) makes the
  // whole tool inert + aria-hidden on demand, so the page's own tab order and
  // accessibility tree can be tested clean.
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
        --rowhover: #eef2f6; --panelw: 340px;
      }
      @media (prefers-color-scheme: dark) {
        :host {
          --bg: #10161c; --fg: #eef2f6; --muted: #9aa7b3; --line: #2a343d;
          --rowhover: #1b2530;
        }
      }
      * { box-sizing: border-box; }
      .panel {
        display: flex; flex-direction: column;
        width: var(--panelw); height: 100%;
        background: var(--bg); color: var(--fg);
        border-left: 1px solid var(--line);
        box-shadow: -2px 0 14px rgba(0,0,0,0.28);
        font: 400 13px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
        forced-color-adjust: none;
      }
      :host(.collapsed) .panel { width: auto; }
      :host(.collapsed) .body { display: none; }
      .grip {
        position: absolute; left: -3px; top: 0; width: 6px; height: 100%;
        cursor: ew-resize; touch-action: none;
      }
      :host(.collapsed) .grip { display: none; }
      header {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border-bottom: 1px solid var(--line);
      }
      .title { font-weight: 700; font-size: 12px; letter-spacing: .02em; white-space: nowrap; }
      .spacer { margin-left: auto; }
      .iconbtn {
        font: inherit; font-size: 12px; color: var(--fg);
        background: transparent; border: 1px solid var(--line);
        border-radius: 4px; padding: 3px 7px; cursor: pointer;
      }
      .iconbtn:hover { background: var(--rowhover); }
      .iconbtn[aria-pressed="true"] { background: #c1121f; color: #fff; border-color: #c1121f; }
      .controls { padding: 8px 10px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
      .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
      .seg button {
        font: inherit; font-size: 12px; color: var(--fg); background: transparent;
        border: 0; border-right: 1px solid var(--line); padding: 4px 8px; cursor: pointer;
      }
      .seg button:last-child { border-right: 0; }
      .seg button[aria-pressed="true"] { background: #0b5fbe; color: #fff; }
      .summary { font-size: 12px; color: var(--muted); }
      .summary .v { color: #c1121f; font-weight: 700; }
      .summary .a { color: #b8860b; font-weight: 700; }
      .body { overflow: auto; flex: 1 1 auto; }
      ul { list-style: none; margin: 0; padding: 4px 0; }
      .row {
        display: flex; align-items: baseline; gap: 8px; width: 100%;
        text-align: left; font: inherit; color: var(--fg);
        background: transparent; border: 0; border-left: 3px solid transparent;
        padding: 4px 10px 4px 0; cursor: pointer;
      }
      .row:hover { background: var(--rowhover); }
      .row:focus-visible { outline: 2px solid #0b5fbe; outline-offset: -2px; }
      .row[data-flag="advisory"] { border-left-color: #b8860b; }
      .row[data-flag="violation"] { border-left-color: #c1121f; }
      .lvl {
        flex: none; min-width: 26px; text-align: center;
        color: #fff; border-radius: 3px; font: 700 11px/1.5 ui-monospace, Menlo, monospace;
        padding: 0 4px;
      }
      .txt { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .txt.empty { color: var(--muted); font-style: italic; }
      .more { flex: none; color: var(--muted); font: 400 11px/1.5 ui-monospace, Menlo, monospace; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rowflags { flex: none; font-size: 11px; font-weight: 700; white-space: nowrap; }
      .rowflags.violation { color: #ff6b74; }
      .rowflags.advisory { color: #e0a83a; }
      .empty-list { padding: 16px 12px; color: var(--muted); }
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
    grip.addEventListener('pointerdown', startResize);

    // Header: title, collapse, close.
    const head = document.createElement('header');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = 'Heading outline';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const collapseBtn = iconButton('Collapse', () => setCollapsed(!panelCollapsed));
    collapseBtn.dataset.role = 'collapse';
    const closeBtn = iconButton('Close', off);
    head.append(title, spacer, collapseBtn, closeBtn);

    // Controls: detail segmented control + quiet toggle.
    const controls = document.createElement('div');
    controls.className = 'controls';

    const seg = document.createElement('div');
    seg.className = 'seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Row detail');
    for (const d of DETAILS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.label;
      b.dataset.mode = d.mode;
      b.addEventListener('click', () => setMode(d.mode));
      seg.append(b);
    }

    const quietBtn = iconButton('Quiet (test page a11y)', () => setQuiet(!quiet));
    quietBtn.dataset.role = 'quiet';
    quietBtn.setAttribute('aria-pressed', 'false');
    quietBtn.title = 'Make the tool inert + aria-hidden so the page’s own tab order and screen-reader output can be tested (Alt+Shift+Q)';

    const copyBtn = iconButton('Copy outline', () => copy(outlineText()));

    const controlRow = document.createElement('div');
    controlRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    controlRow.append(seg, quietBtn, copyBtn);

    panelSummary = document.createElement('div');
    panelSummary.className = 'summary';
    panelSummary.setAttribute('role', 'status');
    panelSummary.setAttribute('aria-live', 'polite');

    controls.append(controlRow, panelSummary);

    const body = document.createElement('div');
    body.className = 'body';
    panelList = document.createElement('ul');
    body.append(panelList);

    panel.append(grip, head, controls, body);
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

  function setCollapsed(v) {
    panelCollapsed = v;
    if (!panelHost) return;
    panelHost.classList.toggle('collapsed', v);
    const btn = panelHost.shadowRoot.querySelector('[data-role="collapse"]');
    if (btn) btn.textContent = v ? 'Expand' : 'Collapse';
  }

  function togglePanel() {
    setPanelHidden(!panelHidden);
  }

  // Hide the sidebar entirely while leaving the boxes and chip in place. Unlike
  // Collapse, which leaves a tab, this removes the panel from view completely.
  // The chip's button and Alt+Shift+P bring it back.
  function setPanelHidden(v) {
    panelHidden = v;
    if (panelHost) panelHost.style.display = v ? 'none' : '';
    if (chipPanelBtn) {
      chipPanelBtn.textContent = v ? 'show panel' : 'hide panel';
      chipPanelBtn.title = `${v ? 'show panel' : 'hide panel'} (alt+shift+p)`;
    }
  }

  // Resizing the panel by dragging its inner edge. Width lives on the host var.
  let resizeStartX = 0;
  let resizeStartW = 0;
  function startResize(e) {
    if (!panelHost) return;
    e.preventDefault();
    resizeStartX = e.clientX;
    resizeStartW = parseInt(getComputedStyle(panelHost).getPropertyValue('--panelw'), 10) || 340;
    const move = (ev) => {
      const w = Math.min(720, Math.max(240, resizeStartW + (resizeStartX - ev.clientX)));
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
      b.setAttribute('aria-pressed', b.dataset.mode === labelMode ? 'true' : 'false');
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

    // Summary line: violations, advisories, page-level findings.
    const bits = [`${stats.total} heading${stats.total === 1 ? '' : 's'}`];
    if (stats.violations) bits.push(`<span class="v">✕ ${stats.violations}</span>`);
    const adv = stats.advisories + pageProblems.length;
    if (adv) bits.push(`<span class="a">⚠ ${adv}</span>`);
    if (!walker.canPierceClosed) bits.push('open roots only');
    let summaryHTML = bits.join(' · ');
    for (const code of pageProblems) {
      summaryHTML += `<br><span class="a">⚠</span> ${PROBLEMS[code].short}: ${PROBLEMS[code].desc}`;
    }
    panelSummary.innerHTML = summaryHTML;

    if (!items.length) {
      const li = document.createElement('li');
      const div = document.createElement('div');
      div.className = 'empty-list';
      div.textContent = 'No headings found on this page.';
      li.append(div);
      panelList.append(li);
      return;
    }

    for (const item of items) {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row';
      const tier = worstTier(item);
      if (tier) row.dataset.flag = tier;
      row.style.paddingLeft = `${8 + (Math.min(item.level, 6) - 1) * 14}px`;

      const lvl = document.createElement('span');
      lvl.className = 'lvl';
      lvl.style.background = COLORS[item.level] || OUT_OF_RANGE;
      lvl.textContent = `H${item.level}`;

      const txt = document.createElement('span');
      txt.className = 'txt';
      const name = walker.composedText(item.el).replace(/\s+/g, ' ').trim();
      if (name) {
        txt.textContent = name;
      } else {
        txt.classList.add('empty');
        txt.textContent = '(no text)';
      }

      row.append(lvl, txt);

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
      const aria = [`Heading level ${item.level}`, name || 'no text'];
      for (const c of item.problems) {
        aria.push(`${PROBLEMS[c].tier === VIOLATION ? 'violation' : 'advisory'}: ${PROBLEMS[c].short}`);
      }
      if (item.fromAria) aria.push('level from aria-level');
      row.setAttribute('aria-label', aria.join(', '));

      row.__shoItem = item;
      row.addEventListener('click', () => goTo(item));
      li.append(row);
      panelList.append(li);
    }
  }

  // Scroll a heading into view, crossing shadow boundaries (scrollIntoView on
  // the element itself works even when it's in a closed root), then pulse a
  // highlight over it.
  function goTo(item) {
    if (quiet) setQuiet(false);
    const el = item.el;
    if (!el || !el.isConnected) return;
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
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

  function setQuiet(v) {
    quiet = v;
    for (const host of [layerHost, chipHost, panelHost]) {
      if (!host) continue;
      if (v) {
        host.setAttribute('inert', '');
        host.setAttribute('aria-hidden', 'true');
        host.style.setProperty('opacity', '0.35', 'important');
      } else {
        host.removeAttribute('inert');
        host.style.removeProperty('opacity');
        // The layer and chip are always aria-hidden by design, so only the
        // panel goes back to being exposed.
        if (host === panelHost) host.removeAttribute('aria-hidden');
      }
    }
    if (panelHost) {
      const btn = panelHost.shadowRoot.querySelector('[data-role="quiet"]');
      if (btn) btn.setAttribute('aria-pressed', v ? 'true' : 'false');
    }
    if (!v) flash('Tool re-enabled');
  }

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
    // that out. Everything below is in document coordinates.
    const lr = layerHost.getBoundingClientRect();
    const originX = lr.left + scrollX;
    const originY = lr.top + scrollY;

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
      box.dataset.style = item.hidden ? 'hidden' : item.fromAria ? 'aria' : 'native';
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

  // MutationObserver doesn't cross shadow boundaries, so every root needs one.
  function observeAll() {
    disconnectAll();
    const { roots } = walker.walk({ skip: (el) => isOurs(el) });
    for (const entry of roots) {
      try {
        const mo = new MutationObserver(rescanSoon);
        mo.observe(entry.root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['role', 'aria-level', 'aria-hidden', 'inert', 'hidden', 'class', 'style'],
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

  function rescanSoon() {
    if (!on) return;
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      if (!on) return;
      items = collect();
      observeAll();
      renderPanel();
      schedule();
    }, 250);
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
      off();
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
      } else if (k === 'q') {
        e.preventDefault();
        setQuiet(!quiet);
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

  function start() {
    on = true;
    quiet = false;
    panelHidden = false;
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

    items = collect();
    observeAll();
    renderPanel();

    addEventListener('scroll', schedule, true);
    addEventListener('resize', schedule, true);
    addEventListener('keydown', onKeyDown, true);
    addEventListener('keyup', onKeyUp, true);
    addEventListener('blur', () => setAlt(false));
    layer.addEventListener('click', onLayerClick, true);

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
    flashTimer = 0;
    disconnectAll();
    removeEventListener('scroll', schedule, true);
    removeEventListener('resize', schedule, true);
    removeEventListener('keydown', onKeyDown, true);
    removeEventListener('keyup', onKeyUp, true);
    items = [];
    if (layerHost && layerHost.isConnected) layerHost.remove();
    if (chipHost && chipHost.isConnected) chipHost.remove();
    if (panelHost && panelHost.isConnected) panelHost.remove();
  }

  window[KEY] = {
    toggle() {
      if (on) off();
      else start();
    },
    get on() {
      return on;
    },
    get stats() {
      return { ...stats };
    },
    outlineText,
  };

  start();
})();
