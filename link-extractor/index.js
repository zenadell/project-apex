const fetch = globalThis.fetch;
const cheerio = require('cheerio');
const url = process.argv[2];
if (!url) {
  console.error('Usage: node index.js <url>');
  process.exit(1);
}
fetch(url)
  .then(res => res.text())
  .then(html => {
    const $ = cheerio.load(html);
    const links = [];
    $('a[href]').each((i, el) => {
      links.push($(el).attr('href'));
    });
    require('fs').writeFileSync('extracted_links.json', JSON.stringify(links, null, 2));
    console.log('Links extracted to extracted_links.json');
  })
  .catch(err => {
    console.error(err);
    process.exit(1);
  });