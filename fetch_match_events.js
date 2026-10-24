// Goal scorers, assists and cards for finished matches, from ESPN's free
// (unofficial, keyless) site API. football-data.org's free tier has no goals,
// so this fills match.goals and match.bookings in all_leagues.json in the
// shape index.html already reads. Runs right after fetch_all_leagues.js in the
// update-data workflow and makes no football-data.org calls.
//
// Per finished match: one scoreboard call per league + date (to find ESPN's
// event ID), then one summary call per match. Results are cached in
// output/match_events.json keyed by football-data match ID, so each match is
// fetched once; every run re-merges the cache because fetch_all_leagues.js
// rewrites all_leagues.json from scratch.

const fs = require('fs');

const OUTPUT_DIR = 'output';
const ALL_LEAGUES_FILE = `${OUTPUT_DIR}/all_leagues.json`;
const CACHE_FILE = `${OUTPUT_DIR}/match_events.json`;

const ESPN_LEAGUES = {
    PL: 'eng.1',
    PD: 'esp.1',
    BL1: 'ger.1',
    SA: 'ita.1',
    FL1: 'fra.1',
    PPL: 'por.1',
    DED: 'ned.1',
    CL: 'uefa.champions',
};

const MAX_CALLS_PER_RUN = 200; // the first run backfills the season over a few runs
const CALL_SPACING_MS = 300;
const RETRY_DAYS = 3; // keep retrying a date this long; older dates are tried once

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let callsMade = 0;
async function espnGet(path) {
    if (callsMade > 0) await delay(CALL_SPACING_MS);
    callsMade++;
    const response = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
    return response.json();
}

// ESPN's scoreboard dates are US Eastern calendar days
function espnDate(utcDate) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date(utcDate));
    return parts.replace(/-/g, '');
}

const FILLER_WORDS = new Set([
    'fc', 'afc', 'cf', 'sc', 'ac', 'as', 'ss', 'ssc', 'sv', 'vfb', 'vfl', 'tsg', 'rc', 'rcd',
    'cd', 'ud', 'sd', 'club', 'de', 'del', 'the', 'and', 'fk', 'us', 'ogc', 'losc', 'calcio',
    '1', '04', '05', '1846', '1899', '1900', '1907', '1909', '1910', '1913', 'bc', 'acf', 'sk',
]);

function nameTokens(name) {
    return (name || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/).filter(t => t && !FILLER_WORDS.has(t));
}

// 0..1: share of tokens that match, where a token matches if one starts with the other
function tokenSimilarity(a, b) {
    const ta = nameTokens(a), tb = nameTokens(b);
    if (!ta.length || !tb.length) return 0;
    const hits = ta.filter(x => tb.some(y => x.startsWith(y) || y.startsWith(x))).length;
    return hits / Math.max(ta.length, tb.length);
}

function teamSimilarity(fdTeam, espnTeam) {
    if (fdTeam.tla && espnTeam.abbreviation && fdTeam.tla === espnTeam.abbreviation) return 1;
    let best = 0;
    for (const a of [fdTeam.name, fdTeam.shortName]) {
        for (const b of [espnTeam.displayName, espnTeam.shortDisplayName, espnTeam.name]) {
            best = Math.max(best, tokenSimilarity(a, b));
        }
    }
    return best;
}

// Best ESPN event for a football-data match, or null if nothing is close enough
function findEspnEvent(match, events) {
    let best = null, bestScore = 0;
    for (const event of events) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        const home = comp.competitors.find(c => c.homeAway === 'home');
        const away = comp.competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;
        let score = teamSimilarity(match.homeTeam, home.team) + teamSimilarity(match.awayTeam, away.team);
        const ft = match.score?.fullTime || {};
        if (String(ft.home) === String(home.score) && String(ft.away) === String(away.score)) score += 0.5;
        if (score > bestScore) { bestScore = score; best = event; }
    }
    return bestScore >= 1 ? best : null;
}

// "45'+2'" -> { minute: 45, injuryTime: 2 }
function parseClock(displayValue) {
    const m = String(displayValue || '').match(/(\d+)'?(?:\s*\+\s*(\d+))?/);
    if (!m) return { minute: null, injuryTime: null };
    return { minute: Number(m[1]), injuryTime: m[2] ? Number(m[2]) : null };
}

// Turn an ESPN summary into football-data-shaped goals and bookings
function convertSummary(summary, match, espnEvent) {
    const comp = espnEvent.competitions[0];
    const espnHomeId = comp.competitors.find(c => c.homeAway === 'home').id;
    const sideTeam = (espnTeamId) => (String(espnTeamId) === String(espnHomeId) ? match.homeTeam : match.awayTeam);
    const otherTeam = (team) => (team === match.homeTeam ? match.awayTeam : match.homeTeam);
    const teamRef = (team) => ({ id: team.id, name: team.name });
    const person = (p) => (p?.athlete ? { id: `espn-${p.athlete.id}`, name: p.athlete.displayName } : null);

    const goals = [];
    const bookings = [];
    for (const ev of summary.keyEvents || []) {
        if (ev.shootout) continue;
        const text = `${ev.type?.text || ''} ${ev.type?.type || ''}`.toLowerCase();
        const { minute, injuryTime } = parseClock(ev.clock?.displayValue);
        const players = ev.participants || [];

        if (ev.scoringPlay) {
            const isOwn = text.includes('own');
            // ESPN credits an own goal to the team that benefits; index.html wants the scorer's own team
            const benefiting = sideTeam(ev.team?.id);
            goals.push({
                minute,
                injuryTime,
                type: isOwn ? 'OWN' : text.includes('penalty') ? 'PENALTY' : 'REGULAR',
                team: teamRef(isOwn ? otherTeam(benefiting) : benefiting),
                scorer: person(players[0]),
                assist: isOwn ? null : person(players[1]),
            });
        } else if (text.includes('card')) {
            const card = text.includes('yellow') && text.includes('red') ? 'YELLOW_RED'
                : text.includes('red') ? 'RED' : 'YELLOW';
            bookings.push({ minute, injuryTime, team: teamRef(sideTeam(ev.team?.id)), player: person(players[0]), card });
        }
    }
    return { goals, bookings };
}

function loadJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return fallback;
    }
}

