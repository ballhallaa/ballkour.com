/* The boards and the player ratings, for the stats on players' Discord profiles (see "Stats on Discord profiles" in
   worker.js). The rating part is a copy of tools/leaderboard-bot/ratings.mjs in the game repo, and loadCourses() is
   its boards.mjs's, reading the cached game data instead of a checkout. The website works out the same boards and
   ratings (index.html, under "Every run, and the ratings"), and the bot gives out the same tiers as roles: keep all
   three in step.

   A course's board ranks every run in its file and in runs.json (the runs sent from the website, and runs that never
   made a top 10), once each per player with their best run, minus the runs taken off for good (runs.json's
   "removed"). Below its top 10 come the players who dropped out of it, from the boards in history.json, but only with
   runs slower than today's #10.

   Every course is worth up to 1,000 points: 1000 × ln(1 + (e − 1) × record ÷ time)². A rating is the average over
   every course that isn't broken, with 0 for the ones a player hasn't run. A player's tier is the share of rated
   players at their place or ahead of it: #4 of 40 (10%) is in the Top 10%, and so is #1 of 16 (6.25%), since the
   Top 0.1% needs 1,000 players. Everyone past
   the last tier (the bottom 10%) is just Rated. */

export const TIERS = [0.1, 1, 5, 10, 25, 50, 75, 90];

const seconds = (t) => t.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
const byTime = (a, b) => seconds(a.time) - seconds(b.time) || a.mistakes - b.mistakes;

// A player is their Discord ID, or for a run without one, its in-game name
export const playerKey = (r) => (r.discord ? "d:" + r.discord : "n:" + r.name.toUpperCase());
// The same run: same time, and the same player (their Discord ID when both have one, and their name otherwise)
export const sameRun = (a, b) => a.time === b.time && (a.discord && b.discord ? a.discord === b.discord : a.name.toUpperCase() === b.name.toUpperCase());
// One run per player, their fastest, fastest first. Ties keep the order the runs came in.
function bestEach(runs) {
  const best = new Map();
  for (const r of runs) {
    const key = playerKey(r);
    const had = best.get(key);
    if (!had || byTime(r, had) < 0) best.set(key, r);
  }
  return [...best.values()].sort(byTime);
}

// course: { file: [run, …], more: [run, …], removed: [run, …], boards: [[run, …], …] } → { top: [run, …], rest: [run, …] }
export function standings(course) {
  const kept = (r) => !course.removed.some((x) => sameRun(x, r));
  const live = [...course.file, ...course.more].filter(kept);
  const board = bestEach(live);
  const last = board.length >= 10 ? board[9] : null;
  const old = last ? course.boards.flat().filter((r) => kept(r) && byTime(r, last) >= 0) : [];
  const all = bestEach([...live, ...old]);
  return { top: all.slice(0, 10), rest: all.slice(10) };
}

// courses: [{ n, broken, file, more, removed, boards }] as standings() takes them
// → { counted: [course numbers], players: [{ key, name, discord, rating, points: { n: points }, courses, rank, tier }] }
export function rate(courses) {
  const counted = [];
  const players = new Map();
  for (const c of courses) {
    if (c.broken) continue;
    counted.push(c.n);
    const { top, rest } = standings(c);
    const all = [...top, ...rest];
    if (!all.length) continue; // nobody has run it yet: 0 for everyone
    const record = seconds(all[0].time);
    for (const r of all) {
      const key = playerKey(r);
      if (!players.has(key)) players.set(key, { key, name: r.name, discord: r.discord || "", date: "", points: {} });
      const p = players.get(key);
      // Named as on their newest run
      if ((r.date || "") > p.date) { p.date = r.date; p.name = r.name; }
      p.points[c.n] = 1000 * Math.log(1 + (Math.E - 1) * record / seconds(r.time)) ** 2;
    }
  }
  const list = [...players.values()].map((p) => {
    const pts = Object.values(p.points);
    return { ...p, courses: pts.length, rating: pts.reduce((a, b) => a + b, 0) / (counted.length || 1) };
  });
  return { counted, players: ranked(list) };
}

