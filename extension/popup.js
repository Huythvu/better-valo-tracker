"use strict";

const DEFAULT_SETTINGS = {
  panelSide: "right",
  refreshMode: "open",
  showLastPlayed: true,
  compactMode: false,
};

const REFRESH_COOLDOWN_MS = 30 * 1000;

const PANEL_HTML = `
<div class="bvt-panel">
  <header>
    <h1>Better Valo Tracker</h1>
    <div class="header-actions">
      <button id="refresh" type="button" title="Refresh all">&#8635;</button>
      <button id="close" type="button" title="Close panel">&times;</button>
    </div>
  </header>

  <nav class="tabs">
    <button class="tab active" type="button" data-view="accounts">Accounts</button>
    <button class="tab" type="button" data-view="settings">Settings</button>
  </nav>

  <section id="view-accounts" class="view">
    <form id="add-form" autocomplete="off">
      <input id="riot-id" type="text" placeholder="name#tag" aria-label="Riot ID" spellcheck="false" />
      <select id="region" aria-label="Region">
        <option value="eu">EU</option>
        <option value="na">NA</option>
        <option value="ap">AP</option>
        <option value="kr">KR</option>
        <option value="latam">LATAM</option>
        <option value="br">BR</option>
      </select>
      <button type="submit">Add</button>
    </form>
    <p id="status" class="status" hidden></p>
    <div id="accounts"></div>
    <p id="empty" class="empty">No accounts tracked yet. Add a Riot ID above.</p>
    <p id="updated" class="updated"></p>
  </section>

  <section id="view-settings" class="view" hidden>
    <div class="setting">
      <label for="refresh-mode">Refresh</label>
      <select id="refresh-mode">
        <option value="open">When panel opens</option>
        <option value="manual">Manual only</option>
      </select>
    </div>

    <label class="setting checkbox-setting">
      <span>Show last comp played</span>
      <input id="show-last-played" type="checkbox" />
    </label>

    <label class="setting checkbox-setting">
      <span>Compact mode</span>
      <input id="compact-mode" type="checkbox" />
    </label>

    <div class="setting">
      <label for="panel-side">Panel side</label>
      <select id="panel-side">
        <option value="right">Right</option>
        <option value="left">Left</option>
      </select>
    </div>

    <p class="setting-hint">Panel closed = no automatic refresh. Manual refresh has a short cooldown.</p>
  </section>
</div>`;

let panelRoot = null;
let rankAssets = {};
let isRefreshing = false;
let lastManualRefreshAt = 0;

let accountsEl;
let emptyEl;
let statusEl;
let updatedEl;
let refreshBtn;
let addForm;
let riotIdInput;
let regionSelect;
let closeBtn;
let panelSideSelect;
let refreshModeSelect;
let showLastPlayedInput;
let compactModeInput;
let tabButtons;

// Called by content.js once the shadow root is created.
self.bvtMountPanel = function bvtMountPanel(root) {
  panelRoot = root;
  root.innerHTML = PANEL_HTML;

  accountsEl = root.getElementById("accounts");
  emptyEl = root.getElementById("empty");
  statusEl = root.getElementById("status");
  updatedEl = root.getElementById("updated");
  refreshBtn = root.getElementById("refresh");
  addForm = root.getElementById("add-form");
  riotIdInput = root.getElementById("riot-id");
  regionSelect = root.getElementById("region");
  closeBtn = root.getElementById("close");
  panelSideSelect = root.getElementById("panel-side");
  refreshModeSelect = root.getElementById("refresh-mode");
  showLastPlayedInput = root.getElementById("show-last-played");
  compactModeInput = root.getElementById("compact-mode");
  tabButtons = root.querySelectorAll(".tab");

  // Expose panel-open refresh to content.js. This is intentionally not a
  // background refresh; it only runs when the user opens the panel.
  self.bvtHandlePanelOpen = refreshOnOpen;
  self.bvtRefreshAll = refreshAll;

  init();
};

async function init() {
  await loadSettings();
  await render();

  addForm.addEventListener("submit", onAdd);
  refreshBtn.addEventListener("click", () => refreshAll({ manual: true }));
  accountsEl.addEventListener("click", onAccountsClick);
  closeBtn.addEventListener("click", () => self.bvtClosePanel());
  tabButtons.forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  panelSideSelect.addEventListener("change", saveSettings);
  refreshModeSelect.addEventListener("change", saveSettings);
  showLastPlayedInput.addEventListener("change", saveSettings);
  compactModeInput.addEventListener("change", saveSettings);

  loadRankAssets().then((assets) => {
    rankAssets = assets;
    render();
  });

  // The panel stays mounted, so re-render when another tab's panel updates
  // stored data or settings change.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      (area === "local" && changes.cache) ||
      (area === "sync" && (changes.accounts || changes.settings))
    ) {
      loadSettings().then(render);
    }
  });
}

