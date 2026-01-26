#!/usr/bin/env python3
"""
RSS Feed Scraper for 101greatgoals.com
Fetches RSS feed, scrapes each article, and saves to JSON file
"""

import feedparser
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import time
import json

def fetch_rss_feed(feed_url):
    """Fetch and parse RSS feed"""
    print(f"Fetching RSS feed from {feed_url}...")
    feed = feedparser.parse(feed_url)
    print(f"Found {len(feed.entries)} articles in feed\n")
    return feed

def scrape_article(url):
    """Scrape article content from URL"""
    try:
        print(f"Fetching: {url}")
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.content, 'html.parser')
        
        # Try to find article content (common selectors)
        article_content = None
        
        # Try different common article selectors
        selectors = [
            'article',
            '.entry-content',
            '.post-content',
            '.article-content',
            'div[class*="content"]',
            '.single-post-content'
        ]
        
        for selector in selectors:
            article_content = soup.select_one(selector)
            if article_content:
                break
        
        if article_content:
            # Remove unwanted elements that cause indentation/spacing issues
            for element in article_content.find_all(['img', 'figure', 'figcaption', 'picture', 'iframe', 'video']):
                element.decompose()
            
            # Extract text from paragraphs
            paragraphs = article_content.find_all(['p', 'h1', 'h2', 'h3', 'h4'])
            full_text = '\n\n'.join([p.get_text().strip() for p in paragraphs if p.get_text().strip()])
            
            # Cut off text at unwanted sections (delete that line and everything after it)
            cutoff_phrases = [
                'Topics:',
                'Follow us:',
                'Latest News',
                'More from',
                'Mitch Fretton',
                '101GreatGoals',
                'Subscribe',
                'Newsletter',
                'Related articles',
                'Also read',
                'You might also like'
            ]
            
            # Find earliest cutoff point
            lines = full_text.split('\n')
            cutoff_index = len(lines)
            
            for i, line in enumerate(lines):
                line_lower = line.strip().lower()
                for phrase in cutoff_phrases:
                    if phrase.lower() in line_lower:
                        cutoff_index = min(cutoff_index, i)
                        print(f"  ✂️  Cutting at line {i}: '{line[:50]}...'")
                        break
            
            # Keep only lines before cutoff and strip each line
            clean_lines = [line.strip() for line in lines[:cutoff_index] if line.strip()]
            clean_text = '\n\n'.join(clean_lines)
            
            return clean_text if clean_text else "Could not extract article content"
        else:
            return "Could not extract article content"
            
    except Exception as e:
        return f"Error fetching article: {str(e)}"

def convert_timestamp(timestamp_str):
    """Convert RSS timestamp to ISO format for client-side rendering"""
    try:
        # Parse the timestamp
        dt = datetime.strptime(timestamp_str, '%a, %d %b %Y %H:%M:%S %z')
        # Return ISO format (browser will handle local timezone conversion)
        return dt.isoformat()
    except:
        return timestamp_str

def main():
    base_feed_url = "https://www.101greatgoals.com/football/feed/"
    output_file = "output/soccer_news.json"
    num_pages = 3
    
    all_articles = []
    
    # Fetch 10 pages
    for page in range(1, num_pages + 1):
        # Build feed URL with pagination
        if page == 1:
            feed_url = base_feed_url
        else:
            feed_url = f"{base_feed_url}?paged={page}"
        
        print(f"\n{'='*80}")
        print(f"FETCHING PAGE {page}/{num_pages}")
        print(f"{'='*80}")
        
        # Fetch RSS feed for this page
        feed = fetch_rss_feed(feed_url)
        
        if not feed.entries:
            print(f"No entries found on page {page}, stopping.")
            break
        
        # Process each article on this page
        for idx, entry in enumerate(feed.entries, 1):
            title = entry.title
            print(f"\n[Page {page} - Article {idx}/{len(feed.entries)}] Processing: {title}")
            
            # Filter out unwanted article types by headline
            title_lower = title.lower()
            
            # Skip articles with "Commentary"
            if 'commentary' in title_lower:
                print(f"  ⏭️  Skipping: Contains 'Commentary'")
                continue
            
            # Skip articles with "Report, result and goals"
            if 'report, result and goals' in title_lower:
                print(f"  ⏭️  Skipping: Contains 'Report, result and goals'")
                continue
            
            # Skip articles with score patterns like "3-1", "2-0", etc.
            import re
            if re.search(r'\b\d+-\d+\b', title):
                print(f"  ⏭️  Skipping: Contains score pattern (e.g., '3-1')")
                continue
            
            # Fetch full article content
            article_text = scrape_article(entry.link)
            
            # Build article object
            article = {
                "title": title,
                "url": entry.link,
                "published": convert_timestamp(entry.published) if hasattr(entry, 'published') else None,
                "summary": entry.summary if hasattr(entry, 'summary') else None,
                "content": article_text
            }
            
            all_articles.append(article)
            
            # Small delay to be respectful to the server
            time.sleep(1)
        
        # Delay between pages
        time.sleep(2)
    
    # Save to JSON
    output_data = {
        "generated": datetime.now().strftime('%B %d, %Y %I:%M:%S %p EST'),
        "source": "101 Great Goals",
        "total_articles": len(all_articles),
        "articles": all_articles
    }
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"\n✅ Done! Saved to {output_file}")
    print(f"Total articles processed: {len(all_articles)}")

if __name__ == "__main__":
    main()
