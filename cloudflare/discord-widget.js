/* Cloudflare Worker for ballkour.com. It does two things with Discord:

   1. The online count. It puts the Discord widget data into each page as Cloudflare serves it. Without this,
      the browser has to ask Discord for the online count after the page loads, so the "• N online" pills next
      to "Join our Discord" pop in a moment late and widen the buttons. With it:
      - each pill already has its count and is visible in the HTML that arrives (in English, like the rest of
        the page's first paint; the page's script re-renders it in the visitor's language)
      - the widget data goes into <head> as <script type="application/json" id="discord-widget">, so the voice
        channel list renders straight away too
      Discord's answer is cached at Cloudflare for 60 seconds, so Discord sees at most about one request a minute
      per Cloudflare location. If Discord is slow (over 1.5 s) or down, the page is served untouched and the
      browser fetches the count itself, as before.

   2. Players' Discord names and pictures for the leaderboards, at /players.json:
        { "<discord id>": { "name": "server nickname, display name or username", "avatar": "https://cdn.discordapp.com/…" } }
      It finds the IDs in the game repo's leaderboard files (the same files the site and the leaderboard bot read)
      and looks each one up with Ballkyrie's token, which only lives here as a Worker secret:
        npx wrangler secret put DISCORD_BOT_TOKEN
      The list is cached at Cloudflare for an hour, so a new or renamed player shows up within the hour. Only
      players on a board are looked up; the endpoint can't be used to look up anyone else. While the list is
      cached, it also goes into each page as <script type="application/json" id="players">, so the boards have
      the names from the start instead of filling them in a moment later.

   Anything else passes straight through to the VPS. */

const GUILD_ID = "1212553452283101245";
const WIDGET_URL = `https://discord.com/api/guilds/${GUILD_ID}/widget.json`;
const GAME = "https://raw.githubusercontent.com/ballhallaa/ballkour/develop";
const API = "https://discord.com/api/v10";
const PLAYERS_TTL = 60 * 60; // seconds

/* ---------- 1. Online count ---------- */
async function getWidget() {
  try {
    const r = await fetch(WIDGET_URL, { cf: { cacheTtl: 60, cacheEverything: true }, signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const d = await r.json();
    if (typeof d.presence_count !== "number") return null;
    // Only what the page uses: the count, the channel names, and which channel each member is in
    return {
      presence_count: d.presence_count,
      channels: (d.channels || []).map(({ id, name, position }) => ({ id, name, position })),
      members: (d.members || []).filter((m) => m.channel_id).map((m) => ({ channel_id: m.channel_id })),
    };
  } catch (e) {
    return null;
  }
}

async function page(request, env, ctx) {
  // Ask for the full page every time (no 304 Not Modified), so a browser never reuses an old count from its cache
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const [res, widget, cached] = await Promise.all([fetch(new Request(request, { headers })), getWidget(), caches.default.match(PLAYERS_KEY())]);
  // No player list cached yet: start building it, so it's ready for the page's own request or the next visitor
  if (!cached && env.DISCORD_BOT_TOKEN) ctx.waitUntil(buildPlayers(env, ctx).catch(() => {}));
  const playersJson = cached ? await cached.text() : "";
  if ((!widget && !playersJson) || !res.ok || !(res.headers.get("Content-Type") || "").includes("text/html")) return res;

  const out = new Response(res.body, res);
  out.headers.delete("ETag");
  out.headers.delete("Last-Modified");
  out.headers.set("Cache-Control", "no-cache");

  const script = (id, json) => `<script type="application/json" id="${id}">${json.replace(/</g, "\\u003c")}</script>`;
  let rw = new HTMLRewriter();
  if (playersJson) rw = rw.on("head", { element(el) { el.append(script("players", playersJson), { html: true }); } });
  if (widget) {
    const text = `${widget.presence_count.toLocaleString("en")} online`;
    rw = rw
      .on("head", { element(el) { el.append(script("discord-widget", JSON.stringify(widget)), { html: true }); } })
      .on("[data-online-wrap]", { element(el) { el.removeAttribute("hidden"); } })
      .on("[data-online]", { element(el) { el.setInnerContent(text); } });
  }
  return rw.transform(out);
}

/* ---------- 2. Players ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function discord(token, route) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(API + route, { headers: { Authorization: `Bot ${token}` } });
    if (r.status === 429) { // rate limited: wait as long as Discord asks
      const wait = (await r.json().catch(() => ({}))).retry_after || 1;
      await sleep(Math.min(wait, 5) * 1000 + 250);
      continue;
    }
    return r.ok ? r.json() : null;
  }
  return null;
}

// Every Discord ID on any board: `# discord: ID` in the .opy files and "discord": "ID" in the .json files
async function boardIds() {
  const text = async (path) => {
    try {
      const r = await fetch(`${GAME}/${encodeURI(path)}`, { cf: { cacheTtl: 300, cacheEverything: true } });
      return r.ok ? r.text() : "";
    } catch (e) {
      return "";
    }
  };
  let files = [];
  try { files = JSON.parse(await text("tools/leaderboard-bot/courses.json")).courses.map((c) => c.file); } catch (e) { /* history only */ }
  const texts = await Promise.all(["leaderboards/history.json", ...files].map(text));
  const ids = new Set();
  for (const t of texts) for (const m of t.matchAll(/discord"?\s*:\s*"?(\d{17,20})\b/gi)) ids.add(m[1]);
  return [...ids];
}

// The name people see in the server (server nickname, then Discord display name, then username) and their picture.
// Someone who left the server keeps their Discord name and picture.
async function lookUp(token, id) {
  const member = await discord(token, `/guilds/${GUILD_ID}/members/${id}`);
  const user = member ? member.user : await discord(token, `/users/${id}`);
  if (!user) return null;
  const avatar = member && member.avatar ? `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/${id}/avatars/${member.avatar}.png?size=64`
    : user.avatar ? `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
  return { name: (member && member.nick) || user.global_name || user.username, avatar };
}

const PLAYERS_KEY = () => new Request("https://ballkour.com/players.json", { method: "GET" });

// Browsers check back after 5 minutes
function forBrowser(res) {
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "public, max-age=300");
  return out;
}

async function players(request, env, ctx) {
  const hit = await caches.default.match(PLAYERS_KEY());
  if (hit) return forBrowser(hit);
  if (!env.DISCORD_BOT_TOKEN) return new Response("{}", { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  return buildPlayers(env, ctx);
}

async function buildPlayers(env, ctx) {
  const ids = await boardIds();
  const found = {};
  for (let i = 0; i < ids.length; i += 5) { // 5 at a time, to stay well inside Discord's rate limits
    const batch = ids.slice(i, i + 5);
    const people = await Promise.all(batch.map((id) => lookUp(env.DISCORD_BOT_TOKEN, id).catch(() => null)));
    batch.forEach((id, j) => { if (people[j]) found[id] = people[j]; });
  }
  // Cloudflare keeps it for an hour
  const res = new Response(JSON.stringify(found), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${PLAYERS_TTL}` } });
  ctx.waitUntil(caches.default.put(PLAYERS_KEY(), res.clone()));
  return forBrowser(res);
}

export default {
  async fetch(request, env, ctx) {
    // If anything here throws, Cloudflare serves the request from the VPS as if the Worker weren't there
    ctx.passThroughOnException();
    if (request.method === "GET" && new URL(request.url).pathname === "/players.json") return players(request, env, ctx);
    const isPage = request.method === "GET" && (request.headers.get("Accept") || "").includes("text/html");
    return isPage ? page(request, env, ctx) : fetch(request);
  },
};
