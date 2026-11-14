// Cloudflare Worker: Free Fire profile + account age
// Uses the HL Gaming API (proapis.hlgamingofficial.com)
//
// Set these in Cloudflare dashboard > Worker > Settings > Variables and Secrets:
//   HL_USERUID  = your developer UID from HL Gaming   (Secret)
//   HL_API_KEY  = your API key from HL Gaming         (Secret)
//   API_URL     = (optional) override the account endpoint

const DEFAULT_API =
  "https://proapis.hlgamingofficial.com/main/games/freefire/account/api";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });

// Search an object (a few levels deep) for the first matching key
function find(node, keys, depth = 0) {
  if (!node || typeof node !== "object" || depth > 3) return null;
  for (const k of keys) {
    const v = node[k];
    if (v !== undefined && v !== null && v !== "" && typeof v !== "object") return v;
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") {
      const r = find(v, keys, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

const toMs = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n; // seconds -> ms
  }
  const d = Date.parse(v);
  return isNaN(d) ? null : d;
};

const num = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v) => (v === null || v === undefined || v === "" ? null : String(v).slice(0, 200));


// ---------- Rate-limit (429) protection ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with retry on 429 / 5xx (waits 0.7s, then 1.5s)
async function hlFetch(url, tries = 3) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await fetch(url);
    if (res.status !== 429 && res.status < 500) return res;
    if (i < tries - 1) await sleep(i === 0 ? 700 : 1500);
  }
  return res;
}

// Our own cache. workers.dev ignores the Cache API, so we layer: memory (per isolate) -> Cache API -> KV.
const FRESH_S = 1800, STALE_S = 86400;
const mem = new Map();
async function cacheGet(name) {
  const m = mem.get(name);
  if (m && m.exp > Date.now()) return m.data;
  if (typeof caches === "undefined") return null;
  try {
    const hit = await caches.default.match(new Request(`https://cache.local/${name}`));
    return hit ? await hit.json() : null;
  } catch (e) { return null; }
}
function cachePut(ctx, name, data, ttl) {
  mem.set(name, { exp: Date.now() + ttl * 1000, data });
  if (mem.size > 500) mem.delete(mem.keys().next().value);
  if (typeof caches === "undefined") return;
  try {
    const put = caches.default.put(
      new Request(`https://cache.local/${name}`),
      new Response(JSON.stringify(data), { headers: { "Cache-Control": `max-age=${ttl}`, "Content-Type": "application/json" } })
    ).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put);
  } catch (e) {}
}
// KV copy of the main profile data (survives across isolates/colos, used as stale fallback)
async function kvGetRaw(env, key) {
  if (!env.CHECKS) return null;
  try { return await env.CHECKS.get("raw:" + key, "json"); } catch (e) { return null; }
}
function kvPutRaw(env, ctx, key, raw) {
  if (!env.CHECKS) return;
  const p = env.CHECKS.put("raw:" + key, JSON.stringify({ t: Date.now(), d: raw }), { expirationTtl: STALE_S }).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}
const inflight = new Map(); // avatar + banner requests share one upstream call

const IMG_API = "https://proapis.hlgamingofficial.com/main/games/freefire/meta/api";

// Find the first http(s) image URL anywhere in an object
function findUrl(node, depth = 0) {
  if (!node) return null;
  if (typeof node === "string") return /^https?:\/\//i.test(node) ? node : null;
  if (typeof node !== "object" || depth > 4) return null;
  for (const v of Object.values(node)) {
    const r = findUrl(v, depth + 1);
    if (r) return r;
  }
  return null;
}

// Signed image URLs expire in ~5 minutes. Cache 4 min; cache failures 60s so we don't hammer the API.
async function getImages(env, uid, region, ctx) {
  const name = `img/${region}/${uid}`;
  const hit = await cacheGet(name);
  if (hit) return hit;
  if (inflight.has(name)) return inflight.get(name);
  const p = (async () => {
    const out = await fetchImages(env, uid, region);
    cachePut(ctx, name, out, out.avatar || out.banner ? 240 : 60);
    return out;
  })();
  inflight.set(name, p);
  try { return await p; } finally { inflight.delete(name); }
}
async function fetchImages(env, uid, region) {
  const out = { avatar: null, banner: null };
  const base = env.API_URL || DEFAULT_API;
  let limited = false;
  try {
    const u = new URL(base);
    u.searchParams.set("sectionName", "AllData");
    u.searchParams.set("PlayerUid", uid);
    u.searchParams.set("region", region.toLowerCase());
    u.searchParams.set("useruid", env.HL_USERUID);
    u.searchParams.set("api", env.HL_API_KEY);
    u.searchParams.set("filter", "isIMG");
    const r = await hlFetch(u.toString(), 2);
    if (r.status === 429) limited = true;
    if (r.ok) {
      const j = await r.json();
      const info = j.AccountInfo || j.accountInfo || j;
      out.avatar = findUrl({ a: info.AccountAvatarId });
      out.banner = findUrl({ a: info.AccountBannerId });
    }
  } catch (e) {}
  if (out.avatar || limited) return out; // don't call a 2nd endpoint when rate-limited
  try {
    const u = new URL(IMG_API);
    u.searchParams.set("sectionName", "image");
    u.searchParams.set("useruid", env.HL_USERUID);
    u.searchParams.set("api", env.HL_API_KEY);
    u.searchParams.set("playeruid", uid);
    u.searchParams.set("region", region.toLowerCase());
    u.searchParams.set("isBeta", "true");
    const r = await hlFetch(u.toString(), 2);
    if (r.ok) {
      const j = await r.json();
      const res = j.result || j;
      out.avatar = findUrl(res.outfitUrl) || findUrl(res.avatarUrl) || out.avatar;
      out.banner = findUrl(res.bannerUrl) || out.banner;
    }
  } catch (e) {}
  return out;
}

