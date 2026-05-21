"use strict";

const accountsEl = document.getElementById("accounts");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const updatedEl = document.getElementById("updated");
const refreshBtn = document.getElementById("refresh");
const addForm = document.getElementById("add-form");
const riotIdInput = document.getElementById("riot-id");
const regionSelect = document.getElementById("region");
const closeBtn = document.getElementById("close");
const panelSideSelect = document.getElementById("panel-side");
const tabButtons = document.querySelectorAll(".tab");

const STALE_MS = 3 * 60 * 1000;

let rankAssets = {};

init();

async function init() {
  await render();
  addForm.addEventListener("submit", onAdd);
  refreshBtn.addEventListener("click", refreshAll);
  accountsEl.addEventListener("click", onAccountsClick);
  closeBtn.addEventListener("click", () => {
    window.parent.postMessage({ type: "bvt-close" }, "*");
  });
  tabButtons.forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });
  panelSideSelect.addEventListener("change", saveSettings);
  loadSettings();

  loadRankAssets().then((assets) => {
    rankAssets = assets;
    render();
  });
  refreshStale();

  // The side panel stays open, so re-render when a background refresh or
  // another panel instance updates stored data.
  chrome.storage.onChanged.addListener((changes, area) => {
    if ((area === "local" && changes.cache) || (area === "sync" && changes.accounts)) {
      render();
    }
  });
}

// --- Tabs + settings --------------------------------------------------------

function switchView(name) {
  tabButtons.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === name);
  });
  document.getElementById("view-accounts").hidden = name !== "accounts";
  document.getElementById("view-settings").hidden = name !== "settings";
}

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  panelSideSelect.value = (settings && settings.panelSide) || "right";
}

async function saveSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  await chrome.storage.sync.set({
    settings: { ...(settings || {}), panelSide: panelSideSelect.value },
  });
}

// --- Storage ----------------------------------------------------------------

function getAccounts() {
  return chrome.storage.sync.get("accounts").then((r) => r.accounts || []);
}

function setAccounts(list) {
  return chrome.storage.sync.set({ accounts: list });
}

function getState() {
  return chrome.storage.local.get(["cache", "lastRefresh"]).then((r) => ({
    cache: r.cache || {},
    lastRefresh: r.lastRefresh || 0,
  }));
}

async function mergeCache(id, entry) {
  const { cache } = await getState();
  cache[id] = entry;
  await chrome.storage.local.set({ cache });
}

// --- Rendering --------------------------------------------------------------

async function render() {
  const accounts = await getAccounts();
  const { cache, lastRefresh } = await getState();

  emptyEl.hidden = accounts.length > 0;

  const rows = accounts.map((account) => ({
    account,
    entry: cache[accountId(account)] || null,
  }));
  rows.sort((a, b) => eloOf(b.entry) - eloOf(a.entry));

  let position = 0;
  accountsEl.innerHTML = rows
    .map(({ account, entry }) => cardHtml(account, entry, entry?.data ? ++position : 0))
    .join("");

  updatedEl.textContent = lastRefresh ? `Updated ${timeAgo(lastRefresh)}` : "";
}

function eloOf(entry) {
  return entry && entry.data ? entry.data.current.elo : -1;
}

function cardHtml(account, entry, position) {
  const id = accountId(account);
  const posClass = position === 1 ? "gold" : position === 2 ? "silver" : position === 3 ? "bronze" : "";
  const pos = `<div class="pos ${posClass}">${position || "&middot;"}</div>`;
  const removeBtn =
    `<button class="remove" data-id="${esc(id)}" title="Remove" type="button">&times;</button>`;
  const riotId =
    `<span class="riot-id">${esc(account.name)}<span class="tag">#${esc(account.tag)}</span></span>`;

  if (!entry) {
    return shell(pos, "#6b7a89", emptyAvatar(),
      `<div class="card-top">${riotId}${removeBtn}</div><div class="card-msg">Loading&hellip;</div>`);
  }
  if (entry.error) {
    return shell(pos, "#c0395a", emptyAvatar(),
      `<div class="card-top">${riotId}${removeBtn}</div>` +
      `<div class="card-msg error">${esc(entry.error)}</div>`);
  }

  const d = entry.data;
  const c = d.current;
  const color = rankColor(c.tierId, rankAssets);
  const icon = rankIcon(c.tierId, rankAssets);
  const iconEl = icon
    ? `<img class="rank-icon" src="${esc(icon)}" alt="" />`
    : `<div class="rank-icon placeholder" style="background:${color}"></div>`;

  const profile = d.profile || {};
  const avatar = profile.cardUrl
    ? `<div class="avatar" style="background-image:url('${esc(profile.cardUrl)}')"></div>`
    : emptyAvatar();
  const level = profile.level ? `<span class="level">Lvl ${profile.level}</span>` : "";
  const top = `<div class="card-top">${riotId}${level}${removeBtn}</div>`;

  const deltaCls = c.lastChange > 0 ? "win" : c.lastChange < 0 ? "loss" : "draw";
  const arrow = c.lastChange > 0 ? "&#9650;" : c.lastChange < 0 ? "&#9660;" : "";
  const deltaText = c.lastChange === 0 ? "0" : `${arrow}${Math.abs(c.lastChange)}`;
  const rrPct = Math.min(100, Math.max(0, c.rr));
  const placements = c.inPlacements ? `<span class="badge">Placements</span>` : "";

  const session = sessionSummary(d.recent);
  const sessionEl = session
    ? `<div class="session">Today &nbsp;` +
      `<strong class="${session.rr >= 0 ? "win" : "loss"}">${signed(session.rr)} RR</strong>` +
      ` &middot; ${session.count} game${session.count === 1 ? "" : "s"}</div>`
    : "";

  const pips =
    d.recent
      .map(
        (m) =>
          `<span class="pip ${m.result}" title="${esc(m.map)} &middot; ${esc(m.tier)}">` +
          `${signed(m.rrChange)}</span>`,
      )
      .join("") || `<span class="card-msg">No recent matches</span>`;

  const body =
    top +
    `<div class="rank-line">${iconEl}` +
    `<div class="rank-info">` +
    `<div class="rank-name">${esc(c.tier)} ${placements}</div>` +
    `<div class="rr-bar"><span style="width:${rrPct}%;background:${color}"></span></div>` +
    `</div>` +
    `<div class="rr-side"><div class="rr-val">${c.rr} RR</div>` +
    `<div class="delta ${deltaCls}">${deltaText}</div></div>` +
    `</div>` +
    `<div class="meta"><span>Peak <strong>${esc(d.peak.tier)}</strong></span>` +
    `<span>Act ${d.act.games > 0 ? `${d.act.wins}W ${d.act.losses}L` : "&mdash;"}</span></div>` +
    sessionEl +
    `<div class="recent">${pips}</div>`;

  return shell(pos, color, avatar, body);
}

