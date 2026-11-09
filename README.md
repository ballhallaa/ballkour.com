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

Keep everything out of `/discord`, `/gameplay`, `/code`, `/releases`, `/courses`, `/leaderboards`, `/submit`, `/features`, `/faq`, `/source-code`, `/translations`, `/runs`, `/stats`, `/api`, and `/data`. Cloudflare redirects `/discord`, `/gameplay`, and `/releases/v*` and `/releases/site/v*` (to that release of the game or website on GitHub, which is where the version chips link), and the Worker redirects `/code/game` and `/code/site` (or `/code/website`) to the game's and this website's GitHub repos, and `/releases` and `/releases/site` (or `/releases/website`) to their release notes. Cloudflare rewrites the others (with or without a trailing slash) to the home page, which scrolls to that section; `/leaderboards` also opens Gibraltar's top 10.

Links can go deeper, and the address shows them while a board or answer is open:

- **A course's board:** `ballkour.com/leaderboards/6`, and `ballkour.com/leaderboards/3/legacy` for a course's Legacy tab. The leaderboard bot links its posts this way, and older links with the course's name after the number (`/leaderboards/6-dorado`) still work. The Worker serves the page at these addresses.
- **The player ratings:** `ballkour.com/leaderboards/ratings`.
- **An FAQ answer:** `ballkour.com/faq/pausing`. The link names are in `FAQ_LINKS`, and older links that used the translation keys (`/faq/pause`) still work.
- **A run sent from the website:** `ballkour.com/runs/<id>`. Ballkyrie's post for it in the run submissions channel links here (see [Runs sent from the website](#runs-sent-from-the-website)), and `ballkour.com/runs` goes to the list of every one. The Worker serves the page at these addresses.
- **Your own stats:** `ballkour.com/stats` opens **My stats** for whoever opens it (signing them in with Discord first). The Worker serves the page here too.

The older `#6-dorado` and `#pause` forms still work too.
- **A language:** `ballkour.com/?lang=ja` opens the page in Japanese; it works with any of the links above. Picking a language puts it in the address.

## Previewing

```
python3 tools/serve.py
```

then open http://localhost:8000. It serves this folder at the site's own addresses (`/leaderboards/6`, `/faq/pausing`, `/runs/<id>`, …) with the live leaderboards from ballkour.com, so you see your changes with real data. Signing in and sending runs only work on the real site (or the test copy below), so the Submit section shows the Discord ticket and **My stats** is hidden.

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

- `/data/game.json`: the game repo's leaderboard files and in-game FAQ from `develop`, its runs and leaderboard history from `leaderboard-data`, plus the latest releases. Refreshed at most once a minute.
- `/data/widget.json`: the Discord server's member count and voice channels. Refreshed at most once a minute.
- `/code/game`, `/code/site` (or `/code/website`): redirect to the game's and this website's GitHub repos.
- `/releases`, `/releases/site` (or `/releases/website`): redirect to the game's and this website's release notes.

  Anything after these carries over, e.g. `/code/game/issues`. A release's own page is `/releases/v2026.10.14-0` or `/releases/site/v2026.11.02.6`, which Cloudflare redirects before the Worker sees it.
