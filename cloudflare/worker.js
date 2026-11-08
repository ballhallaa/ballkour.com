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
                       straight away. See "Signing in with Discord, and runs sent from the website" below. Players'
                       stats on their Discord profiles too: see "Stats on Discord profiles".

   Each page also gets the latest copy of all three in <head> as <script type="application/json"> blocks, and its
   "• N members" pills already filled in, so nothing pops in after the page loads. If GitHub or Discord can't be
   reached, the last copy that worked is served for up to a week.

   Secrets (set once from this folder; each asks you to paste the value):
     npx wrangler secret put DISCORD_BOT_TOKEN   Ballkyrie's bot token, for the player names
     npx wrangler secret put GITHUB_TOKEN        optional: any GitHub token, for GitHub's higher rate limits
     npx wrangler secret put GITHUB_APP_ID          the GitHub App that saves runs sent from the website to the game repo
     npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem   its private key, the .pem file as GitHub hands it out
     npx wrangler secret put DISCORD_CLIENT_ID      Ballkyrie's application ID, for signing in with Discord
     npx wrangler secret put DISCORD_CLIENT_SECRET  Ballkyrie's OAuth2 client secret
     npx wrangler secret put SESSION_SECRET         any long random string, for signing the sign-in cookie
     npx wrangler secret put SUBMIT_CHANNEL      optional: the channel ID where Ballkyrie logs runs sent from the website
   and the PROFILES KV namespace (wrangler.toml), for the stats on players' Discord profiles.

   Board and answer links (/leaderboards/6, /leaderboards/3/legacy, /faq/pausing) get the home page, like /leaderboards and /faq do; the
   page opens the board or answer itself.

   /code/game and /code/site (also /code/website) redirect to the game's and this website's GitHub repos, and
   /releases and /releases/site (also /releases/website) to their release notes. Anything after them carries over,
   so /code/game/issues goes to the game's issues. Everything else is the site's own files, which Cloudflare serves from its copy of this repo. */

import { loadCourses, rate, standings, playerKey } from "./ratings.js";

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
const CACHE_VERSION = 5;
const cacheKey = (name, stale) => new Request(`https://ballkour.com/__cache/v${CACHE_VERSION}/${name}${stale ? "?stale" : ""}`);

// The cached copy of `name` if it's fresh, else rebuilt by build(previous) and cached for `ttl` seconds. When the
// rebuild fails, the last good copy is served (and rebuilding is tried again on the next request). A build that only
// partly worked can return { body, ttl } to be kept for less time, so it's tried again sooner.
async function cached(name, ttl, ctx, build) {
  const fresh = await caches.default.match(cacheKey(name));
  if (fresh) return fresh.text();
  const old = await caches.default.match(cacheKey(name, true));
  const previous = old ? await old.text() : null;
  try {
    const built = await build(previous ? JSON.parse(previous) : null);
    const { body, ttl: keep = ttl } = typeof built === "string" ? { body: built } : built;
    ctx.waitUntil(Promise.all([
      caches.default.put(cacheKey(name), new Response(body, { headers: { "Cache-Control": `public, max-age=${keep}` } })),
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

/* The GitHub App that saves runs sent from the website to the game repo, as itself (ballkour.com's bot, not a person).
   It's the one thing besides deploy keys allowed past develop's pull request rule. Secrets: GITHUB_APP_ID and
   GITHUB_APP_PRIVATE_KEY (the .pem GitHub hands out, as it is). The app needs Contents: Read and write, and to be
   installed on the game repo. A token is made each time one's needed (each lasts an hour), so none is kept. */
const appOn = (env) => !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
// GitHub's keys are PKCS#1 ("BEGIN RSA PRIVATE KEY"), and Web Crypto only reads PKCS#8, which wraps one
function pkcs8(pem) {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  if (/BEGIN PRIVATE KEY/.test(pem)) return der;
  const len = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
  const rsa = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]; // rsaEncryption
  const body = [0x02, 0x01, 0x00, ...rsa, 0x04, ...len(der.length), ...der];
  return new Uint8Array([0x30, ...len(body.length), ...body]);
}
async function appToken(env) {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(env.GITHUB_APP_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => b64url(utf8.encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: now - 60, exp: now + 540, iss: String(env.GITHUB_APP_ID) })}`;
  const jwt = `${unsigned}.${b64url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(unsigned))))}`;
  const headers = { "User-Agent": "ballkour.com", Accept: "application/vnd.github+json", Authorization: `Bearer ${jwt}` };
  const where = await fetch(`https://api.github.com/repos/${REPO}/installation`, { headers, signal: AbortSignal.timeout(5000) });
  if (!where.ok) throw new Error(`the GitHub App isn't installed on ${REPO} (${where.status} ${(await where.text()).slice(0, 120)})`);
  const made = await fetch(`https://api.github.com/app/installations/${(await where.json()).id}/access_tokens`, { method: "POST", headers, signal: AbortSignal.timeout(5000) });
  if (!made.ok) throw new Error(`the GitHub App got no token (${made.status} ${(await made.text()).slice(0, 120)})`);
  return (await made.json()).token;
}

