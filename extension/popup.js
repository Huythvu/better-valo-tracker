"use strict";

const DEFAULT_SETTINGS = {
  panelSide: "right",
  refreshMode: "open",
  showLastPlayed: true,
  compactMode: false,
  hideAddForm: false,
  closeOnOutsideClick: true,
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

    <label class="setting checkbox-setting">
      <span>Hide add player form</span>
      <input id="hide-add-form" type="checkbox" />
    </label>

    <label class="setting checkbox-setting">
      <span>Close when clicking outside panel</span>
      <input id="close-on-outside-click" type="checkbox" />
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

  <div class="scroll-affordance" aria-hidden="true"><span>Scroll for more</span></div>
</div>`;

let panelRoot = null;
let rankAssets = {};
let isRefreshing = false;
let lastManualRefreshAt = 0;
let draggedPinnedId = null;

let accountsEl;
let emptyEl;
let statusEl;
let refreshBtn;
let addForm;
let riotIdInput;
let regionSelect;
let closeBtn;
let panelSideSelect;
let refreshModeSelect;
let showLastPlayedInput;
let compactModeInput;
let hideAddFormInput;
let closeOnOutsideClickInput;
let tabButtons;
let panelEl;

// Called by content.js once the shadow root is created.
self.bvtMountPanel = function bvtMountPanel(root) {
  panelRoot = root;
  root.innerHTML = PANEL_HTML;

  accountsEl = root.getElementById("accounts");
  emptyEl = root.getElementById("empty");
  statusEl = root.getElementById("status");
  refreshBtn = root.getElementById("refresh");
  addForm = root.getElementById("add-form");
  riotIdInput = root.getElementById("riot-id");
  regionSelect = root.getElementById("region");
  closeBtn = root.getElementById("close");
  panelSideSelect = root.getElementById("panel-side");
  refreshModeSelect = root.getElementById("refresh-mode");
  showLastPlayedInput = root.getElementById("show-last-played");
  compactModeInput = root.getElementById("compact-mode");
  hideAddFormInput = root.getElementById("hide-add-form");
  closeOnOutsideClickInput = root.getElementById("close-on-outside-click");
  tabButtons = root.querySelectorAll(".tab");
  panelEl = root.querySelector(".bvt-panel");

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
  accountsEl.addEventListener("dragstart", onPinnedDragStart);
  accountsEl.addEventListener("dragover", onPinnedDragOver);
  accountsEl.addEventListener("dragleave", onPinnedDragLeave);
  accountsEl.addEventListener("drop", onPinnedDrop);
  accountsEl.addEventListener("dragend", onPinnedDragEnd);
  closeBtn.addEventListener("click", () => self.bvtClosePanel());
  tabButtons.forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  panelSideSelect.addEventListener("change", saveSettings);
  refreshModeSelect.addEventListener("change", saveSettings);
  showLastPlayedInput.addEventListener("change", saveSettings);
  compactModeInput.addEventListener("change", saveSettings);
  hideAddFormInput.addEventListener("change", saveSettings);
  closeOnOutsideClickInput.addEventListener("change", saveSettings);

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

  panelEl.addEventListener("scroll", updateScrollAffordance, { passive: true });
  updateScrollAffordance();
}

function updateScrollAffordance() {
  if (!panelEl) return;

  const canScroll = panelEl.scrollHeight > panelEl.clientHeight + 2;
  const atTop = panelEl.scrollTop <= 2;
  const atBottom = panelEl.scrollTop + panelEl.clientHeight >= panelEl.scrollHeight - 2;

  panelEl.classList.toggle("can-scroll", canScroll);
  panelEl.classList.toggle("at-top", !canScroll || atTop);
  panelEl.classList.toggle("at-bottom", !canScroll || atBottom);
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
  hideAddFormInput.checked = Boolean(settings.hideAddForm);
  closeOnOutsideClickInput.checked = settings.closeOnOutsideClick !== false;
  panelRoot.querySelector(".bvt-panel").classList.toggle("compact", Boolean(settings.compactMode));
  return settings;
}

async function saveSettings() {
  const settings = {
    panelSide: panelSideSelect.value,
    refreshMode: refreshModeSelect.value,
    showLastPlayed: showLastPlayedInput.checked,
    compactMode: compactModeInput.checked,
    hideAddForm: hideAddFormInput.checked,
    closeOnOutsideClick: closeOnOutsideClickInput.checked,
  };
  await chrome.storage.sync.set({ settings });
  panelRoot.querySelector(".bvt-panel").classList.toggle("compact", settings.compactMode);
  await render();
}

function updateAddFormVisibility(_accounts, settings) {
  // Simple manual show/hide toggle for the original add-account form.
  addForm.hidden = Boolean(settings.hideAddForm);
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
  const { cache } = await getState();
  const settings = await getSettings();

  emptyEl.hidden = accounts.length > 0;
  panelRoot.querySelector(".bvt-panel").classList.toggle("compact", Boolean(settings.compactMode));
  updateAddFormVisibility(accounts, settings);

  const rows = sortedAccountRows(accounts, cache);
  const rankPositions = rankPositionsById(accounts, cache);

  animateCards(() => {
    accountsEl.innerHTML = rows
      .map(({ account, entry }) => cardHtml(account, entry, rankPositions.get(accountId(account)) || 0, settings))
      .join("");
  });

  requestAnimationFrame(updateScrollAffordance);
}

function rankPositionsById(accounts, cache) {
  const ranked = accounts
    .map((account) => ({ account, entry: cache[accountId(account)] || null }))
    .filter(({ entry }) => entry?.data)
    .sort((a, b) => eloOf(b.entry) - eloOf(a.entry));

  return new Map(ranked.map(({ account }, index) => [accountId(account), index + 1]));
}

function sortedAccountRows(accounts, cache) {
  return accounts
    .map((account, index) => ({
      account,
      index,
      entry: cache[accountId(account)] || null,
    }))
    .sort((a, b) => {
      const aPinned = Boolean(a.account.pinned);
      const bPinned = Boolean(b.account.pinned);
      if (aPinned !== bPinned) return aPinned ? -1 : 1;
      if (aPinned && bPinned) {
        return pinOrderOf(a.account, a.index) - pinOrderOf(b.account, b.index);
      }
      return eloOf(b.entry) - eloOf(a.entry);
    });
}

function pinOrderOf(account, fallback) {
  return Number.isFinite(Number(account.pinOrder)) ? Number(account.pinOrder) : fallback;
}

function animateCards(updateDom) {
  if (!accountsEl || typeof accountsEl.querySelectorAll !== "function") {
    updateDom();
    return;
  }

  const before = new Map(
    Array.from(accountsEl.querySelectorAll(".card[data-id]")).map((card) => [
      card.dataset.id,
      card.getBoundingClientRect(),
    ]),
  );

  updateDom();

  if (!before.size) return;

  requestAnimationFrame(() => {
    accountsEl.querySelectorAll(".card[data-id]").forEach((card) => {
      const previous = before.get(card.dataset.id);
      if (!previous) return;

      const current = card.getBoundingClientRect();
      const dx = previous.left - current.left;
      const dy = previous.top - current.top;
      if (!dx && !dy) return;

      card.style.transition = "none";
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      card.style.opacity = "0.78";

      requestAnimationFrame(() => {
        card.style.transition = "transform 220ms ease, opacity 220ms ease";
        card.style.transform = "translate(0, 0)";
        card.style.opacity = "1";
      });
    });
  });
}

function eloOf(entry) {
  return entry && entry.data && entry.data.current ? entry.data.current.elo : -1;
}

function cardHtml(account, entry, position, settings) {
  const id = accountId(account);
  const posClass = position === 1 ? "gold" : position === 2 ? "silver" : position === 3 ? "bronze" : "";
  const pos = `<div class="pos ${posClass}">${position || "&middot;"}</div>`;
  const isPinned = Boolean(account.pinned);
  const pinBtn =
    `<button class="pin ${isPinned ? "active" : ""}" data-id="${esc(id)}" title="${isPinned ? "Unpin account" : "Pin account"}" type="button" aria-label="${isPinned ? "Unpin account" : "Pin account"}">${isPinned ? "★" : "☆"}</button>`;
  const removeBtn =
    `<button class="remove" data-id="${esc(id)}" title="Remove" type="button">&times;</button>`;
  const riotId =
    `<span class="riot-id">${esc(account.name)}<span class="tag">#${esc(account.tag)}</span></span>`;

  if (!entry) {
    return shell(account, pos, "#6b7a89", emptyAvatar(),
      `<div class="card-top">${pinBtn}${riotId}${removeBtn}</div><div class="card-msg">Not refreshed yet.</div>`);
  }
  if (entry.error) {
    return shell(account, pos, "#c0395a", emptyAvatar(),
      `<div class="card-top">${pinBtn}${riotId}${removeBtn}</div>` +
      `<div class="card-msg error">${esc(entry.error)}</div>`);
  }

  const d = entry.data || {};
  const c = d.current || {};
  const recent = recentMatchesOf(d);
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
  const top = `<div class="card-top">${pinBtn}${riotId}${level}${removeBtn}</div>`;

  const rr = Number.isFinite(c.rr) ? c.rr : 0;
  const lastChange = Number.isFinite(c.lastChange) ? c.lastChange : 0;
  const deltaCls = lastChange > 0 ? "win" : lastChange < 0 ? "loss" : "draw";
  const arrow = lastChange > 0 ? "&#9650;" : lastChange < 0 ? "&#9660;" : "";
  const deltaText = lastChange === 0 ? "0" : `${arrow}${Math.abs(lastChange)}`;
  const rrPct = Math.min(100, Math.max(0, rr));
  const placements = c.inPlacements ? `<span class="badge">Placements</span>` : "";
  const rankName = c.tier || "Unrated";
  const rrText = c.inPlacements ? "Placements" : `${rr} RR`;

  if (settings.compactMode) {
    const compactLastPlayed = settings.showLastPlayed
      ? `<div class="last-played compact-last">${esc(lastCompPlayedText(recent))}</div>`
      : "";
    return shell(account, pos, color, avatar,
      top +
      `<div class="compact-rank">${iconEl}<span>${esc(rankName)} &middot; ${esc(rrText)}</span>` +
      `<span class="delta ${deltaCls}">${deltaText}</span></div>` +
      compactLastPlayed);
  }

  const session = sessionSummary(recent);
  const sessionEl = session
    ? `<div class="session">Today &nbsp;` +
      `<strong class="${session.rr >= 0 ? "win" : "loss"}">${signed(session.rr)} RR</strong>` +
      ` &middot; ${session.count} game${session.count === 1 ? "" : "s"}</div>`
    : "";

  const pips =
    recent
      .slice(0, 5)
      .map((m, index) => matchPipHtml(m, index))
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
    `</div>` +
    lastPlayedEl +
    sessionEl +
    `<div class="recent">${pips}</div>`;

  return shell(account, pos, color, avatar, body);
}

