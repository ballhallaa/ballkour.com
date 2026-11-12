/* Cloudflare Worker for ballkour.com. Visitors' browsers only ever talk to ballkour.com: the Worker fetches
   everything the page needs from GitHub and Discord itself, caches it at Cloudflare, and serves it from here.
   That keeps the site fast, keeps visitors' IPs away from GitHub and Discord, avoids GitHub's limits on
   anonymous requests, and works where GitHub and Discord are blocked (mainland China, some schools).

   /data/game.json     The game repo's leaderboard files and in-game FAQ (develop branch), its runs and leaderboard
                       history (leaderboard-data branch), plus the latest releases of the game and of this website:
                         { files: { "<path>": "<text>" | null }, releases: [...], siteReleases: [...] }.
                       Refreshed at most once a minute.
   /data/widget.json   The Discord server's member count (from its invite), plus the widget's voice channels and
                       who's in them. Refreshed at most once a minute.
   /data/players.json  Players' Discord names and pictures for the leaderboards (also at /players.json):
                         { "<discord id>": { "name": "server nickname, display name or username", "avatar": "https://cdn.discordapp.com/…" } }
                       Looked up with Ballkyrie's token, only for players on a board. Refreshed at most once an hour.
   /api/…              Signing in with Discord, and runs sent from the form under Submit a run, which go on the boards
                       straight away. See "Signing in with Discord, and runs sent from the website" below. Players'
                       stats on their Discord profiles too: see "Stats on Discord profiles". And players claiming their
                       runs from before 2026-04-29: see "Claiming legacy runs". And the names players pick for their
                       links: see "Players' own links".
   /runs/<id>          A run sent from the website: the home page, which opens the run's page. Ballkyrie's post for
                       it in the run submissions channel links here. See "Each run's page".
   /my-stats           The home page, which opens My profile: the visitor's own player panel (signing them in first).
   /stats/<…>          The home page, at Stats: page views and runs for a day picked in the history (/stats/2026-11-05,
                       and /day, /week, /3-months, /6-months, or /12-months for that day alone or the days up to
                       it). See "Page views".
   /players/<…>        The home page, which opens a player's panel: by their number, or the name they picked for their
                       link. See "Players' own links".
   /profile, /profile/<…>
                       The same as /my-stats and /players/<…>: their links since November 2026, which the page shows in
                       the address. The older ones keep working. See PROFILE_LINK.
   /api/visits         How many times the site was opened, and by how many people, for Stats. See "Page views".

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
   and the PROFILES KV namespace (wrangler.toml), for the stats on players' Discord profiles and each run's numbers from
   when it was sent.

   Board, answer and run links (/leaderboards/6, /leaderboards/3/legacy, /leaderboards/3/12,
   /leaderboards/ratings/unassisted, /faq/pausing, /runs/<id>) get the home page, like /leaderboards and /faq do; the
   page opens the board, answer or run itself.

   /code/game and /code/site (also /code/website) redirect to the game's and this website's GitHub repos, and
   /releases and /releases/site (also /releases/website) to their release notes. Anything after them carries over,
   so /code/game/issues goes to the game's issues. Everything else is the site's own files, which Cloudflare serves from its copy of this repo. */

import { DurableObject } from "cloudflare:workers";
import { loadCourses, rate, combine, standings, playerKey } from "./ratings.js";

const GUILD_ID = "1212553452283101245";
// Where players open a ticket on our Discord (the site's ticket button links to it too)
const TICKETS_CHANNEL = "1498944426901508106";
const INVITE = "Skz6cg9rbR";
const REPO = "ballhallaa/ballkour";
const SITE_REPO = "ballhallaa/ballkour.com";
const GAME = `https://raw.githubusercontent.com/${REPO}`; // + /<branch>/<path>
const DISCORD_API = "https://discord.com/api/v10";
const STALE_FOR = 7 * 24 * 60 * 60; // seconds: how long the last good copy is kept for when a source is down

