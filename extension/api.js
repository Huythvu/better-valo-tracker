// Shared Worker-API helpers, used by both popup.js and background.js.

// Stable key for an account in the local cache.
self.accountId = function accountId(account) {
  return `${account.region}:${account.name}:${account.tag}`.toLowerCase();
};

// Fetches one account from the Worker. Always resolves â€” never throws â€” so
// callers get either { data, fetchedAt } or { error, fetchedAt }.
self.fetchAccountData = async function fetchAccountData(account) {
  const url =
    `${self.WORKER_URL}/account/` +
    `${encodeURIComponent(account.name)}/${encodeURIComponent(account.tag)}` +
    `?region=${encodeURIComponent(account.region)}`;

  try {
    const res = await fetch(url);
    let body = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    if (!res.ok) {
      return {
        error: body.error || `Request failed (${res.status})`,
        fetchedAt: Date.now(),
      };
    }
    return { data: body, fetchedAt: Date.now() };
  } catch {
    return { error: "Network error â€” is the Worker URL correct?", fetchedAt: Date.now() };
  }
};
