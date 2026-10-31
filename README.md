# ballkour.com

Website for Ballkour — Wrecking Ball parkour courses for Overwatch. One static page, no build step.

```
index.html               the page (English text lives here)
404.html                 the "page not found" page
robots.txt, sitemap.xml  for search engines
assets/                  logo, icons, link-preview image
locales/*.json           translations, one file per language (managed on Weblate)
tools/extract-en.py      rebuilds locales/en.json from index.html
.github/workflows/       deploys the site on every push to main
```

Keep everything out of `/v*`, `/discord` and `/gameplay`, since Cloudflare redirects those paths.

## Deploying

Every push to `main` deploys to the VPS through `.github/workflows/deploy.yml`, including merged Weblate pull requests. It can also be run by hand from the Actions tab. It needs three repository secrets: `DEPLOY_KEY`, `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS`.

The deploy fails if `locales/en.json` doesn't match `index.html`. After changing English text in `index.html`, run:

```
python3 tools/extract-en.py
```

and commit `locales/en.json` along with it.

## Courses and leaderboards

Course numbers, flags, codes and broken flags live in the `COURSES` list in the script at the bottom of `index.html`.

Leaderboards load live from the game repo's `develop` branch, so they update without a deploy:

- **Remakes (1–3):** `src/courses/*/leaderboard.opy`
- **Classic courses (4–15):** `leaderboards/classic.json`

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
