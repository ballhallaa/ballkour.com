# ballkour.com

The Ballkour website: one static page, no build step.

```
index.html          the page (English text lives here)
assets/             logo, icons, link-preview image
locales/*.json      translations, one file per language (managed on Weblate)
tools/extract-en.py rebuilds locales/en.json from index.html
```

Keep everything out of `/v*`, `/discord` and `/gameplay`, since Cloudflare redirects those paths.

## Courses and leaderboards

Edit the `COURSES` list in the script at the bottom of `index.html`. Each course's number, flag, codes and broken flags live there, and so do its leaderboard runs.

The three remakes also re-read `src/courses/*/leaderboard.opy` from the `develop` branch when someone loads the page. Their boards update as soon as that file changes on GitHub. The runs in `COURSES` are only a fallback for them.

## Translations

The English source is `locales/en.json`. After changing English text in `index.html`, run:

```
python3 tools/extract-en.py
```

Weblate component settings:

| Setting | Value |
|---|---|
| File format | JSON file |
| File mask | `website/locales/*.json` (or wherever this folder lives) |
| Monolingual base language file | `website/locales/en.json` |
| Template for new translations | `website/locales/en.json` |

The 13 translations are first drafts written by Claude, using the HUD's existing Weblate terms. Menu names such as Custom Games and Import Code should be checked against each language's Overwatch client.

Translations may use `<b>` and `<code>` only. Anything else shows up as text. Keep `{placeholders}` as they are.
