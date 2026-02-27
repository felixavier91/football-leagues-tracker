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

const API_KEY = '224c667c50404db8adb4c989bc1715e3';
const SEASON = '2025'; // 2024/2025 season
const OUTPUT_DIR = 'output';

// Create output directory if it doesn't exist
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

// Function to fetch detailed match statistics
async function fetchMatchStats(matchId) {
    try {
        const response = await fetch(
            `http://api.football-data.org/v4/matches/${matchId}`,
            {
                headers: {
                    'X-Auth-Token': API_KEY
                }
            }
        );

        if (!response.ok) {
            console.log(`  ⚠ Match ${matchId}: HTTP ${response.status}`);
            return null;
        }

        const data = await response.json();
        return data;
    } catch (error) {
        console.log(`  ⚠ Match ${matchId}: ${error.message}`);
        return null;
    }
}

// Function to fetch data for a single league
async function fetchLeague(league) {
    console.log(`Fetching ${league.name}...`);
    
    try {
        const response = await fetch(
            `http://api.football-data.org/v4/competitions/${league.code}/matches?season=${SEASON}`,
            {
                headers: {
                    'X-Auth-Token': API_KEY,
                    'X-Unfold-Goals': 'true' // Get detailed match data
                }
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        
        // For Champions League, fetch standings as of matchday 8 (before playoffs)
        if (league.code === 'CL') {
            console.log(`  Fetching CL standings as of matchday 8...`);
            try {
                const standingsResponse = await fetch(
                    `http://api.football-data.org/v4/competitions/${league.code}/standings?season=${SEASON}&matchday=8`,
                    {
                        headers: {
                            'X-Auth-Token': API_KEY
                        }
                    }
                );
                if (standingsResponse.ok) {
                    const standingsData = await standingsResponse.json();
                    // Replace standings in match data with matchday 8 standings
                    if (standingsData.standings) {
                        data.standings = standingsData.standings;
                        console.log(`  ✓ Replaced CL standings with matchday 8 data`);
                    }
                }
            } catch (error) {
                console.log(`  ⚠ Could not fetch CL matchday 8 standings: ${error.message}`);
            }
        }
        
        // Save individual league file
        const filename = `${OUTPUT_DIR}/${league.code.toLowerCase()}.json`;
        fs.writeFileSync(filename, JSON.stringify(data, null, 2));
        
        console.log(`✓ ${league.name} saved to ${filename}`);
        
        return {
            code: league.code,
            name: league.name,
            country: league.country,
            data: data
        };
    } catch (error) {
        console.error(`✗ Error fetching ${league.name}:`, error.message);
        return null;
    }
}

// Function to fetch detailed stats for finished matches
async function fetchDetailedStats(matches, leagueName) {
    const matchStats = {};
    const finishedMatches = matches.filter(m => m.status === 'FINISHED');
    
    console.log(`\nFetching detailed stats for ${finishedMatches.length} finished matches in ${leagueName}...`);
    
    for (let i = 0; i < finishedMatches.length; i++) {
        const match = finishedMatches[i];
        const matchId = match.id;
        
        process.stdout.write(`  Progress: ${i + 1}/${finishedMatches.length} matches...\r`);
        
        const detailedMatch = await fetchMatchStats(matchId);
        
        if (detailedMatch) {
            matchStats[matchId] = detailedMatch;
        }
        
        // Rate limiting: wait 200ms between requests (max 5 requests/second)
        await delay(200);
    }
    
    console.log(`\n✓ Fetched detailed stats for ${Object.keys(matchStats).length} matches`);
    return matchStats;
}

// Function to add delay between requests
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function to fetch all leagues and their detailed stats
async function fetchAllLeagues() {
    console.log('Starting to fetch all leagues...\n');
    
    const results = {};
    const allMatchStats = {};
    
    // Step 1: Fetch all league matches
    for (const league of leagues) {
        const result = await fetchLeague(league);
        
        if (result) {
            results[league.code] = {
                name: league.name,
                country: league.country,
                matches: result.data.matches || []
            };
        }
        
        // Add delay to avoid rate limiting
        await delay(2000);
    }
    
    // Save combined matches file
    const combinedFilename = `${OUTPUT_DIR}/all_leagues.json`;
    fs.writeFileSync(combinedFilename, JSON.stringify(results, null, 2));
    console.log(`\n✓ Combined matches data saved to ${combinedFilename}`);
    
    // Step 2: Fetch detailed stats for finished matches
    console.log('\n=== FETCHING DETAILED MATCH STATISTICS ===\n');
    
    for (const league of leagues) {
        if (results[league.code]) {
            const matches = results[league.code].matches;
            const stats = await fetchDetailedStats(matches, league.name);
            allMatchStats[league.code] = stats;
            
            // Add delay between leagues
            await delay(2000);
        }
    }
    
    // Save match statistics file
    const statsFilename = `${OUTPUT_DIR}/match_statistics.json`;
    fs.writeFileSync(statsFilename, JSON.stringify(allMatchStats, null, 2));
    console.log(`\n✓ Match statistics saved to ${statsFilename}`);
    
    // Create a summary
    console.log('\n=== SUMMARY ===');
    Object.keys(results).forEach(code => {
        const matchCount = results[code].matches.length;
        const statsCount = allMatchStats[code] ? Object.keys(allMatchStats[code]).length : 0;
        console.log(`${results[code].name}: ${matchCount} matches (${statsCount} with detailed stats)`);
    });
    
    console.log('\n✓ All done! Files are in the output folder.');
    console.log('\nFiles created:');
    console.log('  - all_leagues.json (match data with goals/cards)');
    console.log('  - match_statistics.json (detailed stats: possession, shots, etc.)');
}

// Run the script
fetchAllLeagues().catch(error => {
    console.error('Fatal error:', error);
});