function shell(account, posBadge, accent, avatar, inner) {
  const id = accountId(account);
  const pinned = Boolean(account.pinned);
  const classes = pinned ? "card pinned" : "card";
  const dragHandle = pinned
    ? `<span class="drag-handle" aria-hidden="true"><span></span><span></span><span></span></span>`
    : "";
  const draggable = pinned ? ` draggable="true"` : "";
  return `<div class="${classes}" data-id="${esc(id)}"${draggable} style="border-left-color:${accent}">` +
    `${posBadge}<div class="avatar-col">${avatar}${dragHandle}</div><div class="card-main">${inner}</div></div>`;
}

function emptyAvatar() {
  return `<div class="avatar"></div>`;
}

function recentMatchesOf(data) {
  const candidates = [
    data?.recent,
    data?.recentMatches,
    data?.matches,
    data?.matchHistory,
    data?.history,
    data?.data?.recent,
    data?.data?.matches,
  ];
  const list = candidates.find(Array.isArray) || [];
  return list.filter(Boolean);
}

function latestCompetitiveMatch(recent) {
  return recent
    .filter((m) => m && isCompetitiveMatch(m))
    .sort((a, b) => matchDateMs(b) - matchDateMs(a))[0] || null;
}

function matchPipHtml(match, index) {
  const details = matchDetails(match, 0);
  const label = details.rr === "0" ? "0" : details.rr;
  const scorePart = details.score !== "—" ? ` ${esc(details.score)}` : "";

  return `<span class="pip-wrap">` +
    `<span class="pip ${esc(details.resultClass)}" tabindex="0" aria-label="Match ${index + 1} details">${esc(label)}</span>` +
    `<span class="match-popover" role="dialog" aria-label="Match ${index + 1} details">` +
    `<span class="popover-kicker">Match ${index + 1}</span>` +
    `<span class="popover-title">${esc(details.map)}</span>` +
    `<span class="popover-subtitle"><strong class="${esc(details.resultClass)}">${esc(details.result)}${scorePart}</strong><span>${esc(details.rr)} RR</span></span>` +
    `<span class="popover-main">` +
    `<span><strong class="${esc(details.rrClass)}">${esc(details.rr)}</strong><small>RR</small></span>` +
    `<span><strong>${esc(details.agent)}</strong><small>Agent</small></span>` +
    `<span><strong>${esc(details.kda)}</strong><small>K / D / A</small></span>` +
    `</span>` +
    `<span class="popover-row"><span>ACS</span><strong>${esc(details.acs)}</strong></span>` +
    `<span class="popover-row"><span>HS</span><strong>${esc(details.hs)}</strong></span>` +
    `<span class="popover-row"><span>Rank then</span><strong>${esc(details.tier)}</strong></span>` +
    `<span class="popover-row"><span>Played</span><strong>${esc(details.when)}</strong></span>` +
    `</span></span>`;
}
function matchDetails(match, lastChange) {
  const rrValue = numberFrom(
    readField(match, [
      "rrChange",
      "rr_change",
      "mmrChange",
      "mmr_change",
      "mmr_change_to_last_game",
      "eloChange",
      "elo_change",
      "ratingChange",
      "rating_change",
      "change",
    ]),
  );
  const rrChange = Number.isFinite(rrValue) ? rrValue : Number(lastChange || 0);
  const result = resultLabel(match || {}, rrChange);
  const date = matchDate(match);
  const kills = numberOrNull(readField(match, ["kills", "stats.kills", "player.kills", "player.stats.kills", "performance.kills"]));
  const deaths = numberOrNull(readField(match, ["deaths", "stats.deaths", "player.deaths", "player.stats.deaths", "performance.deaths"]));
  const assists = numberOrNull(readField(match, ["assists", "stats.assists", "player.assists", "player.stats.assists", "performance.assists"]));

  return {
    map: valueOrDash(readField(match, ["map", "mapName", "map.name", "metadata.map", "metadata.mapName", "meta.map", "match.map"])),
    rr: signed(rrChange),
    rrClass: rrChange >= 0 ? "win" : "loss",
    result: result.text,
    resultClass: result.className,
    score: scoreText(match),
    agent: valueOrDash(readField(match, ["agent", "agent.name", "character", "characterName", "character.name", "player.agent", "player.agent.name", "player.character", "player.character.name"])),
    kda: kdaText(kills, deaths, assists),
    acs: valueOrDash(readField(match, ["acs", "averageCombatScore", "average_combat_score", "combatScore", "combat_score", "stats.acs", "stats.averageCombatScore", "stats.combatScore", "player.stats.acs", "player.stats.averageCombatScore"])),
    hs: percentText(readField(match, ["hsPct", "hs_pct", "headshotPct", "headshot_pct", "hs", "hsPercent", "hs_percentage", "headshotPercent", "headshot_percentage", "headshot_percentage_display", "stats.hsPct", "stats.hs_pct", "stats.headshotPct", "stats.headshot_pct", "stats.hs", "stats.hsPercent", "stats.headshotPercent", "stats.headshot_percentage", "player.stats.hsPct", "player.stats.hs_pct", "player.stats.headshotPercent"])),
    tier: valueOrDash(readField(match, ["tier", "rank", "rankThen", "currentTierPatched", "tierPatched", "metadata.tier"])),
    when: date ? timeAgo(date) : "—",
  };
}

