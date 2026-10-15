# Football Tracker — Repo Guide

This document explains how the site works end to end: which script produces which
data file, how often each one runs, how `index.html` consumes them, and what
needs to change manually at the start of every new season.

> **Keep this file current.** Every change to a script, workflow, filter,
> schedule or data format should update this README in the same commit. If the
> README and the code disagree, the code wins — fix the README.

---

## 1. High-level architecture

```
GitHub Actions (scheduled)          output/*.json (committed to repo)         index.html (static site)
──────────────────────────    →     ──────────────────────────────    →      ──────────────────────
fetch_all_leagues.js                output/all_leagues.json                  fetch()'d on page load,
fetch_match_statistics.js           output/match_statistics.json             combined client-side into
fetch_head2head.js                  output/head2head.json                    the match cards, standings,
youtube_web_scraper.py              output/highlights_database.json          history tab, and video tabs
fetch_soccer_news.py                output/soccer_news.json
```

There is **no backend/server**. Everything is a static `index.html` that does
`fetch('output/....json')` on load and renders client-side. All the "real work"
(hitting the football-data.org API, scraping YouTube, scraping RSS) happens in
GitHub Actions on a schedule, and the resulting JSON files are committed
straight into the repo. The site is just reading whatever JSON is currently
sitting in `output/`.

The site is served by **GitHub Pages** from the `main` branch; the custom
domain `soccer-highlights.org` is set by the `CNAME` file. Every bot commit
triggers a `pages build and deployment` run that republishes the site.

### Repo map

| Path | What it is |
|---|---|
| `index.html` | The entire website (HTML + CSS + JS in one file) |
| `fetch_all_leagues.js` | Fixtures/results for every league → `all_leagues.json` (source of truth) |
| `fetch_match_statistics.js` | Box-score detail for finished matches → `match_statistics.json` |
| `fetch_head2head.js` | Head-to-head history for upcoming matches → `head2head.json` |
| `youtube_web_scraper.py` | Finds YouTube highlight video IDs → `highlights_database.json` |
| `fetch_soccer_news.py` | News articles from 101greatgoals RSS → `soccer_news.json` |
| `.github/workflows/*.yml` | The five scheduled jobs (§2) |
| `output/` | All generated data, committed by the bots |
| `output/{pl,pd,bl1,sa,fl1,ppl,ded,cl}.json` | Per-league copies written by `fetch_all_leagues.js`; not read by the site |
| `output/bsa.json` | Stale leftover from when Brazil's Série A was tracked (now commented out); nothing reads or updates it |
| `CNAME` | Custom domain for GitHub Pages |
| `soccer_highlights_design.png` | Design mock-up, not used by the site |

### Secrets

