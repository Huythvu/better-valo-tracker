"use strict";

// Valorant rank-tier helpers. Tier ids match HenrikDev's `tier.id` (0-27):
// 0 Unrated, 3-5 Iron, 6-8 Bronze, 9-11 Silver, 12-14 Gold, 15-17 Platinum,
// 18-20 Diamond, 21-23 Ascendant, 24-26 Immortal, 27 Radiant.

const RANK_ASSETS_KEY = "rankAssets";
const RANK_ASSETS_TTL = 7 * 24 * 60 * 60 * 1000;

function rankColorFallback(tierId) {
  if (tierId >= 27) return "#fffba8";
  if (tierId >= 24) return "#c0395a";
  if (tierId >= 21) return "#1fa563";
  if (tierId >= 18) return "#e173b0";
  if (tierId >= 15) return "#4e93a8";
  if (tierId >= 12) return "#e6c14b";
  if (tierId >= 9) return "#bcc7cc";
  if (tierId >= 6) return "#b07b4f";
  if (tierId >= 3) return "#697a86";
  return "#6b7a89";
}

// Pulls competitive-tier icons + colors from valorant-api.com (free, no key),
// cached in storage.local for a week. Returns {} if unavailable so callers can
// fall back to plain colors.
async function loadRankAssets() {
  const stored = (await chrome.storage.local.get(RANK_ASSETS_KEY))[RANK_ASSETS_KEY];
  if (stored && Date.now() - stored.fetchedAt < RANK_ASSETS_TTL) {
    return stored.tiers;
  }
  try {
    const res = await fetch("https://valorant-api.com/v1/competitivetiers");
    const body = await res.json();
    const episodes = body.data || [];
    const latest = episodes[episodes.length - 1] || {};
    const tiers = {};
    for (const t of latest.tiers || []) {
      tiers[t.tier] = {
        color: typeof t.color === "string" ? `#${t.color.slice(0, 6)}` : null,
        icon: t.smallIcon || t.largeIcon || null,
      };
    }
    await chrome.storage.local.set({
      [RANK_ASSETS_KEY]: { tiers, fetchedAt: Date.now() },
    });
    return tiers;
  } catch {
    return (stored && stored.tiers) || {};
  }
}

function rankColor(tierId, assets) {
  const tier = assets && assets[tierId];
  if (tier && tier.color && tierId > 0) return tier.color;
  return rankColorFallback(tierId);
}

function rankIcon(tierId, assets) {
  const tier = assets && assets[tierId];
  return tier && tier.icon ? tier.icon : null;
}