/* ---------- Caching ---------- */
// Bump the version whenever what a copy holds changes. The last good copy is reused for as long as its source can't be
// reached, so under the same key a copy saved by an older Worker can outlive the change.
const CACHE_VERSION = 6;
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
   It only saves to the leaderboard-data branch (see dataBranch), which has no pull request rule. Secrets: GITHUB_APP_ID and
   GITHUB_APP_PRIVATE_KEY (the .pem GitHub hands out, as it is). The app needs Contents: Read and write, and to be
   installed on the game repo. With Actions: Read and write too, it starts the leaderboard bot's daily run (see
   startDailyBot). A token is made each time one's needed (each lasts an hour), so none is kept. */
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
  let appAuth = null; // one GitHub App token for the whole refresh
  const get = async (path) => {
    // runs.json changes with every run sent from the website, and history.json with every board posted and every
    // claim approved, so they're read through GitHub's API, which always has the newest copy (raw files can be a few
    // minutes behind) (with GITHUB_TOKEN if it's set, or else as the GitHub App)
    const viaApi = DATA_FILES.includes(path) && (env.GITHUB_TOKEN || appOn(env));
    const auth = viaApi && !env.GITHUB_TOKEN ? await (appAuth || (appAuth = appToken(env).then((t) => ({ Authorization: `Bearer ${t}` })))) : {};
    const branch = DATA_FILES.includes(path) ? dataBranch(env) : "develop";
    const r = await fetch(viaApi ? `https://api.github.com/repos/${REPO}/contents/${encodeURI(path)}?ref=${branch}` : `${GAME}/${branch}/${encodeURI(path)}`, {
      headers: viaApi ? { ...headers, ...auth, Accept: "application/vnd.github.raw+json" } : headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.text();
  };
  // The leaderboard files are listed in the leaderboard bot's courses.json. runs.json has the runs that never made a
  // top 10 and the runs taken off the boards, for the boards' "Show all" and the player ratings.
  // Its course names and flags are kept too, for the log of runs sent from the website and Ballkyrie's posts about
  // them, and each course's number, file, whether it's broken, and whether it's a remake, for the stats on players'
  // Discord profiles and for the page (which courses are struck through). A remake's broken is its latest code: its
  // Beta code still works, so it can still be run.
  let paths = previous ? Object.keys(previous.files) : [];
  let names = (previous && previous.names) || {};
  let flags = (previous && previous.flags) || {};
  let list = (previous && previous.courses) || null;
  try {
    const courses = JSON.parse(await get("tools/leaderboard-bot/courses.json")).courses;
    paths = [...DATA_FILES, "src/engine/faq.opy", ...courses.map((c) => c.file)];
    names = Object.fromEntries(courses.map((c) => [c.n, c.name]));
    flags = Object.fromEntries(courses.filter((c) => c.flag).map((c) => [c.n, c.flag]));
    list = courses.map(({ n, file, broken, remaker }) => ({ n, file, broken: !!broken, remake: !!remaker }));
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
  return JSON.stringify({ files, names, flags, ...(list ? { courses: list } : {}), releases, siteReleases });
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
// The caller has used up the calls it may make (see "Cloudflare's limits" below), so the rest waits for next time
class NoCallsLeft extends Error {}
// What Discord answered, or null when it has nobody by that ID (or isn't letting Ballkyrie see them). Anything else
// (rate limits, Discord being down, a timeout) throws and says why, so the player can be looked up again soon.
// calls ({ left }) is how many calls the caller can still make, when it's counting: every try takes one.
async function discord(token, route, calls = null) {
  for (let attempt = 0; ; attempt++) {
    if (calls) {
      if (calls.left <= 0) throw new NoCallsLeft("no calls left");
      calls.left--;
    }
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
async function lookUp(token, id, calls) {
  const member = await discord(token, `/guilds/${GUILD_ID}/members/${id}`, calls);
  const user = member ? member.user : await discord(token, `/users/${id}`, calls);
  if (!user) return null;
  const avatar = member && member.avatar ? `https://cdn.discordapp.com/guilds/${GUILD_ID}/users/${id}/avatars/${member.avatar}.png?size=64`
    : user.avatar ? `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(id) >> 22n) % 6n)}.png`;
  return { name: (member && member.nick) || user.global_name || user.username, avatar };
}
// How many calls to Discord one refresh of the names can make. A page load starts the refresh, and Cloudflare's free
// plan lets it make 50 calls in all, a few of them its own (see "Cloudflare's limits" below), so with more players than
// that, one refresh can't look everyone up. Each refresh takes whoever has gone longest without a look (players with no
// name yet first), until it's out of calls, and the rest go in the next one, a few minutes later.
const NAME_CALLS = 24;
// How long a name and picture last before they're looked up again (a little under the hour the list is kept for)
const NAME_AGE = 55 * 60 * 1000;
async function buildPlayers(env, ctx, previous) {
  if (!env.DISCORD_BOT_TOKEN) throw new Error("no DISCORD_BOT_TOKEN secret");
  // Every Discord ID on any board: `# discord: ID` in the .opy files and "discord": "ID" in the .json files, plus the
  // reviewers who checked runs in runs.json ("checkedBy": "ID"), for the reviewers' list of every run. They come from
  // whatever game data is cached, so refreshing the names doesn't fetch the game data from GitHub again too.
  const { files } = JSON.parse((await stored("game")) ?? (await game(env, ctx)));
  const ids = new Set();
  for (const text of Object.values(files)) if (text) for (const m of text.matchAll(/(?:discord|checkedBy)"?\s*:\s*"?(\d{17,20})\b/gi)) ids.add(m[1]);
  // Ballkyrie too (a bot's user ID is its app's ID), for its name and picture where the sign-in panel mentions it
  if (botId(env)) ids.add(botId(env));
  // Everyone keeps what the last refresh had (at: when they were looked up; none for someone a run they just sent added,
  // see showSaved), and whoever's due is looked up again, oldest first
  const now = Date.now();
  const at = (id) => (previous && previous[id] && previous[id].at) || 0;
  const due = [...ids].filter((id) => now - at(id) >= NAME_AGE).sort((a, b) => at(a) - at(b));
  const found = {};
  for (const id of ids) if (previous && previous[id]) found[id] = previous[id];
  const calls = { left: NAME_CALLS };
  const failed = [];
  let looked = 0;
  for (let i = 0; i < due.length && calls.left > 0; i += 5) { // 5 at a time, to stay well inside Discord's rate limits
    const batch = due.slice(i, i + 5);
    const people = await Promise.all(batch.map((id) => lookUp(env.DISCORD_BOT_TOKEN, id, calls).catch((e) => {
      if (e instanceof BadToken) throw e;
      if (!(e instanceof NoCallsLeft)) failed.push((e && e.message) || String(e));
      return undefined; // no answer: they keep what they had, and stay due
    })));
    batch.forEach((id, j) => {
      if (people[j] === undefined) return;
      looked++;
      // Discord has nobody by that ID any more: they keep their last name and picture, if they had one
      found[id] = { ...(people[j] || found[id] || {}), at: now };
    });
  }
  const left = due.length - looked;
  if (!left) return JSON.stringify(found);
  // Whoever's left keeps their last name, or goes without one for now. Kept for an hour, a list like that would hide
  // them until the next hour, so the rest are looked up in a few minutes instead.
  console.error(`players: looked up ${looked} of ${due.length} due, ${left} left for the next refresh in 5 minutes` +
    (failed.length ? `; Discord didn't answer for ${failed.length}. First: ${failed[0]}` : " (out of calls)"));
  return { body: JSON.stringify(found), ttl: 5 * 60 };
}

/* ---------- Signing in with Discord, and runs sent from the website ----------
   Players sign in with Discord (OAuth2 with the "identify" scope: their ID, name and picture, nothing else) to send a
   run from the form under Submit a run. The run goes on the boards straight away: it's saved under their Discord ID
   in leaderboards/runs.json on the game repo's leaderboard-data branch (one commit per run), and the leaderboard bot picks that
   up to post the board and give out roles. Nobody can send a run as someone else: it's always the sender's, whatever
   in-game name they type (in-game names aren't unique, so they're never checked against other players').
     GET  /api/login     Discord's sign-in page, then /api/login/callback, then back to /submit
     GET  /api/me        { on, user: { id, name, avatar, reviewer, profile, role } | null }: whether sending runs is set
                         up, and who's signed in (profile: whether their stats are on their Discord profile, and role:
                         whether they have the Discord Profile App role it needs, see "Stats on Discord profiles")
     POST /api/logout
     POST /api/submit    { course, name, time, mistakes, video } → { ok: true, run, saved, pending, rank } (saved is
                         false when that exact run was already in, sent before or on a board from before the form,
                         and then run has that one's id, or none for one from before; pending is true when it's a top
                         10 run that waits for a check, see "Saving a run, and checking top 10 runs") or { error },
                         the error saying what to fix: login (not signed in), course, name, time, miss, video (not a
                         link, or none for a top 10 run, the only kind that needs one), rate (too many), off (not set
                         up, or GitHub didn't take it) or bad
   GET /api/pending and POST /api/review are for checking top 10 runs (see below), GET /api/run is a run's numbers
   from when it was sent (see "Each run's page"), GET /api/comments is the comments on a run's YouTube video (see
   "YouTube comments"), POST /api/claim and /api/claim/review are for claiming legacy runs (see "Claiming legacy
   runs"), and POST /api/link is for the name on a player's own link (see "Players' own links").
   The session is a cookie signed with SESSION_SECRET that lasts 30 days. Nothing about it is stored here.
   Secrets: DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET (Ballkyrie's app in Discord's Developer Portal, OAuth2 page,
   with https://ballkour.com/api/login/callback added as a redirect), SESSION_SECRET (any long random string) and
   the GitHub App that saves the runs (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, see above), or else a GITHUB_TOKEN
   that can write the game repo's contents. Without them, the form stays hidden.
   RUNS_CHANNEL (wrangler.toml) is the run submissions channel, where Ballkyrie posts every run sent from the website
   with a View run button to its page (see "Each run's page"). Without it (or DISCORD_BOT_TOKEN), nothing is posted.
   SUBMIT_LIMIT (wrangler.toml) allows 5 sends a minute from one Discord account, and runs.json at most 20 a day. */
const RUNS_FILE = "leaderboards/runs.json";
const HISTORY_FILE = "leaderboards/history.json";
// Players' numbers and the names they picked for their links (see "Players' own links")
const LINKS_FILE = "links.json";
// The files on the game repo's data branch: runs.json, every board the leaderboard bot has posted, and players' links
const DATA_FILES = [RUNS_FILE, HISTORY_FILE, LINKS_FILE];
// The game repo's branch with DATA_FILES, kept apart so the commits for every run stay off develop: leaderboard-data,
// or DATA_BRANCH (the test copy's own test-runs, so trying it out never touches the real boards)
const dataBranch = (env) => env.DATA_BRANCH || "leaderboard-data";
const SESSION_DAYS = 30;
// Ballkyrie's own Discord ID, which is the same as its app's ID
const botId = (env) => (/^\d{17,20}$/.test(env.DISCORD_CLIENT_ID || "") ? env.DISCORD_CLIENT_ID : "");
const loginOn = (env) => !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.SESSION_SECRET && (appOn(env) || env.GITHUB_TOKEN));
// The same checks as the page's. Names can't have commas or quotes, which the in-game boards' files use, or spaces,
// which Overwatch names never have.
const NAME_OK = /^[^\u0000-\u001f\u007f"`\\,<>\s]{1,32}$/u;
// Names are saved in capitals, the same as the page's caps(): letters in a special font (𝓫𝓸𝓵𝓭, ᴄᴀᴘꜱ, ⓒⓘⓡⓒⓛⓔⓓ,
// ｗｉｄｅ) stay as they are, and so does one whose capital is longer (ß is SS). Of the small capitals, only ɪ and ʀ
// have capitals of their own (Ɪ and Ʀ), so they're kept by name.
const caps = (s) => s.replace(/./gsu, (c) => {
  const u = c.toUpperCase();
  return u.length === c.length && c.normalize("NFKC") === c && c !== "ɪ" && c !== "ʀ" ? u : c;
});
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
// Both come from one look at their roles on our server (see memberOf), at most a minute old, or ten seconds when the
// page asks again after they've been off getting the Discord Profile App role (?fresh=1).
async function whoAmI(request, env, ctx) {
  // Each time someone opens the site, the page asks this once: a page view (not ?fresh=1, the page asking again)
  if (env.PAGE_VIEWS && !new URL(request.url).searchParams.has("fresh")) {
    ctx.waitUntil(countView(request, env).catch((e) => console.error(`page views: ${(e && e.message) || e}`)));
  }
  const user = await readSession(request, env);
  const profile = user && profileOn(env) ? !!(await env.PROFILES.get(profileKey(user.id)).catch(() => null)) : null;
  const maxAge = new URL(request.url).searchParams.has("fresh") ? 10 : 60;
  const member = user && env.DISCORD_BOT_TOKEN ? await memberOf(env, user.id, maxAge).catch((e) => {
    console.error(`me ${user.id}: couldn't see their roles: ${(e && e.message) || e}`);
    return null;
  }) : null;
  const reviewer = isReviewerIn(env, member);
  const role = profile ? await hasProfileRoleIn(env, ctx, member) : false;
  return answer(200, { on: loginOn(env), user: user && { id: user.id, name: user.name, avatar: user.avatar, reviewer, profile, role } });
}
// A member of our server as Discord has them ({ roles }), or null when they aren't on it, for the reviewer check and
// the Discord Profile App role. Every page load asks (/api/me), so an answer is kept here for a minute, and reused
// while it's at most maxAge seconds old (0: ask Discord again, as before a run or claim is checked).
async function memberOf(env, id, maxAge) {
  const key = cacheKey(`member/${id}`);
  if (maxAge > 0) {
    const hit = await caches.default.match(key).catch(() => null);
    const kept = hit && (await hit.json().catch(() => null));
    if (kept && Date.now() - kept.at < maxAge * 1000) return kept.member;
  }
  const member = await discord(env.DISCORD_BOT_TOKEN, `/guilds/${GUILD_ID}/members/${id}`);
  const kept = { at: Date.now(), member: member ? { roles: Array.isArray(member.roles) ? member.roles : [] } : null };
  await caches.default.put(key, new Response(JSON.stringify(kept), { headers: { "Cache-Control": "public, max-age=60" } })).catch(() => {});
  return kept.member;
}

/* Saving a run, and checking top 10 runs
   Every run sent from the website gets an id, for its page (ballkour.com/runs/<id>), and the time it was sent
   ("sentAt"). Ids are numbers in the order runs are saved, from 1 ("1", "2", …), counted by runs.json's "lastId" so
   none is ever used twice, even after a run is deleted by hand. (The first few runs, from before, have random ids.) A run that would put its player on a course's top 10 (their new best, faster than the #10's) isn't put
   on the board straight away: it waits in runs.json's "pending" until a reviewer checks its video, on its page or at
   ballkour.com/submit, then goes on the board (Approve, into "runs") or into "declined" (Turn down), either way with
   who checked it and when ("checkedBy" and "checkedAt"). So a top 10 run needs a video, and one without is turned
   down ({ error: "video" }). Every other run goes on the board straight away, with or without one. Turned-down
   runs are kept so their page can still say what happened, and reviewers can look back over every run. Reviewers are
   everyone on the server with a role in REVIEWER_ROLES (wrangler.toml). Discord is asked right before every Approve or
   Turn down, so taking someone's role away takes their reviewing away too (and the page catches up within a minute). The leaderboard bot and the website's boards only read "runs" and
   "removed", so a waiting or turned-down run is on no board.
     GET  /api/pending   the runs waiting for a check (reviewers only)
     POST /api/review    { course, id, approve } (reviewers only, and never on their own run: { error: "own" }) */
const idList = (s) => String(s || "").split(/[\s,]+/).filter(Boolean);
// Whether a member (from memberOf) has a reviewer role
const isReviewerIn = (env, member) => !!member && idList(env.REVIEWER_ROLES).some((r) => member.roles.includes(r));
// Discord not answering counts as no, so nobody gets in by a hiccup. maxAge (see memberOf): a minute for the list of
// runs waiting, and none (Discord is asked right then) before a run or claim is checked.
async function isReviewer(env, user, maxAge = 0) {
  if (!user) return false;
  if (!idList(env.REVIEWER_ROLES).length || !env.DISCORD_BOT_TOKEN) return false;
  try {
    return isReviewerIn(env, await memberOf(env, user.id, maxAge));
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
    const rows = [];
    for (const m of body.matchAll(/lb\[(\d+)\]\s*=\s*"([^"]*)"(?:[ \t]*#[ \t]*discord:[ \t]*(\d{17,20}))?/g)) {
      const [name, time, miss] = m[2].split(",").map((s) => s.trim());
      if (name && /^(\d{1,2}:)?\d{1,2}:\d{2}\.\d{2}$/.test(time) && /^\d+$/.test(miss)) rows[Number(m[1])] = { name, discord: m[3] || "", time, mistakes: Number(miss) };
    }
    // lbRunInfo(rank, "YYYY-MM-DD", "host/path"): its date and video, the same way the page reads them (parseBoard())
    for (const m of body.matchAll(/lbRunInfo\(\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g)) {
      const r = rows[Number(m[1])];
      if (!r) continue;
      r.date = m[2];
      if (/^[a-z0-9.-]+\.[a-z]{2,}(\/[^\s"'<>]*)?$/i.test(m[3])) r.video = "https://" + m[3];
    }
    return rows.filter(Boolean);
  }
  try {
    const runs = JSON.parse(body);
    return Array.isArray(runs) ? runs.filter((r) => r && typeof r.name === "string" && typeof r.time === "string" && Number.isInteger(r.mistakes)) : [];
  } catch (e) { return []; }
}
// The runs on a course's old boards in history.json (from the cached game data), or [] when it can't be read
function historyRuns(files, n) {
  try {
    const h = JSON.parse(files && files["leaderboards/history.json"]);
    const boards = (h && h[n] && h[n].boards) || [];
    return (Array.isArray(boards) ? boards : []).flat().filter((r) => r && typeof r.name === "string" && typeof r.time === "string" && Number.isInteger(r.mistakes));
  } catch (e) { return []; }
}
/* A run played in Assist Mode ("mode": "assisted" in runs.json) goes on its course's assisted board, which has its
   own places, records, and rating (the leaderboard bot posts it, and gives out the "(Assisted)" roles): only the other
   assisted runs count there, and it counts for nothing else. The courses' files and the old boards in history.json's
   "boards" only have regular runs (the assisted boards the bot posted are under "assisted"). */
const ASSISTED = "assisted";
const isAssisted = (r) => !!r && r.mode === ASSISTED;
// The runs in a list that are on the same boards as run: the assisted ones, or the regular ones
const ofMode = (list, run) => (Array.isArray(list) ? list : []).filter((r) => !!r && isAssisted(r) === isAssisted(run));
// Where a run would place on its course's board (1 + the other players whose best is faster), and whether it's its
// player's new best there, which is the only way it changes the board. pool and removed: the runs of its board's
// (see ofMode).
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
// runs.json's groups of runs, by course number, in the order they're written
const RUN_GROUPS = ["runs", "pending", "declined", "removed"];
// The number for the next run's id: one more than runs.json's "lastId", or than any numbered run in it (in case
// "lastId" is missing, or was edited by hand)
function nextId(data) {
  let last = Number.isInteger(data.lastId) ? data.lastId : 0;
  for (const k of RUN_GROUPS) {
    for (const list of Object.values(data[k])) {
      for (const r of Array.isArray(list) ? list : []) if (r && /^\d{1,9}$/.test(r.id)) last = Math.max(last, Number(r.id));
    }
  }
  return last + 1;
}
// Now, to the second, for "sentAt" and "checkedAt"
const stamp = () => new Date().toISOString().slice(0, 19) + "Z";
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
  // Other lists (the claims) one item per line too
  const other = (v) => (Array.isArray(v) && v.length ? "[\n" + v.map((r) => "    " + run(r)).join(",\n") + "\n  ]" : JSON.stringify(v));
  const others = Object.entries(data).filter(([k]) => !RUN_GROUPS.includes(k));
  return "{\n" + RUN_GROUPS.map((k) => `  ${JSON.stringify(k)}: ${group(data[k])}`).join(",\n") +
    others.map(([k, v]) => `,\n  ${JSON.stringify(k)}: ${other(v)}`).join("") + "\n}\n";
}
// history.json the way the leaderboard bot writes it (dumpHistory() in its bot.mjs), one run per line: keep the two in step
function dumpHistory(data) {
  const run = (r) => "{" + Object.entries(r).filter(([, v]) => v !== "" && v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}";
  const entry = (e) => Object.entries(e).map(([k, v]) => {
    if (k === "legacy" && Array.isArray(v)) return `    "legacy": [\n${v.map((r) => "      " + run(r)).join(",\n")}\n    ]`;
    if ((k === "boards" || k === ASSISTED) && Array.isArray(v)) return `    ${JSON.stringify(k)}: [\n${v.map((b) => `      [\n${b.map((r) => "        " + run(r)).join(",\n")}\n      ]`).join(",\n")}\n    ]`;
    return `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`;
  }).join(",\n");
  return `{\n${Object.entries(data).map(([k, e]) => `  ${JSON.stringify(k)}: {\n${entry(e)}\n  }`).join(",\n")}\n}\n`;
}
async function runsApi(env) {
  return { ...githubHeaders(env), ...(appOn(env) ? { Authorization: `Bearer ${await appToken(env)}` } : {}), Accept: "application/vnd.github+json" };
}
// A file on the data branch as it is now, through GitHub's API: its text (null if there's none yet) and its sha
async function readData(env, headers, path) {
  const got = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${dataBranch(env)}`, { headers, signal: AbortSignal.timeout(5000) });
  if (!got.ok && got.status !== 404) throw new Error(`reading it: ${got.status} ${(await got.text()).slice(0, 200)}`);
  const meta = got.ok ? await got.json() : null;
  // GitHub only hands over a file's text this way up to 1 MB
  if (meta && !meta.content && meta.size) throw new Error("it's over 1 MB, too big for GitHub's API to hand over");
  return { raw: meta ? text(unbase64(meta.content)) : null, sha: meta && meta.sha };
}
// runs.json's text → its data, with every group in RUN_GROUPS always there
function loadRuns(raw) {
  let data;
  try { data = raw === null ? {} : JSON.parse(raw); } catch (e) { throw new Error("it isn't valid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("it isn't a JSON object");
  for (const k of RUN_GROUPS) if (!data[k] || typeof data[k] !== "object" || Array.isArray(data[k])) data[k] = {};
  return data;
}
// history.json's text → its data. It has to be there already: the leaderboard bot starts it.
function loadHistory(raw) {
  let data;
  try { data = JSON.parse(raw); } catch (e) { throw new Error("it isn't valid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("it isn't a JSON object");
  return data;
}
// runs.json as it is on the data branch, and its sha (null if there's none)
async function readRuns(env, headers) {
  const { raw, sha } = await readData(env, headers, RUNS_FILE);
  return { data: loadRuns(raw), sha };
}
const listIn = (group, n) => (Array.isArray(group[n]) ? group[n] : (group[n] = []));
// Changes a file on the data branch through GitHub's API: load(text) reads it, edit(data) changes that and says what
// to commit ({ message }), or that nothing needs saving ({ skip: true }), or what went wrong ({ error, status }), and
// dump(data) writes it out. It's read again and redone if someone else saved in between. → what edit said, and the
// new file as { text } (null when nothing was saved)
async function editData(env, path, load, dump, edit) {
  const file = path.split("/").pop();
  let headers, why = "";
  try { headers = await runsApi(env); } catch (e) { console.error(`${file}: ${e.message}`); return { error: "off", status: 502 }; }
  for (let attempt = 0; attempt < 3; attempt++) {
    let data, sha;
    try { const got = await readData(env, headers, path); data = load(got.raw); sha = got.sha; } catch (e) { why = e.message; break; }
    const out = edit(data);
    if (out.error || out.skip) return { ...out, text: null };
    const next = dump(data);
    const put = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message: out.message, content: base64(utf8.encode(next)), branch: dataBranch(env), ...(sha ? { sha } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (put.ok) return { ...out, text: next };
    why = `saving it: ${put.status} ${(await put.text()).slice(0, 300)}`;
    if (put.status !== 409) break; // 409: the file changed since it was read, so read it again
  }
  console.error(`${file}: couldn't save it, ${why}`);
  return { error: "off", status: 502 };
}
const editRuns = (env, edit) => editData(env, RUNS_FILE, loadRuns, dumpRuns, edit);
// The site shows a saved run straight away: the cached game data gets the new runs.json (and history.json, when that
// changed too: see "Claiming legacy runs"), and the player's Discord name and picture go in until the next lookup has
// them. That copy is only kept for a few minutes, so adding someone never puts off the lookup for everyone else.
// (Copies from GitHub have the change too: both files are read through GitHub's API, which doesn't serve old copies
// the way raw files can.)
async function putCached(name, ttl, body) {
  await Promise.all([
    caches.default.put(cacheKey(name), new Response(body, { headers: { "Cache-Control": `public, max-age=${ttl}` } })),
    caches.default.put(cacheKey(name, true), new Response(body, { headers: { "Cache-Control": `public, max-age=${STALE_FOR}` } })),
  ]);
}
async function showSaved(runsText, user, historyText = null) {
  const gameCopy = await stored("game");
  if (gameCopy && (runsText || historyText)) {
    const d = JSON.parse(gameCopy);
    if (runsText) d.files[RUNS_FILE] = runsText;
    if (historyText) d.files[HISTORY_FILE] = historyText;
    await putCached("game", 60, JSON.stringify(d));
  }
  const playersCopy = user && (await stored("players"));
  if (playersCopy) {
    const d = JSON.parse(playersCopy);
    if (!(d[user.id] && d[user.id].name)) { d[user.id] = { name: user.name, avatar: user.avatar }; await putCached("players", 5 * 60, JSON.stringify(d)); }
  }
}
// The cached game data's course files, names and list (fetched if there's none yet)
async function gameInfo(env, ctx) {
  try {
    const { files = null, names = {}, flags = {}, courses = [] } = JSON.parse((await stored("game")) ?? (await game(env, ctx)));
    return { files, names, flags, courses };
  } catch (e) { return { files: null, names: {}, flags: {}, courses: [] }; }
}
const courseFile = (files, n) => files && Object.keys(files).find((k) => k.startsWith(`leaderboards/${n}-`) && /\.(opy|json)$/.test(k));
/* ---------- Each run's page ----------
   Every run sent from the website has a page, ballkour.com/runs/<id>, which the page itself draws from runs.json (see
   "A run's page" in index.html): the run, its video, and what it did to the boards, both when it was sent and on
   today's boards. Reviewers get Approve and Turn down there too.
   Ballkyrie posts every run in the run submissions channel (RUNS_CHANNEL in wrangler.toml), with a View run button to
   its page (see runPost). The post stays as it was sent, except that a top 10 run's, which waits for a check, turns
   green or red once a moderator approves it or turns it down, says who did and when, and gets the numbers as they are
   then, the same as the DM to its player (afterCheck). For that, the post's message on Discord is kept in PROFILES as
   post:<id> until then. Ballkyrie needs to be able to see the
   channel, send messages and embed links there.
   What a run did when it was sent is worked out here as it's sent (runStats) and kept in PROFILES as run:<id>, so it
   doesn't change as other runs come in.
     GET /api/run?id=<id>   { stats } (null when there are none: PROFILES isn't set up, or it isn't saved yet) */
const statsKey = (id) => `run:${id}`;
const postKey = (id) => `post:${id}`;
// What a course is worth, all of it for the record (see ratings.js). It was 10,000 until November 2026, and what was
// kept for a run before then has no scale: it's served on today's, a tenth of it (onScale), so its page agrees with
// the boards.
const RATING_SCALE = 1000;
function onScale(stats) {
  if (!stats || stats.scale === RATING_SCALE) return stats;
  const tenth = (v) => (typeof v === "number" ? Math.round(v / 10) : v);
  const pair = (p) => (Array.isArray(p) ? p.map(tenth) : p);
  const alone = stats.alone && typeof stats.alone === "object" ? { ...stats.alone, points: tenth(stats.alone.points) } : stats.alone;
  return { ...stats, points: pair(stats.points), rating: pair(stats.rating), alone, scale: RATING_SCALE };
}
// What a run did to the boards: where its player stood on its course and in the player ratings just before it, and
// with it (a run waiting for a check, as if it were on the board already). before is runs.json as it was just before.
// The page works out the same numbers from today's boards (statsFrom() in index.html): keep the two in step.
//   { place, was, players, best, bestMiss, old, record, points, rating, rank, of, tier, courses, counted,
//     top10s, podiums, records, scale, alone }
// place and was are their place on the course with and before the run (was is null on their first run there),
// players how many players are on the course's board with it (what was kept before there was players has none), best
// and old their best time there with and before it, and bestMiss the mistakes on that best (it isn't the run when its
// time or mistakes aren't the run's: a tie on time goes to fewer mistakes). points (the course rating), rating, rank
// (their place in the ratings) and
// tier are [before, with] (before null when they weren't rated yet, the pair null when the course isn't rated), of is
// how many players are rated, courses [before, with] the rated courses they've run out of counted, and top10s,
// podiums and records [before, with] over every course. global is their Top % in the Global rating [before, with],
// each { tier } (before null when they weren't rated yet, global null when they aren't with it either; what was kept
// before there was global has none). alone is the run by itself, for one that isn't its player's
// best (which changes none of the above): { place } among everyone else's bests, and the course rating its time gets
// ({ points }, null when the course isn't rated). scale is what a course was worth when they were worked out (see
// RATING_SCALE).
// An assisted run's are all on the assisted boards, and its ratings are the assisted ones.
function runStats(game, before, run, n) {
  const key = playerKey(run);
  const after = structuredClone(before);
  listIn(after.runs, n).push(run);
  // Their place in the Global rating too (the unassisted and assisted ratings added up, see combine()), for their
  // (Global) role on Discord. The other kind's ratings don't change with this run, so they're worked out once.
  const other = rate(loadCourses({ ...game.files, [RUNS_FILE]: JSON.stringify(before) }, game.courses, { assisted: !isAssisted(run) }));
  const side = (runs) => {
    const courses = loadCourses({ ...game.files, [RUNS_FILE]: JSON.stringify(runs) }, game.courses, { assisted: isAssisted(run) });
    const medals = { top10s: 0, podiums: 0, records: 0 };
    let board = [];
    for (const c of courses) {
      const { top, rest } = standings(c);
      const all = [...top, ...rest];
      if (c.n === n) board = all;
      const i = all.findIndex((r) => playerKey(r) === key);
      if (i < 0) continue;
      if (i < 10) medals.top10s++;
      if (i < 3) medals.podiums++;
      if (i === 0) medals.records++;
    }
    const at = board.findIndex((r) => playerKey(r) === key);
    const rated = rate(courses);
    const g = combine([rated, other]).players.find((x) => x.key === key) || null;
    return { board, at, best: at >= 0 ? board[at] : null, p: rated.players.find((x) => x.key === key) || null, g, total: rated.players.length, counted: rated.counted.length, medals };
  };
  const b = side(before), a = side(after);
  const rated = !(game.courses.find((c) => c.n === n) || { broken: true }).broken;
  const record = a.board[0];
  const pair = (get) => (a.p && get(a.p) !== undefined ? [b.p && get(b.p) !== undefined ? get(b.p) : null, get(a.p)] : null);
  const round = (v) => (v === undefined ? undefined : Math.round(v));
  return {
    place: a.at >= 0 ? a.at + 1 : null,
    was: b.at >= 0 ? b.at + 1 : null,
    players: a.board.length,
    best: a.best ? a.best.time : null,
    bestMiss: a.best ? a.best.mistakes : null,
    old: b.best ? b.best.time : null,
    record: a.at === 0 && (!b.board[0] || runByTime(a.best, b.board[0]) < 0),
    points: pair((p) => round(p.points[n])),
    rating: pair((p) => Math.round(p.rating)),
    rank: pair((p) => p.rank),
    of: a.total,
    tier: pair((p) => p.tier),
    global: a.g ? [b.g ? { tier: b.g.tier } : null, { tier: a.g.tier }] : null,
    courses: a.p ? [b.p ? b.p.courses : 0, a.p.courses] : null,
    counted: a.counted,
    top10s: [b.medals.top10s, a.medals.top10s],
    podiums: [b.medals.podiums, a.medals.podiums],
    records: [b.medals.records, a.medals.records],
    scale: RATING_SCALE,
    alone: {
      place: 1 + a.board.filter((r) => playerKey(r) !== key && runByTime(r, run) < 0).length,
      points: rated && record ? Math.round(RATING_SCALE * Math.log(1 + (Math.E - 1) * toSeconds(record.time) / toSeconds(run.time)) ** 2) : null,
    },
  };
}
// Works out what a run did as it's sent (runStats)
async function sentStats(env, ctx, { n, run, before }) {
  if (!before) return null;
  const game = await gameData(env, ctx);
  if (!game || !game.files || !Array.isArray(game.courses)) throw new Error("the game data has no course list yet");
  return runStats(game, before, run, n);
}
// A gap between two times, the way the site writes one (gap() in index.html): "0.52s", or "1:05.30" from a minute up
function gapText(sec) {
  const cs = Math.round(Math.abs(sec) * 100);
  const s = ((cs % 6000) / 100).toFixed(2);
  const m = Math.floor(cs / 6000);
  if (!m) return `${s}s`;
  return m < 60 ? `${m}:${s.padStart(5, "0")}` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s.padStart(5, "0")}`;
}
// How much a number changed: "+4", "−1", or "Same"
const changeText = (v) => (v ? `${v < 0 ? "−" : "+"}${Math.abs(v)}` : "Same");
// Where a place went: "#2 → #1", or "Same"
const movedText = (from, to) => (from === to ? "Same" : `#${from} → #${to}`);
// A player's name in an embed's title. Discord draws bold, italics, underline, strikethrough and spoilers there, but not
// links, headings or quotes, so only the characters for those five are escaped (no stray backslashes before a dash).
const titleSafe = (s) => String(s).replace(/([\\*_~|])/g, "\\$1");
// A player's Top % (a tier from rate(), null past the last one), under "Unassisted Top %" in a run's post: "10%", or
// "Rated" for the bottom 10% (as their role on Discord), or "Unrated" when they have no rating
const tierText = (tier, rated) => (typeof tier === "number" ? `${tier}%` : rated ? "Rated" : "Unrated");
// What comes after /profile/ in a player's link: the name they picked, else their number, else (no number yet) their
// Discord ID, the same as the page's linkOf(). links is links.json's players (linksIn).
const linkOf = (links, id) => (links && links[id] ? links[id].link || String(links[id].n) : id);
// When a run was sent, written by Discord in each reader's own language and time zone: "October 30, 2026 at 12:41 PM".
// A run from before the website's form only has its day ("July 21, 2026"): noon UTC is that day almost everywhere.
// "" when it has neither.
function whenText(run) {
  const at = Date.parse(run.sentAt || "");
  if (!Number.isNaN(at)) return `<t:${Math.floor(at / 1000)}:f>`;
  return /^\d{4}-\d{2}-\d{2}$/.test(run.date || "") ? `<t:${Date.parse(`${run.date}T12:00:00Z`) / 1000}:D>` : "";
}
// How long after one run another was sent, in its two biggest units: "3 months, 9 days", "2 days, 4 hours", "12
// minutes". Months and years go by the calendar (UTC). When the earlier one only has its day, it's counted in whole
// days. "" when either has no date, or they're the wrong way round.
function spanText(from, to) {
  const exact = !Number.isNaN(Date.parse(from.sentAt || ""));
  const day = (r) => (/^\d{4}-\d{2}-\d{2}$/.test(r.date || "") ? Date.parse(`${r.date}T00:00:00Z`) : NaN);
  const a = exact ? Date.parse(from.sentAt) : day(from), b = exact ? Date.parse(to.sentAt) : day(to);
  if (!(b >= a)) return "";
  // a, so many months on: the same day of the month, or the month's last when it has no such day (January 31 → February 28)
  const later = (months) => {
    const d = new Date(a);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    d.setUTCDate(Math.min(new Date(a).getUTCDate(), new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
    return d.getTime();
  };
  let months = (new Date(b).getUTCFullYear() - new Date(a).getUTCFullYear()) * 12 + new Date(b).getUTCMonth() - new Date(a).getUTCMonth();
  if (later(months) > b) months--;
  const rest = Math.floor((b - later(months)) / 1000);
  const units = [
    [Math.floor(months / 12), "year"], [months % 12, "month"], [Math.floor(rest / 86400), "day"],
    [Math.floor(rest / 3600) % 24, "hour"], [Math.floor(rest / 60) % 60, "minute"], [rest % 60, "second"],
  ];
  const first = units.findIndex(([count]) => count);
  if (first < 0) return exact ? "Less than a second" : "Less than a day";
  return units.slice(first, first + 2).filter(([count]) => count).map(([count, unit]) => `${count} ${unit}${count === 1 ? "" : "s"}`).join(", ");
}
// The player's best run on the course just before this one (the run stats.old is the time of), with its mistakes and
// when it was sent: from runs.json as it was (before), or from the course's file and old boards (mine), which only
// have its day. null on their first run there, or without stats.
function bestBefore({ n, run, before, mine }, stats) {
  if (!stats || !stats.old) return null;
  const sent = before ? ofMode(before.runs[n], run) : [];
  const same = [...sent, ...(mine || [])].filter((r) => r && r.discord === run.discord && r.time === stats.old && Number.isInteger(r.mistakes));
  // A tie on time goes to fewer mistakes, as on the boards
  return same.sort((a, b) => a.mistakes - b.mistakes)[0] || { time: stats.old };
}
/* The run's post in the run submissions channel. Its title says what the run is, and opens its page:
     New record submission by NAME!    their best on the course, and #1 there
     New podium submission by NAME!    their best, and #2 or #3
     New top 10 submission by NAME!    their best, and #4 to #10
     New personal best by NAME!        their best, past the top 10 (or their first run there)
     New submission by NAME!           not their best
   Under it: the course, who sent it, their in-game name and the video, then three blocks side by side. New personal
   best is the run: its time, mistakes, course rating, the place it takes on the course, the player's rating, place and
   Top % in the player ratings with it, the courses they've run and their Top 10s, Podiums and Records when it changes
   them, and its date. Under the blocks, New role names the roles on our Discord it gives them, once it's on the board. Old personal best is the same for their best on the course
   before it, with their place, rating, place and Top % in the ratings as they were. Comparison is what changed between
   the two, and how long after the old one it came. On their first run on a course there's just the run, with what it
   added to their rating, and where it moved them in the ratings, in the same rows. A run that isn't
   their best is This run beside Personal best: its course rating and place are the ones it would get on its own, and
   neither has anything from the player ratings, which it doesn't count toward.
   A top 10 run, which waits for a check, is in yellow, with its numbers as they'd be once approved, and says so at the
   bottom, until a moderator checks it (see checkedPost, which also has what changes then). Every other run is in green. Under it are View run (which
   the title opens too), Board (the course's) and Profile (the player's panel). The DM to the player once a moderator
   checks their run has the same blocks and buttons (checkedRunMessage).
   Without stats (runStats), it has no ratings, and no best from before to compare with: just the run and its place. */
// The three blocks side by side (see runPost), for the run's post and for the DM to its player once a moderator checks
// it (checkedRunMessage), with whether it's its player's best on the course and the place it takes there. A run that's
// been turned down (checked.approve false) is Turned-down run, beside Personal best: the best it would have replaced,
// which still is, with what the run would have done.
function runBlocks({ n, run, rank, newBest, stats, before, mine, checked, pending }) {
  const s = stats || {};
  // A run's ratings are the ones of its kind: the unassisted ones, or an assisted run's assisted ones, named the way
  // the Player ratings' tabs and the run's page name them (not Global, which is both added up)
  const scope = isAssisted(run) ? "Assisted" : "Unassisted";
  // Whether it's their best on the course: by its numbers, which read the boards the way the site does, or else by
  // where it placed
  const best = stats ? s.best === run.time && s.bestMiss === run.mistakes : !!newBest;
  const place = (best && s.place) || rank;
  const old = bestBefore({ n, run, before, mine }, stats);
  const down = !!checked && !checked.approve;
  const num = (v) => typeof v === "number";
  const of = (pair, i) => (Array.isArray(pair) && num(pair[i]) ? pair[i] : null);
  // The run's numbers (now), and those of their best before it (was): its course rating, its place on the course,
  // and their rating, place and Top % in the player ratings
  const alone = s.alone || {};
  const ratedBefore = num(of(s.rating, 0));
  const tiers = best && Array.isArray(s.tier) && num(of(s.rating, 1)) ? s.tier : null;
  const now = best
    ? { points: of(s.points, 1), place, rating: of(s.rating, 1), rank: of(s.rank, 1), tier: tiers && tierText(tiers[1], true) }
    : { points: alone.points, place: alone.place || rank };
  const was = best
    ? { points: of(s.points, 0), place: s.was, rating: of(s.rating, 0), rank: of(s.rank, 0), tier: tiers && tierText(tiers[0], ratedBefore) }
    : { points: of(s.points, 1), place: s.place };
  const tierMoved = !!tiers && (tiers[0] !== tiers[1] || !ratedBefore);
  // With no best from before (their first run on the course), there's no Comparison, so what the run changed goes in
  // the same rows, the way Comparison writes it: "137 (+91)", "#10 → #2 of 16" and "75% → 25%". The player
  // ratings are over every course, so a first run on one can still move a player who's run others.
  const gain = !old && num(now.rating) ? now.rating - (of(s.rating, 0) ?? 0) : 0;
  const climb = !old && num(now.rank) && num(of(s.rank, 0)) && of(s.rank, 0) !== now.rank;
  const rose = !old && ratedBefore && tierMoved;
  // The rated courses they've run ("3 of 11"), and their Top 10s, Podiums and Records over every course (the numbers
  // on their Discord profile), when the run changes them, as the site shows them after a run: with the run in its
  // block, before it in their old best's, and what changed in Comparison, or on their first run on the course, after
  // the run's count ("2 (+1)")
  const counts = best ? [["courses", "Courses run"], ["top10s", "Top 10s"], ["podiums", "Podiums"], ["records", "Records"]]
    .filter(([k]) => num(of(s[k], 0)) && num(of(s[k], 1)) && s[k][0] !== s[k][1]) : [];
  const countText = (k, v) => (k === "courses" && num(s.counted) ? `${v} of ${s.counted}` : String(v));
  // The roles on our Discord the run gives them, named as there, once it's on the board (not while it waits for a check,
  // or once it's turned down): for its Top % in the ratings of its kind ((Unassisted) or (Assisted)), and in the Global
  // rating, each a role of its own
  const roleOf = (tier, rated, kind) => `${!rated ? "Unrated" : typeof tier === "number" ? `Top ${tier}%` : "Rated"} (${kind})`;
  const onBoard = best && !pending && (!checked || checked.approve);
  const roles = !onBoard ? [] : [
    tiers && [roleOf(tiers[0], ratedBefore, isAssisted(run) ? "Assisted" : "Unassisted"), roleOf(tiers[1], true, isAssisted(run) ? "Assisted" : "Unassisted")],
    Array.isArray(s.global) && s.global[1] && [roleOf(s.global[0] && s.global[0].tier, !!s.global[0], "Global"), roleOf(s.global[1].tier, true, "Global")],
  ].filter((pair) => pair && pair[0] !== pair[1]).map((pair) => pair[1]);
  // The same rows in the same order in every block, so they line up side by side
  const about = (r, d, first) => [
    `Time: ${r.time}`,
    Number.isInteger(r.mistakes) && `Mistakes: ${r.mistakes}`,
    num(d.points) && `Course rating: ${d.points}`,
    num(d.place) && `Course rank: #${d.place}${s.players ? ` of ${s.players}` : ""}`,
    num(d.rating) && `${scope} rating: ${d.rating}${first && gain ? ` (${changeText(gain)})` : ""}`,
    num(d.rank) && `${scope} rank: ${first && climb ? `#${of(s.rank, 0)} → ` : ""}#${d.rank} of ${s.of}`,
    d.tier && `${scope} Top %: ${first && rose ? `${was.tier} → ` : ""}${d.tier}`,
    ...counts.map(([k, name]) => `${name}: ${countText(k, s[k][first ? 1 : 0])}${first && !old ? ` (${changeText(s[k][1] - s[k][0])})` : ""}`),
    whenText(r) && `Date: ${whenText(r)}`,
  ].filter(Boolean).join("\n");
  const both = (a, b) => num(a) && num(b);
  const saved = old ? Math.round((toSeconds(old.time) - toSeconds(run.time)) * 100) / 100 : 0;
  const span = old ? spanText(old, run) : "";
  return {
    best,
    place,
    fields: [
      { name: down ? "Turned-down run" : best ? "New personal best" : "This run", value: about(run, now, true), inline: true },
      ...(old ? [
        { name: best && !down ? "Old personal best" : "Personal best", value: about(old, was), inline: true },
        {
          name: "Comparison",
          value: [
            saved ? `Time ${saved > 0 ? "saved" : "behind"}: ${gapText(saved)}` : "Time: Same",
            Number.isInteger(old.mistakes) && `Mistakes: ${changeText(run.mistakes - old.mistakes)}`,
            both(now.points, was.points) && `Course rating: ${changeText(now.points - was.points)}`,
            both(now.place, was.place) && `Course rank: ${movedText(was.place, now.place)}`,
            both(now.rating, was.rating) && `${scope} rating: ${changeText(now.rating - was.rating)}`,
            both(now.rank, was.rank) && `${scope} rank: ${movedText(was.rank, now.rank)}`,
            // "Unassisted Top %: 50% → 25%" is a little wider than the column, so a change there may take two lines
            tiers && `${scope} Top %: ${tierMoved ? `${was.tier} → ${now.tier}` : "Same"}`,
            ...counts.map(([k, name]) => `${name}: ${changeText(s[k][1] - s[k][0])}`),
            span && `${best && !down ? "Achieved" : "Sent"} after: ${span}`,
          ].filter(Boolean).join("\n"),
          inline: true,
        },
      ] : []),
      // Under the blocks, across the whole post
      ...(roles.length ? [{ name: roles.length > 1 ? "New roles" : "New role", value: roles.join("\n"), inline: false }] : []),
    ],
  };
}
// The buttons under the run's post and the DM: View run, Board (the course's) and Profile (the player's panel, at their
// own link)
function runButtons({ n, run, site, links }) {
  const button = (label, url) => ({ type: 2, style: 5, label, url });
  return [{
    type: 1,
    components: [
      button("View run", `${site}/runs/${run.id}`),
      button("Board", `${site}/leaderboards/${n}${isAssisted(run) ? "/assisted" : ""}`),
      button("Profile", `${site}/profile/${encodeURIComponent(linkOf(links, run.discord))}`),
    ],
  }];
}
// Who checked a run and when, at the bottom of its post and the DM: "Approved by NAME • Today at 3:20 PM" (Discord
// writes the time, from timestamp, in each reader's own time zone)
function checkedFooter(run, { approve, by }) {
  const at = Date.parse(run.checkedAt || "");
  return {
    footer: { text: `${approve ? "Approved" : "Turned down"} by ${by || "a moderator"}` },
    ...(Number.isNaN(at) ? {} : { timestamp: new Date(at).toISOString() }),
  };
}
// A course the way the site writes it, in a run's post and the DM: its number, flag and name ("1 🇬🇮 Watchpoint:
// Gibraltar"), or "Course 1" without its name. safe escapes the name for where it goes (mdSafe, or titleSafe).
const courseText = (n, name, flag, safe) => (name ? `${n} ${flag ? `${flag} ` : ""}${safe(name)}` : `Course ${n}`);
// The colours: green for a run on the board, yellow while it waits for a check, red once it's turned down
const GREEN = 0x00e697, YELLOW = 0xffd54f, RED = 0xff6a4f;
function runPost(info) {
  const { n, courseName, courseFlag, run, pending, site, checked } = info;
  const { best, place, fields } = runBlocks(info);
  const what = !best ? "New submission" : place === 1 ? "New record submission" : place <= 3 ? "New podium submission" : place <= 10 ? "New top 10 submission" : "New personal best";
  // "New assisted record submission by NAME!": a run played in Assist Mode, for its course's assisted board
  const title = `${isAssisted(run) ? what.replace(/^New /, "New assisted ") : what} by ${titleSafe(run.name)}!`;
  return {
    allowed_mentions: { parse: [] }, // shows who sent it without pinging them
    embeds: [{
      // Struck through once it's turned down, so it's plain that it isn't one
      title: checked && !checked.approve ? `~~${title}~~` : title,
      url: `${site}/runs/${run.id}`,
      description: `**${courseText(n, courseName, courseFlag, mdSafe)}**${isAssisted(run) ? " · Assisted" : ""}`,
      color: checked ? (checked.approve ? GREEN : RED) : pending ? YELLOW : GREEN,
      fields: [
        { name: "Sent by", value: `<@${run.discord}>`, inline: true },
        { name: "Player name", value: mdSafe(run.name), inline: true },
        // Only top 10 runs need a video, so the rest can come without one
        { name: "Video", value: run.video ? `[Watch](${run.video})` : "None", inline: true },
        ...fields,
      ],
      // The embed's footer: small grey text under everything else
      ...(checked ? checkedFooter(run, checked) : pending ? { footer: { text: "Waiting for a check from moderators" } } : {}),
    }],
    components: runButtons(info),
  };
}
async function postRun(env, info) {
  if (!env.RUNS_CHANNEL || !env.DISCORD_BOT_TOKEN) return;
  const message = runPost(info);
  const sent = await postIn(env, env.RUNS_CHANNEL, message, `run ${info.run.id}`);
  // A top 10 run's post changes once a moderator checks it (checkedPost), so its message is kept until then
  if (info.pending && sent && sent.id && env.PROFILES) {
    await env.PROFILES.put(postKey(info.run.id), JSON.stringify({ channel: env.RUNS_CHANNEL, id: sent.id, message }))
      .catch((e) => console.error(`run ${info.run.id}: couldn't keep its post for when it's checked: ${(e && e.message) || e}`));
  }
}
// Once a moderator checks a top 10 run, its post is made again (runPost) with what it does to the boards then, the same
// as the DM to its player (see afterCheck), in green (approved) or red (turned down, with its title struck through),
// and says who checked it and when. Without those numbers (they couldn't be worked out), it keeps the ones from when
// it was sent. A post that wasn't kept (from before posts were, or one PROFILES couldn't save) stays as it is.
async function checkedPost(env, info) {
  const { run, checked } = info;
  if (!env.PROFILES || !env.DISCORD_BOT_TOKEN) return;
  const kept = await env.PROFILES.get(postKey(run.id), "json").catch(() => null);
  const sent = kept && kept.message;
  if (!sent || !Array.isArray(sent.embeds) || !sent.embeds[0] || !kept.id) return;
  let message = info.stats ? runPost(info) : null;
  if (!message) {
    const e = sent.embeds[0];
    const down = !checked.approve;
    const renamed = { "New personal best": "Turned-down run", "This run": "Turned-down run", "Old personal best": "Personal best" };
    message = {
      ...sent,
      embeds: [{
        ...e,
        title: down ? `~~${e.title}~~` : e.title,
        color: down ? RED : GREEN,
        fields: (e.fields || []).map((f) => (!down ? f
          : renamed[f.name] ? { ...f, name: renamed[f.name] }
          : f.name === "Comparison" ? { ...f, value: f.value.replace("Achieved after:", "Sent after:") } : f)),
        ...checkedFooter(run, checked),
      }],
    };
  }
  const res = await fetch(`${DISCORD_API}/channels/${kept.channel}/messages/${kept.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify({ embeds: message.embeds, components: message.components, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => ({ ok: false, status: String((e && e.message) || e), text: async () => "" }));
  if (!res.ok) { console.error(`run ${run.id}: Ballkyrie couldn't change its post, Discord said ${res.status} ${(await res.text()).slice(0, 200)}`); return; }
  await env.PROFILES.delete(postKey(run.id)).catch(() => {});
}
// Ballkyrie posts a message in a channel. what says what it's about, for the log if it can't. → the message Discord
// made ({ id, … }), or null if it didn't
async function postIn(env, channel, message, what) {
  const res = await fetch(`${DISCORD_API}/channels/${channel}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => ({ ok: false, status: String((e && e.message) || e), text: async () => "" }));
  if (!res.ok) { console.error(`${what}: Ballkyrie couldn't post in channel ${channel}, Discord said ${res.status} ${(await res.text()).slice(0, 200)}`); return null; }
  return res.json().catch(() => null);
}
/* Ballkyrie tells a player in a direct message when a moderator checks their top 10 run (approved, or turned down) or
   their claim to legacy runs (linked, or turned down), with a button to the run's page or their stats. Someone who
   doesn't take DMs from server members, or isn't on the server, just doesn't get one (and `npx wrangler tail` says so).
   Only with NOTIFY_PLAYERS = "on" in wrangler.toml, so the test copy never messages anyone. */
async function tellPlayer(env, id, message, what) {
  if (env.NOTIFY_PLAYERS !== "on" || !env.DISCORD_BOT_TOKEN || !/^\d{17,20}$/.test(id || "")) return;
  const dm = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
    body: JSON.stringify({ recipient_id: id }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!dm || !dm.id) { console.error(`${what}: Ballkyrie couldn't open a DM with ${id}`); return; }
  await postIn(env, dm.id, message, what);
}
// What it says to a player about their run a moderator checked: the same blocks as its post (runBlocks), worked out
// as it's checked (see afterCheck), then who checked it and when, as on the post, and the post's buttons. Without
// stats, the blocks just have the run.
function checkedRunMessage(info) {
  const { run, n, courseName, courseFlag, site, checked } = info;
  const where = courseText(n, courseName, courseFlag, titleSafe);
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: checked.approve ? `Your ${run.time} on ${where} is on the ${isAssisted(run) ? "assisted " : ""}board!` : `Your ${run.time} on ${where} was turned down`,
      url: `${site}/runs/${run.id}`,
      color: checked.approve ? GREEN : RED,
      description: checked.approve
        ? `A moderator checked your video and approved your run. The new ${isAssisted(run) ? "assisted " : ""}top 10 goes up on our Discord in a few minutes.`
        : `A moderator checked your video and turned your run down, so it won’t go on the board. You can send it again with another video, and if you think it’s a mistake, open a ticket on our Discord here: <#${TICKETS_CHANNEL}>`,
      fields: runBlocks(info).fields,
      ...checkedFooter(run, checked),
    }],
    components: runButtons(info),
  };
}
// Once a moderator checks a top 10 run: what it does to the boards now (or would have, for one turned down), worked out
// once for both its post (checkedPost) and the DM to its player (checkedRunMessage), so the two always match. before
// is runs.json just before it went onto the board or into "declined", and by the moderator's name.
async function afterCheck(env, ctx, { run, n, approve, before, by, site }) {
  const dm = env.NOTIFY_PLAYERS === "on" && !!env.DISCORD_BOT_TOKEN;
  const post = !!env.PROFILES && !!env.DISCORD_BOT_TOKEN;
  if (!dm && !post) return;
  const { files, names, flags } = await gameInfo(env, ctx);
  const file = courseFile(files, n);
  // An assisted run's board has none of the course file's runs, or of its old boards (see ofMode)
  const board = isAssisted(run) ? [] : fileRuns(file, file && files[file]);
  const mine = isAssisted(run) ? [] : [...board, ...historyRuns(files, n)].filter((r) => r.discord === run.discord);
  const { rank, newBest } = placeOf(run, [...board, ...ofMode(before.runs[n], run)], ofMode(before.removed[n], run));
  const stats = await sentStats(env, ctx, { n, run, before }).catch((e) => {
    console.error(`run ${run.id}: couldn't work out what it does now: ${(e && e.message) || e}`);
    return null;
  });
  const info = { n, courseName: names[n], courseFlag: flags[n], run, before, mine, links: linksIn(files), rank, newBest, stats, site, checked: { approve, by } };
  await Promise.all([
    post && checkedPost(env, info),
    dm && tellPlayer(env, run.discord, checkedRunMessage(info), `run ${run.id}`),
  ]);
}
// And about a claim to legacy runs
function checkedClaimMessage({ claim, approve, site }) {
  const runs = `${site}/profile/${encodeURIComponent(upper(claim.name))}`;
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: approve ? `Your legacy runs as ${claim.name} are linked to you` : `Your claim to the legacy runs as ${claim.name} was turned down`,
      url: approve ? `${site}/profile` : runs,
      color: approve ? GREEN : RED,
      description: approve
        ? "A moderator checked that they’re yours. They’re in My profile now, with your Discord name and picture by them on the boards."
        : `A moderator couldn’t confirm that they’re yours. If they are, open a ticket with proof, like an old screenshot or clip, on our Discord here: <#${TICKETS_CHANNEL}>`,
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: approve ? "My profile" : "See the runs", url: approve ? `${site}/profile` : runs }] }],
  };
}
// After a run is saved: its numbers first, kept for its page so they're there by the time anyone opens it from the
// post, and in the post too. Without them, the post still goes, with just its place on the course.
async function afterSend(env, ctx, info) {
  const fail = (what) => (e) => { console.error(`run ${info.run.id}: couldn't ${what}: ${(e && e.message) || e}`); return null; };
  const stats = await sentStats(env, ctx, info).catch(fail("work out what it did"));
  if (stats && env.PROFILES) await env.PROFILES.put(statsKey(info.run.id), JSON.stringify(stats)).catch(fail("save what it did"));
  await postRun(env, { ...info, stats });
}
async function runInfo(request, env) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[\w-]{1,16}$/.test(id)) return answer(400, { error: "bad" });
  const stats = onScale(env.PROFILES ? await env.PROFILES.get(statsKey(id), "json").catch(() => null) : null);
  const res = answer(200, { stats });
  if (stats) res.headers.set("Cache-Control", "public, max-age=86400"); // they never change
  return res;
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
  // Only a top 10 run needs a video (see below), but one that's there has to be a link
  const rawVideo = String(body.video ?? "").trim();
  const video = rawVideo ? cleanVideo(rawVideo) : "";
  if (!Number.isInteger(n) || n < 1 || n > 99) return answer(400, { error: "course" });
  if (!NAME_OK.test(name)) return answer(400, { error: "name" });
  if (!time) return answer(400, { error: "time" });
  if (!Number.isInteger(mistakes) || mistakes < 0 || mistakes > 9999) return answer(400, { error: "miss" });
  if (rawVideo && !video) return answer(400, { error: "video" });
  // Played in Assist Mode: it goes on the course's assisted board (see ofMode)
  const assisted = body.assisted === true;

  // The course has to have a board. Without the game data (GitHub down, and no copy kept here), there's no telling which
  // courses there are, so nothing is saved: the form says to open a ticket instead.
  const { files, names, flags, courses } = await gameInfo(env, ctx);
  if (!files) return answer(503, { error: "off" });
  const file = courseFile(files, n);
  if (!file) return answer(400, { error: "course" });
  // Nor can anyone run a broken course (courses.json in the game repo), unless it's a remake, whose Beta code still
  // works. The form doesn't offer them, the same way.
  const info = courses.find((c) => c.n === n);
  if (info && info.broken && !info.remake) return answer(400, { error: "course" });
  // Only the remakes have Assist Mode (it's part of their Workshop script), so an assisted run on any other course can't
  // be real. The form grays the checkbox out for them.
  if (assisted && !(info && info.remake)) return answer(400, { error: "assisted" });
  // An assisted run's board has none of the course file's runs (see ofMode)
  const board = assisted ? [] : fileRuns(file, file && files[file]);
  // Their runs from before the website's form are on the board, or on its old boards (none of them assisted)
  const mine = assisted ? [] : [...board, ...historyRuns(files, n)].filter((r) => r.discord === user.id);

  const sentAt = stamp();
  const run = { name: caps(name), discord: user.id, time, mistakes, date: sentAt.slice(0, 10), ...(video ? { video } : {}), id: "", sentAt, ...(assisted ? { mode: ASSISTED } : {}) };
  let before = null; // runs.json just before the run went in, for what it did (runStats)
  const saved = await editRuns(env, (data) => {
    const list = listIn(data.runs, n), waiting = listIn(data.pending, n);
    // The same run sent twice is only saved once, and so is one from before the form that's on a board, which has no
    // id (a turned-down run can be sent again, with a new video, say, and so can one that's taken off)
    const removed = ofMode(data.removed[n], run);
    const old = mine.filter((r) => !removed.some((x) => sameRunAs(x, r)));
    const same = [...ofMode(list, run), ...ofMode(waiting, run), ...old].find((r) => r && r.discord === run.discord && r.time === run.time && r.mistakes === run.mistakes);
    if (same) return { skip: true, id: same.id };
    const today = ["runs", "pending", "declined"].flatMap((k) => Object.values(data[k]).flat()).filter((r) => r && r.discord === run.discord && r.date === run.date).length;
    if (today >= 20) return { error: "rate", status: 429 };
    const { rank, newBest } = placeOf(run, [...board, ...ofMode(list, run)], removed);
    // A top 10 run waits for a moderator to check its video, so it can't be sent without one (the form says so first:
    // videoRank() in index.html)
    if (rank <= 10 && newBest && !run.video) return { error: "video", status: 400 };
    before = structuredClone(data);
    // Its id: the next number, worked out again if runs.json changed under it (see editRuns), so two runs sent at
    // once can't get the same one
    data.lastId = nextId(data);
    run.id = String(data.lastId);
    if (rank <= 10 && newBest) {
      waiting.push(run);
      return { message: `chore(leaderboard): hold ${run.name}'s ${assisted ? "assisted " : ""}${run.time} on course ${n} for a check`, pending: true, rank, newBest };
    }
    list.push(run);
    return { message: `chore(leaderboard): add ${run.name}'s ${assisted ? "assisted " : ""}${run.time} on course ${n} from ballkour.com`, pending: false, rank, newBest };
  });
  if (saved.error) return answer(saved.status, { error: saved.error });
  await showSaved(saved.text, user).catch((e) => console.error(`submit: couldn't update the cached copy: ${(e && e.message) || e}`));
  if (saved.text) ctx.waitUntil(afterSend(env, ctx, { n, courseName: names[n], courseFlag: flags[n], run, before, mine, links: linksIn(files), pending: saved.pending, rank: saved.rank, newBest: saved.newBest, site: url.origin }));
  if (saved.text && !saved.pending) ctx.waitUntil(profileAfterRun(env, ctx, user.id));
  // Sent twice: the run that's already in, with its id (undefined ones are left out of the answer)
  const shown = saved.text ? run : { ...run, id: saved.id, sentAt: undefined };
  return answer(200, { ok: true, run: shown, saved: !!saved.text, pending: !!saved.pending, rank: saved.rank || null });
}

// The runs waiting for a check, oldest first, each with where it would place now
async function pending(request, env, ctx) {
  const user = await readSession(request, env);
  if (!(await isReviewer(env, user, 60))) return answer(403, { error: "bad" });
  let data;
  try { ({ data } = await readRuns(env, await runsApi(env))); } catch (e) { console.error(`pending: ${e.message}`); return answer(502, { error: "off" }); }
  const { files, names } = await gameInfo(env, ctx);
  const runs = Object.entries(data.pending).flatMap(([n, list]) => (Array.isArray(list) ? list : []).filter((r) => r && r.id).map((r) => {
    const file = courseFile(files, n);
    const { rank } = placeOf(r, [...(isAssisted(r) ? [] : fileRuns(file, file && files[file])), ...ofMode(data.runs[n], r)], ofMode(data.removed[n], r));
    return { course: Number(n), courseName: names[n] || "", rank, ...r };
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // And the claims to legacy runs waiting for a check, oldest first (see "Claiming legacy runs")
  const claims = (Array.isArray(data.claims) ? data.claims : []).filter((x) => x && x.status === "pending");
  return answer(200, { runs, claims });
}
// Approve (onto the board) or turn down (into "declined") a run waiting for a check. It keeps its id, so its page
// still works, and says who checked it and when.
async function review(request, env, ctx) {
  if (request.method !== "POST") return answer(405, { error: "bad" });
  if (request.headers.get("Origin") !== new URL(request.url).origin) return answer(403, { error: "bad" });
  const user = await readSession(request, env);
  if (!(await isReviewer(env, user))) return answer(403, { error: "bad" });
  let body;
  try { body = JSON.parse(await request.text()); } catch (e) { body = null; }
  const n = Number(body && body.course), id = String((body && body.id) || ""), approve = !!(body && body.approve);
  if (!Number.isInteger(n) || !/^[\w-]{1,16}$/.test(id)) return answer(400, { error: "bad" });
  let run = null, before = null;
  const done = await editRuns(env, (data) => {
    const waiting = listIn(data.pending, n);
    const at = waiting.findIndex((r) => r && r.id === id);
    if (at < 0) return { error: "gone", status: 404 }; // someone else checked it already
    // Nobody checks their own run: another moderator has to
    if (waiting[at].discord === user.id) return { error: "own", status: 403 };
    before = structuredClone(data); // for what it does to the boards, in its post and the DM (afterCheck)
    run = { ...waiting.splice(at, 1)[0], checkedBy: user.id, checkedAt: stamp() };
    listIn(approve ? data.runs : data.declined, n).push(run);
    return { message: `chore(leaderboard): ${approve ? "add" : "turn down"} ${run.name}'s ${run.time} on course ${n}, checked by ${user.name}` };
  });
  if (done.error) return answer(done.status, { error: done.error });
  await showSaved(done.text, null).catch(() => {});
  if (approve && run.discord) ctx.waitUntil(profileAfterRun(env, ctx, run.discord));
  // Its post changes to say so, and its player gets a DM
  ctx.waitUntil(afterCheck(env, ctx, { run, n, approve, before, by: user.name, site: new URL(request.url).origin })
    .catch((e) => console.error(`run ${run.id}: couldn't change its post or tell its player: ${(e && e.message) || e}`)));
  return answer(200, { ok: true, run });
}

/* ---------- Claiming legacy runs ----------
   The legacy boards (history.json's "legacy", from before 2026-04-29) have runs under just an in-game name, with no
   Discord ID. Those runs aren't anyone's on the site: they're their own player, with no Discord name or picture, and
   they don't show in anyone's My profile. A signed-in player can say a legacy name is theirs (Is this you? in its panel
   on the site). The claim waits in runs.json's "claims" until a moderator checks that it's really them, under the form
   at ballkour.com/submit, and Ballkyrie posts it in the legacy claims channel (CLAIMS_CHANNEL in wrangler.toml) so
   moderators know. Ballkyrie needs to be able to see it, send messages and embed links there. Without it (or
   DISCORD_BOT_TOKEN), nothing is posted.
   Legacy runs have no videos, so moderators ask them for proof on Discord first, like an old screenshot or clip.
   Approving it (Link) adds their Discord ID to every legacy run under that name that has none yet, in history.json.
   Turning it down keeps it, so the same player can't ask for that name again (they open a ticket instead).
     POST /api/claim          { name } → { ok: true, claim } or { error }: login (not signed in), name (no legacy runs
                              under that name are left without a Discord ID), declined (a moderator turned their claim
                              to it down), rate (too many), off or bad
     POST /api/claim/review   { name, discord, approve } (reviewers only) → { ok: true, claim } or { error }: gone
                              (someone checked it already), taken (its runs are someone else's now), own (it's
                              theirs: another moderator has to check it), off or bad
   /api/pending lists the claims waiting too. Each claim is one line in "claims":
     { "name", "discord" (theirs), "sentAt", "status": "pending" | "approved" | "declined", "checkedBy", "checkedAt" } */
const upper = (s) => String(s).trim().toUpperCase();
// Every legacy run under a name, as { n (its course), i (where it is in that course's "legacy"), run }
function legacyRuns(history, name) {
  const out = [];
  for (const [n, e] of Object.entries(history && typeof history === "object" ? history : {})) {
    (e && Array.isArray(e.legacy) ? e.legacy : []).forEach((run, i) => {
      if (run && typeof run.name === "string" && upper(run.name) === upper(name)) out.push({ n, i, run });
    });
  }
  return out;
}
// The in-game names a Discord account has on the boards now (the course files and runs.json), for moderators
function namesNow(files, id) {
  const names = new Set();
  for (const [path, body] of Object.entries(files || {})) {
    if (/^leaderboards\/\d+-[^/]+\.(opy|json)$/.test(path)) fileRuns(path, body).forEach((r) => r.discord === id && names.add(r.name));
  }
  try {
    Object.values(JSON.parse(files[RUNS_FILE]).runs || {}).flat().forEach((r) => r && r.discord === id && typeof r.name === "string" && names.add(r.name));
  } catch (e) { /* just the course files' */ }
  return [...names];
}
// The claim's post in the legacy claims channel: who it's from, the legacy runs, and the names they go by now
async function postClaim(env, { claim, runs, files, names, flags, site }) {
  if (!env.CLAIMS_CHANNEL || !env.DISCORD_BOT_TOKEN) return;
  const lines = runs.map(({ n, run }) => `${n} · ${flags[n] ? `${flags[n]} ` : ""}${names[n] || `Course ${n}`}: ${String(run.time).replace(".--", "")}`);
  const now = namesNow(files, claim.discord);
  await postIn(env, env.CLAIMS_CHANNEL, {
    allowed_mentions: { parse: [] }, // shows who it's from without pinging them
    embeds: [{
      title: `Legacy runs to check: ${claim.name}`,
      url: `${site}/submit`,
      color: 0xffd54f,
      description: "Make sure these are really theirs before you link them. Legacy runs have no videos, so ask them for proof, like an old screenshot or clip.",
      fields: [
        { name: "Claimed by", value: `<@${claim.discord}>`, inline: true },
        ...(now.length ? [{ name: "On the boards now as", value: mdSafe(now.join(", ")).slice(0, 1024), inline: true }] : []),
        { name: "Legacy runs", value: lines.join("\n").slice(0, 1024) },
      ],
      timestamp: claim.sentAt,
    }],
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Verify", url: `${site}/submit` }] }],
  }, `claim to ${claim.name}`);
}
async function claim(request, env, ctx) {
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
    body = raw.length <= 1024 ? JSON.parse(raw) : null;
  } catch (e) { body = null; }
  const asked = body && typeof body.name === "string" ? body.name.trim() : "";
  if (!asked || asked.length > 64) return answer(400, { error: "name" });

  // Its legacy runs that aren't anyone's yet, from the cached game data
  const { files, names, flags } = await gameInfo(env, ctx);
  let history = null;
  try { history = loadHistory(files && files[HISTORY_FILE]); } catch (e) { return answer(503, { error: "off" }); }
  const open = legacyRuns(history, asked).filter(({ run }) => !run.discord);
  if (!open.length) return answer(400, { error: "name" });

  const name = open[0].run.name.trim();
  const fresh = { name, discord: user.id, sentAt: stamp(), status: "pending" };
  const saved = await editRuns(env, (data) => {
    const list = Array.isArray(data.claims) ? data.claims : (data.claims = []);
    const theirs = list.filter((x) => x && x.discord === user.id);
    // Asked already: still waiting, or turned down. (An approved one doesn't count: these runs came after it.)
    const same = theirs.filter((x) => upper(x.name) === upper(name) && x.status !== "approved").pop();
    if (same && same.status === "declined") return { error: "declined", status: 409 };
    if (same) return { skip: true, claim: same };
    if (theirs.filter((x) => x.status === "pending").length >= 5) return { error: "rate", status: 429 };
    list.push(fresh);
    return { message: `chore(leaderboard): ${user.name} says the legacy runs as ${name} are theirs, waiting for a check`, claim: fresh };
  });
  if (saved.error) return answer(saved.status, { error: saved.error });
  await showSaved(saved.text, user).catch((e) => console.error(`claim: couldn't update the cached copy: ${(e && e.message) || e}`));
  if (saved.text) ctx.waitUntil(postClaim(env, { claim: fresh, runs: open, files, names, flags, site: url.origin }));
  return answer(200, { ok: true, claim: saved.claim });
}
// Link (approve) or turn down a claim waiting for a check. Linking adds their Discord ID to the legacy runs first, so
// a claim never says it's approved while its runs aren't theirs; linking the same runs again changes nothing, so
// trying again after a hiccup is fine. The claim keeps who checked it and when.
async function reviewClaim(request, env, ctx) {
  if (request.method !== "POST") return answer(405, { error: "bad" });
  if (request.headers.get("Origin") !== new URL(request.url).origin) return answer(403, { error: "bad" });
  const user = await readSession(request, env);
  if (!(await isReviewer(env, user))) return answer(403, { error: "bad" });
  let body;
  try { body = JSON.parse(await request.text()); } catch (e) { body = null; }
  const name = String((body && body.name) || "").trim(), id = String((body && body.discord) || ""), approve = !!(body && body.approve);
  if (!name || name.length > 64 || !/^\d{17,20}$/.test(id)) return answer(400, { error: "bad" });
  // Nobody checks their own claim: another moderator has to
  if (id === user.id) return answer(403, { error: "own" });
  const isIt = (x) => x && x.status === "pending" && x.discord === id && upper(x.name) === upper(name);
  // Still waiting? (Asked again as it's saved, in case another moderator got there in between)
  try {
    const { data } = await readRuns(env, await runsApi(env));
    if (!(Array.isArray(data.claims) && data.claims.some(isIt))) return answer(404, { error: "gone" });
  } catch (e) { console.error(`claim to ${name}: ${e.message}`); return answer(502, { error: "off" }); }
  let linked = null;
  if (approve) {
    linked = await editData(env, HISTORY_FILE, loadHistory, dumpHistory, (history) => {
      const all = legacyRuns(history, name);
      const open = all.filter(({ run }) => !run.discord);
      if (!open.length) return all.some(({ run }) => run.discord === id) ? { skip: true } : { error: "taken", status: 409 };
      // Their ID goes right after the name, like on the runs that have one
      for (const { n, i, run } of open) {
        const { name: runName, discord: none, ...rest } = run;
        history[n].legacy[i] = { name: runName, discord: id, ...rest };
      }
      return { message: `chore(leaderboard): link the legacy runs as ${name} to Discord ${id}, checked by ${user.name}` };
    });
    if (linked.error) return answer(linked.status, { error: linked.error });
  }
  let checked = null;
  const done = await editRuns(env, (data) => {
    const list = Array.isArray(data.claims) ? data.claims : [];
    const at = list.findIndex(isIt);
    if (at < 0) return { error: "gone", status: 404 };
    checked = list[at] = { ...list[at], status: approve ? "approved" : "declined", checkedBy: user.id, checkedAt: stamp() };
    return { message: `chore(leaderboard): ${approve ? "approve" : "turn down"} the claim to the legacy runs as ${name}, checked by ${user.name}` };
  });
  await showSaved(done.text, null, linked && linked.text).catch((e) => console.error(`claim to ${name}: couldn't update the cached copy: ${(e && e.message) || e}`));
  if (done.error) return answer(done.status, { error: done.error });
  ctx.waitUntil(tellPlayer(env, id, checkedClaimMessage({ claim: checked, approve, site: new URL(request.url).origin }), `claim to ${name}`));
  return answer(200, { ok: true, claim: checked });
}

/* ---------- Players' own links ----------
   Every player's panel has a short link, ballkour.com/profile/<number> (and /profile/<number>/runs for their Runs), and
   each player can pick a name for theirs in their own panel, for ballkour.com/profile/<name>. Links from before
   November 2026 have /players/ in place of /profile/, and keep working. Numbers go from 1 in the
   order players first ran a course: runs with no date (the legacy ones, from before 2026-04-29) first, then by date, and
   players who started the same day by how old their Discord account is. New players get the next number. A number is
   never given to anyone else, even when a player's line is deleted by hand ("last" counts them, like runs.json's
   "lastId").
   They're kept in links.json on the game repo's leaderboard-data branch, one player per line. It's outside leaderboards/
   so that saving it doesn't start the leaderboard bot, whose workflow there runs on every change to leaderboards/**:
     { "last": 16, "players": { "<discord id>": { "n": 1, "link": "ball" }, … } }   (link only once they've picked one)
   Every half hour (at :15 and :45, the second cron in wrangler.toml), players who have runs but no number get one, and
   a player who picks a name gets one then too. Until then, their link is /players/<Discord ID>, which opens their panel
   as well. A name from the legacy boards with no Discord ID keeps /players/<in-game name>.
   A link name is up to 32 letters or numbers in any language, plus - and _, with at least one letter, so it's never
   taken for a number or a Discord ID. No two players can have the same one (capitals and wide letters don't make it
   different, see linkFold), and nobody can pick another player's in-game name or Discord name, or one of NOT_LINKS.
     POST /api/link   { link } → { ok: true, n, link } or { error }: login (not signed in), link (not a name like
                      that), taken (someone else's), rate (too many), off or bad. An empty link goes back to their number.
                      Moderators can send { discord, link: "" } to take the name off someone else's link.
   SUBMIT_LIMIT (wrangler.toml) allows 5 changes a minute from one Discord account. */
const LINK_OK = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]{0,31}$/u; // the same as the page's: keep the two in step
const linkOk = (s) => LINK_OK.test(s) && /\p{L}/u.test(s);
// What two names have to share to count as the same: ｗｉｄｅ letters are plain ones, and capitals don't matter
const linkFold = (s) => String(s).normalize("NFKC").toLowerCase();
// Names that would look like they're the site's own
const NOT_LINKS = new Set(["admin", "ballkour", "ballkyrie", "help", "me", "mod", "moderator", "mods", "official", "runs", "staff", "stats", "support"]);
// links.json's text → its data, with "players" and "last" always there
function loadLinks(raw) {
  let data;
  try { data = raw === null || raw === undefined ? {} : JSON.parse(raw); } catch (e) { throw new Error("it isn't valid JSON"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("it isn't a JSON object");
  if (!data.players || typeof data.players !== "object" || Array.isArray(data.players)) data.players = {};
  if (!Number.isInteger(data.last)) data.last = 0;
  // Never below a number that's out already, in case "last" was edited by hand
  for (const p of Object.values(data.players)) if (p && Number.isInteger(p.n)) data.last = Math.max(data.last, p.n);
  return data;
}
// One player per line, by number, so it stays easy to read and edit by hand
function dumpLinks(data) {
  const line = (p) => "{" + Object.entries(p).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}";
  const players = Object.entries(data.players).filter(([, p]) => p && typeof p === "object").sort(([, a], [, b]) => (a.n || 0) - (b.n || 0));
  return `{\n  "last": ${data.last},\n  "players": {` +
    (players.length ? "\n" + players.map(([id, p]) => `    ${JSON.stringify(id)}: ${line(p)}`).join(",\n") + "\n  " : "") + "}\n}\n";
}
// The cron that hands out the numbers (wrangler.toml): keep the two the same
const NUMBERS_CRON = "15,45 * * * *";
/* The leaderboard bot's daily run (leaderboard-daily.yml on the game repo's main branch), started at 00:00 UTC by the
   third cron in wrangler.toml. GitHub's own schedule for it started hours late (06:17 ran at 14:30 to 16:30), as GitHub
   only runs schedules when it has room, and Cloudflare's crons run on time. It needs the GitHub App (see appOn) with
   Actions: Read and write. */
const BOT_CRON = "0 0 * * *";
const DAILY_BOT = "leaderboard-daily.yml";
async function startDailyBot(env) {
  if (!appOn(env)) throw new Error("no GitHub App set up (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)");
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${DAILY_BOT}/dispatches`, {
    method: "POST",
    headers: { "User-Agent": "ballkour.com", Accept: "application/vnd.github+json", Authorization: `Bearer ${await appToken(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
    signal: AbortSignal.timeout(10000),
  });
  // 403: the app doesn't have Actions: Read and write. 422: the workflow can't be started from outside (no workflow_dispatch)
  if (r.status !== 204) throw new Error(`GitHub said ${r.status} ${(await r.text()).slice(0, 200)}`);
  console.log(`daily bot: started ${DAILY_BOT}`);
}
const editLinks = (env, edit) => editData(env, LINKS_FILE, loadLinks, dumpLinks, edit);
// The players in links.json, from the game data (none when it can't be read)
function linksIn(files) {
  try { return loadLinks(files && files[LINKS_FILE]).players; } catch (e) { return {}; }
}
// The player a /players/<…> link is for: a number, a picked name, a Discord ID, or else an in-game name ("n:<NAME>").
// null for a number nobody has. The same as the page's keyOfLink(): keep the two in step.
function keyOfLink(seg, links) {
  if (/^\d{1,9}$/.test(seg)) {
    const id = Object.keys(links).find((k) => links[k] && links[k].n === Number(seg));
    return id ? "d:" + id : null;
  }
  if (/^\d{17,20}$/.test(seg)) return "d:" + seg;
  const folded = linkFold(seg);
  const id = Object.keys(links).find((k) => links[k] && typeof links[k].link === "string" && linkFold(links[k].link) === folded);
  return id ? "d:" + id : "n:" + seg.toUpperCase();
}
// Every run on the site, on today's boards or before, waiting or turned down, as the files have them
function everyRun(files) {
  const out = [];
  for (const [path, body] of Object.entries(files || {})) {
    if (/^leaderboards\/\d+-[^/]+\.(opy|json)$/.test(path)) out.push(...fileRuns(path, body));
  }
  try {
    const data = loadRuns(files[RUNS_FILE] ?? null);
    for (const k of RUN_GROUPS) for (const list of Object.values(data[k])) if (Array.isArray(list)) out.push(...list);
  } catch (e) { /* the rest still count */ }
  try {
    for (const e of Object.values(loadHistory(files[HISTORY_FILE]))) {
      if (e && Array.isArray(e.boards)) out.push(...e.boards.flat());
      if (e && Array.isArray(e.legacy)) out.push(...e.legacy);
    }
  } catch (e) { /* the rest still count */ }
  return out.filter((r) => r && typeof r.name === "string");
}
// The day a run was set, or "" when it has none (like the legacy runs), which counts as before every other
const runDay = (r) => (typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date
  : typeof r.sentAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.sentAt) ? r.sentAt.slice(0, 10) : "");
// Older Discord accounts have smaller IDs
const byAge = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
// Every half hour: a number for each player who has runs but none yet, in the order they first ran a course
async function numberPlayers(env, ctx) {
  if (!appOn(env) && !env.GITHUB_TOKEN) return;
  const { files } = JSON.parse(await game(env, ctx));
  const first = new Map(); // Discord ID → the day of their first run
  for (const r of everyRun(files)) {
    if (typeof r.discord !== "string" || !/^\d{17,20}$/.test(r.discord)) continue;
    const day = runDay(r);
    if (!first.has(r.discord) || day < first.get(r.discord)) first.set(r.discord, day);
  }
  const had = linksIn(files);
  const ids = [...first.keys()].filter((id) => !had[id]).sort((a, b) => first.get(a).localeCompare(first.get(b)) || byAge(a, b));
  if (!ids.length) return;
  // links.json as it is on GitHub decides: the cached copy can be a minute behind
  const saved = await editLinks(env, (data) => {
    const fresh = ids.filter((id) => !data.players[id]);
    if (!fresh.length) return { skip: true };
    for (const id of fresh) data.players[id] = { n: ++data.last };
    return { message: `chore(links): number ${fresh.length === 1 ? "a new player" : `${fresh.length} new players`}` };
  });
  if (saved.error) throw new Error("couldn't save links.json");
  if (saved.text) await showFile(LINKS_FILE, saved.text);
}
// The site shows a saved file straight away, like a run (see showSaved)
async function showFile(path, body) {
  const copy = await stored("game");
  if (!copy) return;
  const d = JSON.parse(copy);
  d.files[path] = body;
  await putCached("game", 60, JSON.stringify(d));
}
async function setLink(request, env, ctx) {
  if (request.method !== "POST") return answer(405, { error: "bad" });
  if (request.headers.get("Origin") !== new URL(request.url).origin) return answer(403, { error: "bad" });
  if (!loginOn(env)) return answer(503, { error: "off" });
  const user = await readSession(request, env);
  if (!user) return answer(401, { error: "login" });
  if (env.SUBMIT_LIMIT && !(await env.SUBMIT_LIMIT.limit({ key: `link:${user.id}` })).success) return answer(429, { error: "rate" });
  let body;
  try {
    const raw = await request.text();
    body = raw.length <= 1024 ? JSON.parse(raw) : null;
  } catch (e) { body = null; }
  if (!body || typeof body.link !== "string") return answer(400, { error: "bad" });
  // A moderator taking the name off someone else's link (Discord is asked right then, like before a run is checked)
  const other = body.discord !== undefined && String(body.discord) !== user.id;
  if (other && (body.link !== "" || !/^\d{17,20}$/.test(String(body.discord)) || !(await isReviewer(env, user)))) return answer(403, { error: "bad" });
  const id = other ? String(body.discord) : user.id;
  const link = body.link.trim().normalize("NFC");
  if (link) {
    if (!linkOk(link)) return answer(400, { error: "link" });
    if (NOT_LINKS.has(linkFold(link))) return answer(409, { error: "taken" });
    // Another player's in-game name (on any run, legacy ones too) or Discord name
    const { files } = await gameInfo(env, ctx);
    const players = JSON.parse((await stored("players").catch(() => null)) || "{}");
    const folded = linkFold(link);
    const theirs = everyRun(files).some((r) => r.discord !== id && linkFold(r.name) === folded) ||
      Object.entries(players).some(([k, p]) => k !== id && p && typeof p.name === "string" && linkFold(p.name) === folded);
    if (theirs) return answer(409, { error: "taken" });
  }
  const saved = await editLinks(env, (data) => {
    const had = data.players[id];
    if (!link && !(had && had.link)) return { skip: true, entry: had || null };
    const folded = linkFold(link);
    if (link && Object.entries(data.players).some(([k, p]) => k !== id && p && typeof p.link === "string" && linkFold(p.link) === folded)) {
      return { error: "taken", status: 409 };
    }
    const entry = { ...had, n: had && Number.isInteger(had.n) ? had.n : ++data.last };
    if (link) entry.link = link;
    else delete entry.link;
    if (had && had.n === entry.n && had.link === entry.link) return { skip: true, entry };
    data.players[id] = entry;
    return {
      entry,
      message: other ? `chore(links): take the name ${had.link} off player ${entry.n}'s link, by ${user.name}`
        : link ? `chore(links): player ${entry.n} (${user.name}) picks the name ${link}`
        : `chore(links): player ${entry.n} (${user.name}) goes back to their number`,
    };
  });
  if (saved.error) return answer(saved.status, { error: saved.error });
  if (saved.text) await showFile(LINKS_FILE, saved.text).catch((e) => console.error(`link: couldn't update the cached copy: ${(e && e.message) || e}`));
  const entry = saved.entry || {};
  return answer(200, { ok: true, n: Number.isInteger(entry.n) ? entry.n : null, link: entry.link || "" });
}

/* ---------- Stats on Discord profiles ----------
   Players can put their stats on their Discord profile, under Apps, like a linked game account. It's Discord's
   "role connection", which shows as:
     ballkour.com · Top 0.1%      their Top % (Rated for the bottom 10%, Unrated before they have a rating)
     DUCKLING · #3                their in-game name and place in the Global rating
     812 ⭐ Rating  4 ⚡ Top 10s  2 🏆 Podiums  1 👑 Records  12 🗺️ Courses run
   Their rating, place and Top % are the Global rating's (the unassisted and assisted ratings added up, see combine() in
   ratings.js), the one the Global roles on our server go by.
   PROFILE_FIELDS are the numbers on the last line. Discord allows at most 5 per app, whole numbers only (so Top %,
   with its 0.1, goes in the text above), and shows each as "<number> <name>", so each name's emoji comes right
   after its number. Changing a name only needs a deploy: Discord gets the new names, and everyone's profile shows
   them straight away. Server owners can also use them for
   linked roles (Server Settings → Linked Roles), like "Top 10s: at least 1". The numbers are the same as the site's
   and the leaderboard bot's: Top 10s, Podiums and Records count every course's board, broken ones too, and Courses
   run counts the courses in the ratings they've run, unassisted or assisted.
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
   whoever's changed is sent; anyone left over goes next time (see PROFILE_CALLS). A player's own stats are also sent
   as soon as their run goes on a board. Someone who took the app off in Discord is dropped the next time there's
   something to send them. The fields' names are sent to Discord by the Worker too (with Ballkyrie's bot token), the
   first time and again whenever PROFILE_FIELDS changes. Needs everything for signing in, DISCORD_BOT_TOKEN, and
   PROFILES.

   Renewing a player's tokens is the one step that can't be redone: Discord takes each refresh token only once, so the
   new ones have to be saved, or the next update finds dead tokens and drops the player. So a send only starts with
   enough calls left to finish (SEND_CALLS), the new tokens are saved straight away (twice if need be), and a player
   whose tokens look dead is only dropped if PROFILES still has the ones that failed, not ones another request (a run
   they sent during the update) renewed in the meantime. */
const PROFILE_SCOPE = "role_connections.write";
// How many calls an update of everyone's profiles can make. Cloudflare's free plan lets a run make 50, and calls to
// PROFILES count as well as ones to Discord, so this leaves room to spare. It's GAME_CALLS fewer when the game data had
// to be fetched from GitHub first (this data center had no copy of it).
const PROFILE_CALLS = 40;
const GAME_CALLS = 25;
// The most one send can take: reading their tokens, renewing them and saving them (twice, if the first save doesn't go
// through), sending, and saving what was sent
const SEND_CALLS = 7;
// type 2: a whole number, which linked roles check with "at least". Keys can't change without everyone's profile
// losing that number until they're sent again.
const PROFILE_FIELDS = [
  { key: "rating", name: "⭐ Rating", description: "Their Global rating, unassisted plus assisted, out of 2,000" },
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
// Whether a member (from memberOf) has it. Not on the server, or Discord not answering, counts as no: their panel then
// shows how to get it.
async function hasProfileRoleIn(env, ctx, member) {
  if (!member) return false;
  try {
    return member.roles.includes(await profileRoleId(env, ctx));
  } catch (e) {
    console.error(`profile: couldn't look up the ${PROFILE_ROLE} role: ${(e && e.message) || e}`);
    return false;
  }
}
const profileKey = (id) => `profile:${id}`;
const tokensFrom = (t) => ({ access: t.access_token, refresh: t.refresh_token, expires: Date.now() + (Number(t.expires_in) || 0) * 1000 });

// Tells Discord the fields' names, unless it has these already (what was sent is kept in PROFILES as "fields").
// calls: { left }, the calls the caller can still make (see PROFILE_CALLS), which this takes 1 to 3 of.
async function registerFields(env, calls) {
  const want = JSON.stringify(PROFILE_FIELDS);
  calls.left--;
  if ((await env.PROFILES.get("fields")) === want) return;
  calls.left -= 2;
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
  // The Global rating: the unassisted and assisted ratings added up
  const rated = new Map(combine([rate(courses), rate(loadCourses(data.files, data.courses, { assisted: true }))]).players.map((p) => [p.key, p]));
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
// they have less than a day left, and keeps both. Every call comes out of calls.left (SEND_CALLS - 1 at most, after
// whoever called it read their tokens). → "sent", or "gone" when their tokens are dead (they're dropped)
async function sendProfile(env, id, tokens, body, calls) {
  const key = profileKey(id);
  const keep = (t, sent) => { calls.left--; return env.PROFILES.put(key, JSON.stringify(t), { metadata: { sent } }); };
  let renewed = false;
  const renew = async () => {
    const used = tokens.refresh;
    calls.left--;
    tokens = await refreshTokens(env, tokens);
    renewed = true;
    if (!tokens) {
      // Dead: they took the app off in Discord, unless another request renewed them in the meantime (Discord takes
      // each refresh token only once), and then PROFILES has the new ones
      calls.left--;
      const now = await env.PROFILES.get(key, "json");
      if (now && now.refresh && now.refresh !== used) { tokens = now; return true; }
      calls.left--;
      await env.PROFILES.delete(key);
      return false;
    }
    // Straight away, since the old refresh token doesn't work any more. If that doesn't go through, once more now,
    // and they're saved again with what's sent below.
    await keep(tokens, "").catch(() => keep(tokens, "")).catch((e) => console.error(`profile of ${id}: couldn't save their renewed tokens yet: ${(e && e.message) || e}`));
    return true;
  };
  if (tokens.expires - Date.now() < 864e5 && !(await renew())) return "gone";
  for (;;) {
    calls.left--;
    const r = await fetch(`${DISCORD_API}/users/@me/applications/${env.DISCORD_CLIENT_ID}/role-connection`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tokens.access}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      await keep(tokens, body).catch((e) => {
        if (renewed) console.error(`profile of ${id}: couldn't save their renewed tokens, so they'll need to turn it on again: ${(e && e.message) || e}`);
        throw e;
      });
      return "sent";
    }
    if (r.status === 401 && !renewed) { if (!(await renew())) return "gone"; continue; }
    if (r.status === 401) { calls.left--; await env.PROFILES.delete(key); return "gone"; }
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
  const calls = { left: 12 };
  await registerFields(env, calls);
  await sendProfile(env, id, tokens, profilesFrom(await gameData(env, ctx))(id), calls);
}
// Sends whoever's stats have changed since they were last sent: everyone with their stats on, or only these IDs
async function updateProfiles(env, ctx, only = null) {
  if (!profileOn(env)) return;
  // The game data as it's cached here, or else from GitHub, which takes about GAME_CALLS of the run's calls first
  const copy = await stored("game").catch(() => null);
  const profileOf = profilesFrom(copy ? JSON.parse(copy) : await gameData(env, ctx));
  // A run that just went on a board catches its player up in the request that saved it, which made calls of its own
  const calls = { left: only ? 15 : copy ? PROFILE_CALLS : PROFILE_CALLS - GAME_CALLS };
  await registerFields(env, calls);
  const due = []; // { id, tokens }: tokens are read when it's their turn, unless they're read already
  if (only) {
    for (const id of only) {
      calls.left--;
      const { value, metadata } = await env.PROFILES.getWithMetadata(profileKey(id), "json");
      if (value && !(metadata && metadata.sent === profileOf(id))) due.push({ id, tokens: value });
    }
  } else {
    let cursor;
    do {
      calls.left--;
      const page = await env.PROFILES.list({ prefix: "profile:", cursor });
      for (const k of page.keys) {
        const id = k.name.slice("profile:".length);
        if (!(k.metadata && k.metadata.sent === profileOf(id))) due.push({ id, tokens: null });
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor && calls.left >= SEND_CALLS);
  }
  let sent = 0, gone = 0, failed = 0, left = 0;
  for (const x of due) {
    // Only with enough calls left to finish, so renewed tokens always get saved (see sendProfile)
    if (calls.left < SEND_CALLS - (x.tokens ? 1 : 0)) { left++; continue; }
    try {
      if (!x.tokens) { calls.left--; x.tokens = await env.PROFILES.get(profileKey(x.id), "json"); }
      if (!x.tokens) continue; // they took them off in the meantime
      if ((await sendProfile(env, x.id, x.tokens, profileOf(x.id), calls)) === "sent") sent++; else gone++;
    } catch (e) {
      failed++;
      console.error(`profile of ${x.id}: ${(e && e.message) || e}`);
    }
  }
  if (due.length) console.log(`profiles: ${sent} sent, ${gone} dropped, ${failed} failed, ${left} left for next time`);
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

/* ---------- Page views ----------
   How many times the site was opened in a browser, and by how many people, for Page views in Stats at the bottom of
   the page. The page asks /api/me once each time someone opens it, so each of those is a page view. It's the site's
   own request, which ad blockers don't stop, and bots that only fetch the page never make it. Views are kept by
   section (the page's address up to its first /: /leaderboards, /runs, …), never by player or run. People are only
   counted for the whole site, not each section.
   People: each visitor is a code made from their IP address, their browser, and a random key that's made new each day
   and deleted at the end of it, so a code only says "the same visitor as earlier today", never who. Only today's
   codes are kept, and past days keep just their counts (for a little over a year).
   They're kept in a Durable Object: PageViews below, a small SQLite database the Worker owns (PAGE_VIEWS in
   wrangler.toml), which a deploy sets up on its own. Without it, nothing is counted.
     GET /api/visits   → { since, days: [{ day, views, people, sections: { home: views, … } }, …] }: since is the
                       first day shown (see FIRST_VIEW_DAY), and days every day kept and at least the last 30, oldest
                       first (0 and no sections for a day nobody came, or from before since). The copy served is at
                       most a minute old. */
// The first day shown. Views were first counted on 2026-11-09, and each section's people (counted until November
// 2026) only from partway through it, so that day was hidden. It's still kept (until it's over a year old, like the
// rest), just never shown.
const FIRST_VIEW_DAY = "2026-11-10";
const VIEW_SECTIONS = ["courses", "leaderboards", "submit", "runs", "players", "stats", "my-stats", "features", "faq", "source-code", "translations"];
const today = () => new Date().toISOString().slice(0, 10);
export class PageViews extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, views INTEGER NOT NULL, people INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS sections (day TEXT NOT NULL, section TEXT NOT NULL, views INTEGER NOT NULL, PRIMARY KEY (day, section))");
    // Each section's people were counted for a while in November 2026, with the sections each of today's codes had
    // been in: both go from a database from then
    let hadPeople = true;
    try { sql.exec("SELECT people FROM sections LIMIT 0"); } catch (e) { hadPeople = false; }
    if (hadPeople) sql.exec("ALTER TABLE sections DROP COLUMN people");
    sql.exec("DROP TABLE IF EXISTS seen_in");
    sql.exec("CREATE TABLE IF NOT EXISTS seen (who TEXT PRIMARY KEY)"); // today's visitors' codes
    sql.exec("CREATE TABLE IF NOT EXISTS daykey (day TEXT PRIMARY KEY, key TEXT NOT NULL)"); // today's key
  }
  // A page view in a section, by a visitor (their IP address and browser, which aren't kept)
  async add(section, visitor) {
    const sql = this.ctx.storage.sql;
    const day = today();
    let key = (sql.exec("SELECT key FROM daykey WHERE day = ?", day).toArray()[0] || {}).key;
    if (!key) {
      // A new day: yesterday's key and codes go, so nobody can be matched across days, and so do counts over a year old
      key = crypto.randomUUID();
      sql.exec("DELETE FROM daykey");
      sql.exec("DELETE FROM seen");
      sql.exec("INSERT INTO daykey (day, key) VALUES (?, ?)", day, key);
      const old = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
      sql.exec("DELETE FROM days WHERE day < ?", old);
      sql.exec("DELETE FROM sections WHERE day < ?", old);
    }
    const who = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(`${key}|${visitor}`))));
    const fresh = sql.exec("INSERT OR IGNORE INTO seen (who) VALUES (?)", who).rowsWritten > 0 ? 1 : 0;
    sql.exec("INSERT INTO days (day, views, people) VALUES (?, 1, ?) ON CONFLICT (day) DO UPDATE SET views = views + 1, people = people + ?", day, fresh, fresh);
    sql.exec("INSERT INTO sections (day, section, views) VALUES (?, ?, 1) ON CONFLICT (day, section) DO UPDATE SET views = views + 1", day, section);
  }
  // Every day kept, and at least the last 30, oldest first (a day nobody came is 0), each with its sections' views (see
  // /api/visits)
  history() {
    const sql = this.ctx.storage.sql;
    const last = today();
    const month = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const oldest = (sql.exec("SELECT MIN(day) AS day FROM days WHERE day >= ?", FIRST_VIEW_DAY).toArray()[0] || {}).day;
    const from = oldest && oldest < month ? oldest : month;
    const shown = from > FIRST_VIEW_DAY ? from : FIRST_VIEW_DAY;
    const got = new Map(sql.exec("SELECT day, views, people FROM days WHERE day >= ?", shown).toArray().map((r) => [r.day, r]));
    const sections = new Map();
    sql.exec("SELECT day, section, views FROM sections WHERE day >= ?", shown).toArray().forEach((r) => {
      if (!sections.has(r.day)) sections.set(r.day, {});
      sections.get(r.day)[r.section] = r.views;
    });
    const days = [];
    for (let at = Date.parse(`${from}T00:00:00Z`); ; at += 864e5) {
      const day = new Date(at).toISOString().slice(0, 10);
      if (day > last) break;
      const d = got.get(day) || {};
      days.push({ day, views: d.views || 0, people: d.people || 0, sections: sections.get(day) || {} });
    }
    return { since: oldest || last, days };
  }
}
const pageViewsDb = (env) => env.PAGE_VIEWS.get(env.PAGE_VIEWS.idFromName("ballkour.com"));
// The section a page view is in, from the page's own address (the Referer of its /api/me)
function viewSection(request) {
  try {
    const page = new URL(request.headers.get("Referer") || "");
    if (page.host !== new URL(request.url).host) return "other";
    const seg = page.pathname.split("/")[1].toLowerCase();
    // A player's panel and My profile are one section, profile, at their links from before November 2026 too
    // (/players/<…> and /my-stats)
    const first = seg === "players" || seg === "my-stats" ? "profile" : seg;
    return !first ? "home" : first === "profile" || VIEW_SECTIONS.includes(first) ? first : "other";
  } catch (e) { return "other"; }
}
async function countView(request, env) {
  await pageViewsDb(env).add(viewSection(request), `${request.headers.get("CF-Connecting-IP") || ""}|${request.headers.get("User-Agent") || ""}`);
}
// Each data center keeps one copy for a minute, so the database isn't asked every time someone opens the site
async function pageViews(env, ctx) {
  if (!env.PAGE_VIEWS) return answer(404, { error: "off" });
  const key = cacheKey("visits");
  const hit = await caches.default.match(key).catch(() => null);
  if (hit) return answer(200, await hit.json());
  const body = await pageViewsDb(env).history();
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(body), { headers: { "Cache-Control": "public, max-age=60" } })).catch(() => {}));
  return answer(200, body);
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
// The security headers Caddy used to add, on every response (the ones in /_headers too: keep them in step)
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
/* The Content-Security-Policy. A page only runs the scripts that carry its nonce, a new one for every response (see
   withNonce), plus the site's own files and Cloudflare's Web Analytics. So even if a player's name or anything else
   ever got onto the page as HTML, a script in it wouldn't run. Cloudflare's own bot check, which it adds to pages,
   copies the nonce from this header. Browsers that know nonces ignore 'unsafe-inline' when there's one: it's only for
   browsers too old for them. frame-src is for the video players on a run's page and in the window a run's time opens
   on the boards, which only load once someone presses Play or clicks the time (embedOf() in index.html). If you add
   an outside service to the page, add its address here. */
