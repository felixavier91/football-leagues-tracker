# Football Tracker — Repo Guide

This document explains how the site works end to end: which script produces which
data file, how often each one runs, how `index.html` consumes them, and what
needs to change manually at the start of every new season.

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

---

## 2. The five data pipelines

### 2.1 `fetch_all_leagues.js` → `output/all_leagues.json`
**This is the source-of-truth file everything else depends on.**

- Hits `GET /v4/competitions/{code}/matches?season={SEASON}` for every league
  in the `leagues` array (PL, PD, BL1, SA, FL1, PPL, DED, CL).
- Fully **overwrites** `all_leagues.json` every run — nothing accumulates here,
  it's always a fresh snapshot of the current season's full fixture list
  (past results + upcoming fixtures) for every tracked league.
- Also writes one file per league (`output/pl.json`, `output/pd.json`, etc.) —
  not used by `index.html` directly, just per-league debug/inspection copies.
- **Special case — Champions League standings:** makes an extra call to
  `/v4/competitions/CL/standings?season={SEASON}&matchday=8` and stashes the
  result under `data.standings` in the CL entry. ⚠️ **Note:** as of writing,
  `index.html` does **not** actually read this `data.standings` field —
  standings are computed client-side (see §3). This fetch currently has no
  effect on what's displayed. Worth revisiting if CL standings ever look wrong
  again — see §5.
- **Schedule:** `update-football-data-workflow.yml` — every 2 minutes,
  7am–9pm EST.

### 2.2 `fetch_match_statistics.js` → `output/match_statistics.json`
- Reads `all_leagues.json`, finds matches finished in the **last 72 hours**
  (today + yesterday + the day before — wide enough to reliably catch
  midweek Champions League matches even if the workflow has a gap).
- For each finished match, calls `/v4/matches/{id}` with the `X-Unfold-*`
  headers to pull full box-score data (goals, bookings, subs, lineups, refs).
- **Accumulates** — keyed by match ID, never wiped. Existing entries for a
  match are always re-fetched in normal mode (to catch stat corrections),
  but nothing is deleted just because it "wasn't in the 72h window" this run.
- **Auto-prunes on every run:** before fetching, deletes any stored match ID
  that's no longer present in the current `all_leagues.json`. Since
  `all_leagues.json` is fully replaced each season, this means stats from a
  season you've moved past get cleared out automatically — no manual cleanup
  needed.
- `--all` flag = backfill mode: fetches every historical FINISHED match
  missing stats, ignoring the 72h window. Use this to catch up after an
  outage or to seed stats for a season retroactively.
- **Schedule:** `fetch_statistics_workflow.yml` — every 10 minutes,
  roughly 7am–11pm EST.

### 2.3 `fetch_head2head.js` → `output/head2head.json`
- Reads `all_leagues.json`, finds matches kicking off in the **next 21 days**.
- For each such match, calls `/v4/matches/{id}/head2head?limit=50` — this
  returns the **full historical head-to-head record** between the two teams
  (up to 50 past meetings, across seasons), fetched fresh every time.
