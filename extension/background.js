// Re-injecting is the toggle: overlay.js guards on a window key and flips state
// when it finds itself already installed. Files execute in order in the same
// isolated world, so walker.js is always defined before overlay.js runs.
//
// allFrames: true rather than walking contentDocument ourselves. Cross-origin
// frames get covered, and each frame's coordinates and clipping are handled by
// its own instance.
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (!/^(https?|file):/.test(tab.url || '')) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['walker.js', 'overlay.js'],
    });
  } catch (err) {
    console.warn('Shadow Heading Outliner: injection failed', err);
  }
});
