// headlines.js — Fetch top headlines from Hacker News (with fallbacks)
const { scrape } = require('./tools/web-scraper.js');
const cheerio = require('cheerio');

const FALLBACK_URLS = [
  'https://news.ycombinator.com/',
  'https://www.reddit.com/r/programming/.rss',
  'https://lobste.rs/',
];

/**
 * Fetch and display up to 3 headlines from each fallback URL.
 */
async function runHeadlines() {
  for (const url of FALLBACK_URLS) {
    console.log(`\n--- ${url} ---`);
    const result = await scrape(url, { returnHtml: true });
    if (result.success && result.data.html) {
      const $ = cheerio.load(result.data.html);
      const links = [];
      $('a').each((i, el) => {
        if (i >= 3) return false; // stop after 3
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (href && text) {
          links.push({ href, text });
        }
      });
      if (links.length === 0) {
        console.log('  No links found.');
      } else {
        links.forEach((link, idx) => {
          console.log(`  ${idx + 1}. ${link.text} — ${link.href}`);
        });
      }
    } else {
      console.log(`  Failed to fetch: ${result.error || 'Unknown error'}`);
    }
  }
}

module.exports = { runHeadlines };