- `/data/players.json`: the Discord name and picture of every player whose run has a Discord ID, looked up with Ballkyrie's token. Refreshed at most once an hour.
- `/api/…`: signing in with Discord, and runs sent from the form under Submit a run. See [Runs sent from the website](#runs-sent-from-the-website). Also players' stats on their Discord profiles (see [Stats on Discord profiles](#stats-on-discord-profiles)), and players claiming their runs from before May 2026 (see [Claiming legacy runs](#claiming-legacy-runs)).

Each page also gets the latest copy of all three as it's served, with the "• N members" counts already filled in, so nothing pops in after the page loads. If GitHub or Discord can't be reached, the last copy that worked is served for up to a week.

It also sets the site's headers. The security headers, including the Content-Security-Policy, are in `SECURITY_HEADERS`; if you add an outside service to the page, add its address to the CSP there. Files in `assets/` are cached for a week, and everything else is checked for a newer copy on every visit.

It's deployed together with the site (see Deploying). It uses two secrets, which deploys keep. Set each once from the `cloudflare/` folder (it asks you to paste the value):

```
npx wrangler login
npx wrangler secret put DISCORD_BOT_TOKEN   # Ballkyrie's bot token, for the player names
npx wrangler secret put GITHUB_TOKEN        # optional: any GitHub token, for GitHub's higher rate limits
```

Resetting Ballkyrie's token in the Discord Developer Portal breaks the copy here too: the boards lose everyone's Discord name (except people who just sent a run from the site), the run log stops posting, and `npx wrangler tail` shows `Discord turned down DISCORD_BOT_TOKEN (401)`. Put the new token here and in the game repo's `DISCORD_BOT_TOKEN` secret, which the leaderboard bot uses. Paste just the token, without `Bot ` in front.

### Runs sent from the website

Players sign in with Discord (one click, no new account) and send their run from the form under Submit a run. It goes on the board straight away: the Worker saves it under their Discord ID in `leaderboards/runs.json` on the game repo's `leaderboard-data` branch, one commit per run (on its own branch, so these commits stay off `develop`). The site shows it at once, and the leaderboard bot posts the board on Discord and updates roles. A run is always the sender's own, whatever in-game name they type, so nobody can send one as someone else. Each Discord account can send 5 runs a minute (`SUBMIT_LIMIT` in `wrangler.toml`) and 20 a day.

**After sending**, the form shows what the run did: their place on the course and who they passed, their course rating, rating, place, and Top %, and any new top 10, podium, or record (the numbers on their Discord profile). A top 10 run that's waiting for a check shows the same, as what they'll get once it's approved.

**My stats** opens a signed-in player's own panel, the same one a click on their name on a board opens: their rating, place, Top % and every course, with Sign out in it too. It's by the language picker, next to Sign out, and under a run's result. Signed out, the one by the language picker signs them in with Discord first and comes back to the same page with `?me=1`, which opens it. It finds their runs by Discord ID, so runs saved under just an in-game name (the legacy runs from before May 2026) don't show there until they claim them (see [Claiming legacy runs](#claiming-legacy-runs)). `ballkour.com/stats` opens it too, and the address shows `/stats` while it's open, so it's easy to copy and share; closing it puts the address back.

**Every run gets its own page** at `ballkour.com/runs/<id>`, and Ballkyrie posts every run in the run submissions channel (`RUNS_CHANNEL` in `cloudflare/wrangler.toml`) with the player, time, mistakes, who sent it, where it would place or placed (its place on its course, and the player's place and rating in the player ratings: `Course: #1 of 12 • Global: #1 of 16 • ⭐ 1,818`), the video, and a **View run** button to its page. Ballkyrie needs to be able to see that channel, send messages, and embed links there. The post stays as it was sent, even after a run is checked.

A run's page shows the course, the player, the time and mistakes, where the run is now (on the board, waiting for a check, turned down, taken off, or not the player's best), and its video. YouTube, Twitch, and Streamable videos play right on the page, but nothing loads from those sites until someone presses play; other links get a button to the video. Under it is what the run did to the boards, in two tabs: **When sent** (worked out by the Worker as the run was sent, and kept in the `PROFILES` KV namespace so it never changes) and **Today** (worked out from today's boards, so it changes as other runs come in). For a run waiting for a check, **Today** is **If approved now**: what approving it would do right now. While nothing on the boards has changed since the run was sent, the two are the same, so the page shows them as one view and says so.

**Top 10 runs are checked first.** A run that would put its player on a course's top 10 waits in `"pending"` in `runs.json` instead of going on the board. On its page, moderators get **Approve** (it goes on the board, and the bot posts it) and **Turn down** (it goes into `"declined"`, so its page still says what happened). Both ask first (**Yes** or **Cancel**), so a stray click doesn't count. Every other run goes on the board straight away. Who can check runs is everyone on the server with a role in `REVIEWER_ROLES` in `cloudflare/wrangler.toml` (the mod role): role IDs, separated by commas.

Moderators also get **Runs to check** under the form at ballkour.com/submit: every run waiting, with what approving it would do (its place on the course, and the player's place and rating in the player ratings, as on its page), **View run**, **Approve**, and **Turn down**. Each checked run in `runs.json` keeps who checked it and when (`checkedBy` and `checkedAt`). Old `/submit?check=<id>` links, from the **Verify** buttons before runs had pages, open the run's page too.

**Everyone can see every run** under the form, in **Submitted runs** (`ballkour.com/runs`, and **All runs** on any run's page goes there too): newest first, with where each run is now, each opening its page. Moderators also see who checked each one there.

The runs from before the form (sent in a Discord ticket) are listed there too: every run on a board now, and on every board in `history.json`, once each. Legacy runs (no date or video) aren't. They have pages too, at `ballkour.com/runs/<course>-<code>`, where the code comes from the run's video, so the link stays the same. Since nothing was worked out when they were sent, their page only has **Today**.

To take a run off, move it from `"runs"` to `"removed"` in `runs.json` on `leaderboard-data` (see [Courses and leaderboards](#courses-and-leaderboards)).

To turn it on:

1. In Discord's Developer Portal, open Ballkyrie's application → OAuth2. Add `https://ballkour.com/api/login/callback` under Redirects, and copy the Client ID and Client Secret.
2. Make the GitHub App that saves the runs, at https://github.com/settings/apps/new:
   - **GitHub App name:** anything free, like `ballkour-com`. Runs are committed as its bot (`ballkour-com[bot]`).
   - **Homepage URL:** `https://ballkour.com`. Under **Webhook**, untick **Active**.
   - **Repository permissions → Contents:** Read and write.
   - **Where can this GitHub App be installed?** Only on this account.

   Then, on the app's page: copy its **App ID**, **Generate a private key** (it downloads a `.pem` file), and under **Install App**, install it on just `ballhallaa/ballkour`.
3. From the `cloudflare/` folder, save the secrets:

   ```
   npx wrangler secret put DISCORD_CLIENT_ID                  # the Client ID
   npx wrangler secret put DISCORD_CLIENT_SECRET              # the Client Secret
   npx wrangler secret put SESSION_SECRET                     # any long random string, e.g. from: openssl rand -base64 32
   npx wrangler secret put GITHUB_APP_ID                      # the App ID
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY < key.pem   # the .pem file (then delete it, or keep it somewhere safe)
   ```

Until those are set, the form stays hidden and the Discord ticket is the only way. (A `GITHUB_TOKEN` that can write the game repo works instead of the app, but then runs are committed as its owner.) The test copy needs its own secrets, and its `…workers.dev/api/login/callback` address added as a redirect too.

The remakes' in-game top 10s are part of the game, so they only change with a release. Before one, run `node tools/leaderboard-bot/game-boards.mjs` in the game repo: it prints the `lb[…]` and `lbRunInfo(…)` lines for every `.opy` file that's behind its board.

### Claiming legacy runs

The legacy boards (before May 2026) have runs under just an in-game name, with no Discord ID. On the site, each of those names is its own player: no Discord name or picture by it, nothing in anyone's My stats, and someone who still plays can show up twice in Find a player (rated, and again as Legacy).

Players can claim them. A legacy name's panel (click it on a legacy board) asks **Is this you?**, and **This is me** sends a claim to the moderators. Signed out, it signs them in with Discord first and comes back to the same page with that panel open again (`?claim=`, the name in URL-safe base64), so they can tap it there. After that, the panel says the claim is waiting for a moderator, or that it was turned down. A player's own panel (My stats) also points out legacy names that match a name they go by now: "Were you DVD before May 2026?"

Each claim waits in `"claims"` in `runs.json` on `leaderboard-data`, one per line:

```json
"claims": [
  {"name": "FLATO", "discord": "ID", "sentAt": "2026-11-09T01:44:31Z", "status": "pending"}
]
```

Ballkyrie posts every claim in the legacy claims channel (`CLAIMS_CHANNEL` in `cloudflare/wrangler.toml`) with who it's from, the legacy runs, the names they go by on the boards now, and a **Verify** button to ballkour.com/submit. Ballkyrie needs to be able to see that channel, send messages, and embed links there.

Moderators get **Legacy runs to check** under Runs to check there. Each claim shows the legacy runs, and who claimed them: their Discord name and picture, which open their Discord profile so a moderator can message them. Then come **View runs** (the name's panel), **Link**, and **Turn down**, which ask first like a run's. Legacy runs have no videos, so ask the player for proof on Discord before linking, like an old screenshot or clip. **Link** adds their Discord ID to every legacy run under that name in `history.json` that doesn't have one yet (the same as doing it by hand), and marks the claim `"approved"`. **Turn down** marks it `"declined"` and leaves the runs alone. That player can't claim the same name again from the site, so they'd open a ticket instead. Both keep who checked it and when (`checkedBy` and `checkedAt`).

A player can have at most 5 claims waiting at once. A name with no unlinked legacy runs left can't be claimed. To undo a link, take the `"discord"` off those runs in `history.json` by hand.

### Stats on Discord profiles

Players can show their Ballkour stats on their Discord profile, under **Apps**, the same way a linked game account shows there. **Show on my Discord profile** in their own panel (My stats) sends them to Discord, which asks if Ballkyrie can update their connection, and brings them back. It shows:

```
ballkour.com · Top 0.1%
DUCKLING · #3
8123 ⭐ Rating   4 ⚡ Top 10s   2 🏆 Podiums   1 👑 Records   12 🗺️ Courses run
```

The first line is their Top % (Rated for the bottom 10%), the second their in-game name and place in the player ratings. Discord allows only 5 numbers per app, whole numbers only, which is why Top % is in the text: 0.1 isn't a whole number. The numbers and their names are `PROFILE_FIELDS` in `cloudflare/worker.js`. Server owners can also use them for linked roles (Server Settings → Linked Roles), like a role for anyone with at least one top 10.

Everyone's stats catch up with the boards every 30 minutes (the cron in `cloudflare/wrangler.toml`), and a player's own stats update as soon as their run goes on a board. **Take them off** in the same panel removes them. So does removing Ballkyrie under Authorized Apps in Discord's settings.

**Show on my Discord profile** first opens a panel that explains it: a preview of the box with the player's own stats, what Discord's "Update your connection and metadata for this application" means, and what happens next. The box only shows on their profile once they also have the Discord Profile App linked role on our Discord server, so once their stats are on, their panel leads with how to get it. The Worker asks Discord whether they have the role (with Ballkyrie's bot token, looking the role up by that name once a day), and once they do, their panel just says their stats are on. It asks again when they come back to the site's tab, so finishing in Discord shows up without a reload. Discord can take a few minutes to show the box the first time.

Since November 2026, Discord has been hiding app boxes like this from profiles now and then, for every app, while still keeping the stats (reported to Discord's developer support). Until it's fixed, the panel and the explainer say so. Once Discord fixes it, set `DISCORD_FLAKY` in `index.html` to `false`.

They're worked out by `cloudflare/ratings.js`, a copy of the leaderboard bot's `ratings.mjs`, so the profile always agrees with the Top % roles.

To turn it on:

1. From the `cloudflare/` folder, make the KV namespace that keeps each player's Discord tokens (Discord only takes a player's stats with their own token):

   ```
   npx wrangler kv namespace create PROFILES
   ```

   and put the id it prints in `wrangler.toml`, in the `[[kv_namespaces]]` block for `PROFILES` (take the `#` off its three lines).
2. In Discord's Developer Portal, open Ballkyrie's application → General Information, and set **Linked Roles Verification URL** to `https://ballkour.com/api/profile`. Discord opens that when someone connects Ballkyrie from a server's Linked Roles.

It uses the sign-in's secrets and `DISCORD_BOT_TOKEN`, which tells Discord the numbers' names; no new secrets. Until the namespace is there, the button doesn't show.

## Fonts

The fonts in `assets/fonts` come from [Fontsource](https://fontsource.org) (the same files Google Fonts serves, split by script so a page only downloads what it uses): Barlow, Barlow Condensed, JetBrains Mono, and a flags-only cut of Noto Color Emoji for Windows, whose own emoji have no flags. Apple devices use their own emoji, and Linux and Android use a local Noto Color Emoji when there is one.

The emoji font has the flags of the course countries and of the other Overwatch maps' countries, plus 🎯 and 🌙. A course with a flag that isn't in it shows the flag's two letters on Windows; rebuild the font with that flag added, or ask Claude to.

## Courses and leaderboards

Course numbers, flags, codes and broken flags live in the `COURSES` list in the script at the bottom of `index.html`.

Leaderboards load live from the game repo's `develop` branch (through the Worker), so they update without a deploy:

- **Remakes (1–3):** `leaderboards/<n>-<slug>.opy`
- **Classic courses (4–15):** `leaderboards/<n>-<slug>.json` (the slugs are in `CLASSIC_FILES`)

The runs written into `COURSES` are only a fallback for when GitHub can't be reached.

Each course's board ranks every run in its file and in `"runs"` in `leaderboards/runs.json` on the `leaderboard-data` branch (runs sent from the website, and runs that never made a top 10), once each per player with their best run. A player is their Discord ID, or their in-game name on a run without one. The board shows the top 10, and **Show all** lists everyone else, including players who dropped out of the top 10, from the boards in `leaderboards/history.json` (on `leaderboard-data` too). To take a run off for good, delete it where it is (or move it, from `"runs"`) and add it to `"removed"`, so it doesn't come back from an old board:

```json
{
  "runs": { "1": [{ "name": "NAME", "discord": "ID", "time": "9:01.50", "mistakes": 3, "date": "2026-11-06", "video": "https://youtu.be/…" }] },
  "removed": { "1": [{ "name": "NAME", "discord": "ID", "time": "6:55.00" }] }
}
```

A run from an old board also only shows if it's slower than today's #10, since a faster one must have been taken off.

Runs sent from the website also have an `id` (for their page: numbers in the order they're saved, from 1, counted by `"lastId"` in `runs.json` so none is used twice) and `sentAt`, and `runs.json` keeps two more groups that are on no board: `"pending"` (waiting for a check) and `"declined"` (turned down). Moving a run's whole line to `"removed"` keeps its page working, and the page says it was taken off.

**Player ratings** (`ballkour.com/leaderboards/ratings`) rate everyone over every course. Each course is worth up to 10,000 points: the record gets all of them, and the further behind it a run is, the fewer it gets (10000 × ln(1 + (e − 1) × record ÷ time)², lucio.surf's curve for a player who has run every map). A rating is the average over every course that isn't broken, with 0 for courses a player hasn't run (courses nobody has run yet included), so a new or faster run never lowers it, and the first run on a course changes nobody else's rating. A player's Top % is their place divided by the number of rated players. The foot of the Player ratings board shows the course rating's and the rating's formulas (`rt.mathCourse` and `rt.mathRating` in `index.html`), with an example; reword them if the math changes.

Every board, and its picture, shows each player's rating beside their run's date. The newest board shows today's ratings. An older board from the history shows the ratings players had at the end of that board's day, worked out from the boards posted by then, so scrolling back shows how they stood at the time. A course's own rating, how close a run is to its record, is in the player's panel, by each course they've run.

The leaderboard bot posts the same boards and gives out the same Top % as roles on Discord (Top 0.1% to Top 90%, and Rated for everyone below, one each), with its own copy of the boards and ratings in `tools/leaderboard-bot/ratings.mjs` in the game repo. The stats on players' Discord profiles use a third copy, `cloudflare/ratings.js`. Change all three together.

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

In the FAQ, `<b>` marks the game's own labels (controls like Reset CP, HUD and lobby names like Runs and Lobby Top 3), which show in orange. Use each label as the game shows it in that language. A word in a `<fgRRGGBBAA>` tag keeps that color from the game's HUD instead (the modes Freemode in violet and Spectator or Spectate in blue, along with spectating and just the word spectator in spectator controls, disqualified in red, grayed out in gray, and (DISCONNECTED) in white), so keep those tags around the same words.