- **Keyed by match ID** (the upcoming fixture's ID) — deliberately kept simple
  rather than keyed by team pair. This means the same two teams playing again
  next season triggers a brand new fetch under a new key; there's no
  cross-fixture reuse, but every fetch is guaranteed fresh and complete since
  the API itself returns the full history each time, not deltas.
- Only fetches matches whose key **doesn't already exist** — once a fixture
  has h2h data, it's never re-fetched (normal mode).
- **Auto-prunes on every run:** before fetching, deletes any stored match ID
  no longer present in the current `all_leagues.json`. Combined with
  match-ID keying, this means the file only ever contains h2h data for
  fixtures in the *current* season's fixture list — nothing lingers from
  prior seasons, no matter how many years this repo runs.
- `--all` flag = backfill mode: fetches h2h for any **past** match missing
  data, ignoring the 21-day window.
- **Schedule:** `fetch_head2head_workflow.yml` — every 5 minutes, 6:00–7:00am
  EST (12 runs/day, tight window since it's a lighter, less urgent dataset).

### 2.4 `youtube_web_scraper.py` → `output/highlights_database.json`
- Reads `all_leagues.json`, finds matches that are finished (2+ hours past
  kickoff or `status == FINISHED`).
- Scrapes YouTube search results (no API key needed) looking for a highlights
  video matching `{HomeTeam}-{AwayTeam}-{Date} highlights {broadcaster}`.
- **Broadcaster requirement per league** (video title must contain this
  string, case-insensitive, or the video is rejected):
  | League | Required string |
  |---|---|
  | Serie A | `CBS Sports Golazo` |
  | Champions League | `CBS Sports` |
  | Ligue 1 | `beIN SPORTS USA` |
  | Primeira Liga | (uses `goles resumen` as search bias, Spanish-language GolTV titles) |
  | Others | generic `highlights` |
- Team names are Unicode-normalized before searching (e.g. `ø`→`o`, `ø/`
  handled, accents stripped) so names like *Bodø/Glimt* search correctly.
- **Data structure:** `highlights[league_code][season_string][match_key]`,
  where `season_string` is computed automatically (see §4) and `match_key` is
  `"{HomeTeam}-{AwayTeam}-{Date}"` (**not** match ID).
- **Auto-prunes on every run:** deletes any `season_string` key that isn't
  the *current* computed season, for every league. This means old-season
  highlight data is wiped out entirely the first time this script runs after
  a season rollover.
- Default mode processes only matches finished in the **last 48 hours**;
  `--backfill` flag processes all historical finished matches.
- **Schedule:** `update-highlights.yml` — daily at 10pm EST.

### 2.5 `fetch_soccer_news.py` → `output/soccer_news.json`
- Scrapes the RSS feed at `101greatgoals.com/football/feed/`, pulling **10
  pages** (`?paged=2` through `?paged=10`) — roughly 180 articles per run.
- For each article, scrapes the full body text and **truncates** it the
  moment it hits any of a list of "junk" phrases (Topics:, Follow us:,
  author bylines, Latest News, etc.) — deletes that line and everything
  after it.
- **Filters out low-quality articles entirely** if the headline contains any
  of: `Commentary`, score patterns like `3-1`, `fixtures`, `lineups`/
  `line-ups` (any variant), `Report, result...`, `Results, scores...`,
  `Text updates...`, `European round-up`, or starts with `WATCH:`, `LIVE`,
  or `FPL `.
- **Fully overwrites** `soccer_news.json` every run — no accumulation, no
  season concept, just "whatever the last 10 pages of the feed currently
  contain."
- **Schedule:** `fetch_soccer_news_workflow.yml` — every hour, all day.

---

## 3. How `index.html` consumes all of this

On page load, `index.html` fires one `Promise.all([...])` fetching all five
JSON files from `output/` (with graceful `.catch(() => ({}))` fallbacks on
the optional ones, so a missing file doesn't break the page):

```js
output/all_leagues.json          → allLeaguesData
output/highlights_database.json  → highlightsDatabase
output/match_statistics.json     → matchStatistics
output/head2head.json            → head2headData
output/soccer_news.json          → soccerNews
```

Everything you see on the site is built client-side from these five objects:

- **Match cards / Finished / Live / Upcoming filters** — built directly from
  `allLeaguesData[league].matches`.
- **Standings tab** — `calculateStandings()` computes the table **entirely
  client-side** by iterating every match in `allLeaguesData[league].matches`
  with `status === 'FINISHED'`. It does **not** read any `standings` field
  from the JSON. Every team appearing in *any* match (finished or not) is
  pre-seeded into the table at 0 games/points, so the table shows the full
  set of teams from day one of the season rather than an empty table.
- **Champions League standings tab visibility** — hidden entirely once
  `match.matchday > 8` (playoffs/knockout phase begin after the 8-game
  league phase, where a "table" stops making sense). This only hides the
  *tab*; it doesn't change how `calculateStandings()` computes numbers for
  matchdays 1–8.
- **Stats tab** — looked up from `matchStatistics[league][match.id]`.
- **History tab** — looked up from `head2headData[match.id]`.
- **Video tab / highlight availability** — looked up from
  `highlightsDatabase[league][CURRENT_SEASON][matchKey]`, where
  `CURRENT_SEASON` is computed client-side by `getCurrentSeason()` (see §4)
  and `matchKey` is built the same way the Python scraper builds it
  (`"{HomeTeam}-{AwayTeam}-{Date}"`).
- **News tab** — one-liner cards built from `soccerNews.articles[]`, full
  article shown in a modal on click, with a "Credit to www.101greatgoals.com"
  line next to the date.
- **Incorrect-data guard** — any match with `status === 'FINISHED'` but a
  `utcDate` in the future is filtered out of the match list entirely before
  rendering (guards against occasional bad API records).

---

## 4. The "SEASON" concept — three independent places it lives

There is **no single source of truth** for "what season is it" — it's defined
in three separate places that all need to agree:

| Location | Type | What it controls |
|---|---|---|
| `SEASON = '2026'` in `fetch_all_leagues.js` | **Manual**, hardcoded number | Which season's fixtures get pulled from the API |
| `SEASON = '2026'` in `fetch_match_statistics.js` | **Manual**, hardcoded number | Passed through to per-match stat fetches (mostly informational; actual matches come from `all_leagues.json`) |
| `get_current_season()` in `youtube_web_scraper.py` | **Automatic**, computed from today's date | Which `"YYYY-YY"` bucket highlight video data is written under, and which old buckets get pruned |
| `getCurrentSeason()` in `index.html` | **Automatic**, computed from today's date | Which `"YYYY-YY"` bucket the site looks up highlight videos from |

The football-data.org `SEASON` param (e.g. `'2026'`) and the highlights
`"YYYY-YY"` string (e.g. `"2026-27"`) are **different formats representing
the same season** — `SEASON='2026'` corresponds to `"2026-27"`. The two
`getCurrentSeason()`/`get_current_season()` functions are kept in sync
deliberately (same July-cutover logic) so the scraper and the site never
disagree about which bucket to read/write.

`head2head.json` and `match_statistics.json` don't use a season string at
all — they self-clean based on **match ID existence** in the current
`all_leagues.json`, which is a more robust signal than a manually-set
season variable.

---

## 5. Checklist: what to do at the start of every new season

1. **Update `SEASON` in `fetch_all_leagues.js`** (currently `'2026'`) to the
   new season's starting year, e.g. `'2027'` for the 2027/28 season.
   *(football-data.org labels a season by the year it starts in.)*

2. **Update `SEASON` in `fetch_match_statistics.js`** to match.

3. **Do nothing for `youtube_web_scraper.py` or `index.html`'s season
   handling** — both compute the season string automatically from the
   current date. Just make sure the actual calendar date has genuinely
   rolled into the new season (July 1st cutover) before relying on it.

4. **Don't flip the switch too early.** If `SEASON` is updated before the
   API has published the new season's fixtures (typically not until each
   competition's draw happens — CL's league-phase draw is usually late
   August), `all_leagues.json` will come back empty or near-empty for that
   competition. Domestic leagues are usually available earlier than CL/UCL
   playoff and league-phase matches.

5. **Run `fetch_all_leagues.js` once manually** after updating `SEASON` to
   confirm fixtures are actually coming back non-empty before relying on the
   scheduled workflow.

6. **Everything else self-cleans on its next scheduled run** once
   `all_leagues.json` reflects the new season:
   - `match_statistics.json` prunes old match IDs automatically.
   - `head2head.json` prunes old match IDs automatically.
   - `highlights_database.json` prunes the old season's bucket automatically.
   - `soccer_news.json` was never season-dependent — no action needed.

7. **Optional backfill runs** — if you want data ready immediately rather
   than waiting for it to trickle in via the normal windows:
   ```bash
   node fetch_match_statistics.js --all
   node fetch_head2head.js --all
   python youtube_web_scraper.py --backfill
   ```

---

## 6. Known gaps / things worth revisiting

- **CL matchday-8 standings fetch in `fetch_all_leagues.js` is currently
  unused.** It fetches `/standings?matchday=8` and stores it, but
  `index.html`'s `calculateStandings()` never reads it — standings are
  always computed client-side from finished matches instead. The *tab* for
  CL standings is hidden past matchday 8 as a workaround, but the fetch
  itself has no effect on anything displayed. Either wire `index.html` up to
  actually use this fetched data, or remove the fetch to save an API call
  each run.
- **`highlights_database.json` match keys are name+date based, not match
  ID based** (`"{HomeTeam}-{AwayTeam}-{Date}"`). If a team's name string
  ever changes in the API response, or two same-named teams play on the
  same date across competitions, this key scheme could collide or miss.
  Match-ID keying (like `match_statistics.json` and `head2head.json` use)
  would be more robust if this ever becomes a problem.
- **`fetch_all_leagues_with_stats.js` should not be used** — an earlier,
  abandoned variant that overwrote `match_statistics.json` incorrectly.
  The three "correct" scripts are `fetch_all_leagues.js`,
  `fetch_match_statistics.js`, and `fetch_head2head.js`, as attached/used
  in this repo.