// ---------- Recent searches (stored in Cloudflare KV, binding name: CHECKS) ----------
const MAX_RECENT = 100;
const SHOW_RECENT = 3;

async function recordCheck(env, d) {
  if (!env.CHECKS || !d.nickname) return;
  try {
    // One UID is listed only once, ever: a repeat search changes nothing.
    const seenKey = `seen:${d.uid}`;
    if (await env.CHECKS.get(seenKey)) return;
    const [list, total] = await Promise.all([env.CHECKS.get("recent", "json"), env.CHECKS.get("total")]);
    const cur = Array.isArray(list) ? list : [];
    if (cur.some((e) => e.uid === d.uid)) { await env.CHECKS.put(seenKey, "1"); return; }
    const entry = { uid: d.uid, region: d.region, name: String(d.nickname).slice(0, 40), level: d.level, t: Date.now() };
    const next = [entry, ...cur].slice(0, MAX_RECENT);
    await Promise.all([
      env.CHECKS.put("recent", JSON.stringify(next)),
      env.CHECKS.put(seenKey, "1"),
      env.CHECKS.put("total", String((Number(total) || 0) + 1)),
    ]);
  } catch (e) {}
}

async function getRecent(env) {
  if (!env.CHECKS) return { enabled: false, total: 0, items: [] };
  try {
    const [list, total] = await Promise.all([env.CHECKS.get("recent", "json"), env.CHECKS.get("total")]);
    const items = (Array.isArray(list) ? list : []).slice(0, SHOW_RECENT).map((e) => ({
      name: e.name, uid: e.uid, region: e.region, level: e.level ?? null, at: e.t,
    }));
    return { enabled: true, total: Math.max(Number(total) || 0, (Array.isArray(list) ? list.length : 0)), items };
  } catch (e) {
    return { enabled: false, total: 0, items: [] };
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    // /api/recent -> the 3 most recent checks (public)
    if (url.pathname.endsWith("/recent")) {
      const out = await getRecent(env);
      return new Response(JSON.stringify(out), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
      });
    }

    // /api/avatar?uid=..&region=.. -> streams the image with CORS so the browser and canvas can use it
    if (url.pathname.endsWith("/avatar") || url.pathname.endsWith("/banner")) {
      const kind = url.pathname.endsWith("/banner") ? "banner" : "avatar";
      const u = (url.searchParams.get("uid") || "").trim();
      const rg = (url.searchParams.get("region") || "IND").trim().toUpperCase();
      if (!/^\d{6,12}$/.test(u) || !/^[A-Z]{2,4}$/.test(rg) || !env.HL_USERUID || !env.HL_API_KEY)
        return new Response("bad request", { status: 400, headers: CORS });
      const iid = (url.searchParams.get("id") || "").replace(/\D/g, "").slice(0, 12);
      // Optional: your own icon CDN. Set AVATAR_URL / BANNER_URL like https://example.com/icons/{id}.png
      const tpl = kind === "banner" ? env.BANNER_URL : env.AVATAR_URL;
      if (tpl && iid) {
        try {
          const own = await fetch(tpl.replace("{id}", iid));
          if (own.ok && /^image\//.test(own.headers.get("Content-Type") || ""))
            return new Response(own.body, { headers: { "Content-Type": own.headers.get("Content-Type"), "Cache-Control": "public, max-age=86400", ...CORS } });
        } catch (e) {}
      }
      const imgs = await getImages(env, u, rg, ctx);
      if (!imgs[kind]) return new Response("not found", { status: 404, headers: CORS });
      const img = await fetch(imgs[kind]);
      if (!img.ok) return new Response("not found", { status: 404, headers: CORS });
      return new Response(img.body, {
        headers: { "Content-Type": img.headers.get("Content-Type") || "image/png", "Cache-Control": "public, max-age=3600", ...CORS },
      });
    }

    const uid = (url.searchParams.get("uid") || "").trim();
    const region = (url.searchParams.get("region") || "IND").trim().toUpperCase();

    if (!/^\d{6,12}$/.test(uid)) return json({ error: "Invalid UID. Enter 6 to 12 digits." }, 400);
    if (!/^[A-Z]{2,4}$/.test(region)) return json({ error: "Invalid region." }, 400);
    if (!env.HL_USERUID || !env.HL_API_KEY) {
      return json({ error: "API credentials are not configured on the Worker." }, 500);
    }

    const api = new URL(env.API_URL || DEFAULT_API);
    api.searchParams.set("sectionName", "AllData");
    api.searchParams.set("PlayerUid", uid);
    api.searchParams.set("region", region.toLowerCase());
    api.searchParams.set("useruid", env.HL_USERUID);
    api.searchParams.set("api", env.HL_API_KEY);

    try {
      const key = `${region}/${uid}`;
      let raw = await cacheGet("raw/" + key); // memory / edge cache (fresh)
      let stale = null;
      if (!raw) {
        const kv = await kvGetRaw(env, key);
        if (kv && kv.d) {
          if (Date.now() - kv.t < FRESH_S * 1000) { raw = kv.d; cachePut(ctx, "raw/" + key, raw, 300); }
          else stale = kv.d;
        }
      }
      if (!raw) {
        const res = await hlFetch(api.toString(), 3);
        if (res.ok) {
          raw = await res.json();
          cachePut(ctx, "raw/" + key, raw, FRESH_S);
          kvPutRaw(env, ctx, key, raw);
        } else if (stale) {
          raw = stale; // upstream failed / rate-limited: serve the old copy
        } else if (res.status === 429) {
          return json({ error: "Server is busy right now. Please try again in a few seconds." }, 429);
        } else {
          return json({ error: "Could not reach the game API. Please try again shortly." }, 502);
        }
      }

      if (url.searchParams.get("raw") === "1") return json(raw);
      const flat = {};
      (function w(n, p, d) {
        if (d > 3 || !n || typeof n !== "object") return;
        for (const [k, v] of Object.entries(n)) {
          const key = p ? p + "." + k : k;
          if (v && typeof v === "object") w(v, key, d + 1);
          else if (v !== null && v !== "" && Object.keys(flat).length < 150) flat[key] = String(v).slice(0, 120);
        }
      })(raw, "", 0);
      const info = raw.AccountInfo || raw.accountInfo || raw;
      const guild = raw.GuildInfo || raw.guildInfo || {};

      if (!find(info, ["AccountName"]) && !find(info, ["AccountCreateTime"])) {
        return json({ error: "Player not found. Check the UID and region." }, 404);
      }

      const result = {
        uid,
        nickname: str(find(info, ["AccountName"])),
        region,
        level: num(find(info, ["AccountLevel"])),
        exp: num(find(info, ["AccountEXP", "AccountExp"])),
        likes: num(find(info, ["AccountLikes"])),
        honor: num(find(info, ["AccountHonorScore", "HonorScore", "CreditScore"])),
        brPoints: num(find(info, ["BrRankPoint"])),
        csPoints: num(find(info, ["CsRankPoint"])),
        badges: num(find(info, ["AccountBadgeCount", "BadgeCount"])),
        title: str(find(info, ["AccountTitle", "TitleName"])),
        guild: str(find(guild, ["GuildName"])),
        bio: str(find(info, ["AccountSignature", "Signature", "Bio"])),
        avatarId: str(find(info, ["AccountAvatarId", "AvatarId", "HeadPic", "AccountAvatar"])),
        bannerId: str(find(info, ["AccountBannerId", "BannerId", "AccountBanner"])),
        avatar: `/api/avatar?uid=${uid}&region=${region}&id=${encodeURIComponent(str(find(info, ["AccountAvatarId", "AvatarId", "HeadPic", "AccountAvatar"])) || "")}`,
        banner: `/api/banner?uid=${uid}&region=${region}&id=${encodeURIComponent(str(find(info, ["AccountBannerId", "BannerId", "AccountBanner"])) || "")}`,
        extra: flat,
        createdAt: toMs(find(info, ["AccountCreateTime"])),
        lastLogin: toMs(find(info, ["AccountLastLogin", "AccountLastLoginTime", "LastLoginAt"])),
      };
      if (url.searchParams.get("silent") !== "1") ctx.waitUntil(recordCheck(env, result));
      return json(result);
    } catch (e) {
      return json({ error: "Could not fetch data from the API." }, 502);
    }
  },
};
