const fs = require('fs');

// Define all leagues
const leagues = [
    { code: 'PD', name: 'La Liga', country: 'Spain' },
    { code: 'PL', name: 'Premier League', country: 'England' },
    { code: 'BL1', name: 'Bundesliga', country: 'Germany' },
    { code: 'SA', name: 'Serie A', country: 'Italy' },
    { code: 'FL1', name: 'Ligue 1', country: 'France' },
    { code: 'PPL', name: 'Primeira Liga', country: 'Portugal' },
    { code: 'DED', name: 'Eredivisie', country: 'Netherlands' },
    { code: 'CL', name: 'Champions League', country: 'Europe' },
];

// *** MANUAL LEAGUE FILTER ***
// Comment out any leagues you DON'T want to process
const LEAGUES_TO_PROCESS = [
    'PL',   // Premier League
    'PD',   // La Liga
    'BL1',  // Bundesliga
    'SA',   // Serie A
    'FL1',  // Ligue 1
    'PPL',  // Primeira Liga
    'DED',  // Eredivisie
    'CL',   // Champions League
];

const API_KEY = '224c667c50404db8adb4c989bc1715e3';
const SEASON = '2025';
const OUTPUT_DIR = 'output';

// Check if we should fetch all matches or just today's
const FETCH_ALL = process.argv.includes('--all');

// Create output directory if it doesn't exist
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

// Get today's date and yesterday's date in YYYY-MM-DD format
function getRecentDates() {
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    return {
        today: today.toISOString().split('T')[0],
        yesterday: yesterday.toISOString().split('T')[0]
    };
}

// Function to fetch detailed match statistics
async function fetchMatchStats(matchId) {
    try {
        const response = await fetch(
            `http://api.football-data.org/v4/matches/${matchId}`,
            {
                headers: {
                    'X-Auth-Token': API_KEY,
                    'X-Unfold-Goals': 'true',
                    'X-Unfold-Bookings': 'true', 
                    'X-Unfold-Substitutions': 'true',
                    'X-Unfold-Lineups': 'true',
                    'X-Unfold-Referees': 'true'
                }
            }
        );

        if (!response.ok) {
            return null;
        }

        const data = await response.json();
        return data;
    } catch (error) {
        return null;
    }
}

// Function to add delay between requests
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Load existing match statistics (if any)
function loadExistingStats() {
    const statsFile = `${OUTPUT_DIR}/match_statistics.json`;
    if (fs.existsSync(statsFile)) {
        const data = fs.readFileSync(statsFile, 'utf8');
        return JSON.parse(data);
    }
    return {};
}

