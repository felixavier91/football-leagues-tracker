// Fetch head2head data for upcoming matches (next 14 days)
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
    if (fs.existsSync('head2head.json')) {
        head2headData = JSON.parse(fs.readFileSync('head2head.json', 'utf8'));
        console.log(`Loaded ${Object.keys(head2headData).length} existing head2head entries`);
    }
    
    // Check for backfill mode (fetch past matches that are missing data)
    const isBackfill = process.argv.includes('--all');
    console.log(`Mode: ${isBackfill ? 'BACKFILL (past matches without data)' : 'NORMAL (upcoming only, skip existing)'}`);
    
    // Get current time and 14-day window
    const now = new Date();
    const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    
    if (isBackfill) {
        console.log(`BACKFILL MODE: Looking for past/finished matches without h2h data`);
    } else {
        console.log(`NORMAL MODE: Looking for matches between ${now.toISOString()} and ${in14Days.toISOString()}`);
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
                // Normal mode: only upcoming matches in next 14 days
                const isUpcoming = matchDate >= now && matchDate <= in14Days;
                
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
    fs.writeFileSync('head2head.json', JSON.stringify(head2headData, null, 2));
    console.log(`\n=== Complete ===`);
    console.log(`Fetched: ${fetchedCount} new entries`);
    console.log(`Skipped: ${skippedCount} entries`);
    console.log(`Total entries: ${Object.keys(head2headData).length}`);
}

main().catch(console.error);
