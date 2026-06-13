// tools/website-cloner.js
// APEX Website Cloner — Extracts any website's design, strips platform lock (Framer, Webflow, Wix),
// converts to clean portable HTML/CSS/JS. Swap content, keep design pixel-perfect.

import { launchStealthBrowser } from './human-cursor.js';
import { complete, structured } from '../core/llm.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLONES_DIR = path.join(__dirname, '..', '.apex-data', 'clones');
if (!existsSync(CLONES_DIR)) mkdirSync(CLONES_DIR, { recursive: true });

export class WebsiteCloner {

  // ── MAIN CLONE ENTRY POINT ─────────────────────────────────────────────────
  async clone(url, opts = {}) {
    const {
      instructions = '',       // e.g. "change to fitness niche"
      targetNiche = '',        // replace content with this niche
      replaceImages = true,    // swap Framer/platform images with placeholders
      outputDir = null,
      keepAnimations = true,
    } = opts;

    console.log(`🔍 Cloning: ${url}`);

    // 1. Fetch full page source using stealth browser
    const { html, css, js, fonts, assets, metadata } = await this._fullExtract(url);

    // 2. Detect platform
    const platform = this._detectPlatform(html, url);
    console.log(`📦 Platform detected: ${platform}`);

    // 3. Strip platform lock
    const cleaned = this._stripPlatformLock(html, css, platform);

    // 4. Extract and preserve animations
    const animations = keepAnimations ? this._extractAnimations(cleaned.html, cleaned.css) : { css: '', js: '' };

    // 5. Convert to standalone HTML
    let standalone = await this._buildStandalone(cleaned, animations, fonts, metadata);

    // 6. Replace content if niche/instructions provided
    if (targetNiche || instructions) {
      standalone = await this._swapContent(standalone, targetNiche, instructions, metadata);
    }

    // 7. Fix all asset URLs (images, fonts, etc.)
    standalone = this._fixAssetURLs(standalone, url, replaceImages);

    // 8. Optimize and finalize
    standalone = this._optimize(standalone);

    // 9. Save output
    const cloneId = `clone-${Date.now()}`;
    const dir = outputDir || path.join(CLONES_DIR, cloneId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), standalone);

