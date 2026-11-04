# ballkour.com

Website for Ballkour — Wrecking Ball parkour courses for Overwatch. One static page, no build step.

```
index.html               the page (English text lives here)
404.html                 the "page not found" page
robots.txt, sitemap.xml  for search engines
assets/                  logo, icons, link-preview image (og.jpg)
assets/fonts/            the site's fonts (Open Font License), served from ballkour.com
locales/*.json           translations, one file per language (managed on Weblate)
tools/extract-en.py      rebuilds locales/en.json from index.html
cloudflare/              the Worker that serves the site, plus the GitHub and Discord data the page uses
.assetsignore            what isn't published: this README, tools/, the Worker's own code, …
.github/workflows/       deploys the site on every push to main
```

Keep everything out of `/discord`, `/gameplay`, `/code`, `/releases`, `/courses`, `/leaderboards`, `/submit`, `/features`, `/faq`, `/source-code` and `/translations`. Cloudflare redirects `/discord`, `/gameplay`, and `/releases/v*` and `/releases/site/v*` (to that release of the game or website on GitHub, which is where the version chips link), and the Worker redirects `/code/game` and `/code/site` (or `/code/website`) to the game's and this website's GitHub repos, and `/releases` and `/releases/site` (or `/releases/website`) to their release notes. Cloudflare rewrites the others (with or without a trailing slash) to the home page, which scrolls to that section; `/leaderboards` also opens Gibraltar's top 10.

Links can go deeper, and the address shows them while a board or answer is open:

- **A course's board:** `ballkour.com/leaderboards/6-dorado` (or just `/leaderboards/6`). The leaderboard bot links its posts this way. The Worker serves the page at these addresses.
- **An FAQ answer:** `ballkour.com/faq/pause`. The ids are in `FAQ_IDS`.

The older `#6-dorado` and `#pause` forms still work.
- **A language:** `ballkour.com/?lang=ja` opens the page in Japanese; it works with any of the links above. Picking a language puts it in the address.

## Deploying

The site runs entirely on Cloudflare: the Worker in `cloudflare/` serves the files in this repo, so ballkour.com stays up even when the VPS is down.

Every push to `main` deploys through `.github/workflows/deploy.yml`, including merged Weblate pull requests. It can also be run by hand from the Actions tab. It runs `wrangler deploy` in `cloudflare/`, which publishes the Worker and the site's files together. Everything in the repo is published except what `.assetsignore` lists. It needs the `CLOUDFLARE_API_TOKEN` secret (from the "Edit Cloudflare Workers" token template, limited to ballkour.com) and the `CLOUDFLARE_ACCOUNT_ID` variable.

The workflow pins Wrangler to a 4.x version (`wranglerVersion`). The action's default is Wrangler 3, which ignores `run_worker_first` in `wrangler.toml`, and pages then go out without their data. When updating it, keep it at 4 or newer.

The deploy fails if `locales/en.json` doesn't match `index.html`. After changing English text in `index.html`, run:

```
python3 tools/extract-en.py
```

and commit `locales/en.json` along with it.

To try changes before merging, deploy a test copy from `cloudflare/`. It has no route and runs on workers.dev, built from your working folder:

```
npx wrangler deploy --env test
```

The test copy doesn't have the Worker's secrets, so player names and pictures are missing there. When you're done, delete it in the Cloudflare dashboard (Workers & Pages → ballkour-discord-widget-test → Settings). Don't use `wrangler delete` without `--env test`: that deletes the live site.

## Cloudflare Worker

`cloudflare/worker.js` is a Cloudflare Worker on `ballkour.com/*` that serves the whole site: every request runs it first, and it hands out the site's own files along with the data below. Visitors' browsers only ever talk to ballkour.com: the Worker fetches what the page needs from GitHub and Discord, caches it at Cloudflare and serves it from here. That keeps the site fast, keeps visitors' IPs away from GitHub and Discord, avoids GitHub's limits on anonymous requests, and works where GitHub and Discord are blocked.

- `/data/game.json`: the game repo's leaderboard files, leaderboard history and in-game FAQ from `develop`, plus the latest releases. Refreshed at most once a minute.
- `/data/widget.json`: the Discord server's member count and voice channels. Refreshed at most once a minute.
- `/code/game`, `/code/site` (or `/code/website`): redirect to the game's and this website's GitHub repos.
- `/releases`, `/releases/site` (or `/releases/website`): redirect to the game's and this website's release notes.

  Anything after these carries over, e.g. `/code/game/issues`. A release's own page is `/releases/v2026.10.14-0` or `/releases/site/v2026.11.02.6`, which Cloudflare redirects before the Worker sees it.
- `/data/players.json`: the Discord name and picture of every player whose run has a Discord ID, looked up with Ballkyrie's token. Refreshed at most once an hour.

Each page also gets the latest copy of all three as it's served, with the "• N members" counts already filled in, so nothing pops in after the page loads. If GitHub or Discord can't be reached, the last copy that worked is served for up to a week.

It also sets the site's headers. The security headers, including the Content-Security-Policy, are in `SECURITY_HEADERS`; if you add an outside service to the page, add its address to the CSP there. Files in `assets/` are cached for a week, and everything else is checked for a newer copy on every visit.

It's deployed together with the site (see Deploying). It uses two secrets, which deploys keep. Set each once from the `cloudflare/` folder (it asks you to paste the value):

```
npx wrangler login
npx wrangler secret put DISCORD_BOT_TOKEN   # Ballkyrie's bot token, for the player names
npx wrangler secret put GITHUB_TOKEN        # optional: any GitHub token, for GitHub's higher rate limits
```

## Fonts

The fonts in `assets/fonts` come from [Fontsource](https://fontsource.org) (the same files Google Fonts serves, split by script so a page only downloads what it uses): Barlow, Barlow Condensed, JetBrains Mono, and a flags-only cut of Noto Color Emoji for Windows, whose own emoji have no flags. Apple devices use their own emoji, and Linux and Android use a local Noto Color Emoji when there is one.

The emoji font has the flags of the course countries and of the other Overwatch maps' countries, plus 🎯 and 🌙. A course with a flag that isn't in it shows the flag's two letters on Windows; rebuild the font with that flag added, or ask Claude to.

## Courses and leaderboards

Course numbers, flags, codes and broken flags live in the `COURSES` list in the script at the bottom of `index.html`.

Leaderboards load live from the game repo's `develop` branch (through the Worker), so they update without a deploy:

- **Remakes (1–3):** `leaderboards/<n>-<slug>.opy`
- **Classic courses (4–15):** `leaderboards/<n>-<slug>.json` (the slugs are in `CLASSIC_FILES`)

The runs written into `COURSES` are only a fallback for when GitHub can't be reached.

## Translations

The English source is `locales/en.json`. Weblate component settings:

| Setting | Value |
|---|---|
| File format | JSON file |
| File mask | `locales/*.json` |
| Monolingual base language file | `locales/en.json` |
| Template for new translations | `locales/en.json` |
| Edit base file | Off |

Translations may use `<b>` and `<code>` only. Anything else shows up as text. Keep `{placeholders}` as they are.

In the FAQ, `<b>` marks the game's own labels (controls like Reset CP, HUD and lobby names like Runs and Lobby Top 3), which show in orange. Use each label as the game shows it in that language.