// --- Tabs + settings --------------------------------------------------------

function switchView(name) {
  tabButtons.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === name);
  });
  panelRoot.getElementById("view-accounts").hidden = name !== "accounts";
  panelRoot.getElementById("view-settings").hidden = name !== "settings";
}

async function getSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function loadSettings() {
  const settings = await getSettings();
  panelSideSelect.value = settings.panelSide;
  refreshModeSelect.value = settings.refreshMode;
  showLastPlayedInput.checked = Boolean(settings.showLastPlayed);
  compactModeInput.checked = Boolean(settings.compactMode);
  panelRoot.querySelector(".bvt-panel").classList.toggle("compact", Boolean(settings.compactMode));
  return settings;
}

async function saveSettings() {
  const settings = {
    panelSide: panelSideSelect.value,
    refreshMode: refreshModeSelect.value,
    showLastPlayed: showLastPlayedInput.checked,
    compactMode: compactModeInput.checked,
  };
  await chrome.storage.sync.set({ settings });
  panelRoot.querySelector(".bvt-panel").classList.toggle("compact", settings.compactMode);
  await render();
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
  const settings = await getSettings();

  emptyEl.hidden = accounts.length > 0;
  panelRoot.querySelector(".bvt-panel").classList.toggle("compact", Boolean(settings.compactMode));

  const rows = accounts.map((account) => ({
    account,
    entry: cache[accountId(account)] || null,
  }));
  rows.sort((a, b) => eloOf(b.entry) - eloOf(a.entry));

  let position = 0;
  accountsEl.innerHTML = rows
    .map(({ account, entry }) => cardHtml(account, entry, entry?.data ? ++position : 0, settings))
    .join("");

  updatedEl.textContent = lastRefresh ? `Updated ${timeAgo(lastRefresh)}` : "";
}

function eloOf(entry) {
  return entry && entry.data && entry.data.current ? entry.data.current.elo : -1;
}

function cardHtml(account, entry, position, settings) {
  const id = accountId(account);
  const posClass = position === 1 ? "gold" : position === 2 ? "silver" : position === 3 ? "bronze" : "";
  const pos = `<div class="pos ${posClass}">${position || "&middot;"}</div>`;
  const removeBtn =
    `<button class="remove" data-id="${esc(id)}" title="Remove" type="button">&times;</button>`;
  const riotId =
    `<span class="riot-id">${esc(account.name)}<span class="tag">#${esc(account.tag)}</span></span>`;

  if (!entry) {
    return shell(pos, "#6b7a89", emptyAvatar(),
      `<div class="card-top">${riotId}${removeBtn}</div><div class="card-msg">Not refreshed yet.</div>`);
  }
  if (entry.error) {
    const updated = entry.fetchedAt ? `<div class="card-msg">Updated ${timeAgo(entry.fetchedAt)}</div>` : "";
    return shell(pos, "#c0395a", emptyAvatar(),
      `<div class="card-top">${riotId}${removeBtn}</div>` +
      `<div class="card-msg error">${esc(entry.error)}</div>${updated}`);
  }

  const d = entry.data || {};
  const c = d.current || {};
  const recent = Array.isArray(d.recent) ? d.recent : [];
  const color = rankColor(c.tierId, rankAssets);
  const icon = rankIcon(c.tierId, rankAssets);
  const iconEl = icon
    ? `<div class="rank-icon" style="background-image:url('${esc(icon)}')"></div>`
    : `<div class="rank-icon placeholder" style="background:${color}"></div>`;

  const profile = d.profile || {};
  const avatar = profile.cardUrl
    ? `<div class="avatar" style="background-image:url('${esc(profile.cardUrl)}')"></div>`
    : emptyAvatar();
  const level = profile.level ? `<span class="level">Lvl ${profile.level}</span>` : "";
  const top = `<div class="card-top">${riotId}${level}${removeBtn}</div>`;

  const rr = Number.isFinite(c.rr) ? c.rr : 0;
  const lastChange = Number.isFinite(c.lastChange) ? c.lastChange : 0;
  const deltaCls = lastChange > 0 ? "win" : lastChange < 0 ? "loss" : "draw";
  const arrow = lastChange > 0 ? "&#9650;" : lastChange < 0 ? "&#9660;" : "";
  const deltaText = lastChange === 0 ? "0" : `${arrow}${Math.abs(lastChange)}`;
  const rrPct = Math.min(100, Math.max(0, rr));
  const placements = c.inPlacements ? `<span class="badge">Placements</span>` : "";
  const rankName = c.tier || "Unrated";
  const rrText = c.inPlacements ? "Placements" : `${rr} RR`;
  const updatedEl = entry.fetchedAt ? `<span>Updated <strong>${timeAgo(entry.fetchedAt)}</strong></span>` : "";

  if (settings.compactMode) {
    const compactLastPlayed = settings.showLastPlayed
      ? `<div class="last-played compact-last">${esc(lastCompPlayedText(recent))}</div>`
      : "";
    return shell(pos, color, avatar,
      top +
      `<div class="compact-rank">${iconEl}<span>${esc(rankName)} &middot; ${esc(rrText)}</span>` +
      `<span class="delta ${deltaCls}">${deltaText}</span></div>` +
      compactLastPlayed +
      `<div class="meta">${updatedEl}</div>`);
  }

  const session = sessionSummary(recent);
  const sessionEl = session
    ? `<div class="session">Today &nbsp;` +
      `<strong class="${session.rr >= 0 ? "win" : "loss"}">${signed(session.rr)} RR</strong>` +
      ` &middot; ${session.count} game${session.count === 1 ? "" : "s"}</div>`
    : "";

  const pips =
    recent
      .map(
        (m) =>
          `<span class="pip ${esc(m.result || "draw")}" title="${esc(m.map || "Unknown map")} &middot; ${esc(m.tier || "")}">` +
          `${signed(Number(m.rrChange || 0))}</span>`,
      )
      .join("") || `<span class="card-msg">No recent matches</span>`;

  const lastPlayedEl = settings.showLastPlayed
    ? `<div class="last-played">${esc(lastCompPlayedText(recent))}</div>`
    : "";

  const body =
    top +
    `<div class="rank-line">${iconEl}` +
    `<div class="rank-info">` +
    `<div class="rank-name">${esc(rankName)} ${placements}</div>` +
    `<div class="rr-bar"><span style="width:${rrPct}%;background:${color}"></span></div>` +
    `</div>` +
    `<div class="rr-side"><div class="rr-val">${esc(rrText)}</div>` +
    `<div class="delta ${deltaCls}">${deltaText}</div></div>` +
    `</div>` +
    `<div class="meta"><span>Peak <strong>${esc(d.peak?.tier || "—")}</strong></span>` +
    `<span>Act ${d.act && d.act.games > 0 ? `${d.act.wins}W ${d.act.losses}L` : "&mdash;"}</span>` +
    `${updatedEl}</div>` +
    lastPlayedEl +
    sessionEl +
    `<div class="recent">${pips}</div>`;

  return shell(pos, color, avatar, body);
}

