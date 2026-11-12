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
tools/check.py           checks the scripts, settings, and translations (every pull request runs it)
cloudflare/              the Worker that serves the site, plus the GitHub and Discord data the page uses
.assetsignore            what isn't published: this README, tools/, the Worker's own code, …
_headers, _redirects     headers and redirects for the files Cloudflare serves without the Worker (assets/ and locales/)
.github/workflows/       checks every pull request, and deploys the site on every push to main
```

Keep everything out of `/discord`, `/gameplay`, `/code`, `/releases`, `/courses`, `/leaderboards`, `/submit`, `/features`, `/faq`, `/source-code`, `/translations`, `/runs`, `/stats`, `/profile`, `/my-stats`, `/players`, `/api`, and `/data`. Cloudflare redirects `/discord`, `/gameplay`, and `/releases/v*` and `/releases/site/v*` (to that release of the game or website on GitHub, which is where the version chips link), and the Worker redirects `/code/game` and `/code/site` (or `/code/website`) to the game's and this website's GitHub repos, and `/releases` and `/releases/site` (or `/releases/website`) to their release notes. Cloudflare rewrites the others (with or without a trailing slash) to the home page, which scrolls to that section; `/leaderboards` also opens Gibraltar's top 10.

Links can go deeper, and the address shows them while a board or answer is open:

- **A course's board:** `ballkour.com/leaderboards/6`, and `ballkour.com/leaderboards/3/legacy` for a course's Legacy tab. The leaderboard bot links its posts this way, and older links with the course's name after the number (`/leaderboards/6-dorado`) still work. Scrubbing back through a course's history puts that board's number in the address, counted from the oldest board (`ballkour.com/leaderboards/3/12`), so an older board's link stays the same as new boards come in. The newest board is just `/leaderboards/3`, and a number past the newest opens the newest. The Worker serves the page at these addresses.
- **The player ratings:** `ballkour.com/leaderboards/ratings`, which opens on the Global rating, with `/unassisted`, `/assisted`, and `/legacy` after it for the other tabs. The older `/leaderboards/ratings/global` still opens Global.
- **An FAQ answer:** `ballkour.com/faq/pausing`. The link names are in `FAQ_LINKS`, and older links that used the translation keys (`/faq/pause`) still work.
- **A run sent from the website:** `ballkour.com/runs/<id>`. Ballkyrie's post for it in the run submissions channel links here (see [Runs sent from the website](#runs-sent-from-the-website)), and `ballkour.com/runs` goes to the list of every one. The Worker serves the page at these addresses.
- **Your own stats:** `ballkour.com/profile` opens **My profile** for whoever opens it (signing them in with Discord first), and the address then shows their own player link (below). It was `/my-stats` until November 2026, which still works. The Worker serves the page here too.
- **The site's stats:** `ballkour.com/stats` goes to **Stats** at the bottom of the page, and `ballkour.com/stats/2026-11-05` to a day in its history, with `/day` or `/week` after it for just that day or the 7 days up to it (`/stats/week` for the last 7 days). The address follows what's picked while Stats is on screen (see [Stats](#stats)). The Worker serves the page at the longer ones.
- **A player's stats:** `ballkour.com/profile/<number>` opens that player's panel, or `/profile/<name>` once they've picked a name for their link (see [Players' own links](#players-own-links)). A name from the legacy boards with no Discord ID has `/profile/<in-game name>`. `/profile/<…>/runs` opens it on **Runs**. These were `/players/<…>` until November 2026, and those links still work (the address then shows the `/profile/` one). The address shows it while their panel is open (your own too, from My profile or your name on a board), and **Copy link** beside Close copies it, so anyone can share their stats. The Worker serves the page here too.

The older `#6-dorado` and `#pause` forms still work too.

A link to a run, a board, or a player shows its own preview when it's pasted on Discord (or anywhere else that reads a page's `og:` tags), instead of the site's: the run's player, time, course, and where it is now ("COLDSKIN · 4:05.81 on 1 🇬🇮 Watchpoint: Gibraltar", "#2 of 15 on the board · 2 mistakes · 2026-08-26"), a board's top 3, or a player's place, rating, and Top %. The Worker works them out as it serves the page (`previewOf()` in `cloudflare/worker.js`), in English like Ballkyrie's posts.
- **A language:** `ballkour.com/?lang=ja` opens the page in Japanese; it works with any of the links above. Picking a language, with the language button at the top right (by Reduce motion), puts it in the address.

## Reduce motion

The pause button at the top right turns Reduce motion on or off. It's lit up green while it's on. With it on, the background and the logo stop where they are, the hamster doesn't roll or throw balls, and the page doesn't animate or scroll smoothly. It starts out the way the device's own Reduce motion setting is, and the browser keeps what it's set to (`ballkour-motion` in localStorage), so it stays that way on every page, the 404 page too. Setting it back to match the device forgets it, so the site then follows the device again.

## Previewing

```
python3 tools/serve.py
```

then open http://localhost:8000. It serves this folder at the site's own addresses (`/leaderboards/6`, `/faq/pausing`, `/runs/<id>`, …) with the live leaderboards from ballkour.com, so you see your changes with real data. Signing in and sending runs only work on the real site (or the test copy below), so the Submit section shows the Discord ticket and **My profile** is hidden.