function emptyAvatar() {
  return `<div class="avatar"></div>`;
}

function shell(posBadge, accent, avatar, inner) {
  return `<div class="card" style="border-left-color:${accent}">` +
    `${posBadge}${avatar}<div class="card-main">${inner}</div></div>`;
}

function sessionSummary(recent) {
  const today = new Date().toDateString();
  const games = recent.filter((m) => m.date && new Date(m.date).toDateString() === today);
  if (games.length === 0) return null;
  return {
    rr: games.reduce((sum, m) => sum + m.rrChange, 0),
    count: games.length,
  };
}

// --- Actions ----------------------------------------------------------------

async function onAdd(event) {
  event.preventDefault();
  hideStatus();

  const parsed = parseRiotId(riotIdInput.value);
  if (!parsed) {
    showStatus("Enter a Riot ID in the form name#tag.");
    return;
  }

  const account = { name: parsed.name, tag: parsed.tag, region: regionSelect.value };
  const invalid = validate(account);
  if (invalid) {
    showStatus(invalid);
    return;
  }

  const accounts = await getAccounts();
  if (accounts.some((a) => accountId(a) === accountId(account))) {
    showStatus("That account is already tracked.");
    return;
  }

  accounts.push(account);
  await setAccounts(accounts);
  riotIdInput.value = "";
  await render();

  const entry = await fetchAccountData(account);
  await mergeCache(accountId(account), entry);
  await render();
}

async function onAccountsClick(event) {
  const button = event.target.closest(".remove");
  if (!button) return;

  const id = button.dataset.id;
  const accounts = await getAccounts();
  await setAccounts(accounts.filter((a) => accountId(a) !== id));

  const { cache } = await getState();
  delete cache[id];
  await chrome.storage.local.set({ cache });
  await render();
}

async function refreshAll() {
  const accounts = await getAccounts();
  if (accounts.length === 0) return;

  refreshBtn.classList.add("spinning");
  const { cache } = await getState();
  await Promise.all(
    accounts.map(async (account) => {
      cache[accountId(account)] = await fetchAccountData(account);
    }),
  );
  await chrome.storage.local.set({ cache, lastRefresh: Date.now() });
  refreshBtn.classList.remove("spinning");
  await render();
}

async function refreshStale() {
  const accounts = await getAccounts();
  const { cache } = await getState();
  const now = Date.now();
  const stale = accounts.filter((account) => {
    const entry = cache[accountId(account)];
    return !entry || entry.error || now - entry.fetchedAt > STALE_MS;
  });
  if (stale.length === 0) return;

  await Promise.all(
    stale.map(async (account) => {
      cache[accountId(account)] = await fetchAccountData(account);
    }),
  );
  await chrome.storage.local.set({ cache, lastRefresh: Date.now() });
  await render();
}

// --- Helpers ----------------------------------------------------------------

function parseRiotId(raw) {
  const value = (raw || "").trim();
  const hash = value.indexOf("#");
  if (hash < 1 || hash === value.length - 1) return null;
  return { name: value.slice(0, hash).trim(), tag: value.slice(hash + 1).trim() };
}

function validate(account) {
  if (account.name.length < 3 || account.name.length > 16) {
    return "Riot ID name must be 3-16 characters.";
  }
  if (account.tag.length < 3 || account.tag.length > 5) {
    return "Riot ID tag must be 3-5 characters.";
  }
  return null;
}

function signed(n) {
  return n > 0 ? `+${n}` : `${n}`;
}

function timeAgo(ts) {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function showStatus(message) {
  statusEl.textContent = message;
  statusEl.hidden = false;
}

function hideStatus() {
  statusEl.hidden = true;
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
  });
}
