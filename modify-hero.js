```javascript
#!/usr/bin/env node

/**
 * modify-hero.js
 * 
 * Reads dashboard/index.html, inserts a new #hero section containing an <img> tag
 * with src='selfie.jpg', adds responsive CSS for max-width, centering and scaling,
 * and saves the modified file.
 * 
 * Architecture: Uses cheerio for robust DOM insertion and CSS rule management.
 * Assumes backup index.html.bak already exists from previous step (backup.js).
 * 
 * Dependencies: cheerio (npm install cheerio)
 * Build: node modify-hero.js
 * Test: node modify-hero.js (logs success/error)
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const sourcePath = path.join(__dirname, 'dashboard', 'index.html');

try {
  // Read the existing HTML file
  const html = fs.readFileSync(sourcePath, 'utf8');

  // Load into cheerio for DOM manipulation
  const $ = cheerio.load(html);

  // --- Step 1: Inject responsive CSS into <head> ---
  const heroCss = `
    #hero {
      text-align: center; /* fallback centering for inline elements */
    }
    #hero img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
  `;

  // Append a new <style> block if <head> exists, otherwise create one
  if ($('head').length) {
    $('head').append(`<style>${heroCss}</style>`);
  } else {
    // If no <head>, prepend a new one (unlikely but robust)
    $('html').prepend('<head><style>' + heroCss + '</style></head>');
  }

  // --- Step 2: Insert the #hero section before </body> ---
  const heroSection = `
    <section id="hero">
      <img src="selfie.jpg" alt="Selfie">
    </section>
  `;

  // Append to body; create <body> if missing
  if ($('body').length) {
    $('body').append(heroSection);
  } else {
    // If no body, wrap everything in <body> (edge case)
    const bodyContent = $.html().replace(/<\/?body>/g, '');
    $('html').html('');
    $('html').append(`<body>${bodyContent}${heroSection}</body>`);
  }

  // --- Step 3: Write modified HTML back to file ---
  const modifiedHtml = $.html();
  fs.writeFileSync(sourcePath, modifiedHtml, 'utf8');
  console.log(`✓ Successfully modified ${sourcePath}`);
  console.log('  - Added #hero section with selfie.jpg');
  console.log('  - Added responsive CSS for image scaling and centering');

} catch (err) {
  console.error(`✗ Error modifying hero section: ${err.message}`);
  process.exit(1);
}
```