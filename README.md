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
cloudflare/              Worker that serves the GitHub and Discord data the page uses
.github/workflows/       deploys the site on every push to main
```

Keep everything out of `/v*`, `/discord`, `/gameplay`, `/courses`, `/leaderboards`, `/submit`, `/features`, `/faq`, `/source-code` and `/translations`. Cloudflare redirects the first three. It rewrites the others (with or without a trailing slash) to the home page, which scrolls to that section; `/leaderboards` also opens Gibraltar's top 10.

Links can go deeper, and the address shows them while a board or answer is open:

- **A course's board:** `ballkour.com/leaderboards#6-dorado` (or just `#6`). The leaderboard bot links its posts this way.
- **An FAQ answer:** `ballkour.com/faq#pause`. The ids are in `FAQ_IDS`.
- **A language:** `ballkour.com/?lang=ja` opens the page in Japanese; it works with any of the links above. Picking a language puts it in the address.

## Deploying

Every push to `main` deploys to the VPS through `.github/workflows/deploy.yml`, including merged Weblate pull requests. It can also be run by hand from the Actions tab. It needs three repository secrets: `DEPLOY_KEY`, `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`.

The deploy fails if `locales/en.json` doesn't match `index.html`. After changing English text in `index.html`, run:

```
python3 tools/extract-en.py
```

and commit `locales/en.json` along with it.

## Cloudflare Worker

`cloudflare/worker.js` is a Cloudflare Worker on `ballkour.com/*`. Visitors' browsers only ever talk to ballkour.com: the Worker fetches what the page needs from GitHub and Discord, caches it at Cloudflare and serves it from here. That keeps the site fast, keeps visitors' IPs away from GitHub and Discord, avoids GitHub's limits on anonymous requests, and works where GitHub and Discord are blocked.

- `/data/game.json`: the game repo's leaderboard files, leaderboard history and in-game FAQ from `develop`, plus the latest releases. Refreshed at most once a minute.
- `/data/widget.json`: the Discord online count and voice channels. Refreshed at most once a minute.
- `/data/players.json`: the Discord name and picture of every player whose run has a Discord ID, looked up with Ballkyrie's token. Refreshed at most once an hour.

Each page also gets the latest copy of all three as it's served, with the "• N online" counts already filled in, so nothing pops in after the page loads. If GitHub or Discord can't be reached, the last copy that worked is served for up to a week.

The Worker isn't part of the VPS deploy. Deploy it once (and again only if you change it) from the `cloudflare/` folder:

```
npx wrangler login
npx wrangler deploy
```

It uses two secrets. Set each once (it asks you to paste the value):

```
npx wrangler secret put DISCORD_BOT_TOKEN   # Ballkyrie's bot token, for the player names
npx wrangler secret put GITHUB_TOKEN        # optional: any GitHub token, for GitHub's higher rate limits
```

Or paste the file into a new Worker in the Cloudflare dashboard (Workers & Pages → Create → Start with Hello World), deploy it, then add the route `ballkour.com/*` under Settings → Domains & Routes.

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