## Deploying

The site runs entirely on Cloudflare: the Worker in `cloudflare/` serves the files in this repo, so ballkour.com stays up even when the VPS is down.

Every push to `main` deploys through `.github/workflows/deploy.yml`, including merged Weblate pull requests. It can also be run by hand from the Actions tab. It runs `wrangler deploy` in `cloudflare/`, which publishes the Worker and the site's files together. Everything in the repo is published except what `.assetsignore` lists. It needs the `CLOUDFLARE_API_TOKEN` secret (from the "Edit Cloudflare Workers" token template, limited to ballkour.com) and the `CLOUDFLARE_ACCOUNT_ID` variable.

The workflow pins Wrangler to a 4.x version (`wranglerVersion`). The action's default is Wrangler 3, which ignores `run_worker_first` in `wrangler.toml`, and pages then go out without their data. When updating it, keep it at 4 or newer.

Every pull request, Weblate's too, gets checked first (`.github/workflows/check.yml`), and so does every deploy:

- `locales/en.json` matches `index.html`. After changing English text in `index.html`, run `python3 tools/extract-en.py` and commit `locales/en.json` along with it.
- The scripts in the pages and the Worker parse, so a typo can't take the page down (`python3 tools/check.py`, which also checks the rest).
- Every translation keeps English's `{placeholders}` and only uses the tags the site allows. A mistake there shows on the pull request; fix it in Weblate.
- The page, the Worker, and the leaderboard bot still work out the same boards, ratings, and Top % from the real boards (`node tools/check-ratings.mjs`). It also runs once a day, since the bot's copy lives in the game repo.

Run both before pushing, if you like:

```
python3 tools/extract-en.py --check
python3 tools/check.py
```

To try changes before merging, deploy a test copy from `cloudflare/`. It has no route and runs on workers.dev, built from your working folder:

```
npx wrangler deploy --env test
```

The test copy doesn't have the Worker's secrets, so player names and pictures are missing there. When you're done, delete it in the Cloudflare dashboard (Workers & Pages → ballkour-discord-widget-test → Settings). Don't use `wrangler delete` without `--env test`: that deletes the live site.

### The free plan's daily limit

Cloudflare's free plan allows 100,000 requests a day that run the Worker: pages and `/api/`, not the fonts, pictures, and translations. A first visit runs it about twice. Past the limit, the site shows an error until midnight UTC, so it's worth one rate limiting rule (the free plan gets one) to stop anyone from using it all up with a loop. In the Cloudflare dashboard, open ballkour.com, then **Security rules** → **Create rule** → **Rate limiting rules**:

