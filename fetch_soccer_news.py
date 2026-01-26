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
            # Extract text from paragraphs
            paragraphs = article_content.find_all(['p', 'h1', 'h2', 'h3', 'h4'])
            text = '\n\n'.join([p.get_text().strip() for p in paragraphs if p.get_text().strip()])
            return text
        else:
            return "Could not extract article content"
            
    except Exception as e:
        return f"Error fetching article: {str(e)}"

def convert_timestamp_to_est(timestamp_str):
    """Convert RSS timestamp to EST"""
    try:
        # Parse the timestamp
        dt = datetime.strptime(timestamp_str, '%a, %d %b %Y %H:%M:%S %z')
        # Convert to EST (UTC-5)
        from datetime import timezone, timedelta
        est = timezone(timedelta(hours=-5))
        dt_est = dt.astimezone(est)
        return dt_est.strftime('%B %d, %Y %I:%M:%S %p EST')
    except:
        return timestamp_str

def main():
    feed_url = "https://www.101greatgoals.com/football/feed/"
    output_file = "output/soccer_news.json"
    
    # Fetch RSS feed
    feed = fetch_rss_feed(feed_url)
    
    articles = []
    
    # Process each article
    for idx, entry in enumerate(feed.entries, 1):
        print(f"\n[{idx}/{len(feed.entries)}] Processing: {entry.title}")
        
        # Fetch full article content
        article_text = scrape_article(entry.link)
        
        # Build article object
        article = {
            "title": entry.title,
            "url": entry.link,
            "published": convert_timestamp_to_est(entry.published) if hasattr(entry, 'published') else None,
            "summary": entry.summary if hasattr(entry, 'summary') else None,
            "content": article_text
        }
        
        articles.append(article)
        
        # Small delay to be respectful to the server
        time.sleep(1)
    
    # Save to JSON
    output_data = {
        "generated": datetime.now().strftime('%B %d, %Y %I:%M:%S %p EST'),
        "source": "101 Great Goals",
        "total_articles": len(articles),
        "articles": articles
    }
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)
    
    print(f"\n✅ Done! Saved to {output_file}")
    print(f"Total articles processed: {len(articles)}")

if __name__ == "__main__":
    main()
