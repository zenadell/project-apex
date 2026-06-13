const axios = require('axios');
const cheerio = require('cheerio');

const FALLBACK_URLS = [
  'https://news.ycombinator.com',
  'https://news.ycombinator.com/newest',
  'https://news.ycombinator.com/ask',
];

async function runHeadlines() {
  for (const url of FALLBACK_URLS) {
    console.log(`\n--- ${url} ---`);
    try {
      const response = await axios.get(url, { timeout: 10000 });
      const $ = cheerio.load(response.data);
      const links = [];
      $('a').each((i, el) => {
        if (i >= 3) return false;
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (text && href) {
          links.push({ text, href });
        }
      });
      if (links.length > 0) {
        links.forEach((l, idx) => {
          console.log(`${idx + 1}. ${l.text} -> ${l.href}`);
        });
        return; // stop after first successful fetch
      }
    } catch (err) {
      console.error(`Error fetching ${url}: ${err.message}`);
    }
  }
  console.log('No headlines found.');
}

module.exports = { runHeadlines };

// If run directly
if (require.main === module) {
  runHeadlines().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
