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

// Function to fetch data for a single league
async function fetchLeague(league) {
    console.log(`Fetching ${league.name}...`);
    
    try {
        const response = await fetch(
            `http://api.football-data.org/v4/competitions/${league.code}/matches?season=${SEASON}`,
            {
                headers: {
                    'X-Auth-Token': API_KEY
                }
            }
        );

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        
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

// Function to add delay between requests
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function to fetch all leagues
async function fetchAllLeagues() {
    console.log('Starting to fetch all leagues...\n');
    
    const results = {};
    
    for (const league of leagues) {
        const result = await fetchLeague(league);
        
        if (result) {
            results[league.code] = {
                name: league.name,
                country: league.country,
                matches: result.data.matches || []
            };
        }
        
        // Add delay to avoid rate limiting (free tier usually has limits)
        await delay(2000); // 2 second delay between requests
    }
    
    // Save combined file
    const combinedFilename = `${OUTPUT_DIR}/all_leagues.json`;
    fs.writeFileSync(combinedFilename, JSON.stringify(results, null, 2));
    console.log(`\n✓ Combined data saved to ${combinedFilename}`);
    
    // Create a summary
    console.log('\n=== SUMMARY ===');
    Object.keys(results).forEach(code => {
        console.log(`${results[code].name}: ${results[code].matches.length} matches`);
    });
    
    console.log('\n✓ All done! Files are in the output folder.');
}

// Run the script
fetchAllLeagues().catch(error => {
    console.error('Fatal error:', error);
});