function resultLabel(match, rrChange = Number(match.rrChange || 0)) {
  const raw = String(readField(match, ["result", "outcome", "matchResult", "status"]) || "").toLowerCase();
  if (raw.includes("win") || raw === "won" || raw === "victory") return { text: "Win", className: "win" };
  if (raw.includes("loss") || raw.includes("lose") || raw === "lost" || raw === "defeat") return { text: "Loss", className: "loss" };
  if (raw.includes("draw") || raw.includes("tie")) return { text: "Draw", className: "draw" };

  const won = readField(match, ["won", "hasWon", "victory"]);
  if (won === true) return { text: "Win", className: "win" };
  if (won === false) return { text: "Loss", className: "loss" };

  if (rrChange > 0) return { text: "Win", className: "win" };
  if (rrChange < 0) return { text: "Loss", className: "loss" };
  return { text: "Unknown", className: "draw" };
}

function scoreText(match) {
  const direct = readField(match, ["score", "scoreText", "roundScore", "round_score", "matchScore", "metadata.score"]);
  if (direct) return normalizeScore(direct);

  const won = readField(match, ["roundsWon", "rounds_won", "teamRoundsWon", "team_rounds_won", "round_won", "rounds.won", "roundsWonLost.won", "team.roundsWon", "team.rounds.won"]);
  const lost = readField(match, ["roundsLost", "rounds_lost", "enemyRoundsWon", "enemy_rounds_won", "round_lost", "rounds.lost", "roundsWonLost.lost", "enemy.roundsWon", "enemy.rounds.won"]);
  if (won !== undefined && lost !== undefined) return `${won}–${lost}`;

  return "—";
}

