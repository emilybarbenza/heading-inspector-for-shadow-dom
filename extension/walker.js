/**
 * shadow-walker
 *
 * Composed-tree traversal that descends into shadow roots of any depth,
 * including closed roots where the host environment allows it.
 *
 * This file has no heading logic in it, so it can be lifted out as a standalone
 * package. It defines one global and nothing else.
 *
 * Capability by environment:
 *   Chrome/Edge extension  chrome.dom.openOrClosedShadowRoot   open + closed
 *   Firefox extension      Element.openOrClosedShadowRoot      open + closed
 *   Safari extension       none                                open only
 *   Bookmarklet / page     Element.shadowRoot                  open only
 */
(() => {
  const KEY = '__shadowWalker';
  if (window[KEY]) return;

  const hasChromeDom =
    typeof chrome !== 'undefined' &&
    chrome.dom &&
    typeof chrome.dom.openOrClosedShadowRoot === 'function';

  let hasGeckoProp = false;
  try {
    hasGeckoProp = 'openOrClosedShadowRoot' in Element.prototype;
  } catch (_) {
    hasGeckoProp = false;
  }

  const canPierceClosed = hasChromeDom || hasGeckoProp;

  /**
   * @param {Element} el
   * @returns {ShadowRoot|null}
   */
  function shadowRootOf(el) {
    if (hasChromeDom) {
      // Some versions throw instead of returning null for non-hosts.
      try {
        const r = chrome.dom.openOrClosedShadowRoot(el);
        if (r) return r;
      } catch (_) {
        /* not a host */
      }
    }
    if (hasGeckoProp) {
      try {
        const r = el.openOrClosedShadowRoot;
        if (r) return r;
      } catch (_) {
        /* not a host */
      }
    }
    try {
      return el.shadowRoot || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Walks up the composed tree, crossing shadow boundaries via ShadowRoot.host.
   * Element.closest() can't do this.
   *
   * @param {Node} node
   * @param {(el: Element) => boolean} predicate
   * @returns {Element|null} the matching ancestor, or null
   */
  function closestComposed(node, predicate) {
    let n = node;
    while (n) {
      if (n.nodeType === 1 && predicate(/** @type {Element} */ (n))) return n;
      n = n.parentNode || n.host || null;
    }
    return null;
  }

  /**
   * Resolves the text a user would actually see, expanding <slot> elements to
   * their assigned nodes. Plain textContent returns '' for slotted content.
   *
   * @param {Node} node
   * @param {number} depth
   * @returns {string}
   */
  function composedText(node, depth = 0) {
    if (depth > 12) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';

    const el = /** @type {Element} */ (node);
    if (el.localName === 'slot' && typeof el.assignedNodes === 'function') {
      const assigned = el.assignedNodes({ flatten: true });
      if (assigned.length) {
        return assigned.map((n) => composedText(n, depth + 1)).join('');
      }
    }
    let out = '';
    for (const child of el.childNodes) out += composedText(child, depth + 1);
    return out;
  }

  /**
   * Depth-first over the composed tree. Matches come back in composed
   * pre-order: visit a host, then its shadow content, then its light children.
   * The hierarchy checks (skipped levels, first heading) and the outline both
   * depend on document order, so this is ordered instead of using the cheaper
   * LIFO stack.
   *
   * Slotted light children show up at their light-DOM position, not their
   * flattened slot position. That's a known limitation. Full flattened-tree
   * ordering would need slot assignment resolved per root.
   *
   * @param {object} [options]
   * @param {Document|ShadowRoot} [options.root]      where to start
   * @param {(el: Element) => boolean} [options.match] collect these elements
   * @param {(el: Element) => boolean} [options.skip]  ignore these elements and
   *                                                   do not descend into them
   * @param {number} [options.max]                     cap on collected matches
   * @returns {{
   *   matches: Array<{element: Element, hosts: Element[], closed: boolean}>,
   *   roots: Array<{root: Document|ShadowRoot, hosts: Element[], closed: boolean}>,
   *   truncated: boolean
   * }}
   */
  function walk(options = {}) {
    const root = options.root || document;
    const match = options.match || (() => false);
    const skip = options.skip || (() => false);
    const max = typeof options.max === 'number' ? options.max : Infinity;

    const matches = [];
    const roots = [];
    const seen = new Set();
    let truncated = false;

    function visitRoot(node, hosts, closed) {
      if (!node || seen.has(node)) return;
      seen.add(node);
      roots.push({ root: node, hosts, closed });
      for (const el of node.children || []) visitElement(el, hosts, closed);
    }

    function visitElement(el, hosts, closed) {
      if (skip(el)) return;

      if (match(el)) {
        if (matches.length >= max) truncated = true;
        else matches.push({ element: el, hosts, closed });
      }

      const sub = shadowRootOf(el);
      if (sub) {
        visitRoot(sub, hosts.concat(el), closed || sub.mode === 'closed');
      }
      for (const child of el.children) visitElement(child, hosts, closed);
    }

    visitRoot(root, [], false);
    return { matches, roots, truncated };
  }

  window[KEY] = { walk, shadowRootOf, closestComposed, composedText, canPierceClosed };
})();
