"use strict";

// The toolbar icon toggles the injected overlay in the active tab.
// No background alarms are used, so the extension makes no automatic API calls
// while the panel is closed.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  chrome.tabs.sendMessage(tab.id, { type: "bvt-toggle" }).catch(() => {});
});