function shell(posBadge, accent, avatar, inner) {
  return `<div class="card" style="border-left-color:${accent}">` +
    `${posBadge}${avatar}<div class="card-main">${inner}</div></div>`;
}

function emptyAvatar() {
  return `<div class="avatar"></div>`;
}

function sessionSummary(recent) {
  const today = new Date().toDateString();
  const games = recent.filter((m) => m.date && new Date(m.date).toDateString() === today);
  if (games.length === 0) return null;
  return {
    rr: games.reduce((sum, m) => sum + Number(m.rrChange || 0), 0),
    count: games.length,
  };
}

function lastCompPlayedText(recent) {
  const matches = recent
    .filter((m) => m && m.date && isCompetitiveMatch(m))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (matches.length === 0) return "Last comp played: No recent comp games found";
  return `Last comp played: ${timeAgo(matches[0].date)}`;
}

function isCompetitiveMatch(match) {
  const possibleMode = `${match.mode || ""} ${match.queue || ""} ${match.queueId || ""}`.toLowerCase();
  if (possibleMode.includes("competitive") || possibleMode.includes("comp")) return true;

  // The current Worker data already appears to return ranked recent matches.
  // If mode/queue is missing, treat matches with RR changes or rank tier data
  // as competitive so the feature works without an extra match-history call.
  return Number.isFinite(Number(match.rrChange)) || Boolean(match.tier);
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
  await chrome.storage.local.set({ lastRefresh: Date.now() });
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

async function refreshOnOpen() {
  const settings = await getSettings();
  if (settings.refreshMode !== "open") return;
  await refreshAll({ manual: false });
}

async function refreshAll(options = {}) {
  const accounts = await getAccounts();
  if (accounts.length === 0 || isRefreshing) return;

  if (options.manual) {
    const now = Date.now();
    const waitMs = REFRESH_COOLDOWN_MS - (now - lastManualRefreshAt);
    if (waitMs > 0) {
      showStatus(`Please wait ${Math.ceil(waitMs / 1000)}s before refreshing again.`);
      return;
    }
    lastManualRefreshAt = now;
  }

  hideStatus();
  isRefreshing = true;
  refreshBtn.classList.add("spinning");
  refreshBtn.disabled = true;

  const { cache } = await getState();
  await Promise.all(
    accounts.map(async (account) => {
      cache[accountId(account)] = await fetchAccountData(account);
    }),
  );
  await chrome.storage.local.set({ cache, lastRefresh: Date.now() });

  refreshBtn.classList.remove("spinning");
  refreshBtn.disabled = false;
  isRefreshing = false;
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
  const then = typeof ts === "number" ? ts : new Date(ts).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
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