const csp = (nonce) => [
  "default-src 'self'",
  `script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""} 'unsafe-inline' https://static.cloudflareinsights.com`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: https://cdn.discordapp.com",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-src https://www.youtube-nocookie.com https://clips.twitch.tv https://player.twitch.tv https://streamable.com https://medal.tv",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
// A page with its own inline scripts stamped with a new nonce, which the CSP then lets run. JSON blocks (the baked-in
// data) don't run, so they go without. → { res, nonce } (nonce null for anything that isn't a page)
function withNonce(res) {
  if (!(res.headers.get("Content-Type") || "").includes("text/html")) return { res, nonce: null };
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const out = new HTMLRewriter().on("script", { element(el) {
    if (!el.hasAttribute("src") && !/json/i.test(el.getAttribute("type") || "")) el.setAttribute("nonce", nonce);
  } }).transform(new Response(res.body, res));
  return { res: out, nonce };
}
function secure(page) {
  const { res, nonce } = withNonce(page);
  const out = new Response(res.body, res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  out.headers.set("Content-Security-Policy", csp(nonce));
  return out;
}
// One of the site's files, with the page and the rest checked for a newer copy on every visit. The files in assets/ and
// locales/ don't come through here: Cloudflare serves them straight away, with the headers in /_headers (see
// run_worker_first in wrangler.toml). If they ever did, assets/ would get a week, the same as there.
async function file(request, env) {
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  const path = new URL(request.url).pathname;
  out.headers.set("Cache-Control", res.ok && path.startsWith("/assets/") ? "public, max-age=604800" : "no-cache");
  return out;
}

/* ---------- The visitor's language ----------
   Every page gets the visitor's translation baked in too (<script type="application/json" id="i18n-lang">), so it draws
   in their language from the start instead of in English first: the one ?lang= asks for, or else the one they picked
   last on the site (the bk_lang cookie, which the page sets), or else the first of their browser's languages the site
   has. It's the same choice the page makes (detectLang() in index.html: keep the two in step), so the page uses what's
   baked in, and only fetches a translation itself when they differ. */
const LANG_CODES = ["en", "de", "es", "fr", "it", "pl", "pt", "tr", "ru", "th", "ja", "ko", "zh_cn", "zh_tw"];
// ?lang=: a code (ja, zh_cn or zh-cn) or a language tag (pt-BR, zh-Hans, zh-Hant), like the page's langParam()
function langAsked(v) {
  const q = String(v || "").trim().toLowerCase().replace(/_/g, "-");
  if (!q) return null;
  if (q === "zh-hans") return "zh_cn";
  if (q === "zh-hant" || q === "zh-hk" || q === "zh-mo") return "zh_tw";
  return LANG_CODES.find((c) => c.replace("_", "-") === q) || LANG_CODES.find((c) => c === q.split("-")[0]) || null;
}
// A browser's language (Accept-Language), like the page's detectLang(): Chinese by script or region, the rest by language
function langOfBrowser(tag) {
  const l = String(tag || "").trim().toLowerCase();
  if (l.startsWith("zh")) return /(tw|hk|mo|hant)/.test(l) ? "zh_tw" : "zh_cn";
  return LANG_CODES.find((c) => c === l.split("-")[0]) || null;
}
function langOf(request, url) {
  const asked = langAsked(url.searchParams.get("lang"));
  if (asked) return asked;
  const picked = /(?:^|;\s*)bk_lang=([\w-]+)/.exec(request.headers.get("Cookie") || "");
  if (picked && LANG_CODES.includes(picked[1])) return picked[1];
  for (const part of (request.headers.get("Accept-Language") || "").split(",")) {
    const l = langOfBrowser(part.split(";")[0]);
    if (l) return l;
  }
  return "en";
}
// The translation, as a block for the page's <head> (none in English, or when it can't be read)
async function langBlock(env, url, lang) {
  if (lang === "en") return "";
  const r = await env.ASSETS.fetch(new Request(new URL(`/locales/${lang}.json`, url))).catch(() => null);
  const text = r && r.ok ? await r.text() : "";
  return text ? `<script type="application/json" id="i18n-lang" data-lang="${lang}">${text.replace(/</g, "\\u003c")}</script>` : "";
}
// The page that isn't there (404.html, which picks the language the same way) gets just the translation (block)
function notFound(res, block) {
  if (!block) return res;
  return new HTMLRewriter().on("head", { element(el) { el.append(block, { html: true }); } }).transform(new Response(res.body, res));
}

/* ---------- YouTube comments ----------
   The window a run's time opens on the page (see "Watching a run's video" in index.html) lists the comments on a
   YouTube video under it:
     GET /api/comments?v=<video id>   { comments: [{ name, channel, text, likes, replies, date }], count, off }
   The first 20, the ones YouTube shows first. count is how many the video has on YouTube (replies too), and off is
   true when its comments are turned off. They come from YouTube's Data API through here, so a visitor's browser never
   talks to YouTube for them (only to play the video, once its time is clicked). Each video's are kept for
   COMMENTS_TTL, and the last good copy is served while YouTube can't be reached. Only the videos of runs the site has
   (on a course's board, in runs.json, or on an old board) get theirs, so nobody can spend the API's daily allowance
   on other videos: it's 10,000 units, and each video takes 2.
   Secret: YOUTUBE_KEY, an API key from Google Cloud with the YouTube Data API v3 turned on (see the README). Without
   it, the window has no comments. */
const COMMENTS_TTL = 6 * 60 * 60;
// A YouTube video's id from its link, or "": the same links as embedOf() in index.html (keep the two in step)
function youtubeId(link) {
  let u;
  try { u = new URL(link); } catch (e) { return ""; }
  const host = u.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
  const path = (re) => (re.exec(u.pathname) || [])[1] || "";
  const id = host === "youtu.be" ? path(/^\/([\w-]{11})\/?$/)
    : host === "youtube.com" || host === "music.youtube.com" ? (u.pathname === "/watch" ? u.searchParams.get("v") || "" : path(/^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/))
    : "";
  return /^[\w-]{11}$/.test(id) ? id : "";
}
// Every YouTube video of a run the site has, from the game data
function runVideos(data) {
  const ids = new Set();
  const add = (r) => {
    const id = r && typeof r.video === "string" ? youtubeId(r.video) : "";
    if (id) ids.add(id);
  };
  const files = (data && data.files) || {};
  ((data && data.courses) || []).forEach((c) => {
    fileRuns(c.file, files[c.file]).forEach(add);
    historyRuns(files, c.n).forEach(add);
  });
  try {
    const sent = JSON.parse(files[RUNS_FILE]) || {};
    RUN_GROUPS.forEach((g) => Object.values(sent[g] && typeof sent[g] === "object" ? sent[g] : {}).forEach((list) => {
      if (Array.isArray(list)) list.forEach(add);
    }));
  } catch (e) { /* none from there */ }
  return ids;
}
// A video's comments from YouTube, as /api/comments answers with them
async function youtubeComments(env, id) {
  const api = (what, params) => fetch(`https://www.googleapis.com/youtube/v3/${what}?${new URLSearchParams({ ...params, key: env.YOUTUBE_KEY })}`);
  const [threads, video] = await Promise.all([
    api("commentThreads", { part: "snippet", videoId: id, maxResults: "20", order: "relevance", textFormat: "plainText" }),
    api("videos", { part: "statistics", id }),
  ]);
  if (!threads.ok) {
    const err = await threads.json().catch(() => null);
    const why = (err && err.error && Array.isArray(err.error.errors) && err.error.errors[0] && err.error.errors[0].reason) || "";
    // Turned off on the video, or the video's gone (made private or deleted)
    if (why === "commentsDisabled") return JSON.stringify({ comments: [], count: 0, off: true });
    if (threads.status === 404) return JSON.stringify({ comments: [], count: 0, off: false });
    throw new Error(`YouTube said ${threads.status}${why ? ` (${why})` : ""}`);
  }
  const items = ((await threads.json()) || {}).items;
  const comments = (Array.isArray(items) ? items : []).map((x) => {
    const top = (x && x.snippet) || {};
    const s = (top.topLevelComment && top.topLevelComment.snippet) || {};
    // Their channel, as an https:// link on youtube.com (YouTube sometimes hands out http://)
    const channel = String(s.authorChannelUrl || "").replace(/^http:/, "https:");
    return {
      name: String(s.authorDisplayName || "").slice(0, 100),
      channel: /^https:\/\/www\.youtube\.com\/[\w@%./-]+$/.test(channel) ? channel : "",
      text: String(s.textOriginal || s.textDisplay || "").slice(0, 2000),
      likes: Number(s.likeCount) || 0,
      replies: Number(top.totalReplyCount) || 0,
      date: /^\d{4}-\d{2}-\d{2}/.test(s.publishedAt || "") ? s.publishedAt.slice(0, 10) : "",
    };
  }).filter((c) => c.text.trim());
  const stats = video.ok ? await video.json().catch(() => null) : null;
  const count = Number(stats && Array.isArray(stats.items) && stats.items[0] && stats.items[0].statistics && stats.items[0].statistics.commentCount);
  return JSON.stringify({ comments, count: Number.isFinite(count) ? count : comments.length, off: false });
}
async function comments(request, env, ctx) {
  const id = new URL(request.url).searchParams.get("v") || "";
  if (!/^[\w-]{11}$/.test(id)) return answer(400, { error: "bad" });
  if (!env.YOUTUBE_KEY) return answer(503, { error: "off" });
  const name = `comments/${id}`;
  // A video with comments kept here is a run's: any other is looked for in the game data first
  if (!(await caches.default.match(cacheKey(name, true))) && !runVideos(await gameData(env, ctx)).has(id)) return answer(404, { error: "bad" });
  return json(await cached(name, COMMENTS_TTL, ctx, () => youtubeComments(env, id)), 600);
}

/* ---------- Link previews ----------
   A link to a run, a board, or a player, pasted on Discord (or anywhere else that reads a page's og: tags), shows its
   own title and a line about it instead of the site's: "COLDSKIN · 4:05.81 on Watchpoint: Gibraltar" and "#2 of 12 on
   the board · 2 mistakes · 2026-08-26". They're worked out from the game data as the page is served, in English like
   Ballkyrie's posts, and the page itself is the same as ever. */
// A run from before the website's form has an id made from its course and video (or its player, time, and mistakes,
// when it has none), the same as pastId() in index.html: keep the two in step
function pastId(n, key) {
  let h = 0x811c9dc5; // FNV-1a
  for (const ch of key) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return `${n}-${h.toString(36)}`;
}
const mistakesText = (n) => `${n} mistake${n === 1 ? "" : "s"}`;
const ratingText = (r) => `⭐ ${Math.round(r)}`; // no separator: a rating only reaches 1000 (see points() in index.html)
// The addresses that have a preview of their own
const PREVIEWED = /^\/(?:runs|leaderboards|players|profile)\/./i;
// My profile and a player's panel at their links since November 2026: /profile, and /profile/<number or name> (with
// /runs for their Runs). DEEP_LINK (below) has the older /my-stats and /players/<…>, which keep working.
const PROFILE_LINK = /^\/profile(?:\/[^/]{1,300}(?:\/runs)?)?\/?$/i;
// /leaderboards/<n>/assisted for a course without Assist Mode (gameText: the game data, as JSON): only the remakes have
// it, and the page has no Assisted tab for the others (see hasAssistMode in index.html)
function noAssistedBoard(path, gameText) {
  const m = /^\/leaderboards\/(\d+)(?:-[\w-]*)?\/assisted\/?$/i.exec(path);
  if (!m) return false;
  try {
    const c = (JSON.parse(gameText).courses || []).find((x) => x.n === Number(m[1]));
    return !!c && !c.remake;
  } catch (e) { return false; }
}
const isPage = (path) => DEEP_LINK.test(path) || PROFILE_LINK.test(path);
function previewOf(pathname, data, players) {
  if (!PREVIEWED.test(pathname) || !data || !data.files || !Array.isArray(data.courses)) return null;
  const loaded = {};
  // The regular boards, or with assisted, the assisted ones (see ofMode)
  const courses = (assisted = false) => loaded[assisted] || (loaded[assisted] = loadCourses(data.files, data.courses, { assisted }));
  const boardOf = (n, assisted = false) => { const c = courses(assisted).find((x) => x.n === n); if (!c) return []; const { top, rest } = standings(c); return [...top, ...rest]; };
  // Its number, flag, and name, like the page's ("1 🇬🇮 Watchpoint: Gibraltar")
  const name = (n) => (data.names[n] ? `${n} ${data.flags[n] ? `${data.flags[n]} ` : ""}${data.names[n]}` : `Course ${n}`);
  const history = (() => { try { return JSON.parse(data.files[HISTORY_FILE]) || {}; } catch (e) { return {}; } })();
  const top3 = (runs) => runs.slice(0, 3).map((r, i) => `${i + 1}. ${caps(r.name)} ${r.time}`).join(" · ");
  let m;
  // A run's page: one sent from the website by its id, or one from before by its course and video
  if ((m = /^\/runs\/([\w-]{1,16})\/?$/i.exec(pathname))) {
    const id = m[1];
    let run = null, n = 0, group = "";
    const sent = (() => { try { return JSON.parse(data.files[RUNS_FILE]) || {}; } catch (e) { return {}; } })();
    for (const g of RUN_GROUPS) {
      for (const [k, list] of Object.entries(sent[g] && typeof sent[g] === "object" ? sent[g] : {})) {
        const r = Array.isArray(list) && list.find((x) => x && x.id === id);
        if (r) { run = r; n = Number(k); group = g; }
      }
    }
    if (!run && /^\d+-/.test(id)) {
      n = Number(id.split("-")[0]);
      const c = data.courses.find((x) => x.n === n);
      const old = [...fileRuns(c && c.file, c && data.files[c.file]), ...((history[n] && history[n].boards) || []).flat()];
      run = old.find((r) => {
        if (!r || typeof r.name !== "string" || typeof r.time !== "string") return false;
        const key = `${playerKey(r)} ${r.time} ${r.mistakes}`;
        return pastId(n, r.video || key) === id || pastId(n, `${r.video} ${key}`) === id;
      }) || null;
      group = "runs";
    }
    if (!run) return null;
    const board = boardOf(n, isAssisted(run));
    const at = board.findIndex((r) => playerKey(r) === playerKey(run) && r.time === run.time && r.mistakes === run.mistakes);
    const best = board.find((r) => playerKey(r) === playerKey(run));
    const where = group === "pending" ? "Waiting for a moderator to check it"
      : group === "declined" ? "Turned down"
      : group === "removed" ? "Taken off the board"
      : at >= 0 ? `#${at + 1} of ${board.length} on the board`
      : best ? `Their best there is ${best.time}` : "Taken off the board";
    return {
      title: `${caps(run.name)} · ${run.time} on ${name(n)}${isAssisted(run) ? " (Assisted)" : ""}`,
      description: [where, mistakesText(run.mistakes), run.date || ""].filter(Boolean).join(" · "),
    };
  }
  // A board: the top 3 on it (the newest board, an older one from its history, the legacy one, or the assisted one),
  // or the ratings' (the Global rating, the tab the board opens on, or the unassisted or assisted ratings)
  if ((m = /^\/leaderboards\/(ratings|\d+)(?:-[\w-]*)?(?:\/(legacy|assisted|unassisted|global|\d+))?\/?$/i.exec(pathname))) {
    const assisted = !!m[2] && m[2].toLowerCase() === ASSISTED;
    if (m[1].toLowerCase() === "ratings") {
      const unassisted = !!m[2] && m[2].toLowerCase() === "unassisted";
      const global = !assisted && !unassisted;
      const { players: rated } = global ? combine([rate(courses(false)), rate(courses(true))]) : rate(courses(assisted));
      return {
        title: global ? "Global player ratings" : assisted ? "Assisted player ratings" : "Unassisted player ratings",
        description: rated.length ? rated.slice(0, 3).map((p) => `${p.rank}. ${caps(p.name)} ${ratingText(p.rating)}`).join(" · ") : "No ratings yet",
      };
    }
    const n = Number(m[1]);
    const c = data.courses.find((x) => x.n === n);
    if (!c) return null;
    if (assisted) {
      if (!c.remake) return null; // no Assist Mode, so no assisted board: the link is a 404
      const board = boardOf(n, true);
      return { title: `${name(n)} · Assisted Top 10`, description: board.length ? `Played in Assist Mode: ${top3(board)}` : "No assisted times yet" };
    }
    const boards = ((history[n] && history[n].boards) || []).filter((b) => Array.isArray(b) && b.length);
    if (m[2] && m[2].toLowerCase() === "legacy") {
      // Timed to the second ("4:30.--"), and a player could be on it twice: their fastest, like the page's legacyHtml()
      const seen = new Set();
      const legacy = ((history[n] && history[n].legacy) || []).filter((r) => r && typeof r.name === "string" && typeof r.time === "string")
        .map((r) => ({ ...r, time: r.time.replace(".--", "") })).sort((a, b) => toSeconds(a.time) - toSeconds(b.time))
        .filter((r) => !seen.has(playerKey(r)) && seen.add(playerKey(r)));
      return { title: `${name(n)} · Legacy Top 10`, description: legacy.length ? `Before 2026-04-29: ${top3(legacy)}` : "Before 2026-04-29" };
    }
    // The boards in its history, then today's when it's changed since the last one (boardsOf() in index.html), so an
    // older board's number is the same as on the page
    const board = boardOf(n);
    const live = board.slice(0, 10);
    const last = boards[boards.length - 1];
    const sameAsLast = !!last && last.length === live.length && live.every((r) => last.some((x) => playerKey(x) === playerKey(r) && x.time === r.time && x.mistakes === r.mistakes));
    const total = boards.length + (live.length && !sameAsLast ? 1 : 0);
    const k = m[2] ? Number(m[2]) : 0;
    if (k >= 1 && k < total) {
      const b = boards[k - 1];
      const day = b.map((r) => r.date || "").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop();
      return { title: `${name(n)} · Board ${k} of ${total}`, description: `${top3(b)}${day ? ` · ${day}` : ""}` };
    }
    return {
      title: `${name(n)} · Top 10`,
      description: board.length ? top3(board) : c.broken && !c.remake ? "No times yet: this course doesn’t work since Overwatch’s August 2026 map updates" : "No times yet. Be the first to set one!",
    };
  }
  // A player (or their Runs): their place, rating, and Top %
  if ((m = /^\/(?:profile|players)\/([^/]{1,300})(?:\/runs)?\/?$/i.exec(pathname))) {
    let seg;
    try { seg = decodeURIComponent(m[1]); } catch (e) { return null; }
    const { players: rated, counted } = rate(courses());
    let key = keyOfLink(seg, linksIn(data.files));
    if (!key) return null;
    const all = courses().flatMap((c) => boardOf(c.n));
    // A name only a Discord player goes by, the way the page opens it
    if (key.startsWith("n:") && !all.some((r) => playerKey(r) === key)) {
      const them = [...new Set(all.filter((r) => upper(r.name) === key.slice(2)).map(playerKey))];
      if (them.length === 1) key = them[0];
    }
    const p = rated.find((x) => x.key === key);
    const theirs = all.filter((r) => playerKey(r) === key);
    const legacy = Object.values(history).flatMap((e) => (e && Array.isArray(e.legacy) ? e.legacy : [])).filter((r) => r && typeof r.name === "string" && playerKey(r) === key);
    const shown = (p && p.name) || (theirs[0] && theirs[0].name) || (legacy[0] && legacy[0].name) || (key.startsWith("d:") && players && players[key.slice(2)] && players[key.slice(2)].name) || "";
    if (!shown) return null;
    return {
      title: caps(shown),
      description: p
        ? [`#${p.rank} of ${rated.length} in the Player ratings`, ratingText(p.rating), p.tier === null ? "Rated" : `Top ${p.tier}%`, `${p.courses} of ${counted.length} courses run`].join(" · ")
        : theirs.length ? "Not rated yet" : legacy.length ? "Runs from before 2026-04-29" : "No runs yet",
    };
  }
  return null;
}

/* ---------- Pages ---------- */
// The sections (/submit, /faq, …) and the links into them (/leaderboards/6, /leaderboards/3/legacy, /leaderboards/3/12
// for one of its older boards, /faq/pausing), and every run sent from the website (/runs, the list under the form)
// and each one's page (/runs/<id>), /my-stats (My profile), Stats for a day picked in its history (/stats/2026-11-05,
// /stats/2026-11-05/week, /stats/day, /stats/3-months), and each player's panel (/players/<number or name>, see "Players' own links",
// and /players/<…>/runs for their Runs), are the home page. On ballkour.com a Cloudflare rule already serves the
// sections that way, but the test copy on workers.dev has no such rule, so the Worker does it too.
const DEEP_LINK = /^\/(?:(?:courses|leaderboards|submit|features|faq|source-code|translations|runs|stats|my-stats)\/?|leaderboards\/[\w-]+(?:\/legacy|\/assisted|\/unassisted|\/global|\/\d+)?\/?|faq\/[\w-]+\/?|runs\/[\w-]+\/?|stats(?:\/\d{4}-\d{2}-\d{2})?(?:\/(?:day|week|3-months|6-months|12-months))?\/?|players\/[^/]{1,300}(?:\/runs)?\/?)$/i;
async function page(request, env, ctx) {
  // Ask for the full page every time (no 304 Not Modified), so a browser never reuses old data from its cache
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  // /leaderboards/6 and /faq/pausing are the home page
  const url = new URL(request.url);
  const asked = url.pathname;
  if (isPage(url.pathname)) url.pathname = "/";
  // Cloudflare's free plan allows 50 fetches per request. Refreshing the game data takes about 20 and the player names
  // one or two per player, so a page load only refreshes the names when the game data is fresh. Past the limit, the
  // releases (fetched last) can't be refreshed and every page keeps getting the last list.
  const freshGame = await caches.default.match(cacheKey("game"));
  const [res, widget, gameData, players, lang] = await Promise.all([
    file(new Request(url, { method: "GET", headers, redirect: "manual" }), env),
    // The online count is worth a short wait (Discord answers in well under the 1.5 s limit), so it's never stale
    cached("widget", 60, ctx, (prev) => buildWidget(env, prev)).catch(() => null),
    freshGame ? freshGame.text() : soon("game", 60, ctx, (prev) => buildGame(env, prev), 2500),
    !env.DISCORD_BOT_TOKEN ? null
      : freshGame ? peek("players", 60 * 60, ctx, (prev) => buildPlayers(env, ctx, prev))
      : stored("players"),
    langBlock(env, url, langOf(request, url)),
  ]);
  const html = (res.headers.get("Content-Type") || "").includes("text/html");
  if (res.status === 404 && html) return notFound(res, lang);
  // Only the remakes have Assist Mode (the game data's remake), so any other course's /assisted link is the page that
  // isn't there, like a board that doesn't exist. Without the game data there's no telling, and the page shows its
  // Top 10 instead.
  if (gameData && noAssistedBoard(asked, gameData)) {
    return notFound(await file(new Request(new URL(asked, url), { method: "GET", headers, redirect: "manual" }), env), lang);
  }
  if (!res.ok || !html) return res;
  const on = loginOn(env);
  if (!widget && !gameData && !players && !lang && !on) return res;

  const out = new Response(res.body, res);
  out.headers.delete("ETag");
  out.headers.delete("Last-Modified");
  out.headers.set("Cache-Control", "no-cache");

  const script = (id, body) => `<script type="application/json" id="${id}">${body.replace(/</g, "\\u003c")}</script>`;
  const blocks = [["discord-widget", widget], ["game-data", gameData], ["players", players]].filter(([, body]) => body);
  let rw = new HTMLRewriter().on("head", { element(el) { el.append(blocks.map(([id, body]) => script(id, body)).join("") + lang, { html: true }); } });
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
  // Its link preview (see "Link previews"), for a run, a board, or a player
  let preview = null;
  const where = new URL(request.url).pathname;
  try { preview = gameData && PREVIEWED.test(where) && previewOf(where, JSON.parse(gameData), players && JSON.parse(players)); }
  catch (e) { console.error(`preview: ${(e && e.message) || e}`); }
  if (preview) {
    const link = `https://ballkour.com${new URL(request.url).pathname.replace(/\/$/, "")}`;
    rw = rw
      // data-own tells the page to keep this title when it switches languages, instead of putting the site's back
      .on("title", { element(el) { el.setInnerContent(`${preview.title} · Ballkour`); el.setAttribute("data-own", ""); } })
      .on('meta[property="og:title"]', { element(el) { el.setAttribute("content", preview.title); } })
      .on('meta[name="description"], meta[property="og:description"]', { element(el) { el.setAttribute("content", preview.description); } })
      .on('meta[property="og:url"]', { element(el) { el.setAttribute("content", link); } });
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
      if (path === "/api/claim") return await claim(request, env, ctx);
      if (path === "/api/claim/review") return await reviewClaim(request, env, ctx);
      if (path === "/api/link") return await setLink(request, env, ctx);
      if (path === "/api/run" && request.method === "GET") return await runInfo(request, env);
      if (path === "/api/comments" && request.method === "GET") return await comments(request, env, ctx);
      if (path === "/api/visits" && request.method === "GET") return await pageViews(env, ctx);
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
  return isPage(path) || (request.headers.get("Accept") || "").includes("text/html") ? page(request, env, ctx) : file(request, env);
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
  // The crons in wrangler.toml. On the hour and half past: the stats on players' Discord profiles catch up with the
  // boards. At :15 and :45: new players get their numbers (see "Players' own links"). Apart, so each has Cloudflare's
  // limit on calls to itself. At 00:00 UTC: the leaderboard bot's daily run (see startDailyBot).
  async scheduled(controller, env, ctx) {
    if (controller.cron === NUMBERS_CRON) {
      await numberPlayers(env, ctx).catch((e) => console.error(`numbers: ${(e && e.message) || e}`));
      return;
    }
    if (controller.cron === BOT_CRON) {
      await startDailyBot(env).catch((e) => console.error(`daily bot: ${(e && e.message) || e}`));
      return;
    }
    await updateProfiles(env, ctx).catch((e) => console.error(`profiles: ${(e && e.message) || e}`));
  },
};