    // Also save metadata
    writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      sourceUrl: url, platform, cloneId, instructions, targetNiche,
      clonedAt: new Date().toISOString(), metadata,
    }, null, 2));

    console.log(`✅ Clone saved to: ${dir}`);
    return { cloneId, dir, platform, outputPath: path.join(dir, 'index.html'), html: standalone };
  }

  // ── FULL EXTRACTION ────────────────────────────────────────────────────────
  async _fullExtract(url) {
    let html = '', css = [], js = [], fonts = [], assets = [], metadata = {};

    try {
      // Try stealth browser first (gets fully rendered JS content)
      const { browser, page, cursor } = await launchStealthBrowser({ headless: true });

      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

        // Wait for animations to load
        await page.waitForTimeout(2000);

        // Scroll to trigger lazy loads
        await cursor.scroll('down', 2000);
        await page.waitForTimeout(1000);
        await cursor.scroll('up', 2000);
        await page.waitForTimeout(500);

        // Get full rendered HTML
        html = await page.content();

        // Extract all computed styles
        css = await page.evaluate(() => {
          return Array.from(document.styleSheets)
            .flatMap(sheet => {
              try { return Array.from(sheet.cssRules).map(r => r.cssText); } catch { return []; }
            })
            .join('\n');
        });

        // Get all script content (inline only, skip externals)
        js = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('script:not([src])'))
            .map(s => s.textContent)
            .filter(t => t && t.length > 10)
            .join('\n\n');
        });

        // Get fonts
        fonts = await page.evaluate(() => {
          return Array.from(document.fonts).map(f => ({ family: f.family, style: f.style }));
        });

        // Metadata
        metadata = await page.evaluate(() => ({
          title: document.title,
          description: document.querySelector('meta[name="description"]')?.content || '',
          ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
          colors: [...new Set(Array.from(document.querySelectorAll('*')).slice(0, 100).flatMap(el => {
            const s = getComputedStyle(el);
            return [s.backgroundColor, s.color].filter(c => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent');
          }))].slice(0, 20),
        }));

        await browser.close();
      } catch (err) {
        await browser.close();
        throw err;
      }
    } catch (err) {
      // Fallback to HTTP fetch
      console.log(`Browser extraction failed: ${err.message} — using HTTP fetch`);
      const resp = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoogleBot/2.1)' },
        timeout: 15000,
      });
      html = resp.data;
      css = '';
      metadata = { title: 'Cloned Site', description: '' };
    }

    return { html, css: typeof css === 'string' ? css : css.join('\n'), js, fonts, assets, metadata };
  }

  // ── PLATFORM DETECTION ────────────────────────────────────────────────────
  _detectPlatform(html, url) {
    if (url.includes('framer.app') || url.includes('framer.website') || html.includes('framer.com') || html.includes('__framer')) return 'framer';
    if (html.includes('webflow') || url.includes('webflow.io')) return 'webflow';
    if (html.includes('wix.com') || html.includes('wixstatic')) return 'wix';
    if (html.includes('squarespace') || url.includes('squarespace.com')) return 'squarespace';
    if (html.includes('wordpress') || html.includes('wp-content')) return 'wordpress';
    if (html.includes('shopify') || html.includes('cdn.shopify')) return 'shopify';
    if (html.includes('ghost') || html.includes('ghost.io')) return 'ghost';
    return 'generic';
  }

  // ── STRIP PLATFORM LOCK ───────────────────────────────────────────────────
  _stripPlatformLock(html, css, platform) {
    const $ = cheerio.load(html);

    // ── FRAMER SPECIFIC ──
    if (platform === 'framer') {
      // Remove Framer badge/branding
      $('[class*="framer-badge"]').remove();
      $('[id*="framer-badge"]').remove();
      $('a[href*="framer.com"]').each((i, el) => {
        const $el = $(el);
        // If it's a badge/link, remove. If it's legit content link, keep.
        if ($el.attr('href')?.includes('framer.com/') && !$el.text().trim()) $el.remove();
      });

      // Remove Framer scripts (the runtime that enforces lock)
      $('script[src*="framer.com"]').remove();
      $('script[src*="framercdn.com"]').remove();
      $('link[href*="framer.com"]').remove();

      // Replace Framer image CDN with placeholder pattern
      $('img[src*="framerusercontent.com"]').each((i, el) => {
        const $el = $(el);
        const alt = $el.attr('alt') || 'image';
        $el.attr('src', `https://picsum.photos/seed/${i}/800/600`);
        $el.attr('data-original-src', $el.attr('src'));
        $el.attr('alt', alt);
      });

      // Remove Framer overlay / editing UI
      $('[data-framer-component-type]').each((i, el) => {
        $(el).removeAttr('data-framer-component-type');
      });
      $('[data-framer-portal-id]').remove();
      $('[class*="framer-"]').each((i, el) => {
        // Keep elements but strip framer-specific classes that cause CDN dependency
        const $el = $(el);
        const classes = $el.attr('class') || '';
        const cleanClasses = classes.split(' ')
          .filter(c => !c.startsWith('framer-') || c.match(/framer-(motion|animate)/))
          .join(' ');
        $el.attr('class', cleanClasses || undefined);
      });

      // Strip Framer CSP headers from meta tags
      $('meta[http-equiv="Content-Security-Policy"]').remove();
    }

    // ── WEBFLOW SPECIFIC ──
    if (platform === 'webflow') {
      $('[class*="w-"]').each((i, el) => $(el).removeAttr('data-w-id'));
      $('script[src*="webflow.js"]').remove();
      $('script[src*="webflow.com"]').remove();
      $('.w-webflow-badge').remove();
    }

    // ── WIX SPECIFIC ──
    if (platform === 'wix') {
      $('[id*="WIX"]').remove();
      $('script[src*="wix.com"]').remove();
      $('script[src*="wixstatic.com"]').remove();
    }

    // ── UNIVERSAL ──
    // Remove analytics (keep design only)
    $('script[src*="google-analytics"]').remove();
    $('script[src*="googletagmanager"]').remove();
    $('script[src*="hotjar"]').remove();
    $('script[src*="intercom"]').remove();
    $('noscript').remove();

    // Remove cookie banners
    $('[id*="cookie"]').remove();
    $('[class*="cookie-banner"]').remove();
    $('[id*="gdpr"]').remove();

    return { html: $.html(), css };
  }

  // ── EXTRACT ANIMATIONS ────────────────────────────────────────────────────
  _extractAnimations(html, css) {
    // Extract @keyframes, transition, animation declarations
    const keyframeRegex = /@keyframes[\s\S]*?}/g;
    const keyframes = (css.match(keyframeRegex) || []).join('\n');

    // Extract animation-related CSS
    const animationProps = css.split('}').filter(block =>
      block.includes('animation') ||
      block.includes('transition') ||
      block.includes('transform') ||
      block.includes('opacity') ||
      block.includes('translate')
    ).join('}');

    // Look for Framer Motion / GSAP patterns in HTML and convert
    const hasFramerMotion = html.includes('framer-motion') || html.includes('data-motion');
    const hasGSAP = html.includes('gsap') || html.includes('TweenMax');

    return {
      css: `${keyframes}\n${animationProps}`,
      hasFramerMotion,
      hasGSAP,
    };
  }

  // ── BUILD STANDALONE HTML ─────────────────────────────────────────────────
  async _buildStandalone(cleaned, animations, fonts, metadata) {
    const $ = cheerio.load(cleaned.html);
    const fontImports = [...new Set(fonts.map(f => f.family))].slice(0, 5);

    // Inject Google Fonts for used fonts
    const googleFontsURL = fontImports.length
      ? `https://fonts.googleapis.com/css2?family=${fontImports.map(f => f.replace(/ /g, '+')).join('&family=')}&display=swap`
      : null;

    // Build consolidated style block
    const styleBlock = `
/* ── APEX CLONED SITE ── */
/* Source: ${metadata.title || 'Cloned Site'} */
/* Cloned by APEX — All platform dependencies removed */

${cleaned.css}
${animations.css}
`;

    // Inject into head
    if (googleFontsURL) $('head').prepend(`<link rel="preconnect" href="https://fonts.googleapis.com"><link href="${googleFontsURL}" rel="stylesheet">`);
    $('head').append(`<style>\n${styleBlock}\n</style>`);

    // Add APEX clone marker (invisible)
    $('body').append(`<!-- APEX Clone | ${new Date().toISOString()} -->`);

    return $.html();
  }

  // ── SWAP CONTENT ──────────────────────────────────────────────────────────
  async _swapContent(html, targetNiche, instructions, metadata) {
    const $ = cheerio.load(html);

    // Extract all visible text nodes
    const textNodes = [];
    $('h1, h2, h3, h4, h5, p, span, a, button, label, li').each((i, el) => {
      const text = $(el).text().trim();
      if (text && text.length > 2 && text.length < 500) {
        textNodes.push({ selector: i, text, tag: el.tagName });
      }
    });

    // Use AI to generate replacement content for the target niche
    const replacements = await structured(
      `You are converting website content to a new niche.\n\nOriginal site title: ${metadata.title}\nTarget niche: ${targetNiche || 'keep general but modernize'}\nAdditional instructions: ${instructions}\n\nHere are the text elements found:\n${JSON.stringify(textNodes.slice(0, 40), null, 2)}\n\nProvide replacement text for each element that fits the new niche. Keep same tone and length.`,
      {
        replacements: textNodes.slice(0, 40).map(n => ({ original: n.text, replacement: 'new text' }))
      },
      { temperature: 0.6 }
    );

    // Apply replacements
    let htmlStr = $.html();
    for (const rep of (replacements.replacements || [])) {
      if (rep.original && rep.replacement && rep.original !== rep.replacement) {
        htmlStr = htmlStr.replace(
          new RegExp(rep.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
          rep.replacement
        );
      }
    }

    return htmlStr;
  }

  // ── FIX ASSET URLS ────────────────────────────────────────────────────────
  _fixAssetURLs(html, sourceUrl, replaceImages = true) {
    const baseUrl = new URL(sourceUrl).origin;
    const $ = cheerio.load(html);

    // Fix relative URLs
    $('img[src], source[src], video[src]').each((i, el) => {
      const src = $(el).attr('src');
      if (src && src.startsWith('/') && !src.startsWith('//')) {
        $(el).attr('src', baseUrl + src);
      }
    });

    $('link[href]').each((i, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('/') && !href.startsWith('//')) {
        $(el).attr('href', baseUrl + href);
      }
    });

    // Replace platform-specific image CDNs with placeholders
    if (replaceImages) {
      $('img').each((i, el) => {
        const src = $(el).attr('src') || '';
        if (src.includes('framerusercontent.com') || src.includes('framer.com/images')) {
          const w = $(el).attr('width') || '800';
          const h = $(el).attr('height') || '600';
          $(el).attr('src', `https://picsum.photos/seed/${i}/${w}/${h}`);
        }
      });
    }

    return $.html();
  }

  // ── OPTIMIZE ─────────────────────────────────────────────────────────────
  _optimize(html) {
    // Remove empty style/script tags
    html = html.replace(/<style>\s*<\/style>/g, '');
    html = html.replace(/<script>\s*<\/script>/g, '');

    // Remove duplicate whitespace in attributes
    html = html.replace(/\s{3,}/g, '  ');

    return html;
  }

  // ── COPY A DESIGN STYLE (not clone — generate similar) ───────────────────
  async mimicStyle(url, newContent = {}) {
    // Analyze the design without copying code
    const { browser, page } = await launchStealthBrowser({ headless: true });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const designAnalysis = await page.evaluate(() => {
      const body = document.body;
      const styles = getComputedStyle(body);
      const allEls = document.querySelectorAll('h1, h2, p, .hero, header, nav, footer, main, section');
      return {
        backgroundColor: styles.backgroundColor,
        fontFamily: styles.fontFamily,
        colors: [...new Set(Array.from(allEls).map(el => getComputedStyle(el).color))].slice(0, 6),
        bgColors: [...new Set(Array.from(allEls).map(el => getComputedStyle(el).backgroundColor))].slice(0, 6),
        fontSizes: [...new Set(Array.from(allEls).map(el => getComputedStyle(el).fontSize))].slice(0, 8),
        layout: document.querySelector('main, .container, [class*="container"]')?.className || '',
      };
    });

    await browser.close();

    // Generate new UI with same style but different content
    const newUI = await complete(
      `Generate a complete HTML page that mimics this design aesthetic:\n${JSON.stringify(designAnalysis, null, 2)}\n\nNew content:\n${JSON.stringify(newContent)}\n\nMatch: colors, fonts, spacing, general layout feel. Do NOT copy any actual code — create your own HTML/CSS that achieves a similar visual result.\n\nReturn only complete HTML.`,
      { temperature: 0.3, maxTokens: 8192 }
    );

    return { html: newUI, designAnalysis };
  }
}

export const websiteCloner = new WebsiteCloner();
export default websiteCloner;