async function main() {
    console.log('=== Fetching match events from ESPN ===');
    const allLeagues = loadJson(ALL_LEAGUES_FILE, null);
    if (!allLeagues) {
        console.error(`✗ ${ALL_LEAGUES_FILE} not found`);
        process.exitCode = 1;
        return;
    }
    const cache = loadJson(CACHE_FILE, {});
    cache.matches = cache.matches || {};
    cache.checkedDates = cache.checkedDates || {};

    const now = Date.now();
    const retryCutoff = now - RETRY_DAYS * 24 * 60 * 60 * 1000;
    const currentIds = new Set();

    // Group finished matches still missing events by league + ESPN date, newest first
    const todo = [];
    for (const [code, league] of Object.entries(allLeagues)) {
        if (!ESPN_LEAGUES[code]) continue;
        const byDate = {};
        for (const match of league.matches || []) {
            currentIds.add(String(match.id));
            if (match.status !== 'FINISHED' || cache.matches[match.id]) continue;
            if (new Date(match.utcDate).getTime() > now) continue;
            const date = espnDate(match.utcDate);
            const key = `${code}|${date}`;
            const isRecent = new Date(match.utcDate).getTime() >= retryCutoff;
            if (cache.checkedDates[key] && !isRecent) continue; // tried once already, gave up
            (byDate[date] = byDate[date] || []).push({ match, isRecent });
        }
        for (const [date, matches] of Object.entries(byDate)) todo.push({ code, date, matches });
    }
    todo.sort((a, b) => b.date.localeCompare(a.date));
    console.log(`${todo.length} league-days with finished matches missing events`);

    let added = 0, unmatched = 0;
    for (const { code, date, matches } of todo) {
        if (callsMade + 1 + matches.length > MAX_CALLS_PER_RUN) {
            console.log(`Reached ${MAX_CALLS_PER_RUN} calls; the rest waits for the next run`);
            break;
        }
        let events;
        try {
            events = (await espnGet(`${ESPN_LEAGUES[code]}/scoreboard?dates=${date}`)).events || [];
        } catch (error) {
            console.error(`  ✗ ${code} ${date}: ${error.message}`);
            continue;
        }
        cache.checkedDates[`${code}|${date}`] = new Date().toISOString();

        for (const { match, isRecent } of matches) {
            const label = `${code} ${date} ${match.homeTeam.shortName} v ${match.awayTeam.shortName}`;
            const event = findEspnEvent(match, events);
            if (!event) {
                console.log(`  ⚠ ${label}: no matching ESPN game`);
                unmatched++;
                continue;
            }
            if (!event.competitions[0].status?.type?.completed) {
                console.log(`  … ${label}: not final on ESPN yet`);
                continue;
            }
            let summary;
            try {
                summary = await espnGet(`${ESPN_LEAGUES[code]}/summary?event=${event.id}`);
            } catch (error) {
                console.error(`  ✗ ${label}: ${error.message}`);
                continue;
            }
            const { goals, bookings } = convertSummary(summary, match, event);
            const ft = match.score?.fullTime || {};
            const expectedGoals = (ft.home || 0) + (ft.away || 0);
            if (goals.length !== expectedGoals) {
                console.log(`  ⚠ ${label}: ESPN has ${goals.length} goals, score says ${expectedGoals}`);
                if (isRecent) continue; // ESPN may still be filling in; try again next run
            }
            cache.matches[match.id] = { espnId: event.id, goals, bookings };
            added++;
            console.log(`  ✓ ${label}: ${goals.length} goals, ${bookings.length} cards`);
        }
    }

    // Drop matches from past seasons, like the other caches do
    for (const id of Object.keys(cache.matches)) {
        if (!currentIds.has(id)) delete cache.matches[id];
    }

    // Merge into all_leagues.json, which fetch_all_leagues.js rewrote without goals
    let merged = 0;
    for (const league of Object.values(allLeagues)) {
        for (const match of league.matches || []) {
            const events = cache.matches[match.id];
            if (!events) continue;
            match.goals = events.goals;
            match.bookings = events.bookings;
            merged++;
        }
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    fs.writeFileSync(ALL_LEAGUES_FILE, JSON.stringify(allLeagues, null, 2));
    console.log(`\n=== Done: ${callsMade} ESPN calls, ${added} new matches, ${unmatched} unmatched, ${merged} matches with events ===`);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exitCode = 1;
});
