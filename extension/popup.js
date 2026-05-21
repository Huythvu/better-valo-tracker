"use strict";

const accountsEl = document.getElementById("accounts");
const emptyEl = document.getElementById("empty");
const statusEl = document.getElementById("status");
const updatedEl = document.getElementById("updated");
const refreshBtn = document.getElementById("refresh");
const addForm = document.getElementById("add-form");
const riotIdInput = document.getElementById("riot-id");
const regionSelect = document.getElementById("region");

const STALE_MS = 3 * 60 * 1000;

init();

async function init() {
  await render();
  addForm.addEventListener("submit", onAdd);
  refreshBtn.addEventListener("click", refreshAll);
  accountsEl.addEventListener("click", onAccountsClick);
  refreshStale();
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
  const rankCol = `<div class="card-rank">${position ? "#" + position : ""}</div>`;
  const head = `
    <div class="card-head">
      <span class="riot-id">${esc(account.name)}<span class="tag">#${esc(account.tag)}</span></span>
      <button class="remove" data-id="${esc(id)}" title="Remove" type="button">&times;</button>
    </div>`;

  if (!entry) {
    return `<div class="card">${rankCol}<div class="card-main">${head}` +
      `<div class="card-msg">Loading&hellip;</div></div></div>`;
  }
  if (entry.error) {
    return `<div class="card">${rankCol}<div class="card-main">${head}` +
      `<div class="card-msg error">${esc(entry.error)}</div></div></div>`;
  }

  const d = entry.data;
  const c = d.current;
  const deltaCls = c.lastChange > 0 ? "win" : c.lastChange < 0 ? "loss" : "draw";
  const placements = c.inPlacements ? `<span class="badge">Placements</span>` : "";
  const actText = d.act.games > 0 ? `${d.act.wins}W ${d.act.losses}L` : "&mdash;";

  const pips = d.recent
    .map((m) => {
      const label = `${signed(m.rrChange)} RR`;
      return `<span class="pip ${m.result}" title="${esc(m.map)} &middot; ${esc(label)}">` +
        `${signed(m.rrChange)}</span>`;
    })
    .join("");
  const recent = pips || `<span class="card-msg">No recent matches</span>`;

  return `
    <div class="card">
      ${rankCol}
      <div class="card-main">
        ${head}
        <div class="rank-row">
          <span class="rank">${esc(c.tier)}</span>
          <span class="rr">${c.rr} RR</span>
          <span class="delta ${deltaCls}">${signed(c.lastChange)}</span>
          ${placements}
        </div>
        <div class="meta">
          <span>Peak: ${esc(d.peak.tier)}</span>
          <span>Act: ${actText}</span>
        </div>
        <div class="recent">${recent}</div>
      </div>
    </div>`;
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
    return !entry || now - entry.fetchedAt > STALE_MS;
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
