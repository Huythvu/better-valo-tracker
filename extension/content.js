"use strict";

// Injects the tracker UI as a fixed-position iframe overlay that slides in
// over the page (high z-index, never shifts page layout). The iframe loads
// popup.html, so the UI runs as an isolated extension page.

const FRAME_ID = "bvt-panel-frame";
const PANEL_WIDTH = 384;
const EXT_ORIGIN = chrome.runtime.getURL("").replace(/\/$/, "");

let isOpen = false;

function frameCss(side, open) {
  const opposite = side === "left" ? "right" : "left";
  const offscreen = side === "left" ? "translateX(-100%)" : "translateX(100%)";
  const shadowX = side === "left" ? "6px" : "-6px";
  return [
    "position:fixed",
    "top:0",
    `${side}:0`,
    `${opposite}:auto`,
    "height:100vh",
    `width:${PANEL_WIDTH}px`,
    "max-width:92vw",
    "border:none",
    "margin:0",
    "padding:0",
    "border-radius:0",
    "background:#0f1923",
    "z-index:2147483647",
    `box-shadow:${shadowX} 0 28px rgba(0,0,0,0.5)`,
    "transition:transform .22s ease",
    `transform:${open ? "translateX(0)" : offscreen}`,
  ]
    .map((decl) => `${decl} !important`)
    .join(";");
}

async function panelSide() {
  const { settings } = await chrome.storage.sync.get("settings");
  return settings && settings.panelSide === "left" ? "left" : "right";
}

async function openPanel() {
  const side = await panelSide();
  let frame = document.getElementById(FRAME_ID);
  if (!frame) {
    frame = document.createElement("iframe");
    frame.id = FRAME_ID;
    frame.src = chrome.runtime.getURL("popup.html");
    frame.style.cssText = frameCss(side, false);
    (document.documentElement || document.body).appendChild(frame);
    void frame.offsetWidth; // force reflow so the slide-in animates
  }
  frame.style.cssText = frameCss(side, true);
  isOpen = true;
}

async function closePanel() {
  const frame = document.getElementById(FRAME_ID);
  if (!frame) return;
  frame.style.cssText = frameCss(await panelSide(), false);
  isOpen = false;
}

function togglePanel() {
  if (isOpen) closePanel();
  else openPanel();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "bvt-toggle") togglePanel();
});

// The panel's own close button posts a message up from the iframe.
window.addEventListener("message", (event) => {
  if (event.origin === EXT_ORIGIN && event.data && event.data.type === "bvt-close") {
    closePanel();
  }
});

// Reposition live when the panel-side preference changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  const frame = document.getElementById(FRAME_ID);
  if (frame) {
    panelSide().then((side) => {
      frame.style.cssText = frameCss(side, isOpen);
    });
  }
});
