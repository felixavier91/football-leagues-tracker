# Football Leagues Tracker - Deployment Guide

This guide will help you deploy your football leagues tracker to GitHub Pages with automatic daily updates.

## Prerequisites
- GitHub account (free)
- Your Football Data API key: `224c667c50404db8adb4c989bc1715e3`

## Step-by-Step Setup

### 1. Create a GitHub Repository

1. Go to https://github.com/new
2. Repository name: `football-leagues-tracker` (or any name you like)
3. Make it **Public** (required for free GitHub Pages)
4. Click "Create repository"

### 2. Upload Your Files

Upload these files to your repository:
- `fetch_all_leagues.js` - The script that fetches league data
- `all_leagues_viewer.html` - Rename to `index.html` (this makes it the default page)
- `.github/workflows/update-data.yml` - The automation script (create the folders)

### 3. Add Your API Key as a Secret

1. Go to your repository settings
2. Click "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. Name: `FOOTBALL_API_KEY`
5. Value: `224c667c50404db8adb4c989bc1715e3`
6. Click "Add secret"

### 4. Enable GitHub Pages

1. Go to repository Settings → Pages
2. Source: Deploy from a branch
3. Branch: `main` (or `master`)
4. Folder: `/ (root)`
5. Click Save

### 5. Wait for First Run

The workflow will run automatically:
- Every day at 3 AM UTC
- Or manually trigger it from Actions tab

Your site will be live at:
`https://YOUR_USERNAME.github.io/football-leagues-tracker/`

## How It Works

1. **Daily at 3 AM UTC**: GitHub Actions runs `fetch_all_leagues.js`
2. **Data is fetched**: All league data for 2025 season is downloaded
3. **Files are saved**: `all_leagues.json` is created in the `output` folder
4. **Commit & Push**: Changes are automatically committed to the repository
5. **GitHub Pages updates**: Your website refreshes with the new data
6. **Auto-selects matchday**: The viewer automatically shows the most recent finished matchday

## Manual Trigger

You can also manually update the data:
1. Go to "Actions" tab in your repository
2. Click "Update Football Data"
3. Click "Run workflow" → "Run workflow"

## File Structure

```
your-repo/
├── index.html                    # Your viewer (renamed from all_leagues_viewer.html)
├── fetch_all_leagues.js          # Data fetching script
├── output/
│   ├── all_leagues.json         # Combined data (auto-generated)
│   ├── pd.json                   # La Liga data (auto-generated)
│   ├── pl.json                   # Premier League data (auto-generated)
│   └── ... other leagues
└── .github/
    └── workflows/
        └── update-data.yml       # Automation script
```

## Important Notes

- The free API tier has rate limits - the script includes delays
- GitHub Actions are free for public repositories
- Data updates once per day automatically
- The matchday auto-advances as matches are played
- All times are in UTC (convert to your timezone if needed)

## Troubleshooting

**Site not loading?**
- Make sure `index.html` is in the root folder
- Check GitHub Pages is enabled in Settings

**Data not updating?**
- Check the Actions tab for errors
- Verify your API key is correct in Secrets

**Rate limit errors?**
- The free API tier has limits
- Consider upgrading or reducing update frequency

## Customization

### Change Update Time
Edit `.github/workflows/update-data.yml`:
```yaml
- cron: '0 3 * * *'  # Change to your preferred time (24h format, UTC)
```

### Change Season
Edit `fetch_all_leagues.js`:
```javascript
const SEASON = '2025';  # Change to desired season
```

Enjoy your automatically updating football tracker! ⚽
