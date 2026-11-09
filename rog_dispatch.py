#!/usr/bin/env python3
"""Match-aware trigger for the GitHub Actions bots, run from the always-on ROG.

GitHub throttles `schedule:` crons badly: the "every 10 minutes" workflows were
actually firing every 4-7 hours (Nov 2026), so results showed up hours after
the final whistle. `workflow_dispatch` runs are not throttled, so a systemd
timer on the ROG runs this script every 10 minutes and it decides whether to
trigger `update-data.yml` (scores, 8 football-data.org calls per run) and
`update-highlights.yml` (YouTube scraper, no API calls).

Cadence (see README §2.0):
  * ACTIVE  - a tracked match kicked off in the last ACTIVE_HOURS and is not
              finished yet (or football-data says IN_PLAY/PAUSED):
              scores every ACTIVE_MINUTES.
  * IDLE    - nothing going on: scores every IDLE_HOURS to pick up fixture
              changes and postponements.
  * HIGHLIGHTS - a match finished within HL_RECENT_HOURS of now: scraper every
              HL_MINUTES; otherwise once per idle score run.

Usage: rog_dispatch.py [--dry-run] [--force]
"""

import datetime as dt
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = "felixavier91/football-leagues-tracker"
DATA_URL = f"https://raw.githubusercontent.com/{REPO}/main/output/all_leagues.json"
STATE = Path.home() / ".local/share/soccer-dispatch/state.json"

ACTIVE_HOURS = 3.5      # a match is "going on" this long after kickoff unless marked finished
ACTIVE_MINUTES = 20     # score pulls during matches / right after the final whistle
IDLE_HOURS = 3          # score pulls when nothing is on
HL_RECENT_HOURS = 6     # a match that finished this recently still gets highlight checks
HL_MINUTES = 40         # highlight scraper cadence while there are fresh results

DATA_WF = "update-data.yml"
HL_WF = "update-highlights.yml"
LIVE = {"IN_PLAY", "PAUSED"}
OVER = {"FINISHED", "AWARDED", "POSTPONED", "CANCELLED", "SUSPENDED"}

DRY = "--dry-run" in sys.argv
FORCE = "--force" in sys.argv


def log(msg):
    print(f"{dt.datetime.now(dt.timezone.utc):%H:%M:%S} {msg}", flush=True)


def load_state():
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=1))


def fetch_matches():
    req = urllib.request.Request(DATA_URL, headers={"User-Agent": "soccer-dispatch"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    return [m for league in data.values() for m in league.get("matches", [])]


def kickoff(m):
    return dt.datetime.fromisoformat(m["utcDate"].replace("Z", "+00:00"))


def classify(matches, now):
    """Return (active, fresh_results): matches in progress, and matches finished recently."""
    active, fresh = [], []
    for m in matches:
        try:
            ko = kickoff(m)
        except (KeyError, ValueError):
            continue
        age = now - ko
        status = m.get("status")
        if status in LIVE or (status not in OVER and dt.timedelta(0) <= age <= dt.timedelta(hours=ACTIVE_HOURS)):
            active.append(m)
        elif status == "FINISHED" and dt.timedelta(0) <= age <= dt.timedelta(hours=HL_RECENT_HOURS):
            fresh.append(m)
    return active, fresh


def label(m):
    return f"{m['homeTeam']['name']} v {m['awayTeam']['name']} ({m['status']}, {m['utcDate'][11:16]}Z)"


def gh(*args):
    return subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)


def running(workflow):
    """True if a run of this workflow is already queued or in progress."""
    out = gh("run", "list", "-R", REPO, "--workflow", workflow, "--limit", "5",
             "--json", "status", "-q", "[.[] | select(.status != \"completed\")] | length")
    return out.returncode == 0 and out.stdout.strip() not in ("", "0")


def minutes_since(state, key, now):
    try:
        return (now - dt.datetime.fromisoformat(state[key])).total_seconds() / 60
    except (KeyError, ValueError):
        return float("inf")


def dispatch(workflow, state, key, now, why):
    if running(workflow):
        log(f"{workflow}: a run is already queued/in progress, not adding another ({why})")
        return
    if DRY:
        log(f"DRY RUN would trigger {workflow}: {why}")
        return
    out = gh("workflow", "run", workflow, "-R", REPO)
    if out.returncode != 0:
        log(f"{workflow}: gh failed: {out.stderr.strip()}")
        return
    state[key] = now.isoformat()
    log(f"triggered {workflow}: {why}")


def main():
    now = dt.datetime.now(dt.timezone.utc)
    state = load_state()
    try:
        matches = fetch_matches()
    except Exception as err:  # network / GitHub hiccup: try again next tick
        log(f"could not read all_leagues.json: {err}")
        return 1

    active, fresh = classify(matches, now)
    since_data = minutes_since(state, "data", now)
    since_hl = minutes_since(state, "highlights", now)
    log(f"{len(active)} match(es) on, {len(fresh)} fresh result(s); "
        f"last score run {since_data:.0f} min ago, last highlights run {since_hl:.0f} min ago")
    for m in active[:6]:
        log("  on: " + label(m))

    data_due = None
    if FORCE:
        data_due = "forced"
    elif active and since_data >= ACTIVE_MINUTES:
        data_due = f"{len(active)} match(es) on, every {ACTIVE_MINUTES} min"
    elif not active and since_data >= IDLE_HOURS * 60:
        data_due = f"idle baseline, every {IDLE_HOURS} h"

    hl_due = None
    if FORCE:
        hl_due = "forced"
    elif fresh and since_hl >= HL_MINUTES:
        hl_due = f"{len(fresh)} recent result(s), every {HL_MINUTES} min"
    elif data_due and not active and since_hl >= IDLE_HOURS * 60:
        hl_due = f"idle baseline, every {IDLE_HOURS} h"

    if data_due:
        dispatch(DATA_WF, state, "data", now, data_due)
    if hl_due:
        dispatch(HL_WF, state, "highlights", now, hl_due)
    if not data_due and not hl_due:
        log("nothing due")
    if not DRY:
        save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
