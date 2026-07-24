// Re-injecting is the toggle. overlay.js guards on a window key and flips state
// when it sees it's already installed. The files run in order in the same
// isolated world, so walker.js is always defined before overlay.js runs.
//
// allFrames: true, so we don't have to walk contentDocument ourselves. That way
// cross-origin frames get covered too, and each frame handles its own
// coordinates and clipping.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (!/^(https?|file):/.test(tab.url || '')) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['walker.js', 'overlay.js'],
    });
  } catch (err) {
    console.warn('Headings Bookmarklet for Shadow DOM: injection failed', err);
  }
});