async function buildGame(env, previous) {
  const headers = githubHeaders(env);
  const get = async (path) => {
    // runs.json changes with every run sent from the website, so it's read through GitHub's API, which always has
    // the newest copy (raw files can be a few minutes behind)
    // (with GITHUB_TOKEN if it's set, or else as the GitHub App)
    const viaApi = path === RUNS_FILE && (env.GITHUB_TOKEN || appOn(env));
    const auth = viaApi && !env.GITHUB_TOKEN ? { Authorization: `Bearer ${await appToken(env)}` } : {};
    const r = await fetch(viaApi ? `https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}?ref=${runsBranch(env)}` : `${GAME}/${encodeURI(path)}`, {
      headers: viaApi ? { ...headers, ...auth, Accept: "application/vnd.github.raw+json" } : headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.text();
  };
  // The leaderboard files are listed in the leaderboard bot's courses.json. runs.json has the runs that never made a
  // top 10 and the runs taken off the boards, for the boards' "Show all" and the player ratings.
  // Its course names are kept too, for the log of runs sent from the website, and each course's number, file and
  // whether it's broken, for the stats on players' Discord profiles.
  let paths = previous ? Object.keys(previous.files) : [];
  let names = (previous && previous.names) || {};
  let list = (previous && previous.courses) || null;
  try {
    const courses = JSON.parse(await get("tools/leaderboard-bot/courses.json")).courses;
    paths = ["leaderboards/history.json", RUNS_FILE, "src/engine/faq.opy", ...courses.map((c) => c.file)];
    names = Object.fromEntries(courses.map((c) => [c.n, c.name]));
    list = courses.map(({ n, file, broken }) => ({ n, file, broken: !!broken }));
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
  return JSON.stringify({ files, names, ...(list ? { courses: list } : {}), releases, siteReleases });
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
// Discord says 401 when the token is wrong or was reset in the Developer Portal. Then nobody can be looked up, so the
// rebuild fails (and `npx wrangler tail` says why) instead of saving a list with nobody on it for an hour.
class BadToken extends Error {}
// What Discord answered, or null when it has nobody by that ID (or isn't letting Ballkyrie see them). Anything else
// (rate limits, Discord being down, a timeout) throws and says why, so the player can be looked up again soon.
async function discord(token, route) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(DISCORD_API + route, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(5000) });
    if (r.ok) return r.json();
    if (r.status === 401) throw new BadToken("Discord turned down DISCORD_BOT_TOKEN (401): set it again to Ballkyrie's current token");
    if (r.status === 403 || r.status === 404) return null;
    const text = await r.text().catch(() => "");
    let wait = NaN;
    try { wait = Number(JSON.parse(text).retry_after); } catch (e) { /* not JSON: Cloudflare's block page */ }
    // Rate limited: wait as long as Discord asks, if that's a few seconds. Longer, or no answer at all, means Discord
    // has blocked Cloudflare's address for a while, and waiting here won't help.
    if (r.status === 429 && attempt < 2 && wait <= 5) { await sleep(wait * 1000 + 250); continue; }
    throw new Error(`${r.status} ${text.replace(/\s+/g, " ").slice(0, 100)}`);
  }
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
  // Ballkyrie too (a bot's user ID is its app's ID), for its name and picture where the sign-in panel mentions it
  if (botId(env)) ids.add(botId(env));
  const found = {};
  const failed = [];
  const list = [...ids];
  for (let i = 0; i < list.length; i += 5) { // 5 at a time, to stay well inside Discord's rate limits
    const batch = list.slice(i, i + 5);
    const people = await Promise.all(batch.map((id) => lookUp(env.DISCORD_BOT_TOKEN, id).catch((e) => {
      if (e instanceof BadToken) throw e;
      failed.push((e && e.message) || String(e));
      return null;
    })));
    batch.forEach((id, j) => { const p = people[j] || (previous && previous[id]); if (p) found[id] = p; });
  }
  if (!failed.length) return JSON.stringify(found);
  // Whoever Discord didn't answer for keeps their last name, or goes without one for now. Kept for an hour, a list
  // like that would hide them until the next hour, so it's tried again in a few minutes instead.
  console.error(`players: Discord didn't answer for ${failed.length} of ${list.length} players, trying again in 5 minutes. First: ${failed[0]}`);
  return { body: JSON.stringify(found), ttl: 5 * 60 };
}

/* ---------- Signing in with Discord, and runs sent from the website ----------
   Players sign in with Discord (OAuth2 with the "identify" scope: their ID, name and picture, nothing else) to send a
   run from the form under Submit a run. The run goes on the boards straight away: it's saved under their Discord ID
   in leaderboards/runs.json on the game repo's develop branch (one commit per run), and the leaderboard bot picks that
   up to post the board and give out roles. Nobody can send a run as someone else: it's always the sender's, whatever
   in-game name they type (in-game names aren't unique, so they're never checked against other players').
     GET  /api/login     Discord's sign-in page, then /api/login/callback, then back to /submit
     GET  /api/me        { on, user: { id, name, avatar, reviewer, profile, role } | null }: whether sending runs is set
                         up, and who's signed in (profile: whether their stats are on their Discord profile, and role:
                         whether they have the Discord Profile App role it needs, see "Stats on Discord profiles")
     POST /api/logout
     POST /api/submit    { course, name, time, mistakes, video } → { ok: true, run, saved, pending, rank } (saved is
                         false when that exact run was already in, and pending is true when it's a top 10 run that
                         waits for a check, see "Saving a run, and checking top 10 runs") or { error }, the error saying
                         what to fix: login (not signed in), course, name, time, miss, video, rate (too many), off
                         (not set up, or GitHub didn't take it) or bad
   GET /api/pending and POST /api/review are for checking top 10 runs (see below).
   The session is a cookie signed with SESSION_SECRET that lasts 30 days. Nothing about it is stored here.
   Secrets: DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (Ballkyrie's app in Discord's Developer Portal, OAuth2 page,
   with https://ballkour.com/api/login/callback added as a redirect), SESSION_SECRET (any long random string) and
   the GitHub App that saves the runs (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, see above), or else a GITHUB_TOKEN
   that can write the game repo's contents. Without them, the form stays hidden.
   SUBMIT_CHANNEL is optional: a Discord channel's ID, where Ballkyrie logs every run sent from the website
   (SUBMIT_WEBHOOK, a webhook URL, does the same without the bot).
   SUBMIT_LIMIT (wrangler.toml) allows 5 sends a minute from one Discord account, and runs.json at most 20 a day. */
const RUNS_FILE = "leaderboards/runs.json";
// The game repo's branch runs.json is read from and saved to: develop, or RUNS_BRANCH (the test copy's own
// test-runs, so trying it out never touches the real boards)
const runsBranch = (env) => env.RUNS_BRANCH || "develop";
const SESSION_DAYS = 30;
// Ballkyrie's own Discord ID, which is the same as its app's ID
const botId = (env) => (/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID || "") ? env.DISCORD_CLIENT_ID : "");
const loginOn = (env) => !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.SESSION_SECRET && (appOn(env) || env.GITHUB_TOKEN));
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
const backTo = (to, otherwise = "/submit") => (/^\/[\w/-]*(\?[\w=&-]*)?$/.test(to || "") ? to : otherwise);