function normalizeScore(value) {
  if (Array.isArray(value) && value.length >= 2) return `${value[0]}–${value[1]}`;
  if (typeof value === "object" && value !== null) {
    const won = readField(value, ["won", "roundsWon", "rounds_won", "team", "blue", "red"]);
    const lost = readField(value, ["lost", "roundsLost", "rounds_lost", "enemy", "opponent"]);
    if (won !== undefined && lost !== undefined) return `${won}–${lost}`;
  }
  return String(value).replace(/\s*-\s*/g, "–");
}

function kdaText(kills, deaths, assists) {
  if (kills === null && deaths === null && assists === null) return "—";
  return `${kills ?? "—"} / ${deaths ?? "—"} / ${assists ?? "—"}`;
}

function percentText(value) {
  if (value === undefined || value === null || value === "") return "—";
  const raw = String(value).trim();
  if (raw.endsWith("%")) return raw;
  const number = Number(raw);
  if (!Number.isFinite(number)) return raw;
  const percent = number > 0 && number <= 1 ? number * 100 : number;
  return `${Math.round(percent)}%`;
}

function numberOrNull(value) {
  const number = numberFrom(value);
  return Number.isFinite(number) ? number : null;
}

function matchDate(match) {
  return readField(match, [
    "date",
    "playedAt",
    "startedAt",
    "startTime",
    "gameStart",
    "game_start",
    "metadata.game_start",
    "metadata.startedAt",
    "meta.started_at",
  ]);
}

