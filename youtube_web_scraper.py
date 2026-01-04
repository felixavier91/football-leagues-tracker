#!/usr/bin/env python3
"""
YouTube Highlights Web Scraper (No API Required)
Automatically finds YouTube highlight video IDs by scraping the YouTube website
Can be scheduled to run daily automatically
"""

import json
import time
import unicodedata
import re
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from datetime import datetime

# ============================================
# CONFIGURATION
# ============================================

# Configuration
INPUT_FILE = "highlights_database.json"
ALL_LEAGUES_FILE = "all_leagues.json"  # Source of match data
OUTPUT_FILE = "highlights_database_updated.json"

# Search settings
DELAY_BETWEEN_SEARCHES = 2  # Seconds (be nice to YouTube)

# Processing mode
TODAY_ONLY = True  # Set to True to only process today's matches, False to backfill all historical matches

# Leagues to process (set to None to process all)
LEAGUES_TO_PROCESS = ["PD", "PL", "FL1", "BL1", "SA", "PPL", "DED", "CL"]  # PD = La Liga, PL = Premier League, FL1 = Ligue 1, BL1 = Bundesliga, SA = Serie A, PPL = Primeira Liga, DED = Eredivisie, CL = Champions League
MAX_MATCHES_TO_PROCESS = None  # Process ALL finished matches

# Browser settings
HEADLESS = True  # Set to False to see the browser in action

# ============================================
# Text Normalization
# ============================================

def normalize_text(text):
    """
    Normalize text by removing accents and replacing special characters
    Examples:
    - "Deportivo Alavés" → "Deportivo Alaves"
    - "FC København" → "FC Kobenhavn"
    - "São Paulo" → "Sao Paulo"
    """
    # First, try to decompose and remove accents
    nfd = unicodedata.normalize('NFD', text)
    text_without_accents = ''.join(char for char in nfd if unicodedata.category(char) != 'Mn')
    
    # Then replace special characters that don't decompose
    replacements = {
        'ø': 'o', 'Ø': 'O',
        'æ': 'ae', 'Æ': 'AE',
        'œ': 'oe', 'Œ': 'OE',
        'ß': 'ss',
        'ð': 'd', 'Ð': 'D',
        'þ': 'th', 'Þ': 'TH',
        'đ': 'd', 'Đ': 'D',
        'ł': 'l', 'Ł': 'L',
        'ı': 'i', 'İ': 'I',
        'ş': 's', 'Ş': 'S',
        'ğ': 'g', 'Ğ': 'G',
        'ç': 'c', 'Ç': 'C',
    }
    
    for special, replacement in replacements.items():
        text_without_accents = text_without_accents.replace(special, replacement)
    
    # Remove any remaining non-ASCII characters
    text_ascii = text_without_accents.encode('ascii', 'ignore').decode('ascii')
    
    return text_ascii


def extract_team_keywords(team_name):
    """
    Extract key identifying words from team name.
    Examples:
    - "Real Madrid" -> ["Madrid"]
    - "Deportivo Alavés" -> ["Alaves"]
    - "FC Barcelona" -> ["Barcelona"]
    - "Atlético Madrid" -> ["Atletico"]
    - "RCD Espanyol de Barcelona" -> ["Espanyol"]
    """
    # Common prefixes/suffixes to skip
    skip_words = {
        'fc', 'cf', 'ud', 'cd', 'sd', 'rcd', 'real', 'club', 'deportivo', 
        'atletico', 'athletic', 'de', 'del', 'la', 'las', 'los', 'el',
        'sporting', 'racing', 'union', 'royal', 'united'
    }
    
    # Split and normalize
    words = normalize_text(team_name).lower().split()
    
    # Filter out short words and common prefixes
    keywords = [w for w in words if len(w) > 3 and w not in skip_words]
    
    # If we filtered everything out, use the last word (usually most distinctive)
    if not keywords:
        keywords = [words[-1]] if words else []
    
    return keywords