// profile: also ask to put their stats on their Discord profile (/api/profile, see "Stats on Discord profiles"),
// which comes back to their own panel unless it says where
async function login(request, env, profile = false) {
  const url = new URL(request.url);
  const to = backTo(url.searchParams.get("to"), profile ? "/?me=1" : "/submit");
  if (!loginOn(env)) return Response.redirect(`${url.origin}/submit`, 302);
  if (profile && !profileOn(env)) return Response.redirect(url.origin + to, 302);
  const state = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const auth = new URL("https://discord.com/oauth2/authorize");
  auth.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID, response_type: "code", scope: profile ? `identify ${PROFILE_SCOPE}` : "identify", prompt: "none", state,
    redirect_uri: `${url.origin}/api/login/callback`,
  });
  // The state comes back from Discord and has to match, so nobody can sign someone in with their own account
  const headers = new Headers({ Location: auth.href });
  headers.append("Set-Cookie", cookie("bk_login", `${state}.${b64url(utf8.encode(to))}`, 600, "/api/login"));
  return new Response(null, { status: 302, headers });
}
async function loginCallback(request, env, ctx) {
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
  // From /api/profile: their stats go on their Discord profile now (Discord only hands over this scope when it was
  // asked for, and they said yes)
  if (String(token.scope || "").split(/\s+/).includes(PROFILE_SCOPE) && profileOn(env)) {
    await connectProfile(env, ctx, me.id, tokensFrom(token)).catch((e) => console.error(`profile of ${me.id}: couldn't put it on: ${(e && e.message) || e}`));
  }
  return back(await signSession(env, { id: me.id, name: me.global_name || me.username, avatar }));
}
// profile: whether their stats are on their Discord profile, or null when that isn't set up. role: whether they have
// the Discord Profile App role on our server, which Discord needs before it shows them (asked only when they're on).
async function whoAmI(request, env, ctx) {
  const user = await readSession(request, env);
  const profile = user && profileOn(env) ? !!(await env.PROFILES.get(profileKey(user.id)).catch(() => null)) : null;
  const [role, reviewer] = await Promise.all([profile ? hasProfileRole(env, ctx, user.id) : false, isReviewer(env, user)]);
  return answer(200, { on: loginOn(env), user: user && { id: user.id, name: user.name, avatar: user.avatar, reviewer, profile, role } });
}

/* Saving a run, and checking top 10 runs
   A run that would put its player on a course's top 10 (their new best, faster than the #10's) isn't put on the board
   straight away: it waits in runs.json's "pending" until a reviewer checks its video at ballkour.com/submit, then goes
   on the board (Approve) or away (Turn down). Every other run goes on the board straight away. Reviewers are
   everyone on the server with a role in REVIEWER_ROLES (wrangler.toml). Discord is asked each time, so taking someone's
   role away takes their reviewing away too. The leaderboard bot and the website only read "runs" and "removed", so a
   waiting run is on no board until it's approved.
     GET  /api/pending   the runs waiting for a check (reviewers only)
     POST /api/review    { course, id, approve } (reviewers only) */
