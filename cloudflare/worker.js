/* Cloudflare Worker for ballkour.com. Visitors' browsers only ever talk to ballkour.com: the Worker fetches
   everything the page needs from GitHub and Discord itself, caches it at Cloudflare, and serves it from here.
   That keeps the site fast, keeps visitors' IPs away from GitHub and Discord, avoids GitHub's limits on
   anonymous requests, and works where GitHub and Discord are blocked (mainland China, some schools).

   /data/game.json     The game repo's leaderboard files, leaderboard history and in-game FAQ (develop branch),
                       plus the latest releases of the game and of this website:
                         { files: { "<path>": "<text>" | null }, releases: [...], siteReleases: [...] }.
                       Refreshed at most once a minute.
   /data/widget.json   The Discord server's member count (from its invite), plus the widget's voice channels and
                       who's in them. Refreshed at most once a minute.
   /data/players.json  Players' Discord names and pictures for the leaderboards (also at /players.json):
                         { "<discord id>": { "name": "server nickname, display name or username", "avatar": "https://cdn.discordapp.com/…" } }
                       Looked up with Ballkyrie's token, only for players on a board. Refreshed at most once an hour.

   Each page also gets the latest copy of all three in <head> as <script type="application/json"> blocks, and its
   "• N members" pills already filled in, so nothing pops in after the page loads. If GitHub or Discord can't be
   reached, the last copy that worked is served for up to a week.

   Secrets (set once from this folder; each asks you to paste the value):
     npx wrangler secret put DISCORD_BOT_TOKEN   Ballkyrie's bot token, for the player names
     npx wrangler secret put GITHUB_TOKEN        optional: any GitHub token, for GitHub's higher rate limits

   Board and answer links (/leaderboards/6-dorado, /faq/pause) get the home page, like /leaderboards and /faq do; the
   page opens the board or answer itself.

   /code/game and /code/site (also /code/website) redirect to the game's and this website's GitHub repos, and
   /releases and /releases/site (also /releases/website) to their release notes. Anything after them carries over,
   so /code/game/issues goes to the game's issues. Anything else passes straight through to the VPS. */

const GUILD_ID = "1212553452283101245";
const INVITE = "Skz6cg9rbR";
const REPO = "ballhallaa/ballkour";
const SITE_REPO = "ballhallaa/ballkour.com";
const GAME = `https://raw.githubusercontent.com/${REPO}/develop`;
const DISCORD_API = "https://discord.com/api/v10";
const STALE_FOR = 7 * 24 * 60 * 60; // seconds: how long the last good copy is kept for when a source is down

/* ---------- Caching ---------- */
const cacheKey = (name, stale) => new Request(`https://ballkour.com/__cache/${name}${stale ? "?stale" : ""}`);

// The cached copy of `name` if it's fresh, else rebuilt by build(previous) and cached for `ttl` seconds. When the
// rebuild fails, the last good copy is served (and rebuilding is tried again on the next request).
async function cached(name, ttl, ctx, build) {
  const fresh = await caches.default.match(cacheKey(name));
  if (fresh) return fresh.text();
  const old = await caches.default.match(cacheKey(name, true));
  const previous = old ? await old.text() : null;
  try {
    const body = await build(previous ? JSON.parse(previous) : null);
    ctx.waitUntil(Promise.all([
      caches.default.put(cacheKey(name), new Response(body, { headers: { "Cache-Control": `public, max-age=${ttl}` } })),
      caches.default.put(cacheKey(name, true), new Response(body, { headers: { "Cache-Control": `public, max-age=${STALE_FOR}` } })),
    ]));
    return body;
  } catch (e) {
    console.error(`${name}: rebuild failed, ${previous ? "serving the last good copy" : "nothing cached yet"}: ${(e && e.message) || e}`);
    if (previous) return previous;
    throw e;
  }
}
// Whatever copy is cached right now, fresh or not, without waiting on GitHub or Discord. A missing or stale copy
// is rebuilt in the background, ready for the page's own request or the next visitor.
async function peek(name, ttl, ctx, build) {
  const fresh = await caches.default.match(cacheKey(name));
  if (fresh) return fresh.text();
  ctx.waitUntil(cached(name, ttl, ctx, build).catch(() => {}));
  const old = await caches.default.match(cacheKey(name, true));
  return old ? old.text() : null;
}

// For copies baked into a page: the cached copy if it's fresh. If not, it's rebuilt right away and the page waits up
// to `wait` ms for it, so a page served after a new release already shows it. If the rebuild takes longer, the last
// good copy goes into the page and the rebuild finishes in the background for the next visitor.
async function soon(name, ttl, ctx, build, wait) {
  const fresh = await caches.default.match(cacheKey(name));
  if (fresh) return fresh.text();
  const rebuild = cached(name, ttl, ctx, build).catch(() => null);
  ctx.waitUntil(rebuild);
  const quick = await Promise.race([rebuild, new Promise((resolve) => setTimeout(resolve, wait))]);
  if (quick) return quick;
  const old = await caches.default.match(cacheKey(name, true));
  return old ? old.text() : null;
}

