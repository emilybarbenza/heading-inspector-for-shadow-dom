/**
 * Toolbar click handling.
 *
 * The obvious implementation is "re-injecting is the toggle": overlay.js guards
 * on a window key and flips state when it sees itself already installed. That
 * works until the frame set changes. Each frame owns its own copy of that key,
 * so a frame created after the first click starts from the off state and stays
 * permanently inverted relative to the rest — click again and the panel vanishes
 * while boxes stay painted inside a lazily-loaded iframe, with no way to clear
 * them but a reload. Lazy iframes (chat widgets, consent frames, ad refreshes,
 * infinite scroll) make that a routine occurrence rather than an edge case.
 *
 * So the desired state is decided here and pushed to every frame explicitly.
 * Injection still toggles — the bookmarklet depends on that idiom — but the
 * follow-up call settles every frame on the same answer regardless of when it
 * appeared or how many times it has been injected.
 *
 * Frame coverage is a separate matter: activeTab grants host access for the
 * tab's own origin only, so `allFrames` reaches same-origin frames and silently
 * skips cross-origin ones. Per-frame denials don't reject, so there is nothing
 * to catch. The overlay reports the shortfall in the page itself, where the
 * person reading the outline will see it.
 */

const INJECTABLE = /^(https?|file):/;

// chrome.storage.session survives the service worker being torn down, which an
// in-memory Map would not: MV3 kills idle workers aggressively, and losing the
// state mid-session is what desyncs the toggle.
const memory = new Map();

async function readState(tabId) {
  const key = `tab:${tabId}`;
  try {
    if (chrome.storage && chrome.storage.session) {
      const got = await chrome.storage.session.get(key);
      return !!got[key];
    }
  } catch (_) {
    /* fall through to memory */
  }
  return !!memory.get(tabId);
}

async function writeState(tabId, value) {
  const key = `tab:${tabId}`;
  memory.set(tabId, value);
  try {
    if (chrome.storage && chrome.storage.session) {
      await chrome.storage.session.set({ [key]: value });
    }
  } catch (_) {
    /* memory already updated */
  }
}

async function clearState(tabId) {
  memory.delete(tabId);
  try {
    if (chrome.storage && chrome.storage.session) {
      await chrome.storage.session.remove(`tab:${tabId}`);
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * Say something in the UI when a click does nothing. Restricted pages
 * (chrome://, the extension galleries, the PDF viewer) and file:// URLs without
 * the per-extension "allow access to file URLs" opt-in all fail here, and a
 * console.warn in the service worker is invisible to everyone who isn't already
 * debugging the extension. Three separate ways to experience "I clicked the
 * button and absolutely nothing happened" is the worst thing a one-button tool
 * can do.
 */
function badge(tabId, text, title) {
  try {
    chrome.action.setBadgeText({ tabId, text });
    if (text) chrome.action.setBadgeBackgroundColor({ tabId, color: '#c1121f' });
    chrome.action.setTitle({
      tabId,
      title: title || 'Heading Inspector for Shadow DOM',
    });
  } catch (_) {
    /* the tab may already be gone */
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  if (!INJECTABLE.test(tab.url || '')) {
    badge(
      tab.id,
      '!',
      'Heading Inspector can’t run on this page. Browser pages (chrome://, ' +
        'about:), the extension galleries and the built-in PDF viewer are off ' +
        'limits to every extension.'
    );
    return;
  }

  const next = !(await readState(tab.id));

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['walker.js', 'overlay.js'],
    });

    // Settle every frame on the same state, whatever the injection above did to
    // each one individually.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      args: [next],
      func: (want) => {
        const api = window.__shadowHeadingOutliner;
        if (api && typeof api.set === 'function') api.set(want);
      },
    });

    await writeState(tab.id, next);
    badge(tab.id, '', 'Heading Inspector for Shadow DOM');
  } catch (err) {
    const isFile = (tab.url || '').startsWith('file:');
    badge(
      tab.id,
      '!',
      isFile
        ? 'Heading Inspector needs file access for local pages. Turn on ' +
            '“Allow access to file URLs” for this extension on the ' +
            'extensions page, then click again.'
        : 'Heading Inspector couldn’t run on this page. The browser blocked ' +
            'script injection here.'
    );
    console.warn('Heading Inspector for Shadow DOM: injection failed', err);
  }
});

// A navigation tears the overlay down with the old document, so the stored
// state would otherwise claim it is still on and the next click would try to
// turn it off.
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.status === 'loading') {
    clearState(tabId);
    badge(tabId, '', 'Heading Inspector for Shadow DOM');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => clearState(tabId));