const idList = (s) => String(s || "").split(/[\s,]+/).filter(Boolean);
// Discord not answering counts as no, so nobody gets in by a hiccup
async function isReviewer(env, user) {
  if (!user) return false;
  const roles = idList(env.REVIEWER_ROLES);
  if (!roles.length || !env.DISCORD_BOT_TOKEN) return false;
  try {
    const member = await discord(env.DISCORD_BOT_TOKEN, `/guilds/${GUILD_ID}/members/${user.id}`);
    return !!member && (member.roles || []).some((r) => roles.includes(r));
  } catch (e) {
    console.error(`reviewer ${user.id}: couldn't tell if they have a reviewer role: ${(e && e.message) || e}`);
    return false;
  }
}
const runKey = (r) => (r.discord ? "d:" + r.discord : "n:" + String(r.name).toUpperCase());
const sameRunAs = (a, b) => a.time === b.time && (a.discord && b.discord ? a.discord === b.discord : String(a.name).toUpperCase() === String(b.name).toUpperCase());
const runByTime = (a, b) => toSeconds(a.time) - toSeconds(b.time) || a.mistakes - b.mistakes;
// The runs in a course's own file (its .opy top 10, or its .json), from the cached game data
function fileRuns(file, body) {
  if (!file || typeof body !== "string") return [];
  if (file.endsWith(".opy")) {
    const out = [];
    for (const m of body.matchAll(/lb\[\d+\]\s*=\s*"([^"]*)"(?:[ \t]*#[ \t]*discord:[ \t]*(\d{17,20}))?/g)) {
      const [name, time, miss] = m[1].split(",").map((s) => s.trim());
      if (name && /^(\d{1,2}:)?\d{1,2}:\d{2}\.\d{2}$/.test(time) && /^\d+$/.test(miss)) out.push({ name, discord: m[2] || "", time, mistakes: Number(miss) });
    }
    return out;
  }
  try {
    const runs = JSON.parse(body);
    return Array.isArray(runs) ? runs.filter((r) => r && typeof r.name === "string" && typeof r.time === "string" && Number.isInteger(r.mistakes)) : [];
  } catch (e) { return []; }
}
// Where a run would place on its course's board (1 + the other players whose best is faster), and whether it's its
// player's new best there, which is the only way it changes the board
function placeOf(run, pool, removed) {
  const best = new Map();
  let mine = null;
  for (const r of pool) {
    if (!r || typeof r.time !== "string" || typeof r.name !== "string" || removed.some((x) => sameRunAs(x, r))) continue;
    if (runKey(r) === runKey(run)) { if (!mine || runByTime(r, mine) < 0) mine = r; continue; }
    const had = best.get(runKey(r));
    if (!had || runByTime(r, had) < 0) best.set(runKey(r), r);
  }
  return { rank: 1 + [...best.values()].filter((r) => runByTime(r, run) < 0).length, newBest: !mine || runByTime(run, mine) < 0 };
}
// One run per line, so runs.json stays easy to read and edit by hand
function dumpRuns(data) {
  const run = (r) => (r && typeof r === "object" && !Array.isArray(r)
    ? "{" + Object.entries(r).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}"
    : JSON.stringify(r));
  const group = (obj) => {
    const keys = Object.keys(obj && typeof obj === "object" ? obj : {}).filter((k) => Array.isArray(obj[k]) && obj[k].length)
      .sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1));
    return keys.length ? "{\n" + keys.map((k) => `    ${JSON.stringify(k)}: [\n` + obj[k].map((r) => "      " + run(r)).join(",\n") + "\n    ]").join(",\n") + "\n  }" : "{}";
  };
  const others = Object.entries(data).filter(([k]) => !["runs", "pending", "removed"].includes(k));
  return `{\n  "runs": ${group(data.runs)},\n  "pending": ${group(data.pending)},\n  "removed": ${group(data.removed)}` +
    others.map(([k, v]) => `,\n  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join("") + "\n}\n";
}
async function runsApi(env) {
  return { ...githubHeaders(env), ...(appOn(env) ? { Authorization: `Bearer ${await appToken(env)}` } : {}), Accept: "application/vnd.github+json" };
}
// runs.json as it is on develop, with "runs", "pending" and "removed" always there, and its sha (null if there's none)
async function readRuns(env, headers) {
  const got = await fetch(`https://api.github.com/repos/${REPO}/contents/${RUNS_FILE}?ref=${runsBranch(env)}`, { headers, signal: AbortSignal.timeout(5000) });
  if (!got.ok && got.status !== 404) throw new Error(`reading it: ${got.status} ${(await got.text()).slice(0, 200)}`);
  const meta = got.ok ? await got.json() : null;
  let data;
  try { data = meta ? JSON.parse(text(unbase64(meta.content))) : {}; } catch (e) { throw new Error("it isn't valid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("it isn't a JSON object");
  for (const k of ["runs", "pending", "removed"]) if (!data[k] || typeof data[k] !== "object" || Array.isArray(data[k])) data[k] = {};
  return { data, sha: meta && meta.sha };
}
const listIn = (group, n) => (Array.isArray(group[n]) ? group[n] : (group[n] = []));
// Changes runs.json on develop through GitHub's API: edit(data) changes it and says what to commit ({ message }), or
// that nothing needs saving ({ skip: true }), or what went wrong ({ error, status }). It's read again and redone if
// someone else saved in between. → what edit said, and the new runs.json as { text } (null when nothing was saved)
async function editRuns(env, edit) {
  let headers, why = "";
  try { headers = await runsApi(env); } catch (e) { console.error(`runs.json: ${e.message}`); return { error: "off", status: 502 }; }
  for (let attempt = 0; attempt < 3; attempt++) {
    let data, sha;
    try { ({ data, sha } = await readRuns(env, headers)); } catch (e) { why = e.message; break; }
    const out = edit(data);
    if (out.error || out.skip) return { ...out, text: null };
    const next = dumpRuns(data);
    const put = await fetch(`https://api.github.com/repos/${REPO}/contents/${RUNS_FILE}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message: out.message, content: base64(utf8.encode(next)), branch: runsBranch(env), ...(sha ? { sha } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (put.ok) return { ...out, text: next };
    why = `saving it: ${put.status} ${(await put.text()).slice(0, 300)}`;
    if (put.status !== 409) break; // 409: runs.json changed since it was read, so read it again
  }
  console.error(`runs.json: couldn't save it, ${why}`);
  return { error: "off", status: 502 };
}
// The site shows a saved run straight away: the cached game data gets the new runs.json, and the player's Discord
// name and picture go in until the next lookup has them. That copy is only kept for a few minutes, so adding someone
// never puts off the lookup for everyone else. (Copies from GitHub have the run too: runs.json is read through
// GitHub's API, which doesn't serve old copies the way raw files can.)
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
  const playersCopy = user && (await stored("players"));
  if (playersCopy) {
    const d = JSON.parse(playersCopy);
    if (!d[user.id]) { d[user.id] = { name: user.name, avatar: user.avatar }; await putCached("players", 5 * 60, JSON.stringify(d)); }
  }
}
// The cached game data's course files and names (fetched if there's none yet)
async function gameInfo(env, ctx) {
  try {
    const { files = null, names = {} } = JSON.parse((await stored("game")) ?? (await game(env, ctx)));
    return { files, names };
  } catch (e) { return { files: null, names: {} }; }
}
const courseFile = (files, n) => files && Object.keys(files).find((k) => k.startsWith(`leaderboards/${n}-`) && /\.(opy|json)$/.test(k));
// A line in the log channel for every run sent from the website, if there is one: posted by Ballkyrie in the
// SUBMIT_CHANNEL channel (it needs to be able to see it, send messages and embed links there), or else through the
// SUBMIT_WEBHOOK webhook. kind: "new" (on the board), "check" (waiting for a check, at place rank), "approved" or
// "declined" (by reviewer).
async function logRun(env, { n, courseName, run, kind, rank, reviewer, site = "https://ballkour.com" }) {
  const byBot = !!(env.SUBMIT_CHANNEL && env.DISCORD_BOT_TOKEN);
  if (!byBot && !env.SUBMIT_WEBHOOK) return;
  const where = `Course ${n}${courseName ? ` · ${courseName}` : ""}`;
  const look = {
    new: [`New run on ${where}`, 0x00e697],
    check: [`Run to check on ${where}`, 0xffd54f],
    approved: [`Approved run on ${where}`, 0x00e697],
    declined: [`Turned down run on ${where}`, 0xff6a4f],
  }[kind];
  const fields = [
    { name: "Player", value: mdSafe(run.name), inline: true },
    { name: "Time", value: run.time, inline: true },
    { name: "Mistakes", value: String(run.mistakes), inline: true },
    { name: "Sent by", value: `<@${run.discord}>`, inline: true },
    ...(kind === "check" ? [{ name: "Would be", value: `#${rank}`, inline: true }] : []),
    ...(reviewer ? [{ name: "Checked by", value: `<@${reviewer.id}>`, inline: true }] : []),
    { name: "Video", value: `<${run.video}>` },
    // Webhooks can't have buttons, so they get the link
    ...(kind === "check" && !byBot ? [{ name: "Check it", value: `${site}/submit?check=${run.id}` }] : []),
  ];
  const message = {
    allowed_mentions: { parse: [] }, // shows who sent it without pinging them
    embeds: [{ title: look[0], url: `${site}/leaderboards/${n}`, color: look[1], fields, timestamp: new Date().toISOString() }],
    // Verify opens the run in the reviewers' list on ballkour.com/submit, to approve or turn down
    ...(kind === "check" && byBot ? { components: [{ type: 1, components: [{ type: 2, style: 5, label: "Verify", url: `${site}/submit?check=${run.id}` }] }] } : {}),
  };
  const res = await fetch(byBot ? `${DISCORD_API}/channels/${env.SUBMIT_CHANNEL}/messages` : env.SUBMIT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(byBot ? { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } : {}) },
    body: JSON.stringify(byBot ? message : { username: "ballkour.com", ...message }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => ({ ok: false, status: String((e && e.message) || e), text: async () => "" }));
  if (!res.ok) console.error(`log: ${byBot ? `Ballkyrie couldn't post in channel ${env.SUBMIT_CHANNEL}` : "the log webhook"} said ${res.status} ${(await res.text()).slice(0, 200)}`);
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

  // The course has to have a board
  const { files, names } = await gameInfo(env, ctx);
  const file = courseFile(files, n);
  if (files && !file) return answer(400, { error: "course" });
  const board = fileRuns(file, file && files[file]);

  const run = { name: name.toUpperCase(), discord: user.id, time, mistakes, date: new Date().toISOString().slice(0, 10), video };
  const saved = await editRuns(env, (data) => {
    const list = listIn(data.runs, n), waiting = listIn(data.pending, n);
    // The same run sent twice is only saved once
    if ([...list, ...waiting].some((r) => r && r.discord === run.discord && r.time === run.time && r.mistakes === run.mistakes)) return { skip: true };
    const today = [...Object.values(data.runs), ...Object.values(data.pending)].flat().filter((r) => r && r.discord === run.discord && r.date === run.date).length;
    if (today >= 20) return { error: "rate", status: 429 };
    const { rank, newBest } = placeOf(run, [...board, ...list], Array.isArray(data.removed[n]) ? data.removed[n] : []);
    if (rank <= 10 && newBest) {
      const id = b64url(crypto.getRandomValues(new Uint8Array(6)));
      waiting.push({ ...run, id });
      return { message: `chore(leaderboard): hold ${run.name}'s ${run.time} on course ${n} for a check`, pending: true, rank, id };
    }
    list.push(run);
    return { message: `chore(leaderboard): add ${run.name}'s ${run.time} on course ${n} from ballkour.com`, pending: false, rank };
  });
  if (saved.error) return answer(saved.status, { error: saved.error });
  await showSaved(saved.text, user).catch((e) => console.error(`submit: couldn't update the cached copy: ${(e && e.message) || e}`));
  if (saved.text) ctx.waitUntil(logRun(env, { n, courseName: names[n], run: { ...run, id: saved.id }, kind: saved.pending ? "check" : "new", rank: saved.rank, site: url.origin }));
  if (saved.text && !saved.pending) ctx.waitUntil(profileAfterRun(env, ctx, user.id));
  return answer(200, { ok: true, run, saved: !!saved.text, pending: !!saved.pending, rank: saved.rank || null });
}

// The runs waiting for a check, oldest first, each with where it would place now
async function pending(request, env, ctx) {
  const user = await readSession(request, env);
  if (!(await isReviewer(env, user))) return answer(403, { error: "bad" });
  let data;
  try { ({ data } = await readRuns(env, await runsApi(env))); } catch (e) { console.error(`pending: ${e.message}`); return answer(502, { error: "off" }); }
  const { files, names } = await gameInfo(env, ctx);
  const runs = Object.entries(data.pending).flatMap(([n, list]) => (Array.isArray(list) ? list : []).filter((r) => r && r.id).map((r) => {
    const file = courseFile(files, n);
    const { rank } = placeOf(r, [...fileRuns(file, file && files[file]), ...listIn(data.runs, n)], Array.isArray(data.removed[n]) ? data.removed[n] : []);
    return { course: Number(n), courseName: names[n] || "", rank, ...r };
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return answer(200, { runs });
}
// Approve (onto the board) or turn down (gone) a run waiting for a check
async function review(request, env, ctx) {
  if (request.method !== "POST") return answer(405, { error: "bad" });
  if (request.headers.get("Origin") !== new URL(request.url).origin) return answer(403, { error: "bad" });
  const user = await readSession(request, env);
  if (!(await isReviewer(env, user))) return answer(403, { error: "bad" });
  let body;
  try { body = JSON.parse(await request.text()); } catch (e) { body = null; }
  const n = Number(body && body.course), id = String((body && body.id) || ""), approve = !!(body && body.approve);
  if (!Number.isInteger(n) || !/^[\w-]{4,16}$/.test(id)) return answer(400, { error: "bad" });
  let run = null;
  const done = await editRuns(env, (data) => {
    const waiting = listIn(data.pending, n);
    const at = waiting.findIndex((r) => r && r.id === id);
    if (at < 0) return { error: "gone", status: 404 }; // someone else checked it already
    const { id: _, ...taken } = waiting.splice(at, 1)[0]; // the id is only for while it waits
    run = taken;
    if (approve) listIn(data.runs, n).push(run);
    return { message: `chore(leaderboard): ${approve ? "add" : "turn down"} ${run.name}'s ${run.time} on course ${n}, checked by ${user.name}` };
  });
  if (done.error) return answer(done.status, { error: done.error });
  await showSaved(done.text, null).catch(() => {});
  const { names } = await gameInfo(env, ctx);
  ctx.waitUntil(logRun(env, { n, courseName: names[n], run, kind: approve ? "approved" : "declined", reviewer: user, site: new URL(request.url).origin }));
  if (approve && run.discord) ctx.waitUntil(profileAfterRun(env, ctx, run.discord));
  return answer(200, { ok: true, run });
}

/* ---------- Stats on Discord profiles ----------
   Players can put their stats on their Discord profile, under Apps, like a linked game account. It's Discord's
   "role connection", which shows as:
     ballkour.com · Top 0.1%      their Top % (Rated for the bottom 10%, Unrated before they have a rating)
     DUCKLING · #3                their in-game name and place in the player ratings
     8123 ⭐ Rating  4 ⚡ Top 10s  2 🏆 Podiums  1 👑 Records  12 🗺️ Courses run
   PROFILE_FIELDS are the numbers on the last line. Discord allows at most 5 per app, whole numbers only (so Top %,
   with its 0.1, goes in the text above), and shows each as "<number> <name>", so each name's emoji comes right
   after its number. Changing a name only needs a deploy: Discord gets the new names, and everyone's profile shows
   them straight away. Server owners can also use them for
   linked roles (Server Settings → Linked Roles), like "Top 10s: at least 1". The numbers are the same as the site's
   and the leaderboard bot's: Top 10s, Podiums and Records count every course's board, broken ones too, like the
   bot's Top 10 role, and Courses run counts the courses in the ratings, like the player panel's.
     GET  /api/profile      Discord's sign-in page, also asking to update their connection, then back to the page
                            (to=…, or their own panel), signed in and with their stats on their profile. It's also
                            the app's Linked Roles Verification URL in the Developer Portal.
     POST /api/profile/off  takes them off: their Discord authorization is revoked and their tokens deleted
   /api/me says whether a signed-in player's stats are on their profile.

   Discord only shows them on a profile once its owner also has the Discord Profile App role on our server (a linked
   role, which they get from the server name → Linked Roles), so /api/me asks Discord whether they have it, with
   Ballkyrie's bot token, and their own panel walks them through getting it until they do.

   Discord only takes a player's stats with their own token, so their tokens (the access and refresh tokens, which
   allow nothing else) are kept in the PROFILES KV namespace under profile:<discord id>, with what was last sent
   (in the key's metadata). Every 30 minutes (the cron in wrangler.toml) everyone's stats are worked out again and
   whoever's changed is sent, at most PROFILE_FETCHES fetches' worth at a time, which keeps the Worker under
   Cloudflare's 50 fetches; anyone left over goes next time. A player's own stats are also sent as soon as their run
   goes on a board. Someone who took the app off in Discord is dropped the next time there's something to send them.
   The fields' names are sent to Discord by the Worker too (with Ballkyrie's bot token), the first time and again
   whenever PROFILE_FIELDS changes. Needs everything for signing in, DISCORD_BOT_TOKEN, and PROFILES. */
const PROFILE_SCOPE = "role_connections.write";
const PROFILE_FETCHES = 24;
// type 2: a whole number, which linked roles check with "at least". Keys can't change without everyone's profile
// losing that number until they're sent again.
const PROFILE_FIELDS = [
  { key: "rating", name: "⭐ Rating", description: "Their player rating over every course, out of 10,000" },
  { key: "top10s", name: "⚡ Top 10s", description: "How many courses they're on the top 10 of" },
  { key: "podiums", name: "🏆 Podiums", description: "How many courses they're in the top 3 of" },
  { key: "records", name: "👑 Records", description: "How many courses they hold the record on" },
  { key: "courses", name: "🗺️ Courses run", description: "How many of the rated courses they've run" },
].map((f) => ({ type: 2, ...f }));
const profileOn = (env) => loginOn(env) && !!env.PROFILES && !!env.DISCORD_BOT_TOKEN;
// The linked role that Discord needs before it shows someone's stats, by the name the site shows it with (the same in
// every language). Its ID is looked up once a day.
const PROFILE_ROLE = "Discord Profile App";
async function profileRoleId(env, ctx) {
  return JSON.parse(await cached("profile-role", 24 * 60 * 60, ctx, async () => {
    const role = ((await discord(env.DISCORD_BOT_TOKEN, `/guilds/${GUILD_ID}/roles`)) || []).find((r) => r.name === PROFILE_ROLE);
    if (!role) throw new Error(`there's no ${PROFILE_ROLE} role on the server`);
    return JSON.stringify(role.id);
  }));
}
// Whether they have it. Not on the server, or Discord not answering, counts as no: their panel then shows how to get it.
async function hasProfileRole(env, ctx, id) {
  try {
    const member = await discord(env.DISCORD_BOT_TOKEN, `/guilds/${GUILD_ID}/members/${id}`);
    return !!member && (member.roles || []).includes(await profileRoleId(env, ctx));
  } catch (e) {
    console.error(`profile of ${id}: couldn't tell if they have the ${PROFILE_ROLE} role: ${(e && e.message) || e}`);
    return false;
  }
}
const profileKey = (id) => `profile:${id}`;
const tokensFrom = (t) => ({ access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (Number(t.expires_in) || 0) * 1000 });

// Tells Discord the fields' names, unless it has these already (what was sent is kept in PROFILES as "fields")
async function registerFields(env) {
  const want = JSON.stringify(PROFILE_FIELDS);
  if ((await env.PROFILES.get("fields")) === want) return;
  const r = await fetch(`${DISCORD_API}/applications/${env.DISCORD_CLIENT_ID}/role-connections/metadata`, {
    method: "PUT",
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: want,
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`Discord didn't take the profile fields (${r.status} ${(await r.text()).slice(0, 200)})`);
  await env.PROFILES.put("fields", want);
}

// The game data → (Discord ID → what goes on their profile, as it's sent to Discord). Everyone's at once, for the cron.
function profilesFrom(data) {
  if (!data || !data.files || !Array.isArray(data.courses)) throw new Error("the game data has no course list yet");
  const courses = loadCourses(data.files, data.courses);
  const rated = new Map(rate(courses).players.map((p) => [p.key, p]));
  const boards = new Map(); // player → { top10s, podiums, records, name }
  for (const c of courses) {
    const { top, rest } = standings(c);
    [...top, ...rest].forEach((r, i) => {
      const k = playerKey(r);
      const b = boards.get(k) || { top10s: 0, podiums: 0, records: 0, name: r.name, date: "" };
      if (i < 10) b.top10s++;
      if (i < 3) b.podiums++;
      if (i === 0) b.records++;
      if ((r.date || "") > b.date) { b.date = r.date; b.name = r.name; } // named as on their newest run
      boards.set(k, b);
    });
  }
  return (id) => {
    const p = rated.get("d:" + id);
    const b = boards.get("d:" + id) || { top10s: 0, podiums: 0, records: 0, name: "" };
    return JSON.stringify({
      platform_name: `ballkour.com · ${!p ? "Unrated" : p.tier === null ? "Rated" : `Top ${p.tier}%`}`,
      platform_username: p ? `${p.name} · #${p.rank}` : b.name || "No runs yet",
      metadata: { rating: p ? Math.round(p.rating) : 0, top10s: b.top10s, podiums: b.podiums, records: b.records, courses: p ? p.courses : 0 },
    });
  };
}

// New tokens for a player's old ones (the old refresh token is spent), or null when Discord says they're no good
// any more: they took the app off, or it was revoked
async function refreshTokens(env, tokens) {
  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: tokens.refresh }),
    signal: AbortSignal.timeout(5000),
  });
  if (r.ok) return tokensFrom(await r.json());
  const why = await r.text().catch(() => "");
  // Only invalid_grant means the player's tokens are dead. Anything else (a reset client secret, Discord being down)
  // mustn't drop everyone.
  if (r.status === 400 && /invalid_grant/.test(why)) return null;
  throw new Error(`refreshing their tokens: ${r.status} ${why.slice(0, 200)}`);
}
// Sends a player's profile (body, from profilesFrom) to Discord with their tokens, which are renewed first when
// they have less than a day left, and keeps both. spend() is called before each fetch.
// → "sent", or "gone" when their tokens are dead (they're dropped)
async function sendProfile(env, id, tokens, body, spend = () => {}) {
  const key = profileKey(id);
  const keep = (t, sent) => env.PROFILES.put(key, JSON.stringify(t), { metadata: { sent } });
  let renewed = false;
  const renew = async () => {
    spend();
    tokens = await refreshTokens(env, tokens);
    renewed = true;
    if (tokens) await keep(tokens, ""); // straight away: the old refresh token doesn't work any more
    else await env.PROFILES.delete(key);
    return !!tokens;
  };
  if (tokens.expires - Date.now() < 864e5 && !(await renew())) return "gone";
  for (;;) {
    spend();
    const r = await fetch(`${DISCORD_API}/users/@me/applications/${env.DISCORD_CLIENT_ID}/role-connection`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tokens.access}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) { await keep(tokens, body); return "sent"; }
    if (r.status === 401 && !renewed) { if (!(await renew())) return "gone"; continue; }
    if (r.status === 401) { await env.PROFILES.delete(key); return "gone"; }
    throw new Error(`Discord said ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
}
// The game data as it's cached, or else fetched
async function gameData(env, ctx) {
  try { return JSON.parse((await stored("game")) ?? (await game(env, ctx))); }
  catch (e) { return JSON.parse(await buildGame(env, null)); } // the cache isn't there (from the cron, say)
}
// From the callback, once they've said yes: their stats go on their profile, and their tokens are kept
async function connectProfile(env, ctx, id, tokens) {
  await registerFields(env);
  await sendProfile(env, id, tokens, profilesFrom(await gameData(env, ctx))(id));
}
// Sends whoever's stats have changed since they were last sent: everyone with their stats on, or only these IDs
async function updateProfiles(env, ctx, only = null) {
  if (!profileOn(env)) return;
  const profileOf = profilesFrom(await gameData(env, ctx));
  await registerFields(env);
  const due = [];
  if (only) {
    for (const id of only) {
      const { metadata } = await env.PROFILES.getWithMetadata(profileKey(id));
      if (metadata && metadata.sent !== profileOf(id)) due.push(id);
    }
  } else {
    let cursor;
    do {
      const page = await env.PROFILES.list({ prefix: "profile:", cursor });
      for (const k of page.keys) {
        const id = k.name.slice("profile:".length);
        if (!(k.metadata && k.metadata.sent === profileOf(id))) due.push(id);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
  }
  let spent = 0, sent = 0, gone = 0, failed = 0;
  for (const id of due) {
    if (spent + 3 > PROFILE_FETCHES) break; // a send takes 3 fetches at most
    const tokens = await env.PROFILES.get(profileKey(id), "json");
    if (!tokens) continue;
    try {
      if ((await sendProfile(env, id, tokens, profileOf(id), () => spent++)) === "sent") sent++; else gone++;
    } catch (e) {
      failed++;
      console.error(`profile of ${id}: ${(e && e.message) || e}`);
    }
  }
  if (due.length) console.log(`profiles: ${sent} sent, ${gone} dropped, ${failed} failed, ${due.length - sent - gone - failed} left for next time`);
}
// Right after a run goes on a board: its player's profile catches up straight away (everyone else's with the cron)
const profileAfterRun = (env, ctx, id) => updateProfiles(env, ctx, [id]).catch((e) => console.error(`profile of ${id}: ${(e && e.message) || e}`));

// Takes their stats off their profile: revoking the token ends Ballkyrie's authorization, which takes the
// connection off with it (and signs the site out of nothing: its own session doesn't use Discord's tokens)
async function profileOff(request, env) {
  if (request.method !== "POST") return answer(405, { error: "bad" });
  if (request.headers.get("Origin") !== new URL(request.url).origin) return answer(403, { error: "bad" });
  const user = await readSession(request, env);
  if (!user) return answer(401, { error: "login" });
  if (!profileOn(env)) return answer(503, { error: "off" });
  const tokens = await env.PROFILES.get(profileKey(user.id), "json");
  if (tokens) {
    const r = await fetch("https://discord.com/api/oauth2/token/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, token: tokens.refresh, token_type_hint: "refresh_token" }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => ({ ok: false, status: String((e && e.message) || e), text: async () => "" }));
    if (!r.ok) {
      console.error(`profile of ${user.id}: Discord didn't revoke the token (${r.status} ${(await r.text()).slice(0, 200)})`);
      return answer(502, { error: "off" });
    }
    await env.PROFILES.delete(profileKey(user.id));
  }
  return answer(200, { ok: true });
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
// The sections (/submit, /faq, …) and the links into them (/leaderboards/6, /leaderboards/3/legacy, /faq/pausing) are
// the home page. On ballkour.com a Cloudflare rule already serves the sections that way, but the test copy on
// workers.dev has no such rule, so the Worker does it too.
const DEEP_LINK = /^\/(?:(?:courses|leaderboards|submit|features|faq|source-code|translations)\/?|leaderboards\/[\w-]+(?:\/legacy)?\/?|faq\/[\w-]+\/?)$/i;
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
  // Sending runs from the website is set up (see "Signing in with Discord"): the page shows the form. So are the
  // stats on Discord profiles (see "Stats on Discord profiles"): the sign-in panel tells people about them.
  if (on) {
    const profiles = profileOn(env);
    rw = rw.on("#submit", { element(el) {
      el.setAttribute("data-login", "on");
      if (profiles) el.setAttribute("data-profiles", "on");
      if (botId(env)) el.setAttribute("data-bot", botId(env));
    } });
  }
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
      if (path === "/api/login/callback" && request.method === "GET") return await loginCallback(request, env, ctx);
      if (path === "/api/profile" && request.method === "GET") return await login(request, env, true);
      if (path === "/api/profile/off") return await profileOff(request, env);
      if (path === "/api/me" && request.method === "GET") return await whoAmI(request, env, ctx);
      if (path === "/api/logout" && request.method === "POST") {
        if (request.headers.get("Origin") !== new URL(request.url).origin) return answer(403, { error: "bad" });
        return answer(200, { ok: true }, [cookie("bk_session", "", 0)]);
      }
      if (path === "/api/submit") return await submit(request, env, ctx);
      if (path === "/api/pending" && request.method === "GET") return await pending(request, env, ctx);
      if (path === "/api/review") return await review(request, env, ctx);
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
  // Every 30 minutes (the cron in wrangler.toml): the stats on players' Discord profiles catch up with the boards
  async scheduled(controller, env, ctx) {
    await updateProfiles(env, ctx).catch((e) => console.error(`profiles: ${(e && e.message) || e}`));
  },
};