def create_search_query(home_team, away_team, match_date, league_code):
    """
    Create search query: "HomeTeam-AwayTeam-YYYY-MM-DD highlights [BROADCASTER]"
    Normalize team names to remove accents
    Uses different broadcasters per league:
    - La Liga (PD): ESPN
    - Premier League (PL): NBC Sports
    - Ligue 1 (FL1): beIN SPORTS USA
    - Bundesliga (BL1): Bundesliga
    - Serie A (SA): CBS Sports Golazo
    - Primeira Liga (PPL): VSPORTS - Liga Portugal
    - Eredivisie (DED): Eredivisie
    - Champions League (CL): CBS Sports Golazo
    """
    # Normalize team names
    home_normalized = normalize_text(home_team)
    away_normalized = normalize_text(away_team)
    
    # Choose broadcaster based on league
    if league_code == "PL":
        broadcaster = "NBC Sports"
    elif league_code == "PD":
        broadcaster = "ESPN"
    elif league_code == "FL1":
        broadcaster = "beIN SPORTS USA"
    elif league_code == "BL1":
        broadcaster = "Bundesliga"
    elif league_code == "SA":
        broadcaster = "CBS Sports Golazo"
    elif league_code == "PPL":
        broadcaster = "sport tv"
    elif league_code == "DED":
        broadcaster = "Eredivisie"
    elif league_code == "CL":
        broadcaster = "CBS Sports Golazo"
    else:
        broadcaster = "highlights"  # Default for other leagues
    
    # Format: Team-Team-Date highlights [Broadcaster]
    query = f"{home_normalized}-{away_normalized}-{match_date} highlights {broadcaster}"
    
    return query


# ============================================
# YouTube Web Scraping
# ============================================

def setup_browser():
    """
    Setup Selenium browser (Chrome) with automatic driver management
    """
    chrome_options = Options()
    
    if HEADLESS:
        chrome_options.add_argument("--headless")
    
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
    
    # Use webdriver-manager to automatically download and manage ChromeDriver
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)
    return driver


def search_youtube_web(driver, query, match_date, home_team, away_team, league_code):
    """
    Search YouTube and return first video uploaded on match date with team keywords in title
    Filters out blocked channels that don't allow embedding
    """
    try:
        # Go to YouTube
        driver.get("https://www.youtube.com")
        time.sleep(1)
        
        # Find search box and enter query
        search_box = WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.NAME, "search_query"))
        )
        search_box.clear()
        search_box.send_keys(query)
        search_box.send_keys(Keys.RETURN)
        
        # Wait for results to load
        time.sleep(2)
        
        # Find video renderers (contain both video link and metadata)
        video_renderers = WebDriverWait(driver, 10).until(
            EC.presence_of_all_elements_located((By.CSS_SELECTOR, "ytd-video-renderer"))
        )
        
        # Parse match date and calculate days ago
        from datetime import datetime
        match_date_obj = datetime.strptime(match_date, "%Y-%m-%d")
        today = datetime.now()
        days_ago = (today - match_date_obj).days
        
        # Extract team keywords
        home_keywords = extract_team_keywords(home_team)
        away_keywords = extract_team_keywords(away_team)
        
        print(f"  📅 Match was {days_ago} days ago")
        print(f"  🔑 Looking for keywords: {home_keywords} vs {away_keywords}")
        
        # Check top 10 results
        for renderer in video_renderers[:10]:
            try:
                # Get video link and title
                video_link = renderer.find_element(By.CSS_SELECTOR, "a#video-title")
                video_url = video_link.get_attribute("href")
                video_title = video_link.get_attribute("title")
                
                if not video_url or "watch?v=" not in video_url:
                    continue
                
                video_title_lower = video_title.lower()
                
                # Block videos with "laliga ea sports" anywhere in title (official channel that blocks embedding)
                # This exact phrase appears in all their videos
                if league_code == "PD" and "laliga ea sports" in video_title_lower:
                    print(f"  ⏭️  Skipping (LaLiga EA Sports official): {video_title}")
                    continue
                
                # Check if at least one keyword from EITHER team is in the title
                home_match = any(keyword in video_title_lower for keyword in home_keywords)
                away_match = any(keyword in video_title_lower for keyword in away_keywords)
                
                if not (home_match or away_match):
                    print(f"  ⏭️  Skipping (no team keywords found): {video_title}")
                    continue
                
                # Try to get upload date from metadata text
                try:
                    metadata = renderer.find_element(By.CSS_SELECTOR, "#metadata-line")
                    metadata_text = metadata.text.lower()
                    
                    # Check if upload date matches (within 1 day tolerance)
                    upload_matches = False
                    
                    # Recent uploads (0-1 days ago)
                    if days_ago == 0:
                        upload_matches = any(x in metadata_text for x in 
                            ["hour ago", "hours ago", "minute ago", "minutes ago", "just now"])
                    elif days_ago == 1:
                        upload_matches = "1 day ago" in metadata_text or any(x in metadata_text for x in 
                            ["hour ago", "hours ago"])
                    # 2-60 days ago
                    elif days_ago < 60:
                        # First check for exact days (with ±2 day tolerance to catch all uploads)
                        for tolerance in range(-2, 3):  # -2, -1, 0, +1, +2 days
                            check_days = days_ago + tolerance
                            if check_days > 0:
                                if f"{check_days} day ago" in metadata_text or f"{check_days} days ago" in metadata_text:
                                    upload_matches = True
                                    break
                        
                        # YouTube switches to "weeks ago" around 14 days, so also check weeks format
                        if not upload_matches and days_ago >= 12:
                            weeks_ago = days_ago // 7
                            for week_tolerance in range(-1, 2):
                                check_weeks = weeks_ago + week_tolerance
                                if check_weeks > 0:
                                    if f"{check_weeks} week ago" in metadata_text or f"{check_weeks} weeks ago" in metadata_text:
                                        upload_matches = True
                                        break
                        
                        # YouTube can also show "1 month ago" for videos around 30 days
                        if not upload_matches and days_ago >= 28:
                            if "1 month ago" in metadata_text:
                                upload_matches = True
                    # 60+ days ago (check for months)
                    elif days_ago < 365:
                        months_ago = days_ago // 30
                        # Check current month and adjacent months due to rounding
                        for month_tolerance in range(-1, 2):
                            check_months = months_ago + month_tolerance
                            if check_months > 0:
                                if f"{check_months} month ago" in metadata_text or f"{check_months} months ago" in metadata_text:
                                    upload_matches = True
                                    break
                        
                        # Also check for exact date format for older videos
                        if not upload_matches:
                            date_str = match_date_obj.strftime("%b %d, %Y").lower()
                            if date_str in metadata_text:
                                upload_matches = True
                    
                    if not upload_matches:
                        print(f"  ⏭️  Skipping (upload date mismatch): {video_title}")
                        print(f"      Metadata: {metadata_text}")
                        continue
                    
                except Exception as e:
                    print(f"  ⚠️  Could not verify upload date: {video_title}")
                    continue
                
                # All checks passed!
                video_id = video_url.split("watch?v=")[1].split("&")[0]
                print(f"  ✅ Found valid video: {video_title}")
                print(f"      Upload info: {metadata_text}")
                return video_id, video_title
                    
            except Exception as e:
                continue
        
        # No valid videos found
        print(f"  ❌ No videos with matching upload date found")
        return None, None
        
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return None, None