function matchDateMs(match) {
  const value = matchDate(match);
  const ms = typeof value === "number" ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function readField(source, paths) {
  if (!source) return undefined;
  for (const path of paths) {
    const parts = path.split(".");
    let value = source;
    for (const part of parts) {
      if (value === undefined || value === null) break;
      value = value[part];
    }
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function numberFrom(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function valueOrDash(value) {
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

function sessionSummary(recent) {
  const today = new Date().toDateString();
  const games = recent.filter((m) => matchDate(m) && new Date(matchDate(m)).toDateString() === today);
  if (games.length === 0) return null;
  return {
    rr: games.reduce((sum, m) => sum + Number(matchDetails(m, 0).rr || 0), 0),
    count: games.length,
  };
}

function lastCompPlayedText(recent) {
  const matches = recent
    .filter((m) => m && matchDate(m) && isCompetitiveMatch(m))
    .sort((a, b) => matchDateMs(b) - matchDateMs(a));

  if (matches.length === 0) return "Last comp played: No recent comp games found";
  return `Last comp played: ${timeAgo(matchDate(matches[0]))}`;
}

function isCompetitiveMatch(match) {
  const possibleMode = `${readField(match, ["mode", "queue", "queueId", "metadata.mode", "metadata.queue"]) || ""}`.toLowerCase();
  if (possibleMode.includes("competitive") || possibleMode.includes("comp")) return true;

  // The current Worker data already appears to return ranked recent matches.
  // If mode/queue is missing, treat matches with RR changes or rank tier data
  // as competitive so the feature works without an extra match-history call.
  return Number.isFinite(numberFrom(readField(match, ["rrChange", "rr_change", "mmrChange", "mmr_change", "mmr_change_to_last_game", "eloChange"]))) || Boolean(readField(match, ["tier", "rank", "currentTierPatched"]));
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
  const pinButton = event.target.closest(".pin");
  if (pinButton) {
    await togglePinned(pinButton.dataset.id);
    return;
  }

  const removeButton = event.target.closest(".remove");
  if (!removeButton) return;

  const id = removeButton.dataset.id;
  const accounts = await getAccounts();
  await setAccounts(accounts.filter((a) => accountId(a) !== id));

  const { cache } = await getState();
  delete cache[id];
  await chrome.storage.local.set({ cache });
  await render();
}

async function togglePinned(id) {
  const accounts = await getAccounts();
  const maxPinOrder = accounts.reduce((max, account, index) => {
    if (!account.pinned) return max;
    return Math.max(max, pinOrderOf(account, index));
  }, -1);

  const nextAccounts = accounts.map((account) => {
    if (accountId(account) !== id) return account;
    if (account.pinned) {
      const { pinned, pinOrder, ...rest } = account;
      return rest;
    }
    return { ...account, pinned: true, pinOrder: maxPinOrder + 1 };
  });

  await setAccounts(normalizePinnedOrder(nextAccounts));
  await render();
}

function normalizePinnedOrder(accounts) {
  const pinned = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => account.pinned)
    .sort((a, b) => pinOrderOf(a.account, a.index) - pinOrderOf(b.account, b.index));

  const orderById = new Map(
    pinned.map(({ account }, index) => [accountId(account), index]),
  );

  return accounts.map((account) => {
    if (!account.pinned) return account;
    return { ...account, pinOrder: orderById.get(accountId(account)) ?? 0 };
  });
}

function onPinnedDragStart(event) {
  const card = event.target.closest(".card.pinned");
  if (!card) return;

  // The whole pinned card is draggable, but normal controls should not start a drag.
  if (event.target.closest("button, input, select, textarea, a, .pip, .pip-wrap, .match-popover")) {
    event.preventDefault();
    return;
  }

  draggedPinnedId = card.dataset.id;
  card.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedPinnedId);
}

function onPinnedDragOver(event) {
  const card = event.target.closest(".card.pinned");
  if (!card || !draggedPinnedId || card.dataset.id === draggedPinnedId) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  card.classList.add("drop-target");
}

function onPinnedDragLeave(event) {
  const card = event.target.closest(".card.pinned");
  if (card) card.classList.remove("drop-target");
}

async function onPinnedDrop(event) {
  const targetCard = event.target.closest(".card.pinned");
  if (!targetCard || !draggedPinnedId || targetCard.dataset.id === draggedPinnedId) return;

  event.preventDefault();
  await movePinnedAccount(draggedPinnedId, targetCard.dataset.id);
}

function onPinnedDragEnd() {
  draggedPinnedId = null;
  accountsEl.querySelectorAll(".card.dragging, .card.drop-target").forEach((card) => {
    card.classList.remove("dragging", "drop-target");
  });
}

async function movePinnedAccount(fromId, toId) {
  const accounts = normalizePinnedOrder(await getAccounts());
  const pinned = accounts
    .filter((account) => account.pinned)
    .sort((a, b) => pinOrderOf(a, 0) - pinOrderOf(b, 0));

  const fromIndex = pinned.findIndex((account) => accountId(account) === fromId);
  const toIndex = pinned.findIndex((account) => accountId(account) === toId);
  if (fromIndex < 0 || toIndex < 0) return;

  const [moved] = pinned.splice(fromIndex, 1);
  pinned.splice(toIndex, 0, moved);

  const newOrders = new Map(pinned.map((account, index) => [accountId(account), index]));
  const nextAccounts = accounts.map((account) => {
    if (!account.pinned) return account;
    return { ...account, pinOrder: newOrders.get(accountId(account)) ?? 0 };
  });

  await setAccounts(nextAccounts);
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
