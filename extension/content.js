"use strict";

// Injects the tracker UI as a Shadow DOM overlay. Unlike an iframe, a plain
// <div> is not a frame, so the page's frame-src CSP cannot block it - this is
// what lets the panel render on strict-CSP sites. The shadow boundary keeps
// page styles and panel styles fully isolated from each other.

const HOST_ID = "bvt-panel-host";
const PANEL_WIDTH = 384;

let host = null;
let isOpen = false;

function hostCss(side, open) {
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
    "margin:0",
    "padding:0",
    "border:none",
    "overflow:hidden",
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

async function buildPanel() {
  if (host) return;
  // Claim `host` synchronously so a rapid second toggle cannot build twice.
  host = document.createElement("div");
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: "open" });

  const side = await panelSide();
  host.style.cssText = hostCss(side, false);
  (document.documentElement || document.body).appendChild(host);

  let css = "";
  try {
    css = await fetch(chrome.runtime.getURL("popup.css")).then((r) => r.text());
  } catch {
    css = "";
  }

  self.bvtMountPanel(root);

  // Content-script-injected <style> inside the shadow root - exempt from the
  // page's style-src and scoped to the shadow tree.
  if (css) {
    const style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);
  }

  void host.offsetWidth; // force reflow so the first open animates
}

async function openPanel() {
  await buildPanel();

  if (typeof self.bvtHandlePanelOpen === "function") {
    self.bvtHandlePanelOpen();
  }

  host.style.cssText = hostCss(await panelSide(), true);
  isOpen = true;
}

async function closePanel() {
  if (!host) return;
  host.style.cssText = hostCss(await panelSide(), false);
  isOpen = false;
}

self.bvtClosePanel = closePanel;

function togglePanel() {
  if (isOpen) closePanel();
  else openPanel();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "bvt-toggle") togglePanel();
});

// Reposition live when the panel-side preference changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings || !host) return;
  panelSide().then((side) => {
    host.style.cssText = hostCss(side, isOpen);
  });
});