# ============================================
# Main Processing
# ============================================

def process_matches():
    """
    Main function to process matches and find video IDs
    """
    print("🔍 YouTube Highlights Web Scraper")
    print("=" * 60)
    print("📅 Running at:", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print(f"⚙️  Mode: {'TODAY ONLY (re-scraping today matches)' if TODAY_ONLY else 'BACKFILL (all historical matches)'}")
    
    # Load all_leagues.json (source of truth for match data)
    print(f"\n📂 Loading {ALL_LEAGUES_FILE}...")
    try:
        with open(ALL_LEAGUES_FILE, 'r', encoding='utf-8') as f:
            all_leagues_data = json.load(f)
    except FileNotFoundError:
        print(f"❌ Error: {ALL_LEAGUES_FILE} not found!")
        return
    
    # Load existing highlights database
    print(f"📂 Loading {INPUT_FILE}...")
    try:
        with open(INPUT_FILE, 'r', encoding='utf-8') as f:
            highlights_data = json.load(f)
            highlights = highlights_data["highlights"]
    except FileNotFoundError:
        print(f"⚠️  {INPUT_FILE} not found, creating new database...")
        highlights = {}
    
    # Collect matches to process from all_leagues.json
    matches_to_process = []
    
    for league_code, league_data in all_leagues_data.items():
        # Skip if league not in filter
        if LEAGUES_TO_PROCESS and league_code not in LEAGUES_TO_PROCESS:
            continue
        
        # Ensure league exists in highlights database
        if league_code not in highlights:
            highlights[league_code] = {}
        
        season = "2025-26"
        if season not in highlights[league_code]:
            highlights[league_code][season] = {}
        
        # Process each match from all_leagues.json
        for match in league_data["matches"]:
            # Check if match should be finished (2+ hours after kickoff)
            from datetime import datetime, timedelta
            match_datetime = datetime.fromisoformat(match["utcDate"].replace('Z', '+00:00'))
            time_since_kickoff = datetime.now(match_datetime.tzinfo) - match_datetime
            
            # Match is "finished" if 2+ hours have passed since kickoff OR status is FINISHED
            is_finished = (time_since_kickoff >= timedelta(hours=2)) or (match["status"] == "FINISHED")
            
            if is_finished:
                # Create match key
                match_date = match["utcDate"].split("T")[0]
                home_team = match["homeTeam"]["name"]
                away_team = match["awayTeam"]["name"]
                match_key = f"{home_team}-{away_team}-{match_date}"
                
                # If TODAY_ONLY mode, skip matches that aren't from today
                if TODAY_ONLY:
                    from datetime import date
                    today = date.today().isoformat()
                    if match_date != today:
                        continue  # Skip this match, it's not from today
                
                # Check if match already exists in database with a videoId
                existing_video_id = highlights[league_code][season].get(match_key, {}).get("videoId")
                
                # Add to highlights database if not exists
                if match_key not in highlights[league_code][season]:
                    highlights[league_code][season][match_key] = {
                        "homeTeam": home_team,
                        "awayTeam": away_team,
                        "date": match_date,
                        "matchday": match.get("matchday", 0),
                        "status": "FINISHED",
                        "videoId": None
                    }
                
                # Process logic based on mode
                should_process = False
                
                if TODAY_ONLY:
                    # In TODAY_ONLY mode: always re-scrape today's matches (even if they have a videoId)
                    should_process = True
                else:
                    # In backfill mode: only process if videoId is null
                    should_process = (existing_video_id is None)
                
                if should_process:
                    matches_to_process.append({
                        "league_code": league_code,
                        "season": season,
                        "match_key": match_key,
                        "match_data": {
                            "homeTeam": home_team,
                            "awayTeam": away_team,
                            "date": match_date
                        }
                    })
    
    # Sort by date (most recent first)
    matches_to_process.sort(key=lambda x: x["match_data"]["date"], reverse=True)
    
    # Limit number of matches if specified
    if MAX_MATCHES_TO_PROCESS:
        matches_to_process = matches_to_process[:MAX_MATCHES_TO_PROCESS]
    
    total_matches = len(matches_to_process)
    print(f"\n📊 Found {total_matches} matches to process")
    
    if total_matches == 0:
        print("\n✅ No matches to process!")
        return
    
    # Setup browser
    print("\n🌐 Starting browser...")
    driver = setup_browser()
    
    # Process each match
    updated_count = 0
    failed_count = 0
    
    print(f"\n🎥 Starting YouTube search...\n")
    
    try:
        for i, item in enumerate(matches_to_process, 1):
            match_data = item["match_data"]
            home_team = match_data["homeTeam"]
            away_team = match_data["awayTeam"]
            match_date = match_data["date"]
            league_code = item["league_code"]
            
            # Create search query with normalization and date (broadcaster varies by league)
            query = create_search_query(home_team, away_team, match_date, league_code)
            
            print(f"[{i}/{total_matches}] {home_team} vs {away_team} ({match_date})")
            print(f"  🔎 Searching: \"{query}\"")
            
            # Search YouTube - verify upload date and team keywords, filter blocked channels
            video_id, video_title = search_youtube_web(driver, query, match_date, home_team, away_team, league_code)
            
            if video_id:
                # Update the database
                highlights[item["league_code"]][item["season"]][item["match_key"]]["videoId"] = video_id
                print(f"  ✅ Found: {video_title}")
                print(f"  📺 Video ID: {video_id}")
                updated_count += 1
            else:
                print(f"  ⚠️  No video found")
                failed_count += 1
            
            print()
            
            # Delay to avoid being blocked
            if i < total_matches:
                time.sleep(DELAY_BETWEEN_SEARCHES)
    
    finally:
        # Close browser
        print("🔒 Closing browser...")
        driver.quit()
    
    # Save updated database
    print("=" * 60)
    print(f"\n💾 Saving to {OUTPUT_FILE}...")
    
    output_data = {
        "highlights": highlights
    }
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    # Summary
    print("\n📊 Summary:")
    print(f"  ✅ Updated: {updated_count}")
    print(f"  ⚠️  Failed: {failed_count}")
    print(f"  📁 Output: {OUTPUT_FILE}")
    print(f"  🕐 Finished at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("\n✨ Done!\n")


# ============================================
# Main
# ============================================

if __name__ == "__main__":
    process_matches()
