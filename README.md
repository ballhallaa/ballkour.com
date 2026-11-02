# ballkour.com

Website for Ballkour — Wrecking Ball parkour courses for Overwatch. One static page, no build step.

```
index.html               the page (English text lives here)
404.html                 the "page not found" page
robots.txt, sitemap.xml  for search engines
assets/                  logo, icons, link-preview image
locales/*.json           translations, one file per language (managed on Weblate)
tools/extract-en.py      rebuilds locales/en.json from index.html
cloudflare/              Worker that puts the Discord online count into the page
.github/workflows/       deploys the site on every push to main
```

Keep everything out of `/v*`, `/discord`, `/gameplay`, `/courses`, `/leaderboards`, `/submit`, `/features`, `/faq`, `/source-code` and `/translations`. Cloudflare redirects the first three. It rewrites the others (with or without a trailing slash) to the home page, which scrolls to that section; `/leaderboards` also opens Gibraltar's top 10.

## Deploying

Every push to `main` deploys to the VPS through `.github/workflows/deploy.yml`, including merged Weblate pull requests. It can also be run by hand from the Actions tab. It needs three repository secrets: `DEPLOY_KEY`, `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`.

The deploy fails if `locales/en.json` doesn't match `index.html`. After changing English text in `index.html`, run:

```
python3 tools/extract-en.py
```

and commit `locales/en.json` along with it.

## Discord online count

`cloudflare/discord-widget.js` is a Cloudflare Worker on `ballkour.com/*`. As each page goes out, it fills in the "• N online" count next to "Join our Discord" and adds the voice channel data, so neither pops in after the page loads. Discord's answer is cached at Cloudflare for 60 seconds. If Discord is slow or down, the page goes out unchanged and the browser fetches the count itself.

The Worker isn't part of the VPS deploy. Deploy it once (and again only if you change it) from the `cloudflare/` folder:

```
npx wrangler login
npx wrangler deploy
```

Or paste the file into a new Worker in the Cloudflare dashboard (Workers & Pages → Create → Start with Hello World), deploy it, then add the route `ballkour.com/*` under Settings → Domains & Routes.

## Courses and leaderboards

Course numbers, flags, codes and broken flags live in the `COURSES` list in the script at the bottom of `index.html`.

Leaderboards load live from the game repo's `develop` branch, so they update without a deploy:

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