const json = (body, maxAge) => new Response(body, {
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` },
});
// Says why, so a problem shows up both here and in `npx wrangler tail`
const unavailable = (why) => {
  console.error(why);
  return new Response(JSON.stringify({ error: why }), { status: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
};

/* ---------- Game data from GitHub ---------- */
const githubHeaders = (env) => ({
  "User-Agent": "ballkour.com",
  ...(env.GITHUB_TOKEN ? { Authorization: `token ${env.GITHUB_TOKEN}` } : {}),
});

async function buildGame(env, previous) {
  const headers = githubHeaders(env);
  const get = async (path) => {
    const r = await fetch(`${GAME}/${encodeURI(path)}`, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.text();
  };
  // The leaderboard files are listed in the leaderboard bot's courses.json
  let paths = previous ? Object.keys(previous.files) : [];
  try {
    const courses = JSON.parse(await get("tools/leaderboard-bot/courses.json")).courses;
    paths = ["leaderboards/history.json", "src/engine/faq.opy", ...courses.map((c) => c.file)];
  } catch (e) {
    if (!paths.length) throw e;
  }
  const got = await Promise.allSettled(paths.map(get));
  const failed = got.find((g) => g.status === "rejected");
  const files = {};
  paths.forEach((p, i) => { files[p] = got[i].status === "fulfilled" ? got[i].value : (previous && previous.files[p]) ?? null; });
  if (Object.values(files).every((v) => v === null)) throw new Error(`GitHub can't be reached: ${failed ? failed.reason.message : "no files"}`);

  // Only what the page uses from each release; if GitHub doesn't answer, the previous list is kept
  const releasesOf = async (repo, kept) => {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
        headers: { ...headers, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        // Usually GitHub's limit on requests without a token (60 an hour, shared with other Workers on the same IP)
        const why = (await r.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
        console.error(`releases of ${repo}: GitHub said ${r.status}${env.GITHUB_TOKEN ? "" : " (no GITHUB_TOKEN set)"}; keeping the last list. ${why}`);
        return kept;
      }
      return (await r.json()).filter((x) => !x.draft)
        .map(({ tag_name, html_url, prerelease, published_at }) => ({ tag_name, html_url, prerelease, published_at }));
    } catch (e) {
      console.error(`releases of ${repo}: ${(e && e.message) || e}; keeping the last list`);
      return kept;
    }
  };
  const [releases, siteReleases] = await Promise.all([
    releasesOf(REPO, previous ? previous.releases : null),
    releasesOf(SITE_REPO, previous ? previous.siteReleases ?? null : null),
  ]);
  return JSON.stringify({ files, releases, siteReleases });
}
const game = (env, ctx) => cached("game", 60, ctx, (prev) => buildGame(env, prev));

/* ---------- Discord widget ---------- */
// The member count comes from the server's invite (the widget only counts who's online); the voice channels come
// from the widget. Either one can fail on its own: the other still goes out, and a missing member count keeps the
// last one that worked.
async function buildWidget(previous) {
  const [widget, invite] = await Promise.allSettled([
    fetch(`https://discord.com/api/guilds/${GUILD_ID}/widget.json`, { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`widget: ${r.status}`)))),
    fetch(`${DISCORD_API}/invites/${INVITE}?with_counts=true`, {
      headers: { "User-Agent": "DiscordBot (https://ballkour.com, 1.0)" },
      signal: AbortSignal.timeout(1500),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`invite: ${r.status}`)))),
  ]);
  const d = widget.status === "fulfilled" ? widget.value : null;
  const memberCount = invite.status === "fulfilled" && typeof invite.value.approximate_member_count === "number"
    ? invite.value.approximate_member_count
    : previous && previous.member_count;
  if (typeof memberCount !== "number" && widget.status === "rejected") throw widget.reason;
  // Only what the page uses: the member count, the channel names, and which channel each member is in
  return JSON.stringify({
    ...(typeof memberCount === "number" ? { member_count: memberCount } : {}),
    channels: d ? (d.channels || []).map(({ id, name, position }) => ({ id, name, position })) : (previous && previous.channels) || [],
    members: d ? (d.members || []).filter((m) => m.channel_id).map((m) => ({ channel_id: m.channel_id })) : (previous && previous.members) || [],
  });
}

