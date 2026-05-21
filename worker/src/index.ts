// Better Valo Tracker - Cloudflare Worker
//
// Public endpoint:
//   GET /account/:name/:tag?region=eu
// Fans out to two HenrikDev endpoints (MMR v3 + mmr-history v2), trims the
// ~30 KB upstream payload down to the ~1 KB contract the extension consumes,
// and caches the result at the edge.

const HENRIK_BASE = "https://api.henrikdev.xyz/valorant";
const VALID_REGIONS = new Set(["eu", "na", "ap", "kr", "latam", "br"]);
const CACHE_TTL_SECONDS = 180;
const RATE_LIMIT_PER_MINUTE = 60;

interface Env {
  HENRIKDEV_API_KEY: string;
}

// --- HenrikDev response shapes (only the fields we read) ---------------------

interface HenrikTier {
  id?: number;
  name?: string;
}

interface HenrikMmr {
  data?: {
    account?: { name?: string; tag?: string };
    current?: {
      tier?: HenrikTier;
      rr?: number;
      elo?: number;
      last_change?: number;
      games_needed_for_rating?: number;
    };
    peak?: { tier?: HenrikTier; season?: { short?: string } };
    seasonal?: Array<{
      season?: { short?: string };
      wins?: number;
      games?: number;
    }>;
  };
}

interface HenrikHistoryEntry {
  tier?: HenrikTier;
  map?: { name?: string };
  last_change?: number;
  date?: string;
}

interface HenrikHistory {
  data?: { history?: HenrikHistoryEntry[] };
}

// --- The contract returned to the extension ---------------------------------

interface AccountPayload {
  name: string;
  tag: string;
  region: string;
  current: {
    tier: string;
    tierId: number;
    rr: number;
    elo: number;
    lastChange: number;
    inPlacements: boolean;
  };
  peak: { tier: string; season: string };
  act: { season: string; wins: number; losses: number; games: number };
  recent: Array<{
    result: "win" | "loss" | "draw";
    rrChange: number;
    map: string;
    tier: string;
    date: string;
  }>;
  updatedAt: string;
}

// --- Worker entrypoint ------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true });
    }

    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!allowRequest(ip)) {
      return json({ error: "Rate limit exceeded. Try again in a minute." }, 429);
    }

    const route = url.pathname.match(/^\/account\/([^/]+)\/([^/]+)\/?$/);
    if (!route) {
      return json({ error: "Not found" }, 404);
    }

    const name = decodeURIComponent(route[1]).trim();
    const tag = decodeURIComponent(route[2]).trim();
    const region = (url.searchParams.get("region") ?? "eu").toLowerCase();

    const invalid = validate(name, tag, region);
    if (invalid) {
      return json({ error: invalid }, 400);
    }

    const cache = caches.default;
    const cacheKey = new Request(
      `https://bvt-cache/${region}/${name.toLowerCase()}/${tag.toLowerCase()}`,
    );

    const hit = await cache.match(cacheKey);
    if (hit) {
      const cachedResponse = new Response(hit.body, hit);
      cachedResponse.headers.set("X-Cache", "HIT");
      return cachedResponse;
    }

    let payload: AccountPayload;
    try {
      payload = await fetchAccount(name, tag, region, env.HENRIKDEV_API_KEY);
    } catch (err) {
      const e = err as ApiError;
      return json({ error: e.message }, e.status ?? 502);
    }

    const response = new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...corsHeaders(),
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        "X-Cache": "MISS",
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

// --- HenrikDev fetch + shaping ----------------------------------------------

interface ApiError extends Error {
  status?: number;
}

function apiError(message: string, status: number): ApiError {
  const e = new Error(message) as ApiError;
  e.status = status;
  return e;
}

async function fetchAccount(
  name: string,
  tag: string,
  region: string,
  apiKey: string,
): Promise<AccountPayload> {
  const headers = { Authorization: apiKey };
  const path = `${region}/pc/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`;

  const [mmrRes, histRes] = await Promise.all([
    fetch(`${HENRIK_BASE}/v3/mmr/${path}`, { headers }),
    fetch(`${HENRIK_BASE}/v2/mmr-history/${path}`, { headers }),
  ]);

  if (mmrRes.status === 404) {
    throw apiError("Account not found. Check the Riot ID and region.", 404);
  }
  if (mmrRes.status === 429) {
    throw apiError("Upstream rate limit reached. Try again shortly.", 429);
  }
  if (mmrRes.status === 401 || mmrRes.status === 403) {
    throw apiError("Worker is missing a valid HenrikDev API key.", 502);
  }
  if (!mmrRes.ok) {
    throw apiError("Failed to fetch rank data from upstream.", 502);
  }

  const mmr = (await mmrRes.json()) as HenrikMmr;

  // History is best-effort: a card without recent matches still beats no card.
  let history: HenrikHistoryEntry[] = [];
  if (histRes.ok) {
    const parsed = (await histRes.json()) as HenrikHistory;
    history = parsed.data?.history ?? [];
  }

  return shape(name, tag, region, mmr, history);
}

function shape(
  name: string,
  tag: string,
  region: string,
  mmr: HenrikMmr,
  history: HenrikHistoryEntry[],
): AccountPayload {
  const data = mmr.data ?? {};
  const current = data.current ?? {};
  const seasonal = data.seasonal ?? [];
  const act = seasonal[seasonal.length - 1];

  const recent = history.slice(0, 5).map((h) => {
    const change = h.last_change ?? 0;
    return {
      result: (change > 0 ? "win" : change < 0 ? "loss" : "draw") as
        | "win"
        | "loss"
        | "draw",
      rrChange: change,
      map: h.map?.name ?? "Unknown",
      tier: h.tier?.name ?? "Unrated",
      date: h.date ?? "",
    };
  });

  return {
    name: data.account?.name ?? name,
    tag: data.account?.tag ?? tag,
    region,
    current: {
      tier: current.tier?.name ?? "Unrated",
      tierId: current.tier?.id ?? 0,
      rr: current.rr ?? 0,
      elo: current.elo ?? 0,
      lastChange: current.last_change ?? 0,
      inPlacements: (current.games_needed_for_rating ?? 0) > 0,
    },
    peak: {
      tier: data.peak?.tier?.name ?? "Unrated",
      season: data.peak?.season?.short ?? "",
    },
    act: act
      ? {
          season: act.season?.short ?? "",
          wins: act.wins ?? 0,
          losses: Math.max(0, (act.games ?? 0) - (act.wins ?? 0)),
          games: act.games ?? 0,
        }
      : { season: "", wins: 0, losses: 0, games: 0 },
    recent,
    updatedAt: new Date().toISOString(),
  };
}

// --- Helpers ----------------------------------------------------------------

function validate(name: string, tag: string, region: string): string | null {
  if (!VALID_REGIONS.has(region)) {
    return `Invalid region. Use one of: ${[...VALID_REGIONS].join(", ")}.`;
  }
  if (name.length < 3 || name.length > 16) {
    return "Riot ID name must be 3-16 characters.";
  }
  if (tag.length < 3 || tag.length > 5) {
    return "Riot ID tag must be 3-5 characters.";
  }
  return null;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Lightweight per-IP rate limit. In-memory and per-isolate, so it only catches
// obvious hammering - edge caching is the real load protection. For hard abuse
// limits, add a Cloudflare dashboard rate-limiting rule.
const rateBuckets = new Map<string, { count: number; reset: number }>();

function allowRequest(ip: string): boolean {
  const now = Date.now();
  if (rateBuckets.size > 10000) rateBuckets.clear();

  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.reset) {
    rateBuckets.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_PER_MINUTE;
}