- **If incoming requests match:** URI Path *contains* `/` (that's every request)
- **With the same characteristics:** IP (the only one on the free plan)
- **When rate exceeds:** 100 requests per 10 seconds
- **Then take action:** Block, for 10 seconds

Someone browsing never gets near 100 in 10 seconds (a first visit is about 13, fonts and pictures included), and a loop gets cut off in seconds.

## Cloudflare Worker

`cloudflare/worker.js` is a Cloudflare Worker on `ballkour.com/*` that serves the whole site: every request runs it first, and it hands out the site's own files along with the data below. The fonts, pictures, and translations (`assets/` and `locales/`) are the exception: Cloudflare serves them straight away (`run_worker_first` in `cloudflare/wrangler.toml`), with the headers in `_headers` and the redirects in `_redirects`. Visitors' browsers only ever talk to ballkour.com: the Worker fetches what the page needs from GitHub and Discord, caches it at Cloudflare and serves it from here. That keeps the site fast, keeps visitors' IPs away from GitHub and Discord, avoids GitHub's limits on anonymous requests, and works where GitHub and Discord are blocked.

- `/data/game.json`: the game repo's leaderboard files and in-game FAQ from `develop`, its runs and leaderboard history from `leaderboard-data`, plus the latest releases. Refreshed at most once a minute.
- `/data/widget.json`: the Discord server's member count and voice channels. Refreshed at most once a minute.
- `/code/game`, `/code/site` (or `/code/website`): redirect to the game's and this website's GitHub repos.
- `/releases`, `/releases/site` (or `/releases/website`): redirect to the game's and this website's release notes.

  Anything after these carries over, e.g. `/code/game/issues`. A release's own page is `/releases/v2026.10.14-0` or `/releases/site/v2026.11.02.6`, which Cloudflare redirects before the Worker sees it.
- `/data/players.json`: the Discord name and picture of every player whose run has a Discord ID, looked up with Ballkyrie's token. Each is looked up again about once an hour. A refresh only makes so many calls to Discord (Cloudflare's free plan allows 50 per request), so with lots of players it takes a few refreshes, minutes apart, players with no name yet first.
- `/api/…`: signing in with Discord, and runs sent from the form under Submit a run. See [Runs sent from the website](#runs-sent-from-the-website). Also players' stats on their Discord profiles (see [Stats on Discord profiles](#stats-on-discord-profiles)), players claiming their runs from before May 2026 (see [Claiming legacy runs](#claiming-legacy-runs)), the names players pick for their links (see [Players' own links](#players-own-links)), and the comments on runs' YouTube videos (see [YouTube comments](#youtube-comments)).

Each page also gets the latest copy of all three as it's served, with the "• N members" counts already filled in, so nothing pops in after the page loads. If GitHub or Discord can't be reached, the last copy that worked is served for up to a week.

It also sets the site's headers. The security headers are in `SECURITY_HEADERS`, and the Content-Security-Policy is `csp()`; if you add an outside service to the page, add its address to the CSP there. Every page gets a new nonce, which the Worker puts on the page's own inline scripts, and only scripts with it run, so even if a name or anything else ever got onto the page as HTML, a script in it wouldn't. Cloudflare's own bot check, which it adds to pages, copies the nonce from the header. Files in `assets/` are cached for a week, and everything else is checked for a newer copy on every visit. The files Cloudflare serves without the Worker get theirs from `_headers` instead: keep the two in step.

It's deployed together with the site (see Deploying). It uses these secrets, which deploys keep. Set each once from the `cloudflare/` folder (it asks you to paste the value):

```
npx wrangler login
npx wrangler secret put DISCORD_BOT_TOKEN   # Ballkyrie's bot token, for the player names
npx wrangler secret put GITHUB_TOKEN        # optional: any GitHub token, for GitHub's higher rate limits
npx wrangler secret put YOUTUBE_KEY         # optional: a YouTube API key, for the comments under YouTube videos (see YouTube comments)
```

Resetting Ballkyrie's token in the Discord Developer Portal breaks the copy here too: the boards lose everyone's Discord name (except people who just sent a run from the site), the run log stops posting, and `npx wrangler tail` shows `Discord turned down DISCORD_BOT_TOKEN (401)`. Put the new token here and in the game repo's `DISCORD_BOT_TOKEN` secret, which the leaderboard bot uses. Paste just the token, without `Bot ` in front.

### Runs sent from the website

Players sign in with Discord (one click, no new account) and send their run from the form under Submit a run. It goes on the board straight away (a top 10 run waits for a check first: see below): the Worker saves it under their Discord ID in `leaderboards/runs.json` on the game repo's `leaderboard-data` branch, one commit per run (on its own branch, so these commits stay off `develop`). The site shows it at once, and the leaderboard bot posts the board on Discord and updates roles. A run is always the sender's own, whatever in-game name they type, so nobody can send one as someone else. Each Discord account can send 5 runs a minute (`SUBMIT_LIMIT` in `wrangler.toml`) and 20 a day.

**Only top 10 runs need a video**, since a moderator checks those first (see below). Every other run can be sent with or without one. As the run is typed in, the form's video field says which it is: **Needed: this run would put you #4…** in gold, or **Optional: this run won't go in the top 10** (`videoRank()` in `index.html`), and it won't send a top 10 run without one. The Worker works it out again as the run is saved (`placeOf()` in `cloudflare/worker.js`) and turns down a top 10 run without a video, so the two have to agree. A link that's there has to be one, either way. Submit a run and the FAQ say so too. The FAQ's answers are read from the game, so the game repo's `src/engine/faq.opy` says it as well.

**After sending**, the form shows what the run did: their place on the course (of how many players), how long after their old best it came, their mistakes, their course rating, rating, place, and Top %, and any new top 10, podium, or record (the numbers on their Discord profile). A top 10 run that's waiting for a check shows the same, as what they'll get once it's approved.

**My profile** opens a signed-in player's own panel, the same one a click on their name on a board opens: their rating, place, Top % and every course, with Sign out in it too. In every player's panel, **Rating**, **Place**, and **Top %** open the Player ratings with their row marked (with Show all open when they're past the top 10), and **Runs** lists every run of theirs on one list, newest first, with **Back** to the rest. It sorts by time, mistakes, course rating, or date, like a board does (by time, mistakes, rating, or date: highest rating or newest first, with everyone on the board ranked again, as with mistakes. A board's rating is each player's rating over every course, the one beside their date, and Legacy boards, which have no ratings or dates, stay by time while either is picked). On both, pressing the sort that's on again turns it around (slowest, most mistakes, lowest rating, or oldest first), with an arrow on it showing which way it goes. The profile icon after Find a player, at the end of the section bar, opens it from anywhere on the page. It's also next to Sign out, and under a run's result. Under Join our Discord, a line says how to get the Top % role and the stats on your Discord profile, with My profile as a link to it. Signed out, the one in the section bar signs them in with Discord first and comes back to the same page with `?me=1`, which opens it. It finds their runs by Discord ID, so runs saved under just an in-game name (the legacy runs from before May 2026) don't show there until they claim them (see [Claiming legacy runs](#claiming-legacy-runs)). `ballkour.com/profile` opens it too (it was `/stats` until Stats took that link in November 2026, so older links to `/stats` open Stats now, and then `/my-stats`, which still works). While it's open, the address shows their own player link (`/profile/<number or name>`, or `/profile/<…>/runs` on Runs), so what's in the address works for anyone it's sent to. Signed out, the panel that signs them in shows `/my-stats`. Closing either puts the address back.

Under each course in a player's panel, its runs sort by time, mistakes, course rating, or date too, the same way Runs does: fastest first to start with, like the course's board, and whatever's picked holds for every course until the page is left (Runs keeps its own sort). The sort is there once a course has more than one run, with Rating only where the runs have a course rating and Date only where they have a date, so a course with just legacy runs has Time and Mistakes.

**Every run gets its own page** at `ballkour.com/runs/<id>`, and Ballkyrie posts every run in the run submissions channel (`RUNS_CHANNEL` in `cloudflare/wrangler.toml`). The post's title says what the run is, with the player's in-game name, and opens its page: **New record submission by …!**, **New podium submission** (#2 or #3), **New top 10 submission**, **New personal best** (their best on the course, past the top 10), or **New submission** (not their best). Under it are the course, who sent it, their in-game name, and a link to the video (**None** for a run sent without one). Then come three blocks side by side. **New personal best** is the run: its time, mistakes, course rating, the place it takes on the course (`Course rank: #1 of 15`), the player's rating, place, and Top % in the player ratings with it (`Unassisted rating: 91`, `Unassisted rank: #2 of 16`, and `Unassisted Top %: 25%`, or `Assisted …` for a run played in Assist Mode), and its date. **Old personal best** is the same for the player's best on the course before it, with their place, rating, place, and Top % in the ratings as they were. **Comparison** is what changed between the two: the time saved, the change in mistakes, course rating, and rating (`+6`), where they moved on the course and in the ratings (`#2 → #1`), their Top % before and after (`Unassisted Top %: 50% → 25%`), and how long after the old run it came (`3 months, 9 days`). A player's first run on a course has just the run, with what it changed in the same rows (`Unassisted rating: 137 (+91)`, `Unassisted rank: #10 → #2 of 16`, and `Unassisted Top %: 75% → 25%`): the player ratings are over every course, so a first run on one still moves a player who has run others. A run that isn't their best is **This run** beside **Personal best**, with how far behind it is: its course rating and place are the ones it would get on its own, and neither has anything from the player ratings, which it doesn't count toward. Under the blocks are **View run** (its page), **Board** (the course's), and **Profile** (the player's panel, at their own link). A top 10 run, which waits for a check, is in yellow, with its numbers as they'd be once it's approved and **Waiting for a check from moderators** at the bottom; every other run is in green. Discord shows the dates in each reader's own language and time zone, and a run from before the website's form only has its day. Ballkyrie needs to be able to see that channel, send messages, and embed links there. Once a moderator checks a top 10 run, its post turns green (approved) or red (turned down, with its title struck through), and the bottom line says who checked it and when (**Approved by …** or **Turned down by …**), the same as the run's page. Its numbers are worked out again then, the same as the player's DM, so the two always match and show where the run really landed, even when other runs went on the board while it waited (a record can become a podium). A turned-down run's blocks are **Turned-down run** (what it would have done) beside **Personal best** (their best, which it didn't replace). For that, the Worker keeps the post in the `PROFILES` KV namespace until the run is checked; without `PROFILES`, the post stays yellow.

When a run gives its player a new top 10, podium, or record, its blocks also have their **Top 10s**, **Podiums**, and **Records** (the numbers on their Discord profile, as the site shows them after a run): `Top 10s: 2` in the run's block, `Top 10s: 1` in their old best's, and `Top 10s: +1` in Comparison, or `Top 10s: 2 (+1)` on their first run on the course. **Courses run** shows the same way (`Courses run: 3 of 11 (+1)`) when it goes up. Once the run is on the board, **New role** under the blocks names the roles on our Discord it gives them, when it changes their Top %: one for the ratings of its kind (`Top 10% (Unassisted)`, or `(Assisted)` for an assisted run) and one for the Global rating (`Top 10% (Global)`). The DM to the player has them too.

A run's page shows the course, the player, the time and mistakes, where the run is now (on the board, waiting for a check, turned down, taken off, or not the player's best), and its video, or that it has none (**No video. Only top 10 runs need one.**). YouTube, Twitch, Streamable, and Medal videos play right on the page, but nothing loads from those sites until someone presses play; other links get a button to the video. Under it is what the run did to the boards, in two tabs: **When sent** (worked out by the Worker as the run was sent, and kept in the `PROFILES` KV namespace so it never changes) and **Today** (worked out from today's boards, so it changes as other runs come in). For a run waiting for a check, **Today** is **If approved now**: what approving it would do right now. While nothing on the boards has changed since the run was sent, the two are the same, so the page shows them as one view and says so. The course's name, over the player's and on its row under the tabs, opens the course's board, and the player's name opens their panel at that course. So does **Runs on this course**, while **Runs on all courses** opens it on **Runs**, every run of theirs on one list.

**Top 10 runs are checked first.** A run that would put its player on a course's top 10 (their new best, with fewer than 10 other players faster) waits in `"pending"` in `runs.json` instead of going on the board, which is why it needs a video. On its page, moderators get **Approve** (it goes on the board, and the bot posts it) and **Turn down** (it goes into `"declined"`, so its page still says what happened). Both ask first (**Yes** or **Cancel**), so a stray click doesn't count, and either way Ballkyrie tells the player in a DM (`NOTIFY_PLAYERS` in `cloudflare/wrangler.toml`; someone who doesn't take DMs from server members just doesn't get one). It has the same three blocks as the run's post (worked out once, as the run is checked, for both), who checked it and when, and the post's **View run**, **Board**, and **Profile** buttons. A turned-down run's DM links to the ticket channel on our Discord, for anyone who thinks it's a mistake. Every other run goes on the board straight away. Who can check runs is everyone on the server with a role in `REVIEWER_ROLES` in `cloudflare/wrangler.toml` (the mod role): role IDs, separated by commas. Nobody checks their own run: a moderator's own top 10 run waits for another moderator, and its row says so in place of the buttons.

Moderators also get **Runs to check** over Submitted runs at ballkour.com/runs: every run waiting, with what approving it would do (its place on the course, and the player's place and rating in the player ratings, with what it would add, as on its page), **View run**, **Approve**, and **Turn down**. Each checked run in `runs.json` keeps who checked it and when (`checkedBy` and `checkedAt`). Old `/submit?check=<id>` links, from the **Verify** buttons before runs had pages, open the run's page too.

**Everyone can see every run** over the form, in **Submitted runs** (`ballkour.com/runs`, which has its own link in the section bar, between Leaderboards and Submit a run, and **All runs** on any run's page goes there too), with where each run is now and its course rating, each opening its page. Its search box, like a board's, finds a player's runs by their in-game or Discord name (capitals and accents don't matter), and the number by its title counts the runs it finds. While the list is longer than the screen, ↑ and ↓ ride along at the bottom right of the screen, down to **Show more** at its end: ↑ goes back to its top (the search and sort), and ↓ to its end. It's newest first to start with, and sorts by time, mistakes, course rating, or date, like a player's **Runs**: fastest first (whatever the course), fewest mistakes first (then fastest), highest course rating first, or newest first, and pressing the sort that's on again turns it around. A course rating is what the time is worth on its course against today's record, up to 1000, and for a run waiting for a check, what it would be if it's approved. Runs that were turned down or taken off, and runs on broken courses, have none, and go last when sorted by rating. Moderators also see who checked each one there.

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

The legacy boards (before May 2026) have runs under just an in-game name, with no Discord ID. On the site, each of those names is its own player: no Discord name or picture by it, nothing in anyone's My profile, and someone who still plays can show up twice in Find a player (on Global, and again on Legacy).

Players can claim them. A legacy name's panel (click it on a legacy board) asks **Is this you?**, and **This is me** sends a claim to the moderators. Signed out, it signs them in with Discord first and comes back to the same page with that panel open again (`?claim=`, the name in URL-safe base64), so they can tap it there. After that, the panel says the claim is waiting for a moderator, or that it was turned down. A player's own panel (My profile) also points out legacy names that match a name they go by now: "Were you DVD before May 2026?"

Each claim waits in `"claims"` in `runs.json` on `leaderboard-data`, one per line:

```json
"claims": [
  {"name": "FLATO", "discord": "ID", "sentAt": "2026-11-09T01:44:31Z", "status": "pending"}
]
```

Ballkyrie posts every claim in the legacy claims channel (`CLAIMS_CHANNEL` in `cloudflare/wrangler.toml`) with who it's from, the legacy runs, the names they go by on the boards now, and a **Verify** button to ballkour.com/submit. Ballkyrie needs to be able to see that channel, send messages, and embed links there.

Moderators get **Legacy runs to check** under Runs to check there (a moderator's own claim waits for another moderator, like their runs). Each claim shows the legacy runs, and who claimed them: their Discord name and picture, which open their Discord profile so a moderator can message them. Then come **View runs** (the name's panel), **Link**, and **Turn down**, which ask first like a run's. Legacy runs have no videos, so ask the player for proof on Discord before linking, like an old screenshot or clip. **Link** adds their Discord ID to every legacy run under that name in `history.json` that doesn't have one yet (the same as doing it by hand), and marks the claim `"approved"`. **Turn down** marks it `"declined"` and leaves the runs alone. That player can't claim the same name again from the site, so they'd open a ticket instead. Both keep who checked it and when (`checkedBy` and `checkedAt`), and Ballkyrie tells the player in a DM, like for a run. A turned-down claim's DM links to the ticket channel on our Discord, for sending proof.

A player can have at most 5 claims waiting at once. A name with no unlinked legacy runs left can't be claimed. To undo a link, take the `"discord"` off those runs in `history.json` by hand.

### Players' own links

Every player's panel has a short link, `ballkour.com/profile/<number>` (`/players/<number>` until November 2026, which still works). Numbers start at 1, in the order players first ran a course: runs with no date (the legacy ones, from before May 2026) count first, then by date, and players who started on the same day go by how old their Discord account is. New players get the next number. **Picture**, by Copy link in every player's panel, draws their stats as a picture to save, copy, or share, the way a board's Picture does: their rating, place, Top %, Top 10s, Podiums, and Records, every course with their best run there, and their link. Like a board's, its words are in the site's language, or in another one picked with the language button by Save, which changes just the picture.

In their own panel (My profile), **Your link** shows theirs, and **Pick a name** lets them choose one instead: `ballkour.com/profile/<name>`. **Change** picks another, and **Use my number ID** goes back to the number, which it shows in parentheses (**Use my number ID (8)**). A name is up to 32 letters or numbers in any language (the same as an in-game name on the run form), plus `-` and `_`, with at least one letter, so a name can never be confused with a number. Nobody else can have the same name (capitals and wide letters like `ｂａｌｌ` count as the same), or pick another player's in-game name or Discord name, or a name that looks official (`NOT_LINKS` in `worker.js`). Each Discord account can change it 5 times a minute (`SUBMIT_LIMIT`). Moderators see **Remove the name** in anyone else's panel whose link has one, which puts that player back on their number.

Both are kept in `links.json` on the game repo's `leaderboard-data` branch, one player per line:

```json
{
  "last": 16,
  "players": {
    "175372497720573953": {"n": 1, "link": "ball"},
    "206866465025032193": {"n": 2}
  }
}
```

It's at the top of the branch, not in `leaderboards/`, so that a player changing their name doesn't start the leaderboard bot (its workflow there runs on every change to `leaderboards/**`). The Worker gives out numbers every half hour, at :15 and :45 (the second cron in `wrangler.toml`), to everyone with runs who doesn't have one yet, and right away to a player who picks a name. Until then, a new player's link is `/profile/<Discord ID>`, which opens their panel too. `"last"` is the highest number given out, so a number is never used twice, even if someone's line is deleted. To take a name off by hand, delete its `"link"`.

Old links keep working: `/profile/<Discord ID>` and `/profile/<in-game name>` (or with `/players/`) still open the panel, and the address then switches to the player's number or name. A number nobody has opens Find a player.

### Stats on Discord profiles

Players can show their Ballkour stats on their Discord profile, under **Apps**, the same way a linked game account shows there. **Show on my Discord profile** in their own panel (My profile) sends them to Discord, which asks if Ballkyrie can update their connection, and brings them back. It shows:

```
ballkour.com · Top 0.1%
DUCKLING · #3
812 ⭐ Rating   4 ⚡ Top 10s   2 🏆 Podiums   1 👑 Records   12 🗺️ Courses run
```

The first line is their Top % (Rated for the bottom 10%), the second their in-game name and place. Their rating, place, and Top % are the Global rating's (the unassisted and assisted ratings added up), the one the Global roles on our Discord server go by. Discord allows only 5 numbers per app, whole numbers only, which is why Top % is in the text: 0.1 isn't a whole number. The numbers and their names are `PROFILE_FIELDS` in `cloudflare/worker.js`. Server owners can also use them for linked roles (Server Settings → Linked Roles), like a role for anyone with at least one top 10.

Everyone's stats catch up with the boards every 30 minutes (the cron in `cloudflare/wrangler.toml`), and a player's own stats update as soon as their run goes on a board. Each update stays within Cloudflare's limit of 50 calls, so after a new record (which changes everyone's rating) it can take a few updates to reach everyone. **Take them off** in the same panel removes them. So does removing Ballkyrie under Authorized Apps in Discord's settings.

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

### Stats

**Stats**, at the very bottom of the page and last in the section bar, is for everyone. Its menu at the top picks which days it covers: a day, the 7 or 30 days up to it (30 to start with), or the 3, 6, or 12 months up to it (from the day after the same date that many months before, so the 3 months up to November 10 start on August 11). Their links end in `/3-months`, `/6-months`, or `/12-months` like `/week` (`/stats/3-months`, `/stats/2026-11-05/6-months`). With today picked, its options say Today, Last 7 days, and so on, and with another day, Day, 7 days, and so on. Beside it (or under it on a phone) are the dates the one picked covers (2026-10-12 to 2026-11-10). The month menu, beside the Runs and Page views headings (so it's there on a phone without going back up), jumps to a month, picking its last day (or today, for this month). Under the menu are two parts, **Runs** and then **Page views**, each with a bar for every day, 30 at a time. Clicking a bar picks its day, and so do the arrows beside the bars (and ←, →, Home, End, Page Up, and Page Down on a bar). Going past the first or last bar slides the 30 days along. Both parts follow the same pick, and the address follows it too (see the links above), so a link shows the same days. Days are UTC days, midnight to midnight.

- **Runs:** the runs sent (from the website, by when they were sent, and the ones from before it by their date), the rating they gained, and the new top 10 times and records, a bar for each day's runs sent, and under that, the new podiums, new players (whose first run it was), the players rated at the end of the day picked, their total global rating (everyone's rating added up) and total course rating (every course rating they had, added up) at the end of it, how much each of those two totals went up or down over the days picked, and the course with the most runs. Rating gained adds up how much each run raised its player's rating, the number in parentheses beside it on the boards: each player who got faster on a rated course that day gains their new course rating, less what their old best had against the record without their new run, over the number of rated courses. The two changes count everyone instead, so they also take off what other players lose when someone beats a record (a faster record lowers everyone else's course rating there), and they can go down. The page works all of these out from the same files as the boards, so they need nothing from the Worker.
- **What makes up each number:** each box and row under Runs opens a list in a panel of what makes up its number, with that number by its name. The runs ones (Submitted runs, Rating gained with what each run added, Top 10s and Podiums with each run's place, Records, New players with each one's first run, and Most runs) list the runs, each opening its page. The ratings ones (Rated players and the two totals as they were at the end of the day picked, and the two changes with how far each player went up or down) list the players, each opening their panel. A run's page or a player's panel opened from a list has Back to it at the top, until the panel closes.
- **Page views:** how many people opened the site, and how many times, a bar for each day, and the most viewed sections (the top of the page, the boards, runs, profiles, and so on, never which player or run), each with its views. Profiles counts opening the site at My profile or anyone's profile link (`/profile` or `/profile/<…>`, and the older `/my-stats` and `/players/<…>`), not opening a profile on the page. Like the list under Runs, each row goes to its section when pressed (Profiles opens My profile), apart from Other. A person counts once a day, so over a week someone who came on three days counts three times. Days from before page views were counted show "—", with a line saying when counting started. Page views start on November 10, 2026. They were first counted on November 9, but each section's people (counted until November 2026) only from partway through it, so that day was hidden. The Worker still keeps it but doesn't show it (`FIRST_VIEW_DAY` in `cloudflare/worker.js`).

Page views are counted by the site itself, so they're closer to the truth than Cloudflare's Web Analytics, which samples and which ad blockers stop. Each time someone opens the site, the page asks the Worker who's signed in (`/api/me`), and the Worker counts that. Bots that only fetch the page never ask, so they don't count. People are counted once a day each: a visitor is a code made from their IP address, their browser, and a random key that's made new every day and deleted after it, so the site never keeps who anyone is, and only today's codes are kept at all.

The counts are kept in a Durable Object (`PageViews` in `cloudflare/worker.js`, a small database the Worker owns, `PAGE_VIEWS` in `cloudflare/wrangler.toml`), which a deploy sets up on its own. The free plan allows 100,000 writes a day there, and each page view takes two or three, so it's good for about 33,000 page views a day. The page asks for them (`/api/visits`) as it opens, and each of Cloudflare's data centers keeps one copy for a minute, so the database is asked at most once a minute per data center, however many people open the site. The test copy doesn't count anything.

### YouTube comments

The window a run's time opens (see [Courses and leaderboards](#courses-and-leaderboards)) lists the comments on a YouTube video under it: the first 20, the ones YouTube shows first, with who wrote each one (linked to their channel), when, its likes, and how many replies it has, then a link to all of them on YouTube. Comments can be turned off on a video, and the window says so. Twitch, Streamable, and Medal videos don't get any.

The Worker gets them from YouTube's Data API (`/api/comments?v=<video id>`, see "YouTube comments" in `cloudflare/worker.js`), so visitors' browsers never talk to YouTube for them. It only does that for the videos of runs on the site, and keeps each video's comments for 6 hours, so the API's free daily allowance (10,000 units, 2 for each video) is plenty. If YouTube can't be reached, the last copy is shown for up to a week. They're shown as YouTube has them, without anyone checking them first, as text only (no profile pictures, and links in them aren't clickable).

It needs an API key, set once as the Worker's `YOUTUBE_KEY` secret. Without it, the window has no comments.

1. In the [Google Cloud console](https://console.cloud.google.com/), make a project (any name), then go to **APIs & Services → Library**, find **YouTube Data API v3**, and turn it on.
2. Go to **APIs & Services → Credentials**, then **Create credentials → API key**. Edit the key: under **API restrictions**, pick **Restrict key** and tick only **YouTube Data API v3**. Leave **Application restrictions** at None, since the Worker calls YouTube from Cloudflare's servers, not from a website.
3. From the `cloudflare/` folder: `npx wrangler secret put YOUTUBE_KEY`, and paste the key.

## Fonts

The fonts in `assets/fonts` come from [Fontsource](https://fontsource.org) (the same files Google Fonts serves, split by script so a page only downloads what it uses): Barlow, Barlow Condensed, Exo 2 (only for the BALLKOUR wordmark, so just its Latin letters), JetBrains Mono, and a flags-only cut of Noto Color Emoji for Windows, whose own emoji have no flags. Apple devices use their own emoji, and Linux and Android use a local Noto Color Emoji when there is one.

The emoji font has the flags of the course countries and of the other Overwatch maps' countries, plus 🎯 and 🌙. A course with a flag that isn't in it shows the flag's two letters on Windows; rebuild the font with that flag added, or ask Claude to.

## Courses and leaderboards

Course numbers, flags, and codes live in the `COURSES` list in the script at the bottom of `index.html`. Which courses are broken comes from `tools/leaderboard-bot/courses.json` in the game repo (`"broken": true`), through the Worker, so marking a course broken there, or fixing it, does it on the site too, along with the boards, the ratings, and the form. For a remake, broken means its latest code: its Beta code still works, so it can still be run and sent. The broken flags in `COURSES` are only for when the game data can't be loaded. The Worker turns away runs on a broken course (other than a remake), like the form.

Leaderboards load live from the game repo's `develop` branch (through the Worker), so they update without a deploy:

- **Remakes (1–3):** `leaderboards/<n>-<slug>.opy`
- **Classic courses (4–15):** `leaderboards/<n>-<slug>.json` (the slugs are in `CLASSIC_FILES`)

The runs written into `COURSES` are only a fallback for when GitHub can't be reached.

Each course's board ranks every run in its file and in `"runs"` in `leaderboards/runs.json` on the `leaderboard-data` branch (runs sent from the website, and runs that never made a top 10), once each per player with their best run. A player is their Discord ID, or their in-game name on a run without one. The board shows the top 10, and **Show all** lists everyone else, including players who dropped out of the top 10, from the boards in `leaderboards/history.json` (on `leaderboard-data` too). An older board from the history shows its top 10 as it was posted, and its **Show all** lists everyone else with a run sent by that board's day. To take a run off for good, delete it where it is (or move it, from `"runs"`) and add it to `"removed"`, so it doesn't come back from an old board:

```json
{
  "runs": { "1": [{ "name": "NAME", "discord": "ID", "time": "9:01.50", "mistakes": 3, "date": "2026-11-06", "video": "https://youtu.be/…" }] },
  "removed": { "1": [{ "name": "NAME", "discord": "ID", "time": "6:55.00" }] }
}
```

A run from an old board also only shows if it's slower than today's #10, since a faster one must have been taken off.

Runs sent from the website also have an `id` (for their page: numbers in the order they're saved, from 1, counted by `"lastId"` in `runs.json` so none is used twice) and `sentAt`, and `runs.json` keeps two more groups that are on no board: `"pending"` (waiting for a check) and `"declined"` (turned down). Moving a run's whole line to `"removed"` keeps its page working, and the page says it was taken off.

**Player ratings** (`ballkour.com/leaderboards/ratings`) rate everyone over every course. Each course is worth up to 1,000 points: the record gets all of them, and the further behind it a run is, the fewer it gets (1000 × ln(1 + (e − 1) × record ÷ time)², lucio.surf's curve for a player who has run every map, at a tenth of its 10,000, so the numbers stay short). Until November 2026 it was 10,000: what a run did when it was sent, kept from before then, is shown at a tenth too. A rating is the average over every course that isn't broken, with 0 for courses a player hasn't run (courses nobody has run yet included), so a new or faster run never lowers it, and the first run on a course changes nobody else's rating. A player's Top % is their place divided by the number of rated players. The foot of the Player ratings board shows the course rating's and the rating's formulas (`rt.mathCourse` and `rt.mathRating` in `index.html`), with an example; reword them if the math changes.

Every board, and its picture, shows each player's rating beside their run's date, and what the run adds to it in parentheses, the same as on the run's page and under Submitted runs: their rating with it, less what it would be if their next-fastest run on that course counted instead (`★ 86 (+10)`). A run that's the record can add nothing when the player's next run would still be the record. A broken course isn't rated, so its runs show the rating alone. The newest board shows today's ratings. An older board from the history shows the ratings players had at the end of that board's day, worked out from the boards posted by then, so scrolling back shows how they stood at the time. A course's own rating, how close a run is to its record, is in the player's panel, by each course they've run, and in their picture. Their best run on each course shows what it adds to that course's rating the same way (`★ 941 (+108)`). On a phone, the date goes under the rating on the boards.

A run's time, on the boards and in a player's panel, links to its video, if it has one. Clicking it plays a YouTube, Twitch, Streamable, or Medal video right on the site, in a window over the page, with a link to watch it on that site instead. The course's name at the top of the window opens its board, closing the window. Nothing loads from those sites until the time is clicked, and closing the window stops the video. Other links, and Ctrl/Cmd or middle clicks, open the video in a new tab. A YouTube video's comments are listed under it (see [YouTube comments](#youtube-comments)).

A player's Discord name, under their in-game name on the boards, in their panel, and on a run's page, links to their profile on Discord (`discord.com/users/<id>`, which opens the Discord app where it's installed). In Find a player it doesn't, since each row there is what's clicked to pick the player.

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

Each page comes with the visitor's translation already in it, so it draws in their language from the start instead of in English first. The Worker picks the language the same way the page does: the one `?lang=` asks for, or else the one they last picked on the site (the `bk_lang` cookie, which the page sets when they pick one), or else the first of their browser's languages the site has. The preview (`tools/serve.py`) doesn't do this, so there the page still switches from English once the translation loads.

Translations may use `<b>` and `<code>` only. Anything else shows up as text. Keep `{placeholders}` as they are.

In the FAQ, `<b>` marks the game's own labels (controls like Reset CP, HUD and lobby names like Runs and Lobby Top 3), which show in orange. Use each label as the game shows it in that language. A word in a `<fgRRGGBBAA>` tag keeps that color from the game's HUD instead (the modes Freemode in violet and Spectator or Spectate in blue, along with spectating and just the word spectator in spectator controls, disqualified in red, grayed out in gray, and (DISCONNECTED) in white), so keep those tags around the same words.