/* ---------- Players' Discord names ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function discord(token, route) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(DISCORD_API + route, { headers: { Authorization: `Bot ${token}` } });
    if (r.status === 429) { // rate limited: wait as long as Discord asks
      const wait = (await r.json().catch(() => ({}))).retry_after || 1;
      await sleep(Math.min(wait, 5) * 1000 + 250);
      continue;
    }
    return r.ok ? r.json() : null;
  }
  return null;
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
async function buildPlayers(env, ctx, previous) {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("no DISCORD_BOT_TOKEN secret");
  // Every Discord ID on any board: `# discord: ID` in the .opy files and "discord": "ID" in the .json files
  const { files } = JSON.parse(await game(env, ctx));
  const ids = new Set();
  for (const text of Object.values(files)) if (text) for (const m of text.matchAll(/discord"?\s*:\s*"?(\d{17,20})\b/gi)) ids.add(m[1]);
  const found = {};
  const list = [...ids];
  for (let i = 0; i < list.length; i += 5) { // 5 at a time, to stay well inside Discord's rate limits
    const batch = list.slice(i, i + 5);
    const people = await Promise.all(batch.map((id) => lookUp(env.DISCORD_BOT_TOKEN, id).catch(() => null)));
    batch.forEach((id, j) => { const p = people[j] || (previous && previous[id]); if (p) found[id] = p; });
  }
  return JSON.stringify(found);
}

/* ---------- Short links ---------- */
// ballkour.com/code/game → the game repo, /code/site (or /code/website) → this repo.
// ballkour.com/releases (or /releases/game) → the game's release notes, /releases/site (or /releases/website) → this
// website's. A temporary (302) redirect, so browsers don't remember it if a repo ever moves.
const CODE_LINK = /^\/code\/(game|site|website)(\/.*)?$/i;
const RELEASES_LINK = /^\/releases(?:\/(game|site|website)(?=\/|$))?(\/.*)?$/i;
const repoOf = (name) => (/^(site|website)$/i.test(name || "") ? SITE_REPO : REPO);
function shortLink(path) {
  let m, to;
  if ((m = CODE_LINK.exec(path))) to = `https://github.com/${repoOf(m[1])}${m[2] || ""}`;
  else if ((m = RELEASES_LINK.exec(path))) to = `https://github.com/${repoOf(m[1])}/releases${m[2] || ""}`;
  else return null;
  return Response.redirect(to.replace(/\/+$/, ""), 302);
}

/* ---------- Pages ---------- */
const DEEP_LINK = /^\/(?:leaderboards|faq)\/[\w-]+\/?$/i;
async function page(request, env, ctx) {
  // Ask for the full page every time (no 304 Not Modified), so a browser never reuses old data from its cache
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  // /leaderboards/6-dorado and /faq/pause are the home page
  const url = new URL(request.url);
  if (DEEP_LINK.test(url.pathname)) url.pathname = "/";
  const [res, widget, gameData, players] = await Promise.all([
    fetch(new Request(url, { method: "GET", headers, redirect: "manual" })),
    // The online count is worth a short wait (Discord answers in well under the 1.5 s limit), so it's never stale
    cached("widget", 60, ctx, (prev) => buildWidget(prev)).catch(() => null),
    soon("game", 60, ctx, (prev) => buildGame(env, prev), 2500),
    env.DISCORD_BOT_TOKEN ? peek("players", 60 * 60, ctx, (prev) => buildPlayers(env, ctx, prev)) : null,
  ]);
  if (!res.ok || !(res.headers.get("Content-Type") || "").includes("text/html")) return res;
  if (!widget && !gameData && !players) return res;

  const out = new Response(res.body, res);
  out.headers.delete("ETag");
  out.headers.delete("Last-Modified");
  out.headers.set("Cache-Control", "no-cache");

  const script = (id, body) => `<script type="application/json" id="${id}">${body.replace(/</g, "\\u003c")}</script>`;
  const blocks = [["discord-widget", widget], ["game-data", gameData], ["players", players]].filter(([, body]) => body);
  let rw = new HTMLRewriter().on("head", { element(el) { el.append(blocks.map(([id, body]) => script(id, body)).join(""), { html: true }); } });
  const count = widget && JSON.parse(widget).member_count;
  if (typeof count === "number") {
    rw = rw
      .on("[data-members-wrap]", { element(el) { el.removeAttribute("hidden"); } })
      .on("[data-members]", { element(el) { el.setInnerContent(`${count.toLocaleString("en")} members`); } });
  }
  return rw.transform(out);
}

export default {
  async fetch(request, env, ctx) {
    // If anything here throws, Cloudflare serves the request from the VPS as if the Worker weren't there
    ctx.passThroughOnException();
    if (request.method !== "GET") return fetch(request);
    const path = new URL(request.url).pathname;
    const short = shortLink(path);
    if (short) return short;
    try {
      if (path === "/data/game.json") return json(await game(env, ctx), 60);
      if (path === "/data/widget.json") return json(await cached("widget", 60, ctx, (prev) => buildWidget(prev)), 60);
      if (path === "/data/players.json" || path === "/players.json") {
        if (!env.DISCORD_BOT_TOKEN) return unavailable("The DISCORD_BOT_TOKEN secret isn't set");
        return json(await cached("players", 60 * 60, ctx, (prev) => buildPlayers(env, ctx, prev)), 300);
      }
    } catch (e) {
      if (path.startsWith("/data/") || path === "/players.json") return unavailable(String((e && e.message) || e));
    }
    return DEEP_LINK.test(path) || (request.headers.get("Accept") || "").includes("text/html") ? page(request, env, ctx) : fetch(request);
  },
};
