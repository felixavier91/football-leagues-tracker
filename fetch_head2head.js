// Fetch head2head data for upcoming matches (next 48 hours)
// Run daily at 6 AM

const https = require('https');
const fs = require('fs');

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;

function httpsGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        }).on('error', reject);
    });
}

async function fetchHead2Head(matchId) {
    const url = `https://api.football-data.org/v4/matches/${matchId}/head2head?limit=50`;
    console.log(`Fetching head2head for match ${matchId}...`);
    
    try {
        const data = await httpsGet(url, { 'X-Auth-Token': API_KEY });
        return data;
    } catch (error) {
        console.error(`Error fetching match ${matchId}:`, error.message);
        return null;
    }
}

async function main() {
    console.log('=== Fetching Head2Head Data ===');
    console.log('Time:', new Date().toISOString());
    
    // Load all leagues data
    const allLeaguesData = JSON.parse(fs.readFileSync('all_leagues.json', 'utf8'));
    
    // Load existing head2head data
    let head2headData = {};
    if (fs.existsSync('head2head.json')) {
        head2headData = JSON.parse(fs.readFileSync('head2head.json', 'utf8'));
        console.log(`Loaded ${Object.keys(head2headData).length} existing head2head entries`);
    }
    
    // Get current time and 48-hour window
    const now = new Date();
    const in48Hours = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    
    console.log(`Looking for matches between ${now.toISOString()} and ${in48Hours.toISOString()}`);
    
    // Find all matches in next 48 hours
    const upcomingMatches = [];
    
    for (const [leagueCode, leagueData] of Object.entries(allLeaguesData)) {
        if (!leagueData.matches) continue;
        
        for (const match of leagueData.matches) {
            const matchDate = new Date(match.utcDate);
            
            // Check if match is in next 48 hours
            if (matchDate >= now && matchDate <= in48Hours) {
                // Skip if already have data for this match
                if (head2headData[match.id]) {
                    console.log(`  Skipping match ${match.id} (already exists)`);
                    continue;
                }
                
                upcomingMatches.push({
                    id: match.id,
                    homeTeam: match.homeTeam.name,
                    awayTeam: match.awayTeam.name,
                    date: match.utcDate,
                    league: leagueCode
                });
            }
        }
    }
    
    console.log(`Found ${upcomingMatches.length} matches in next 48 hours`);
    
    // Fetch head2head for each match
    let fetchedCount = 0;
    
    for (const match of upcomingMatches) {
        console.log(`\n${match.homeTeam} vs ${match.awayTeam} (${match.league})`);
        
        const h2hData = await fetchHead2Head(match.id);
        
        if (h2hData) {
            head2headData[match.id] = h2hData;
            fetchedCount++;
            console.log(`  ✓ Fetched ${h2hData.matches?.length || 0} historical matches`);
        }
        
        // Rate limiting - wait 6 seconds between requests (10 requests per minute limit)
        if (fetchedCount < upcomingMatches.length) {
            await new Promise(resolve => setTimeout(resolve, 6000));
        }
    }
    
    // Save updated head2head data
    fs.writeFileSync('head2head.json', JSON.stringify(head2headData, null, 2));
    console.log(`\n=== Complete ===`);
    console.log(`Fetched: ${fetchedCount} new entries`);
    console.log(`Total entries: ${Object.keys(head2headData).length}`);
}

main().catch(console.error);
