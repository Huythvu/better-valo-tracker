"use strict";

importScripts("config.js", "api.js");

const REFRESH_ALARM = "bvt-refresh";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) refreshAll();
});

async function refreshAll() {
  const { accounts = [] } = await chrome.storage.sync.get("accounts");
  if (accounts.length === 0) return;

  const { cache = {} } = await chrome.storage.local.get("cache");
  await Promise.all(
    accounts.map(async (account) => {
      cache[self.accountId(account)] = await self.fetchAccountData(account);
    }),
  );
  await chrome.storage.local.set({ cache, lastRefresh: Date.now() });
}
