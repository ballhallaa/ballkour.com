#!/usr/bin/env node
/* Checks that the three copies of the boards and ratings agree, on the real boards:
     - the page (index.html, under "Every run, and the ratings"),
     - the Worker (cloudflare/ratings.js, for the stats on Discord profiles and Ballkyrie's posts),
     - and the leaderboard bot (tools/leaderboard-bot/ratings.mjs and boards.mjs in the game repo, for the Top % roles).
   Each works out every course's board and the player ratings from the same files (the game repo's courses.json and
   course files on develop, and runs.json and history.json on leaderboard-data), and every board, place, rating, and
   Top % has to come out the same. .github/workflows/check.yml runs it on every pull request and once a day, since the
   bot's copy can change in the other repo.

       node tools/check-ratings.mjs

   Needs Node 20 or newer, and no packages. The page's own script runs as it is, in a stand-in for the browser with
   nothing on screen, so what's checked is the page's code, not a copy of it. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = "https://raw.githubusercontent.com/ballhallaa/ballkour";
const get = async (branch, file) => {
  const r = await fetch(`${RAW}/${branch}/${encodeURI(file)}`);
  if (!r.ok) throw new Error(`${file} (${branch}): GitHub said ${r.status}`);
  return r.text();
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ballkour-ratings-"));

// ---------- The files, as GitHub has them now ----------
const coursesJson = await get("develop", "tools/leaderboard-bot/courses.json");
const list = JSON.parse(coursesJson).courses;
const files = {
  "leaderboards/runs.json": await get("leaderboard-data", "leaderboards/runs.json"),
  "leaderboards/history.json": await get("leaderboard-data", "leaderboards/history.json"),
};
for (const c of list) files[c.file] = await get("develop", c.file);
// The game data the way the Worker hands it to the page (buildGame() in cloudflare/worker.js)
const game = {
  files,
  names: Object.fromEntries(list.map((c) => [c.n, c.name])),
  flags: Object.fromEntries(list.filter((c) => c.flag).map((c) => [c.n, c.flag])),
  courses: list.map(({ n, file, broken, remaker }) => ({ n, file, broken: !!broken, remake: !!remaker })),
};

// Every board as [player, time, mistakes], and the ratings as [player, place, rating, Top %, courses run]
const boardRows = (b) => [...b.top, ...b.rest].map((r) => `${r.discord ? "d:" + r.discord : "n:" + r.name.toUpperCase()} ${r.time} ${r.mistakes ?? r.miss}`);
const ratingRows = (r) => r.players.map((p) => `${p.key} #${p.rank} ${p.rating.toFixed(2)} ${p.tier ?? "Rated"} ${p.courses}`);

// ---------- The Worker's ----------
async function worker() {
  const copy = path.join(tmp, "worker-ratings.mjs");
  fs.copyFileSync(path.join(ROOT, "cloudflare/ratings.js"), copy);
  const { loadCourses, standings, rate, combine } = await import(pathToFileURL(copy).href);
  const courses = loadCourses(files, game.courses);
  const global = combine([rate(courses), rate(loadCourses(files, game.courses, { assisted: true }))]);
  return { boards: Object.fromEntries(courses.map((c) => [c.n, boardRows(standings(c))])), ratings: ratingRows(rate(courses)), counted: rate(courses).counted, global: ratingRows(global) };
}

// ---------- The bot's: its own files, reading the same course files and data from folders, like its workflow ----------
async function bot() {
  const dir = path.join(tmp, "bot");
  const repo = path.join(tmp, "repo");
  const data = path.join(tmp, "data");
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["ratings.mjs", "boards.mjs"]) fs.writeFileSync(path.join(dir, f), await get("develop", `tools/leaderboard-bot/${f}`));
  fs.writeFileSync(path.join(dir, "courses.json"), coursesJson);
  for (const c of list) { fs.mkdirSync(path.dirname(path.join(repo, c.file)), { recursive: true }); fs.writeFileSync(path.join(repo, c.file), files[c.file]); }
  fs.mkdirSync(path.join(data, "leaderboards"), { recursive: true });
  for (const f of ["leaderboards/runs.json", "leaderboards/history.json"]) fs.writeFileSync(path.join(data, f), files[f]);
  process.env.REPO_ROOT = repo;
  process.env.DATA_ROOT = data;
  const { loadCourses } = await import(pathToFileURL(path.join(dir, "boards.mjs")).href);
  const { standings, rate, combine } = await import(pathToFileURL(path.join(dir, "ratings.mjs")).href);
  const courses = loadCourses();
  // The Global rating, once the bot has it (combine)
  const global = combine ? ratingRows(combine([rate(courses), rate(loadCourses({ assisted: true }))])) : null;
  return { boards: Object.fromEntries(courses.map((c) => [c.n, boardRows(standings(c))])), ratings: ratingRows(rate(courses)), counted: rate(courses).counted, global };
}

// ---------- The page's: its script, in a stand-in for the browser ----------
// Anything the script reaches for on the page is a stand-in that takes any call, and remembers what's set on it (so
// el.hidden = true reads back true), except the few things it reads: its English text, and the game data the
// Worker bakes in.
function standIn() {
  const fn = function () {};
  const props = {};
  return new Proxy(fn, {
    get(_, prop) {
      if (prop in props) return props[prop];
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined;
      if (["textContent", "innerHTML", "outerHTML", "value", "id", "title", "href"].includes(prop)) return "";
      if (["open", "hidden", "isComposing"].includes(prop)) return false;
      if (prop === "dataset") return {};
      if (prop === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (prop === "children" || prop === "length") return 0;
      return standIn();
    },
    set: (_, prop, value) => { props[prop] = value; return true; },
    apply: () => standIn(),
    construct: () => standIn(),
  });
}
async function page() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const english = /<script type="application\/json" id="i18n-dynamic">([\s\S]*?)<\/script>/.exec(html)[1];
  const start = html.indexOf("<script>\n(() => {");
  const end = html.indexOf("</script>", start);
  let code = html.slice(start + "<script>".length, end);
  const last = code.lastIndexOf("})();");
  if (!code.trimStart().startsWith("(() => {") || last < 0) throw new Error("index.html's script isn't one (() => { … })(); any more: update tools/check-ratings.mjs");
  // What's checked, handed out at the end of the script
  code = "globalThis.__page = " + code.slice(0, last) + "  return { ratings, standingsOf, COURSES, LOADS };\n" + code.slice(last);
  const blocks = { "#i18n-dynamic": english, "#game-data": JSON.stringify(game) };
  const element = (sel) => (sel in blocks ? { textContent: blocks[sel], dataset: {} } : standIn());
  const document = new Proxy({}, {
    get(_, prop) {
      if (prop === "querySelector") return (sel) => element(sel);
      if (prop === "querySelectorAll") return () => [];
      if (prop === "getElementById") return () => null; // nothing is drawn, so every redraw is skipped
      if (prop === "hidden") return false;
      if (prop === "cookie") return "";
      if (prop === "fonts") return undefined; // the page waits for fonts only when there's a way to
      return standIn();
    },
    set: () => true,
  });
  const context = {
    document,
    location: { pathname: "/", search: "", hash: "", href: "https://ballkour.com/", hostname: "ballkour.com", origin: "https://ballkour.com" },
    history: { state: null, replaceState() {}, pushState() {} },
    navigator: { languages: ["en"], language: "en" },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: () => Promise.reject(new Error("no network here")),
    requestAnimationFrame() {}, setInterval() {}, setTimeout: () => 0, clearTimeout() {}, getSelection: () => standIn(),
    addEventListener() {}, innerWidth: 1200, innerHeight: 900, devicePixelRatio: 1, scrollY: 0,
    CSS: { escape: (s) => s },
    HTMLInputElement: class {}, HTMLDetailsElement: class {}, Element: class {}, Node: { TEXT_NODE: 3 },
    performance, queueMicrotask, structuredClone, TextEncoder, TextDecoder, atob, btoa, Intl, URL, URLSearchParams, console,
  };
  context.window = context;
  vm.createContext(context);
  try {
    vm.runInContext(code, context, { filename: "index.html" });
  } catch (e) {
    console.error(e);
    process.exit(2);
  }
  const { ratings, standingsOf, COURSES, LOADS } = context.__page;
  await Promise.allSettled(LOADS);
  await new Promise((r) => setImmediate(r)); // the redraws queued as the boards loaded
  const rated = ratings();
  return {
    boards: Object.fromEntries(COURSES.map((c) => [c.n, boardRows(standingsOf(c))])),
    ratings: ratingRows(rated),
    counted: rated.counted.map((c) => c.n),
    global: ratingRows(ratings(null, "global")),
  };
}

// ---------- Compare ----------
const copies = { "the Worker": await worker(), "the bot": await bot(), "the page": await page() };
fs.rmSync(tmp, { recursive: true, force: true });
const [baseName, base] = Object.entries(copies)[0];
const problems = [];
for (const [name, c] of Object.entries(copies).slice(1)) {
  if (JSON.stringify(c.counted) !== JSON.stringify(base.counted)) problems.push(`${name} counts courses ${c.counted.join(", ")} in the ratings, ${baseName} counts ${base.counted.join(", ")}`);
  for (const n of Object.keys(base.boards)) {
    const a = base.boards[n], b = c.boards[n] || [];
    const at = a.findIndex((row, i) => row !== b[i]);
    if (at >= 0 || a.length !== b.length) {
      const i = at >= 0 ? at : Math.min(a.length, b.length);
      problems.push(`course ${n}'s board: at #${i + 1}, ${baseName} has ${a[i] || "nobody"} and ${name} has ${b[i] || "nobody"} (${a.length} and ${b.length} players)`);
    }
  }
  // The Player ratings, and the Global rating (the unassisted and assisted ratings added up, for the Global roles)
  for (const [what, rows] of [["the Player ratings", "ratings"], ["the Global rating", "global"]]) {
    const a = base[rows], b = c[rows];
    if (!b) continue; // the bot's copy has no Global rating yet
    const at = a.findIndex((row, i) => row !== b[i]);
    if (at >= 0 || a.length !== b.length) {
      const i = at >= 0 ? at : Math.min(a.length, b.length);
      problems.push(`${what}: at #${i + 1}, ${baseName} has ${a[i] || "nobody"} and ${name} has ${b[i] || "nobody"}`);
    }
  }
}
const players = base.ratings.length;
const runs = Object.values(base.boards).reduce((sum, b) => sum + b.length, 0);
if (problems.length) {
  console.log(`The boards or ratings don't agree (keep the page, the Worker, and the bot in step):`);
  for (const p of problems) console.log(`  ${p}`);
  process.exit(1);
}
console.log(`The page, the Worker, and the bot agree: ${list.length} courses' boards (${runs} players' best runs) and ${players} players' ratings, places, and Top %.`);