| Secret | Used by |
|---|---|
| `FOOTBALL_API_KEY` | football-data.org API key. Passed to `fetch_all_leagues.js` (the workflow `sed`s it into the script's working copy at run time) and `fetch_head2head.js` (read from the environment). **`fetch_match_statistics.js` ignores it and uses a key hard-coded in the file** — see §6. |
| `GITHUB_TOKEN` | Built in; lets each workflow push its commit |

---

## 2. The five data pipelines

All cron times in the workflows are **UTC**. `12-23,0-2` UTC is roughly
8am–11pm US Eastern in summer (EDT) and 7am–10pm in winter (EST).

| Workflow file | Script | Schedule (UTC) | Manual trigger |
|---|---|---|---|
| `update-data.yml` | `fetch_all_leagues.js` | Every 10 min (:00, :10, …), hours 12–23 and 0–2; also on every push to `main` | Yes |
| `fetch_statistics_workflow.yml` | `fetch_match_statistics.js` | Every 10 min (:06, :16, …), hours 12–23 and 0–2 | Yes, with `fetch_all` (backfill) |
| `fetch_head2head_workflow.yml` | `fetch_head2head.js` | Every 5 min, 11:00–11:55 | Yes, with `fetch_all` (backfill) |
| `update-highlights.yml` | `youtube_web_scraper.py` | Every 10 min (:03, :13, …), hours 12–23 and 0–2 | Yes, with `backfill` |
| `fetch_soccer_news_workflow.yml` | `fetch_soccer_news.py` | Every hour, all day | Yes |

GitHub delays and sometimes skips scheduled runs at busy times, so real
intervals are often longer than the cron says.

Manual triggers from the command line:
```bash
gh workflow run update-highlights.yml -f backfill=true
gh workflow run fetch_statistics_workflow.yml -f fetch_all=true
gh workflow run fetch_head2head_workflow.yml -f fetch_all=true
gh workflow run update-data.yml
gh workflow run fetch_soccer_news_workflow.yml
```

### 2.1 `fetch_all_leagues.js` → `output/all_leagues.json`
**This is the source-of-truth file everything else depends on.**

- Hits `GET /v4/competitions/{code}/matches?season={SEASON}` for every league
  in the `leagues` array (PL, PD, BL1, SA, FL1, PPL, DED, CL), 2 seconds apart
  to stay within the free-tier rate limit.
- Fully **overwrites** `all_leagues.json` every run — nothing accumulates here,
  it's always a fresh snapshot of the current season's full fixture list
  (past results + upcoming fixtures) for every tracked league.
- Output shape: `{ "PL": { "name", "country", "matches": [...] }, ... }`.
  If a league's request fails, that league is simply missing from the file
  for that run.
- Also writes one file per league (`output/pl.json`, `output/pd.json`, etc.) —
  not used by `index.html`, just per-league debug/inspection copies.

### 2.2 `fetch_match_statistics.js` → `output/match_statistics.json`
- Reads `all_leagues.json`, finds matches finished in the **last 72 hours**
  (today + yesterday + the day before — wide enough to reliably catch
  midweek Champions League matches even if the workflow has a gap).
- For each finished match, calls `/v4/matches/{id}` with the `X-Unfold-*`
  headers to pull full box-score data (goals, bookings, subs, lineups, refs).
- Output shape: `{ "PL": { "<matchId>": {...match detail...} }, ... }`.
- **Accumulates** — keyed by match ID, never wiped. Matches in the 72h window
  are always re-fetched in normal mode (to catch stat corrections), but
  nothing is deleted just because it wasn't in the window this run.
- **Auto-prunes on every run:** before fetching, deletes any stored match ID
  that's no longer present in the current `all_leagues.json`. Since
  `all_leagues.json` is fully replaced each season, stats from a season
  you've moved past get cleared out automatically.
- `--all` flag = backfill mode: fetches every FINISHED match that doesn't
  have stats yet, ignoring the 72h window.
- `LEAGUES_TO_PROCESS` at the top of the file lets you switch individual
  leagues off.

### 2.3 `fetch_head2head.js` → `output/head2head.json`
- Reads `all_leagues.json`, finds matches kicking off in the **next 21 days**.
- For each such match, calls `/v4/matches/{id}/head2head?limit=50` — this
  returns the **full historical head-to-head record** between the two teams
  (up to 50 past meetings, across seasons).
- **Keyed by match ID** (the upcoming fixture's ID). The same two teams
  playing again later gets a new fetch under a new key.
- Only fetches matches whose key **doesn't already exist** — once a fixture
  has h2h data, it's never re-fetched.
- **Auto-prunes on every run:** deletes any stored match ID no longer present
  in the current `all_leagues.json`, so the file only ever holds the current
  season's fixtures.
- `--all` flag = backfill mode: fetches h2h for any **past** match missing
  data, ignoring the 21-day window.
- Exits with an error if `FOOTBALL_API_KEY` is not set.

### 2.4 `youtube_web_scraper.py` → `output/highlights_database.json`

**How it searches**
- Reads `all_leagues.json`, takes matches that are finished (2+ hours past
  kickoff, or `status == FINISHED`).
- Opens YouTube search in headless Chrome (Selenium; no API key needed) for
  `"{HomeTeam}-{AwayTeam}-{YYYY-MM-DD} highlights {broadcaster}"`. Team names
  are Unicode-normalized first (accents stripped, `ø`→`o`, etc.) so names like
  *Bodø/Glimt* search correctly.
- Looks at the **top 20 results**, rejects anything failing the filters below,
  then keeps the **5 most-viewed** survivors.

**Filters (applied in this order; a video must pass all of them)**

1. **Blocked words in the title** (all leagues): `simulation`, `simulacion`,
   `live`, `directo`, `vivo`, `audio` (whole words), or a standalone
   upper-case `HD`.
2. **League rules:**

   | League | Search term added | Rule |
   |---|---|---|
   | Premier League (PL) | `NBC Sports` | Title must contain `NBC Sports` **and** `Premier League Highlights` (rejects NBC's single-goal clips) |
   | La Liga (PD) | `ESPN` | Channel URL must start with `/@espn` (any ESPN channel); titles containing `LaLiga EA Sports` are rejected (official channel blocks embedding) |
   | Serie A (SA) | `CBS Sports Golazo` | Title must contain `CBS Sports Golazo` **or** `CBS Golazo` (uploads seen since Oct 2026 use the short name; older ones the long one) |
   | Champions League (CL) | `CBS Sports` | Title must contain `CBS Sports` |
   | Ligue 1 (FL1) | `beIN SPORTS USA` | Title must contain `beIN SPORTS USA` |
   | Bundesliga (BL1) | `Bundesliga` | Channel URL must contain `/@bundesliga` |
   | Primeira Liga (PPL) | `goles resumen` | Title must contain a `\| Team 2-1 Team \|` pattern, and titles with `highlights`/`resumo` are rejected unless they contain Spanish words (`gol`, `resumen`, …) — targets GolTV's Spanish uploads |
   | Eredivisie (DED) | `Eredivisie` | No extra rule |

3. **Team keywords:** at least one keyword from either team's name must
   appear in the title. Keywords are the name's words longer than 3 letters,
   minus generic ones (`real`, `club`, `united`, `sporting`, …), so
   "Manchester City FC" → `manchester`, `city`.
4. **Upload date** must line up with the match date (see below).

**Upload-date and view-count parsing**

YouTube shows the age and view count in two formats depending on layout,
and the scraper accepts both:

| | Long form | Compact form (current as of Oct 2026) |
|---|---|---|
| Views | `959K views` | `959K` |
| Age | `1 day ago`, `3 weeks ago` | `1d ago`, `3w ago`, `5h ago`, `8mo ago`, `1y ago` |

`parse_upload_age()` and `parse_view_count()` handle both. Matching rules,
where *N* is the number of days since the match:

| N | Accepted video age |
|---|---|
| 0 | minutes or hours |
| 1 | hours, or exactly 1 day |
| 2–59 | days within ±2 of N; weeks within ±1 of N/7 (if N ≥ 12); "1 month" (if N ≥ 28) |
| 60–364 | months within ±1 of N/30, or the exact date |

> ⚠️ If YouTube changes this format again, **every video gets rejected** with
> `Skipping (upload date mismatch)` and every run reports `Updated: 0`. That is
> exactly what happened from 9 Oct to 12 Oct 2026. Check the `Metadata:` line
> printed under the skip messages in the workflow log and extend the two
> parsers.

**Data structure**
```json
{ "highlights": {
    "PL": {
      "2026-27": {
        "Liverpool FC-Manchester City FC-2026-10-11": {
          "homeTeam": "Liverpool FC", "awayTeam": "Manchester City FC",
          "date": "2026-10-11", "matchday": 6, "status": "FINISHED",
          "videoId": null,
          "videoIds": ["<id1>", "<id2>"]
        } } } } }
```
- `season` key (`"2026-27"`) is computed from today's date (see §4).
- `match_key` is `"{HomeTeam}-{AwayTeam}-{Date}"` — **not** the match ID.
- `videoIds` (up to 5, most viewed first) is the current format. `videoId`
  is a legacy single-video field that is now always `null`; the site reads
  either.
- A match with no video found has no `videoIds`. A later run that finds
  nothing leaves existing `videoIds` untouched.

**Modes**
- **Normal** (scheduled): re-scrapes every finished match from **today and
  yesterday**, even ones that already have videos (to pick up better uploads).
  Anything older than that is never revisited.
- **Backfill** (`--backfill`, or the workflow's `backfill` input): scrapes
  every finished match of the current season that has **no videos yet**
  (neither `videoId` nor `videoIds`). Use this to fill gaps after an outage.

**Auto-prunes on every run:** deletes any season key that isn't the
*current* computed season, for every league.

**Workflow details:** installs Google Chrome and `selenium` +
`webdriver-manager`, runs the scraper from inside `output/`, writes
`highlights_database_updated.json`, renames it over `highlights_database.json`,
commits, then runs `git pull --rebase` before `git push`. The rebase matters:
other workflows push to `main` while the scrape is running (it takes several
minutes), and without it the push was rejected and that run's results were
lost.

### 2.5 `fetch_soccer_news.py` → `output/soccer_news.json`
- Reads the RSS feed at `101greatgoals.com/football/feed/`, pages 1–20
  (`num_pages = 20`).
- For each article, scrapes the full body text and **truncates** it at the
  first "junk" phrase (Topics:, Follow us:, author bylines, Related articles,
  Latest News, etc.).
- **Drops low-quality articles entirely** if the headline contains:
  `Commentary`, a score like `3-1`, `fixtures`, line-up variants, report/result
  patterns, text-update patterns, `Champions League round-up`,
  `European round-up`, or starts with `WATCH:`, `LIVE` or `FPL `.
- **Fully overwrites** `soccer_news.json` every run — no accumulation and no
  season concept.
- Workflow installs `feedparser requests beautifulsoup4`.

---

## 3. How `index.html` consumes all of this

On page load, `index.html` fires one `Promise.all([...])` fetching all five
JSON files from `output/`. `all_leagues.json` and `highlights_database.json`
are required (the page shows an error if either fails); the other three fall
back to `{}`.

```js
output/all_leagues.json          → allLeaguesData
output/highlights_database.json  → highlightsDatabase  (its .highlights property)
output/match_statistics.json     → matchStatistics
output/head2head.json            → head2headData
output/soccer_news.json          → soccerNews
```

Everything you see on the site is built client-side from these objects:

- **Match cards / Finished / Live / Upcoming filters** — built directly from
  `allLeaguesData[league].matches`. Matches marked `FINISHED` with a
  `utcDate` in the future are filtered out (guards against bad API records).
- **Standings tab** — `calculateStandings()` computes the table **entirely
  client-side** from every `FINISHED` match. Every team appearing in any
  match is pre-seeded at 0 points, so the table is complete from day one.
- **Champions League standings** — hidden once `match.matchday > 8` (the
  league phase has 8 matchdays; after that it's knockouts).
- **Stats tab** — `matchStatistics[league][match.id]`.
- **History tab** — `head2headData[match.id]`.
- **Videos** — `highlightsDatabase[league][CURRENT_SEASON][matchKey]`, with
  `CURRENT_SEASON` from `getCurrentSeason()` (§4) and `matchKey` built exactly
  like the scraper builds it. Shows up to **4** of the stored `videoIds` as
  tabs of embedded players, plus a "Find more videos" YouTube search button.
  Players start unmuted at 50% volume: on opening the match modal the YouTube
  IFrame API (`initVideoPlayer`) sets it on load and again on first play,
  overriding the volume YouTube remembers from earlier visits.
  If there are no videos, only the search button appears.
- **News tab** — cards from `soccerNews.articles[]`; the full article opens in
  a modal with a "Credit to www.101greatgoals.com" line.

---

## 4. The "SEASON" concept — where it lives

There is **no single source of truth** for "what season is it":

| Location | Type | What it controls |
|---|---|---|
| `SEASON = '2026'` in `fetch_all_leagues.js` | **Manual**, hard-coded | Which season's fixtures are pulled from the API. Everything else follows from this. |
| `get_current_season()` in `youtube_web_scraper.py` | **Automatic**, from today's date | Which `"YYYY-YY"` bucket highlight data is written to, and which buckets are pruned |
| `getCurrentSeason()` in `index.html` | **Automatic**, from today's date | Which `"YYYY-YY"` bucket the site reads videos from |
| `SEASON = '2025'` in `fetch_match_statistics.js` | Unused | Declared but never referenced; changing it does nothing |

- football-data.org labels a season by the year it **starts**:
  `SEASON='2026'` is the 2026/27 season, i.e. highlights bucket `"2026-27"`.
- The two automatic functions use the same rule: **July 1** starts a new
  season (July–December → this year; January–June → last year). They must
  stay identical, or the site will look in a different bucket from the one
  the scraper writes to.
- `head2head.json` and `match_statistics.json` don't use a season at all —
  they clean themselves up based on which match IDs exist in the current
  `all_leagues.json`.

**What happens on July 1 automatically:** the highlights bucket flips to the
new season. The next scraper run deletes the old season's video IDs, and the
site starts reading the new (empty) bucket — so old-season videos disappear
from the site on July 1, even if `SEASON` in `fetch_all_leagues.js` hasn't been
changed yet. This is expected; the old season is over by then.

---

## 5. Checklist: what to do at the start of every new season

1. **Wait until the API has the new fixtures.** Domestic leagues usually
   appear in June/July; the Champions League league phase only after its
   draw (late August). Updating `SEASON` too early gives empty or partial
   fixture lists. You can check with:
   ```bash
   curl -s -H "X-Auth-Token: $FOOTBALL_API_KEY" \
     "https://api.football-data.org/v4/competitions/PL/matches?season=2027" | head -c 500
   ```

2. **Update `SEASON` in `fetch_all_leagues.js`** to the new starting year,
   e.g. `'2027'` for 2027/28. This is the only required code change.

3. **Run the fixtures workflow once** and check every league has matches:
   `gh workflow run update-data.yml`, then look at the "SUMMARY" lines in the
   run log (one `<League>: <N> matches` line per league). Pushing the `SEASON`
   change to `main` also triggers this workflow automatically.

4. **Leave everything else alone.** On their next scheduled runs:
   - `match_statistics.json` and `head2head.json` prune old-season match IDs.
   - `highlights_database.json` already switched buckets on July 1 (§4).
   - `soccer_news.json` has no season concept.

5. **Optional backfills** if the season has already started when you switch:
   ```bash
   gh workflow run update-highlights.yml -f backfill=true
   gh workflow run fetch_statistics_workflow.yml -f fetch_all=true
   gh workflow run fetch_head2head_workflow.yml -f fetch_all=true
   ```

6. **Check the broadcaster rules still hold** (§2.4 table). Broadcasting
   rights and channel names change between seasons (e.g. CBS Sports Golazo →
   CBS Golazo in 2026). After the first weekend, open a highlights workflow
   log: if a league shows lots of `Skipping (<League> requires ...)` lines for
   videos that are clearly the right highlights, update that league's rule in
   `youtube_web_scraper.py` and the table above.

7. **Adding or removing a league** means editing the league list in
   `fetch_all_leagues.js`, `LEAGUES_TO_PROCESS` in `fetch_match_statistics.js`
   and `youtube_web_scraper.py`, and adding a broadcaster rule in
   `create_search_query()` plus a filter if needed.

---

## 6. Known gaps / things worth revisiting

- **Hard-coded API key in `fetch_match_statistics.js`.** The repo is public,
  so the key is visible to anyone. The workflow already passes
  `FOOTBALL_API_KEY`, but the script doesn't read it. Fix: read
  `process.env.FOOTBALL_API_KEY` like `fetch_head2head.js` does, and rotate the
  key at football-data.org.
- **Primeira Liga highlights are mostly missing.** The GolTV-style title rule
  (§2.4) matches almost nothing in current search results; about 65 PPL
  matches this season have no video.
- **Team-keyword filter is loose.** Generic words count as keywords, so for
  Liverpool v Manchester City the word `city` also accepts Hull City and
  Coventry City highlights. The right video still ranks first by views, but
  wrong ones are stored alongside it. Eredivisie also accepts "Preview"
  videos.
- **Only the highlights workflow rebases before pushing.** The other four push
  straight away, so they can still fail occasionally when two workflows
  finish at the same moment. The next run normally catches up.
- **"Finished" filter checks only `videoId`.** In `index.html`, the
  finished-matches filter decides "has a video" from the legacy `videoId`
  field, which is now always `null`. Harmless today (finished matches show
  anyway), but it should check `videoIds` too.
- **Repo history is very large (~3.7 GB).** Every bot commit rewrites
  multi-megabyte JSON files (`all_leagues.json` is ~4 MB and changes every
  10 minutes), and git keeps every version. A fresh `git clone` takes a long
  time; `git clone --depth 1` avoids that if you don't need history.
- **Highlights match keys are name + date**, not match ID. If the API changes
  a team's name string mid-season, that match's videos stop showing until
  they're scraped again under the new key.
