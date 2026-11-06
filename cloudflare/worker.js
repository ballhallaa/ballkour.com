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
   /api/…              Signing in with Discord, and runs sent from the form under Submit a run, which go on the boards
                       straight away. See "Signing in with Discord, and runs sent from the website" below.

   Each page also gets the latest copy of all three in <head> as <script type="application/json"> blocks, and its
   "• N members" pills already filled in, so nothing pops in after the page loads. If GitHub or Discord can't be
   reached, the last copy that worked is served for up to a week.

   Secrets (set once from this folder; each asks you to paste the value):
     npx wrangler secret put DISCORD_BOT_TOKEN   Ballkyrie's bot token, for the player names
     npx wrangler secret put GITHUB_TOKEN        a GitHub token that can write the game repo's contents, for saving runs
                                                 sent from the website (and GitHub's higher rate limits)
     npx wrangler secret put DISCORD_CLIENT_ID      Ballkyrie's application ID, for signing in with Discord
     npx wrangler secret put DISCORD_CLIENT_SECRET  Ballkyrie's OAuth2 client secret
     npx wrangler secret put SESSION_SECRET         any long random string, for signing the sign-in cookie
     npx wrangler secret put SUBMIT_WEBHOOK      optional: a channel's webhook URL, where runs sent from the website are logged

   Board and answer links (/leaderboards/6, /leaderboards/3/legacy, /faq/pausing) get the home page, like /leaderboards and /faq do; the
   page opens the board or answer itself.

   /code/game and /code/site (also /code/website) redirect to the game's and this website's GitHub repos, and
   /releases and /releases/site (also /releases/website) to their release notes. Anything after them carries over,
   so /code/game/issues goes to the game's issues. Everything else is the site's own files, which Cloudflare serves from its copy of this repo. */

const GUILD_ID = "1212553452283101245";
const INVITE = "Skz6cg9rbR";
const REPO = "ballhallaa/ballkour";
const SITE_REPO = "ballhallaa/ballkour.com";
const GAME = `https://raw.githubusercontent.com/${REPO}/develop`;
const DISCORD_API = "https://discord.com/api/v10";
const STALE_FOR = 7 * 24 * 60 * 60; // seconds: how long the last good copy is kept for when a source is down

/* ---------- Caching ---------- */
// Bump the version whenever what a copy holds changes. The last good copy is reused for as long as its source can't be
// reached, so under the same key a copy saved by an older Worker can outlive the change.
const CACHE_VERSION = 3;
const cacheKey = (name, stale) => new Request(`https://ballkour.com/__cache/v${CACHE_VERSION}/${name}${stale ? "?stale" : ""}`);

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
// Whatever copy is cached right now, fresh or not, without rebuilding it
async function stored(name) {
  const copy = (await caches.default.match(cacheKey(name))) || (await caches.default.match(cacheKey(name, true)));
  return copy ? copy.text() : null;
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
    // runs.json changes with every run sent from the website, so it's read through GitHub's API, which always has
    // the newest copy (raw files can be a few minutes behind)
    const viaApi = path === RUNS_FILE && env.GITHUB_TOKEN;
    const r = await fetch(viaApi ? `https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}?ref=develop` : `${GAME}/${encodeURI(path)}`, {
      headers: viaApi ? { ...headers, Accept: "application/vnd.github.raw+json" } : headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.text();
  };
  // The leaderboard files are listed in the leaderboard bot's courses.json. runs.json has the runs that never made a
  // top 10 and the runs taken off the boards, for the boards' "Show all" and the player ratings.
  let paths = previous ? Object.keys(previous.files) : [];
  try {
    const courses = JSON.parse(await get("tools/leaderboard-bot/courses.json")).courses;
    paths = ["leaderboards/history.json", RUNS_FILE, "src/engine/faq.opy", ...courses.map((c) => c.file)];
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
      const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
        headers: { ...headers, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        // Usually GitHub's limit on requests without a token (60 an hour, shared with other Workers on the same IP)
        const why = (await r.text().catch(() => "")).slice(0, 160).replace(/\s+/g, " ");
        console.error(`releases of ${repo}: GitHub said ${r.status}${env.GITHUB_TOKEN ? "" : " (no GITHUB_TOKEN set)"}; keeping the last list. ${why}`);
        return kept;
      }
      // Newest first by date: GitHub orders them by tag, where v2026.11.02-beta.9 comes before beta.13
      const all = (await r.json()).filter((x) => !x.draft)
        .map(({ tag_name, html_url, prerelease, published_at }) => ({ tag_name, html_url, prerelease, published_at }))
        .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
      // The page only shows the newest release and the newest stable one, which can be dozens of betas back
      const stable = all.find((x) => !x.prerelease);
      return all.filter((x, i) => i === 0 || x === stable);
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
// The member count comes from the server itself, asked with Ballkyrie's token (Discord often turns down the public
// invite lookup from Cloudflare), or from the server's invite without the token. The voice channels come from the
// widget. Either can fail on its own: the other still goes out, and a missing member count keeps the last one that
// worked.
async function memberCountOf(env) {
  if (env.DISCORD_BOT_TOKEN) {
    const r = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}?with_counts=true`, {
      headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
      signal: AbortSignal.timeout(1500),
    }).catch(() => null);
    const d = r && r.ok ? await r.json().catch(() => null) : null;
    if (d && typeof d.approximate_member_count === "number") return d.approximate_member_count;
    console.error(`member count: Discord said ${r ? r.status : "nothing"} with the bot token; trying the invite`);
  }
  const r = await fetch(`${DISCORD_API}/invites/${INVITE}?with_counts=true`, {
    headers: { "User-Agent": "DiscordBot (https://ballkour.com, 1.0)" },
    signal: AbortSignal.timeout(1500),
  });
  if (!r.ok) throw new Error(`invite: ${r.status}`);
  const d = await r.json();
  if (typeof d.approximate_member_count !== "number") throw new Error("invite: no member count");
  return d.approximate_member_count;
}
async function buildWidget(env, previous) {
  const [widget, count] = await Promise.allSettled([
    fetch(`https://discord.com/api/guilds/${GUILD_ID}/widget.json`, { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`widget: ${r.status}`)))),
    memberCountOf(env),
  ]);
  const d = widget.status === "fulfilled" ? widget.value : null;
  if (count.status === "rejected") console.error(`member count: ${count.reason.message}`);
  const memberCount = count.status === "fulfilled" ? count.value : previous && previous.member_count;
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
  // Every Discord ID on any board: `# discord: ID` in the .opy files and "discord": "ID" in the .json files. They come
  // from whatever game data is cached, so refreshing the names doesn't fetch the game data from GitHub again too.
  const { files } = JSON.parse((await stored("game")) ?? (await game(env, ctx)));
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

/* ---------- Signing in with Discord, and runs sent from the website ----------
   Players sign in with Discord (OAuth2 with the "identify" scope: their ID, name and picture, nothing else) to send a
   run from the form under Submit a run. The run goes on the boards straight away: it's saved under their Discord ID
   in leaderboards/runs.json on the game repo's develop branch (one commit per run), and the leaderboard bot picks that
   up to post the board and give out roles. Nobody can send a run as someone else: it's always the sender's, whatever
   in-game name they type (in-game names aren't unique, so they're never checked against other players').
     GET  /api/login     Discord's sign-in page, then /api/login/callback, then back to /submit
     GET  /api/me        { on, user: { id, name, avatar } | null }: whether sending runs is set up, and who's signed in
     POST /api/logout
     POST /api/submit    { course, name, time, mistakes, video } → { ok: true, run, saved } (saved is false when that
                         exact run was already in) or { error }, the error saying
                         what to fix: login (not signed in), course, name, time, miss, video, rate (too many), off
                         (not set up, or GitHub didn't take it) or bad
   The session is a cookie signed with SESSION_SECRET that lasts 30 days. Nothing about it is stored here.
   Secrets: DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (Ballkyrie's app in Discord's Developer Portal, OAuth2 page,
   with https://ballkour.com/api/login/callback added as a redirect), SESSION_SECRET (any long random string) and
   GITHUB_TOKEN, which has to be able to write the game repo's contents. Without all four, the form stays hidden.
   SUBMIT_WEBHOOK is optional: a Discord channel's webhook URL, where every run sent from the website is logged.
   SUBMIT_LIMIT (wrangler.toml) allows 5 sends a minute from one Discord account, and runs.json at most 20 a day. */
const RUNS_FILE = "leaderboards/runs.json";
const SESSION_DAYS = 30;
const loginOn = (env) => !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.SESSION_SECRET && env.GITHUB_TOKEN);
// The same checks as the page's. Names can't have commas or quotes, which the in-game boards' files use.
const NAME_OK = /^[^\u0000-\u001f\u007f"`\\,<>]{1,32}$/u;
const toSeconds = (t) => t.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
// "4:05.81" (or "1:04:05.81", or with a decimal comma) → "4:05.81", or "" if it isn't a time
function cleanTime(v) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{2})$/.exec(v.trim());
  if (!m || Number(m[3]) > 59 || (m[1] && Number(m[2]) > 59)) return "";
  const out = m[1] ? `${Number(m[1])}:${m[2].padStart(2, "0")}:${m[3]}.${m[4]}` : `${Number(m[2])}:${m[3]}.${m[4]}`;
  return toSeconds(out) > 0 ? out : "";
}
// A link to the video (https:// is added if it's left off), or "" if it isn't one. Brackets are escaped, so the
// link can't turn into a Discord [masked link](…).
function cleanVideo(v) {
  v = v.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "https://" + v;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !/\.[a-z]{2,}$/i.test(u.hostname) || v.length > 300 || /[\s"'<>`]/.test(v)) return "";
    return u.href.replace(/[[\]()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  } catch (e) { return ""; }
}
const answer = (status, body, cookies = []) => {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  cookies.forEach((c) => headers.append("Set-Cookie", c));
  return new Response(JSON.stringify(body), { status, headers });
};
const mdSafe = (s) => String(s).replace(/([\\*_~`|>#[\]()-])/g, "\\$1");

// Base64 for text and bytes, and the URL-safe kind for cookies
const utf8 = new TextEncoder();
function base64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const unbase64 = (s) => Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0));
const b64url = (bytes) => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => unbase64(s.replace(/-/g, "+").replace(/_/g, "/"));
const text = (bytes) => new TextDecoder().decode(bytes);

/* The session cookie: the Discord account, signed so it can't be made up */
const hmacKey = (env) => crypto.subtle.importKey("raw", utf8.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const cookie = (name, value, maxAge, path = "/") => `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
async function signSession(env, user) {
  const body = b64url(utf8.encode(JSON.stringify({ ...user, exp: Date.now() + SESSION_DAYS * 864e5 })));
  return `${body}.${b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(env), utf8.encode(body))))}`;
}
async function readSession(request, env) {
  if (!loginOn(env)) return null;
  const m = /(?:^|;\s*)bk_session=([\w-]+)\.([\w-]+)/.exec(request.headers.get("Cookie") || "");
  if (!m) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(env), unb64url(m[2]), utf8.encode(m[1])))) return null;
    const user = JSON.parse(text(unb64url(m[1])));
    return user && user.exp > Date.now() && /^\d{17,20}$/.test(user.id) ? user : null;
  } catch (e) { return null; }
}
// Where to go back to after signing in: a page of the site, with its language
const backTo = (to) => (/^\/[\w/-]*(\?lang=[\w-]+)?$/.test(to || "") ? to : "/submit");

async function login(request, env) {
  const url = new URL(request.url);
  if (!loginOn(env)) return Response.redirect(`${url.origin}/submit`, 302);
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const auth = new URL("https://discord.com/oauth2/authorize");
  auth.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID, response_type: "code", scope: "identify", prompt: "none", state,
    redirect_uri: `${url.origin}/api/login/callback`,
  });
  // The state comes back from Discord and has to match, so nobody can sign someone in with their own account
  const headers = new Headers({ Location: auth.href });
  headers.append("Set-Cookie", cookie("bk_login", `${state}.${b64url(utf8.encode(backTo(url.searchParams.get("to"))))}`, 600, "/api/login"));
  return new Response(null, { status: 302, headers });
}
async function loginCallback(request, env) {
  const url = new URL(request.url);
  const m = /(?:^|;\s*)bk_login=([\w-]+)\.([\w-]+)/.exec(request.headers.get("Cookie") || "");
  let to = "/submit";
  try { if (m) to = backTo(text(unb64url(m[2]))); } catch (e) { /* stays /submit */ }
  const back = (session) => {
    const headers = new Headers({ Location: url.origin + to });
    headers.append("Set-Cookie", cookie("bk_login", "", 0, "/api/login"));
    if (session) headers.append("Set-Cookie", cookie("bk_session", session, SESSION_DAYS * 86400));
    return new Response(null, { status: 302, headers });
  };
  const code = url.searchParams.get("code");
  if (!loginOn(env) || !m || !code || url.searchParams.get("state") !== m[1]) return back(null); // cancelled, or a stale link
  const token = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code,
      redirect_uri: `${url.origin}/api/login/callback`,
    }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const me = token && token.access_token
    ? await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(5000) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null)
    : null;
  if (!me || !/^\d{17,20}$/.test(me.id)) {
    console.error("login: Discord didn't hand over the account");
    return back(null);
  }
  const avatar = me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(me.id) >> 22n) % 6n)}.png`;
  return back(await signSession(env, { id: me.id, name: me.global_name || me.username, avatar }));
}
async function whoAmI(request, env) {
  const user = await readSession(request, env);
  return answer(200, { on: loginOn(env), user: user && { id: user.id, name: user.name, avatar: user.avatar } });
}

/* Saving a run */
// One run per line, so runs.json stays easy to read and edit by hand
function dumpRuns(data) {
  const run = (r) => (r && typeof r === "object" && !Array.isArray(r)
    ? "{" + Object.entries(r).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}"
    : JSON.stringify(r));
  const group = (obj) => {
    const keys = Object.keys(obj && typeof obj === "object" ? obj : {}).filter((k) => Array.isArray(obj[k]))
      .sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1));
    return keys.length ? "{\n" + keys.map((k) => `    ${JSON.stringify(k)}: [` +
      (obj[k].length ? "\n" + obj[k].map((r) => "      " + run(r)).join(",\n") + "\n    " : "") + "]").join(",\n") + "\n  }" : "{}";
  };
  const others = Object.entries(data).filter(([k]) => k !== "runs" && k !== "removed");
  return `{\n  "runs": ${group(data.runs)},\n  "removed": ${group(data.removed)}` +
    others.map(([k, v]) => `,\n  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join("") + "\n}\n";
}
// Adds the run to runs.json on develop through GitHub's API, reading it again if someone else saved in between.
// → { text } (the new runs.json, or null if this exact run was already in), or { error, status }
async function saveRun(env, n, run) {
  const api = `https://api.github.com/repos/${REPO}/contents/${RUNS_FILE}`;
  const headers = { ...githubHeaders(env), Accept: "application/vnd.github+json" };
  let why = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await fetch(`${api}?ref=develop`, { headers, signal: AbortSignal.timeout(5000) });
    if (!got.ok && got.status !== 404) { why = `reading it: ${got.status} ${(await got.text()).slice(0, 200)}`; break; }
    const meta = got.ok ? await got.json() : null;
    let data;
    try { data = meta ? JSON.parse(text(unbase64(meta.content))) : {}; } catch (e) { why = "it isn't valid JSON"; break; }
    if (!data || typeof data !== "object" || Array.isArray(data)) { why = "it isn't a JSON object"; break; }
    if (!data.runs || typeof data.runs !== "object") data.runs = {};
    if (!data.removed || typeof data.removed !== "object") data.removed = {};
    const list = Array.isArray(data.runs[n]) ? data.runs[n] : (data.runs[n] = []);
    // The same run sent twice is only saved once
    if (list.some((r) => r && r.discord === run.discord && r.time === run.time && r.mistakes === run.mistakes)) return { text: null };
    const today = Object.values(data.runs).flat().filter((r) => r && r.discord === run.discord && r.date === run.date).length;
    if (today >= 20) return { error: "rate", status: 429 };
    list.push(run);
    const next = dumpRuns(data);
    const put = await fetch(api, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `chore(leaderboard): add ${run.name}'s ${run.time} on course ${n} from ballkour.com`,
        content: base64(utf8.encode(next)),
        branch: "develop",
        ...(meta ? { sha: meta.sha } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (put.ok) return { text: next };
    why = `saving it: ${put.status} ${(await put.text()).slice(0, 300)}`;
    if (put.status !== 409) break; // 409: runs.json changed since it was read, so read it again
  }
  console.error(`submit: couldn't save to ${RUNS_FILE}, ${why}`);
  return { error: "off", status: 502 };
}
// The site shows a saved run straight away: the cached game data gets the new runs.json, and the player's Discord
// name and picture go in until the hourly lookup has them. (Copies from GitHub have the run too: runs.json is read
// through GitHub's API, which doesn't serve old copies the way raw files can.)
async function putCached(name, ttl, body) {
  await Promise.all([
    caches.default.put(cacheKey(name), new Response(body, { headers: { "Cache-Control": `public, max-age=${ttl}` } })),
    caches.default.put(cacheKey(name, true), new Response(body, { headers: { "Cache-Control": `public, max-age=${STALE_FOR}` } })),
  ]);
}
async function showSaved(runsText, user) {
  const gameCopy = await stored("game");
  if (gameCopy && runsText) {
    const d = JSON.parse(gameCopy);
    d.files[RUNS_FILE] = runsText;
    await putCached("game", 60, JSON.stringify(d));
  }
  const playersCopy = await stored("players");
  if (playersCopy) {
    const d = JSON.parse(playersCopy);
    if (!d[user.id]) { d[user.id] = { name: user.name, avatar: user.avatar }; await putCached("players", 60 * 60, JSON.stringify(d)); }
  }
}
// A line in the log channel for every run sent from the website, if there is one
async function logRun(env, n, file, run, user) {
  if (!env.SUBMIT_WEBHOOK) return;
  const res = await fetch(env.SUBMIT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "ballkour.com",
      allowed_mentions: { parse: [] }, // shows who sent it without pinging them
      embeds: [{
        title: `New run on course ${n}${file ? ` (${file.replace(/^leaderboards\//, "")})` : ""}`,
        url: `https://ballkour.com/leaderboards/${n}`,
        color: 0x00e697,
        fields: [
          { name: "Player", value: mdSafe(run.name), inline: true },
          { name: "Time", value: run.time, inline: true },
          { name: "Mistakes", value: String(run.mistakes), inline: true },
          { name: "Sent by", value: `<@${user.id}> (${mdSafe(user.name)})`, inline: true },
          { name: "Video", value: `<${run.video}>` },
        ],
        footer: { text: `Saved to ${RUNS_FILE}. To take it off, move it to "removed" there.` },
        timestamp: new Date().toISOString(),
      }],
    }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => ({ ok: false, status: String((e && e.message) || e) }));
  if (!res.ok) console.error(`submit: the log webhook said ${res.status}`);
}

async function submit(request, env, ctx) {
  if (request.method !== "POST") return answer(405, { error: "bad" });
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return answer(403, { error: "bad" });
  if (!loginOn(env)) return answer(503, { error: "off" });
  const user = await readSession(request, env);
  if (!user) return answer(401, { error: "login" });
  if (env.SUBMIT_LIMIT && !(await env.SUBMIT_LIMIT.limit({ key: user.id })).success) return answer(429, { error: "rate" });

  let body;
  try {
    const raw = await request.text();
    body = raw.length <= 4096 ? JSON.parse(raw) : null;
  } catch (e) { body = null; }
  if (!body || typeof body !== "object") return answer(400, { error: "bad" });
  const n = Number(body.course);
  const name = String(body.name ?? "").trim();
  const time = cleanTime(String(body.time ?? ""));
  const mistakes = Number(body.mistakes);
  const video = cleanVideo(String(body.video ?? ""));
  if (!Number.isInteger(n) || n < 1 || n > 99) return answer(400, { error: "course" });
  if (!NAME_OK.test(name)) return answer(400, { error: "name" });
  if (!time) return answer(400, { error: "time" });
  if (!Number.isInteger(mistakes) || mistakes < 0 || mistakes > 9999) return answer(400, { error: "miss" });
  if (!video) return answer(400, { error: "video" });

  // The course has to have a board, going by whatever game data is cached (fetched if there's none yet)
  let files = null;
  try { files = JSON.parse((await stored("game")) ?? (await game(env, ctx))).files; } catch (e) { files = null; }
  const file = files && Object.keys(files).find((k) => k.startsWith(`leaderboards/${n}-`) && /\.(opy|json)$/.test(k));
  if (files && !file) return answer(400, { error: "course" });

  const run = { name: name.toUpperCase(), discord: user.id, time, mistakes, date: new Date().toISOString().slice(0, 10), video };
  const saved = await saveRun(env, n, run);
  if (saved.error) return answer(saved.status, { error: saved.error });
  await showSaved(saved.text, user).catch((e) => console.error(`submit: couldn't update the cached copy: ${(e && e.message) || e}`));
  if (saved.text) ctx.waitUntil(logRun(env, n, file, run, user));
  return answer(200, { ok: true, run, saved: !!saved.text });
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

/* ---------- Files and headers ---------- */
// The security headers Caddy used to add, on every response
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self' https://cloudflareinsights.com; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
function secure(res) {
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}
// One of the site's files, cached like Caddy did: logo, icons and preview image for a week; the page and
// translations are checked for a newer copy on every visit
async function file(request, env) {
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  const path = new URL(request.url).pathname;
  out.headers.set("Cache-Control", res.ok && path.startsWith("/assets/") ? "public, max-age=604800" : "no-cache");
  return out;
}

/* ---------- Pages ---------- */
const DEEP_LINK = /^\/(?:leaderboards\/[\w-]+(?:\/legacy)?|faq\/[\w-]+)\/?$/i;
async function page(request, env, ctx) {
  // Ask for the full page every time (no 304 Not Modified), so a browser never reuses old data from its cache
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  // /leaderboards/6 and /faq/pausing are the home page
  const url = new URL(request.url);
  if (DEEP_LINK.test(url.pathname)) url.pathname = "/";
  // Cloudflare's free plan allows 50 fetches per request. Refreshing the game data takes about 20 and the player names
  // one or two per player, so a page load only refreshes the names when the game data is fresh. Past the limit, the
  // releases (fetched last) can't be refreshed and every page keeps getting the last list.
  const freshGame = await caches.default.match(cacheKey("game"));
  const [res, widget, gameData, players] = await Promise.all([
    file(new Request(url, { method: "GET", headers, redirect: "manual" }), env),
    // The online count is worth a short wait (Discord answers in well under the 1.5 s limit), so it's never stale
    cached("widget", 60, ctx, (prev) => buildWidget(env, prev)).catch(() => null),
    freshGame ? freshGame.text() : soon("game", 60, ctx, (prev) => buildGame(env, prev), 2500),
    !env.DISCORD_BOT_TOKEN ? null
      : freshGame ? peek("players", 60 * 60, ctx, (prev) => buildPlayers(env, ctx, prev))
      : stored("players"),
  ]);
  if (!res.ok || !(res.headers.get("Content-Type") || "").includes("text/html")) return res;
  const on = loginOn(env);
  if (!widget && !gameData && !players && !on) return res;

  const out = new Response(res.body, res);
  out.headers.delete("ETag");
  out.headers.delete("Last-Modified");
  out.headers.set("Cache-Control", "no-cache");

  const script = (id, body) => `<script type="application/json" id="${id}">${body.replace(/</g, "\\u003c")}</script>`;
  const blocks = [["discord-widget", widget], ["game-data", gameData], ["players", players]].filter(([, body]) => body);
  let rw = new HTMLRewriter().on("head", { element(el) { el.append(blocks.map(([id, body]) => script(id, body)).join(""), { html: true }); } });
  // Sending runs from the website is set up (see "Signing in with Discord"): the page shows the form
  if (on) rw = rw.on("#submit", { element(el) { el.setAttribute("data-login", "on"); } });
  const count = widget && JSON.parse(widget).member_count;
  if (typeof count === "number") {
    rw = rw
      .on("[data-members-wrap]", { element(el) { el.removeAttribute("hidden"); } })
      .on("[data-members]", { element(el) { el.setInnerContent(`${count.toLocaleString("en")} members`); } });
  }
  return rw.transform(out);
}

async function handle(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/")) {
    try {
      if (path === "/api/login" && request.method === "GET") return await login(request, env);
      if (path === "/api/login/callback" && request.method === "GET") return await loginCallback(request, env);
      if (path === "/api/me" && request.method === "GET") return await whoAmI(request, env);
      if (path === "/api/logout" && request.method === "POST") {
        if (request.headers.get("Origin") !== new URL(request.url).origin) return answer(403, { error: "bad" });
        return answer(200, { ok: true }, [cookie("bk_session", "", 0)]);
      }
      if (path === "/api/submit") return await submit(request, env, ctx);
      return answer(404, { error: "bad" });
    } catch (e) {
      console.error(`${path}: ${(e && e.message) || e}`);
      return answer(500, { error: "off" });
    }
  }
  if (request.method !== "GET") return file(request, env);
  const short = shortLink(path);
  if (short) return short;
  try {
    if (path === "/data/game.json") return json(await game(env, ctx), 60);
    if (path === "/data/widget.json") return json(await cached("widget", 60, ctx, (prev) => buildWidget(env, prev)), 60);
    if (path === "/data/players.json" || path === "/players.json") {
      if (!env.DISCORD_BOT_TOKEN) return unavailable("The DISCORD_BOT_TOKEN secret isn't set");
      return json(await cached("players", 60 * 60, ctx, (prev) => buildPlayers(env, ctx, prev)), 300);
    }
  } catch (e) {
    if (path.startsWith("/data/") || path === "/players.json") return unavailable(String((e && e.message) || e));
  }
  return DEEP_LINK.test(path) || (request.headers.get("Accept") || "").includes("text/html") ? page(request, env, ctx) : file(request, env);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return secure(await handle(request, env, ctx));
    } catch (e) {
      // If anything here breaks, the plain file still goes out, just without the baked-in data
      console.error(`serving the plain file instead: ${(e && e.message) || e}`);
      return secure(await file(request, env));
    }
  },
};
