// Fetch head2head data for upcoming matches
// Data is stored keyed by MATCH ID. Each fetch pulls the FULL cumulative
// head2head history between the two teams (up to 50 past meetings) from
// the API — so every fresh fetch for a new fixture already contains all
// prior history, not just "new" results since the last run.
// Run every 5 minutes between 6-7 AM daily

const https = require('https');
const fs = require('fs');

const API_KEY = process.env.FOOTBALL_API_KEY;

// Debug: Check if API key is loaded
if (!API_KEY) {
    console.error('ERROR: FOOTBALL_API_KEY environment variable is not set!');
    console.error('Please set it in GitHub Secrets or as an environment variable');
    process.exit(1);
}
console.log('API Key loaded:', API_KEY ? `${API_KEY.substring(0, 8)}...` : 'NOT SET');

async function fetchHead2Head(matchId) {
    console.log(`Fetching head2head for match ${matchId}...`);
    
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.football-data.org',
            path: `/v4/matches/${matchId}/head2head?limit=50`,
            method: 'GET',
            headers: {
                'X-Auth-Token': API_KEY
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                // Accept any response, don't check status code
                try {
                    const parsed = JSON.parse(data);
                    // Check if we got actual match data (not an error object)
                    if (parsed.matches && parsed.matches.length > 0) {
                        console.log(`  ✓ Got ${parsed.matches.length} historical matches`);
                        resolve(parsed);
                    } else if (parsed.errorCode) {
                        console.log(`  ⚠ API returned error for match ${matchId}: ${parsed.message}`);
                        resolve(null);
                    } else {
                        console.log(`  ⚠ No matches returned for ${matchId}`);
                        resolve(null);
                    }
                } catch (error) {
                    console.error(`  ✗ Failed to parse response: ${error.message}`);
                    resolve(null);
                }
            });
        });
        
        req.on('error', (e) => {
            console.error(`  ✗ Request error: ${e.message}`);
            resolve(null); // Don't reject, just return null
        });
        
        req.end();
    });
}

async function main() {
    console.log('=== Fetching Head2Head Data ===');
    console.log('Time:', new Date().toISOString());
    
    // Load all leagues data from output folder
    const allLeaguesData = JSON.parse(fs.readFileSync('output/all_leagues.json', 'utf8'));
    
    // Load existing head2head data
    let head2headData = {};
    if (fs.existsSync('output/head2head.json')) {
        head2headData = JSON.parse(fs.readFileSync('output/head2head.json', 'utf8'));
        console.log(`Loaded ${Object.keys(head2headData).length} existing head2head entries`);
    }
    
    // Build a set of every match ID that exists in the CURRENT all_leagues.json.
    // all_leagues.json is fully overwritten each season, so any match ID no
    // longer present there belongs to a season we've already moved past.
    const currentMatchIds = new Set();
    for (const leagueData of Object.values(allLeaguesData)) {
        if (!leagueData.matches) continue;
        for (const match of leagueData.matches) {
            currentMatchIds.add(String(match.id));
        }
    }
    
    // Prune stale entries: drop any head2head entry whose match ID is no
    // longer in the current season's fixture list, so the file never bloats
    // with years-old data that can never be looked up again.
    const beforePruneCount = Object.keys(head2headData).length;
    for (const matchId of Object.keys(head2headData)) {
        if (!currentMatchIds.has(String(matchId))) {
            delete head2headData[matchId];
        }
    }
    const prunedCount = beforePruneCount - Object.keys(head2headData).length;
    if (prunedCount > 0) {
        console.log(`🧹 Pruned ${prunedCount} stale entries (match IDs no longer in current season)`);
    }
    console.log(`${Object.keys(head2headData).length} entries remain after pruning`);
    
    // Check for backfill mode (fetch past matches that are missing data)
    const isBackfill = process.argv.includes('--all');
    console.log(`Mode: ${isBackfill ? 'BACKFILL (past matches without data)' : 'NORMAL (upcoming only, skip existing)'}`);
    
    // Get current time and 21-day window
    const now = new Date();
    const in21Days = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
    
    if (isBackfill) {
        console.log(`BACKFILL MODE: Looking for past/finished matches without h2h data`);
    } else {
        console.log(`NORMAL MODE: Looking for matches between ${now.toISOString()} and ${in21Days.toISOString()}`);
    }
    
    // Find matches to fetch
    const matchesToFetch = [];
    
    for (const [leagueCode, leagueData] of Object.entries(allLeaguesData)) {
        if (!leagueData.matches) continue;
        
        for (const match of leagueData.matches) {
            const matchDate = new Date(match.utcDate);
            
            if (isBackfill) {
                // Backfill mode: only past/finished matches that don't have data yet
                const isPast = matchDate < now;
                const missingData = !head2headData[match.id];
                
                if (isPast && missingData) {
                    matchesToFetch.push({
                        id: match.id,
                        homeTeam: match.homeTeam.name,
                        awayTeam: match.awayTeam.name,
                        date: match.utcDate,
                        league: leagueCode
                    });
                }
            } else {
                // Normal mode: only upcoming matches in next 21 days
                const isUpcoming = matchDate >= now && matchDate <= in21Days;
                
                if (isUpcoming) {
                    // Skip if already have data for this match
                    if (head2headData[match.id]) {
                        console.log(`  Skipping match ${match.id} (already exists)`);
                        continue;
                    }
                    
                    matchesToFetch.push({
                        id: match.id,
                        homeTeam: match.homeTeam.name,
                        awayTeam: match.awayTeam.name,
                        date: match.utcDate,
                        league: leagueCode
                    });
                }
            }
        }
    }
    
    console.log(`Found ${matchesToFetch.length} matches to process`);
    
    // Fetch head2head for each match
    let fetchedCount = 0;
    let skippedCount = 0;
    
    for (let i = 0; i < matchesToFetch.length; i++) {
        const match = matchesToFetch[i];
        console.log(`\n[${i + 1}/${matchesToFetch.length}] ${match.homeTeam} vs ${match.awayTeam} (${match.league})`);
        
        const h2hData = await fetchHead2Head(match.id);
        
        if (h2hData && h2hData.matches && h2hData.matches.length > 0) {
            head2headData[match.id] = h2hData;
            fetchedCount++;
        } else {
            skippedCount++;
            console.log(`  ⊘ Skipped (no data available)`);
        }
    }
    
    // Save updated head2head data
    fs.writeFileSync('output/head2head.json', JSON.stringify(head2headData, null, 2));
    console.log(`\n=== Complete ===`);
    console.log(`Fetched: ${fetchedCount} new entries`);
    console.log(`Skipped: ${skippedCount} entries`);
    console.log(`Total entries: ${Object.keys(head2headData).length}`);
}

main().catch(console.error);