// Rated players, best first (then whoever has run more courses, then by name), each with their place and tier.
// Players with the same rating share the better place.
function ranked(list) {
  list.sort((a, b) => b.rating - a.rating || b.courses - a.courses || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const same = (a, b) => Math.round(a.rating * 100) === Math.round(b.rating * 100);
  list.forEach((p, i) => {
    p.rank = i > 0 && same(list[i - 1], p) ? list[i - 1].rank : i + 1;
    p.tier = TIERS.find((tier) => (p.rank / list.length) * 100 <= tier + 1e-9) ?? null;
  });
  return list;
}

// The Global rating: rate()'s results for the unassisted and the assisted boards, added up per player (courses: the
// courses they've run either way), for the Global Discord roles. The bot (combine() in
// tools/leaderboard-bot/ratings.mjs) and the page (ratings(then, "global")) work it out the same way.
// → { counted: [course numbers], players: [{ key, name, discord, rating, courses, rank, tier }] }
export function combine(ratings) {
  const players = new Map();
  for (const p of ratings.flatMap((r) => r.players)) {
    if (!players.has(p.key)) players.set(p.key, { key: p.key, name: p.name, discord: p.discord, date: p.date, rating: 0, ran: new Set() });
    const g = players.get(p.key);
    g.rating += p.rating;
    for (const n of Object.keys(p.points)) g.ran.add(n);
    // Named as on their newest run
    if ((p.date || "") > g.date) { g.date = p.date; g.name = p.name; }
  }
  const counted = [...new Set(ratings.flatMap((r) => r.counted))].sort((a, b) => a - b);
  return { counted, players: ranked([...players.values()].map(({ ran, ...p }) => ({ ...p, courses: ran.size }))) };
}

/* ---------- Reading the files (boards.mjs in the game repo) ---------- */
const TIME = /^(\d{1,2}:)?\d{1,2}:\d{2}\.\d{2}$/;
const DISCORD_ID = /^\d{17,20}$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// "YYYY-MM-DD" stays as it is; "Mon D, YYYY" becomes YYYY-MM-DD
function isoDate(s) {
  const str = String(s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(str);
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return mi >= 0 ? `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}
// lb[i] = "NAME, M:SS.cc, MISTAKES, '...'"  # discord: ID, and lbRunInfo(rank, "YYYY-MM-DD", "host/path")
function parseOpy(text) {
  if (!/\blb\s*=\s*\[\s*\]/.test(text)) return null; // file layout changed: don't guess
  const rows = [];
  for (const m of text.matchAll(/lb\[(\d+)\]\s*=\s*"([^"]*)"(?:[ \t]*#[ \t]*discord:[ \t]*(\d{17,20})\b)?/g)) {
    const [name, time, miss] = m[2].split(",").map((s) => s.trim());
    if (name && TIME.test(time) && /^\d+$/.test(miss)) rows[Number(m[1])] = { name, discord: m[3] || "", time, mistakes: Number(miss), date: "" };
  }
  for (const m of text.matchAll(/lbRunInfo\(\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g)) {
    const r = rows[Number(m[1])];
    if (r) r.date = isoDate(m[2]);
  }
  return rows.filter(Boolean).slice(0, 10);
}
// A run as in the classic courses' files → a clean run, or null
function cleanRun(r) {
  if (!r || typeof r.name !== "string" || !r.name.trim() || !TIME.test(r.time) || !Number.isInteger(r.mistakes) || r.mistakes < 0) return null;
  return { name: r.name.trim(), discord: DISCORD_ID.test(r.discord) ? r.discord : "", time: r.time, mistakes: r.mistakes, date: isoDate(r.date) };
}
// A removed run: its player (name, and Discord ID if it has one) and time are enough to find it
function cleanRemoved(r) {
  if (!r || typeof r.name !== "string" || !r.name.trim() || !TIME.test(r.time)) return null;
  return { name: r.name.trim(), discord: DISCORD_ID.test(r.discord) ? r.discord : "", time: r.time };
}
function fileRuns(path, text) {
  if (typeof text !== "string") return [];
  if (path.endsWith(".opy")) return parseOpy(text) || [];
  try {
    const runs = JSON.parse(text);
    return Array.isArray(runs) ? runs.map(cleanRun).filter(Boolean).sort(byTime) : [];
  } catch (e) { return []; }
}
// The game data's files and course list ({ n, file, broken }) → every course with what its board is made of, for
// standings() and rate(). Throws when history.json or runs.json can't be read, so no stats go out without them.
// assisted: the assisted boards instead (boards.mjs's loadCourses({ assisted: true })): the runs played in Assist Mode
// ("mode": "assisted" in runs.json) alone, and the assisted boards posted (history.json's "assisted"), for the courses
// with Assist Mode (the remakes) alone, so the assisted rating is over them. The courses' files only have regular runs.
export function loadCourses(files, courses, { assisted = false } = {}) {
  const history = JSON.parse(files["leaderboards/history.json"]);
  const extra = JSON.parse(files["leaderboards/runs.json"]);
  if (!history || typeof history !== "object" || !extra || typeof extra !== "object") throw new Error("history.json or runs.json isn't a JSON object");
  const byCourse = (obj, clean) => Object.fromEntries(Object.entries(obj && typeof obj === "object" ? obj : {})
    .filter(([, list]) => Array.isArray(list))
    .map(([n, list]) => [n, list.filter((r) => !!r && (r.mode === "assisted") === assisted).map(clean).filter(Boolean)]));
  const runs = byCourse(extra.runs, cleanRun), removed = byCourse(extra.removed, cleanRemoved);
  const posted = assisted ? "assisted" : "boards";
  return courses.filter((c) => !assisted || c.remake).map((c) => ({
    n: c.n,
    broken: !!c.broken,
    file: assisted ? [] : fileRuns(c.file, files[c.file]),
    more: runs[c.n] || [],
    removed: removed[c.n] || [],
    boards: ((history[c.n] && history[c.n][posted]) || []).map((b) => (Array.isArray(b) ? b.map(cleanRun).filter(Boolean) : [])),
  }));
}
