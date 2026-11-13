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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
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
      const res = await fetch(api.toString(), { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!res.ok) return json({ error: `API error (${res.status})` }, 502);
      const raw = await res.json();

      const info = raw.AccountInfo || raw.accountInfo || raw;
      const guild = raw.GuildInfo || raw.guildInfo || {};

      if (!find(info, ["AccountName"]) && !find(info, ["AccountCreateTime"])) {
        return json({ error: "Player not found. Check the UID and region." }, 404);
      }

      return json({
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
        avatar: null, // API returns only a numeric avatar id
        createdAt: toMs(find(info, ["AccountCreateTime"])),
        lastLogin: toMs(find(info, ["AccountLastLogin", "AccountLastLoginTime", "LastLoginAt"])),
      });
    } catch (e) {
      return json({ error: "Could not fetch data from the API." }, 502);
    }
  },
};