// Main function
async function fetchMatchStatistics() {
    const dates = getRecentDates();
    
    console.log('=== FETCH MATCH STATISTICS ===');
    console.log(`Mode: ${FETCH_ALL ? 'BACKFILL ALL MATCHES' : 'RECENT MATCHES (LAST 48 HOURS)'}`);
    console.log(`Checking dates: ${dates.yesterday} and ${dates.today}\n`);
    
    // Load existing statistics
    let allStats = loadExistingStats();
    
    // Try multiple possible locations for all_leagues.json
    const possiblePaths = [
        `${OUTPUT_DIR}/all_leagues.json`,
        'all_leagues.json',
        '../all_leagues.json'
    ];
    
    let allLeaguesFile = null;
    for (const path of possiblePaths) {
        if (fs.existsSync(path)) {
            allLeaguesFile = path;
            console.log(`Found all_leagues.json at: ${path}\n`);
            break;
        }
    }
    
    if (!allLeaguesFile) {
        console.error('Error: all_leagues.json not found in any expected location.');
        console.error('Searched:', possiblePaths.join(', '));
        return;
    }
    
    const allLeagues = JSON.parse(fs.readFileSync(allLeaguesFile, 'utf8'));
    
    let totalMatches = 0;
    let fetchedMatches = 0;
    let skippedMatches = 0;
    
    // Process each league
    for (const [leagueCode, leagueData] of Object.entries(allLeagues)) {
        // Skip if league not in filter
        if (!LEAGUES_TO_PROCESS.includes(leagueCode)) {
            console.log(`\n⏭️  Skipping ${leagueData.name} (not in LEAGUES_TO_PROCESS)`);
            continue;
        }
        
        console.log(`\nProcessing ${leagueData.name}...`);
        
        if (!allStats[leagueCode]) {
            allStats[leagueCode] = {};
        }
        
        // Debug: Show total matches in league
        console.log(`  Total matches in league: ${leagueData.matches.length}`);
        
        // Filter matches based on mode
        let matchesToFetch;
        if (FETCH_ALL) {
            // Fetch all finished matches
            matchesToFetch = leagueData.matches.filter(m => m.status === 'FINISHED');
            console.log(`  Finished matches (all time): ${matchesToFetch.length}`);
        } else {
            // Fetch matches from the last 48 hours that are finished
            const recentFinished = leagueData.matches.filter(m => {
                const matchDate = m.utcDate.split('T')[0];
                const isRecent = matchDate === dates.today || matchDate === dates.yesterday;
                const isFinished = m.status === 'FINISHED';
                
                // Debug logging
                if (isRecent) {
                    console.log(`    Match on ${matchDate}: ${m.homeTeam.shortName} vs ${m.awayTeam.shortName} - Status: ${m.status}`);
                }
                
                return isRecent && isFinished;
            });
            matchesToFetch = recentFinished;
            console.log(`  Matches in last 48h: ${leagueData.matches.filter(m => {
                const matchDate = m.utcDate.split('T')[0];
                return matchDate === dates.today || matchDate === dates.yesterday;
            }).length}`);
            console.log(`  Finished matches in last 48h: ${matchesToFetch.length}`);
        }
        
        if (matchesToFetch.length === 0) {
            console.log(`  ⚠ No matches to fetch for this league`);
            continue;
        }
        
        console.log(`  Found ${matchesToFetch.length} matches to process`);
        totalMatches += matchesToFetch.length;
        
        // Fetch stats for each match
        for (let i = 0; i < matchesToFetch.length; i++) {
            const match = matchesToFetch[i];
            const matchId = String(match.id); // Convert to string for consistent checking
            
            // In --all mode, skip if we already have stats
            // In 48-hour mode, always fetch to get latest data
            if (FETCH_ALL && allStats[leagueCode][matchId]) {
                skippedMatches++;
                process.stdout.write(`  [${i + 1}/${matchesToFetch.length}] Match ${matchId} - SKIPPED (already exists)\r`);
                continue;
            }
            
            process.stdout.write(`  [${i + 1}/${matchesToFetch.length}] Match ${matchId} - Fetching...\r`);
            
            const detailedMatch = await fetchMatchStats(matchId);
            
            if (detailedMatch) {
                allStats[leagueCode][matchId] = detailedMatch;
                
                // Check if statistics were actually included
                const hasStats = detailedMatch.homeTeam?.statistics && detailedMatch.awayTeam?.statistics;
                const statusMsg = hasStats ? '✓ HAS STATS' : '⚠ NO STATS';
                console.log(`  [${i + 1}/${matchesToFetch.length}] Match ${matchId} - ${statusMsg}`);
                
                fetchedMatches++;
            } else {
                console.log(`  [${i + 1}/${matchesToFetch.length}] Match ${matchId} - ❌ FETCH FAILED`);
            }
            
            // NO DELAY - fetch as fast as possible
        }
        
        console.log(`\n  ✓ Completed ${leagueData.name}`);
        
        // Count matches with actual statistics
        const matchesWithStats = Object.values(allStats[leagueCode]).filter(m => 
            m.homeTeam?.statistics && m.awayTeam?.statistics
        ).length;
        console.log(`  📊 Matches with statistics: ${matchesWithStats}/${Object.keys(allStats[leagueCode]).length}`);
        
        // Save after completing each league
        const statsFile = `${OUTPUT_DIR}/match_statistics.json`;
        fs.writeFileSync(statsFile, JSON.stringify(allStats, null, 2));
        console.log(`  💾 Saved progress to ${statsFile}`);
    }
    
    // Save updated statistics
    const statsFile = `${OUTPUT_DIR}/match_statistics.json`;
    fs.writeFileSync(statsFile, JSON.stringify(allStats, null, 2));
    
    console.log('\n=== SUMMARY ===');
    console.log(`Total matches processed: ${totalMatches}`);
    console.log(`Newly fetched: ${fetchedMatches}`);
    console.log(`Skipped (already exists): ${skippedMatches}`);
    
    // Count total matches with actual statistics across all leagues
    let totalWithStats = 0;
    let totalWithoutStats = 0;
    for (const [code, matches] of Object.entries(allStats)) {
        const withStats = Object.values(matches).filter(m => m.homeTeam?.statistics && m.awayTeam?.statistics).length;
        const withoutStats = Object.keys(matches).length - withStats;
        totalWithStats += withStats;
        totalWithoutStats += withoutStats;
        if (Object.keys(matches).length > 0) {
            console.log(`  ${code}: ${withStats} with stats, ${withoutStats} without stats`);
        }
    }
    console.log(`\nGRAND TOTAL: ${totalWithStats} matches WITH statistics, ${totalWithoutStats} WITHOUT statistics`);
    
    console.log(`\n✓ Match statistics saved to ${statsFile}`);
    
    if (!FETCH_ALL) {
        console.log('\nℹ To backfill all historical matches, run: node fetch_match_statistics.js --all');
    }
}

// Run the script
fetchMatchStatistics().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
