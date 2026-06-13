// agents/browser.js
// APEX BrowserAgent — Full Playwright automation. Browse, click, fill forms, extract data, take screenshots.
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import bus from '../core/event-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.join(__dirname, '..', '.apex-screenshots');
if (!existsSync(SCREENSHOTS_DIR)) mkdirSync(SCREENSHOTS_DIR, { recursive: true });

export class BrowserAgent extends BaseAgent {
  constructor() {
    super({
      name: 'BrowserAgent',
      type: 'browser',
      description: 'Full browser automation. Navigates websites, fills forms, extracts data, takes screenshots, interacts with any web app. Powered by Playwright.',
    });
    this._browser = null;
    this._page = null;
    this._playwrightAvailable = null;
  }

  async run(task) {
    const { objective, url = null, actions = [], extract = null, screenshot = false } = task;
    this.log(`BrowserAgent: ${objective}`);

    const available = await this._ensurePlaywright();
    if (!available) {
      return this._fallbackHttpFetch(url || objective);
    }

    try {
      const result = await this._executeWithBrowser(objective, url, actions, extract, screenshot);
      this.remember(
        `Browsed: ${url || objective} — ${result.summary || 'completed'}`,
        { tags: ['browser', 'web'], importance: 6 }
      );
      return result;
    } finally {
      await this._closeBrowser();
    }
  }

  async _executeWithBrowser(objective, url, actions, extract, screenshot) {
    const pw = await import('playwright');
    this._browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await this._browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    this._page = await context.newPage();

    const results = { objective, pages: [], extracted: [], screenshots: [] };

    // Navigate to URL if provided
    if (url) {
      await this._navigate(url);
      results.pages.push({ url, title: await this._page.title() });
    }

    // If no explicit actions, let AI plan them
    if (!actions.length && objective) {
      const plannedActions = await this._planActions(objective, url);
      actions.push(...plannedActions);
    }

    // Execute actions
    for (const action of actions) {
      try {
        const actionResult = await this._executeAction(action);
        results.pages.push(actionResult);
      } catch (err) {
        this.log(`Action failed: ${action.type} — ${err.message}`, 'warn');
      }
    }

    // Extract data if requested
    if (extract) {
      results.extracted = await this._extract(extract);
    }

    // Auto-extract page content
    results.content = await this._getPageContent();

    // Screenshot if requested
    if (screenshot) {
      const screenshotPath = path.join(SCREENSHOTS_DIR, `apex-${Date.now()}.png`);
      await this._page.screenshot({ path: screenshotPath, fullPage: true });
      results.screenshots.push(screenshotPath);
      this.log(`Screenshot saved: ${screenshotPath}`);
    }

    // Summarize what was found
    results.summary = await complete(
      `Summarize what was found/accomplished:\nObjective: ${objective}\nContent found: ${results.content?.slice(0, 2000)}\n\nBe concise and factual.`,
      { temperature: 0.3, maxTokens: 500 }
    );

    return results;
  }

  async _navigate(url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this._page.waitForTimeout(1500);
  }

  async _planActions(objective, startUrl) {
    return structured(
      `Plan browser automation actions for: "${objective}"\nStarting URL: ${startUrl || 'not specified'}\n\nWhat steps does a browser need to take to accomplish this?`,
      {
        actions: [
          {
            type: 'navigate|click|fill|scroll|wait|extract|screenshot',
            selector: 'CSS selector if applicable',
            value: 'value to fill if applicable',
            url: 'URL to navigate to if applicable',
            description: 'what this does',
          }
        ]
      },
      { temperature: 0.3 }
    );
  }

  async _executeAction(action) {
    switch (action.type) {
      case 'navigate':
        await this._navigate(action.url);
        return { type: 'navigate', url: action.url, title: await this._page.title() };

      case 'click':
        await this._page.click(action.selector, { timeout: 10000 });
        await this._page.waitForTimeout(800);
        return { type: 'click', selector: action.selector };

      case 'fill':
        await this._page.fill(action.selector, action.value, { timeout: 10000 });
        return { type: 'fill', selector: action.selector };

      case 'scroll':
        await this._page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await this._page.waitForTimeout(500);
        return { type: 'scroll' };

      case 'wait':
        await this._page.waitForTimeout(action.value || 2000);
        return { type: 'wait' };

      case 'extract':
        return { type: 'extract', data: await this._extract(action.selector) };

      case 'screenshot': {
        const screenshotPath = path.join(SCREENSHOTS_DIR, `step-${Date.now()}.png`);
        await this._page.screenshot({ path: screenshotPath });
        return { type: 'screenshot', path: screenshotPath };
      }

      case 'search': {
        // Handle search forms intelligently
        const searchSelectors = ['input[type="search"]', 'input[name="q"]', 'input[placeholder*="Search"]', '#search', '.search-input'];
        for (const sel of searchSelectors) {
          try {
            await this._page.fill(sel, action.value);
            await this._page.keyboard.press('Enter');
            await this._page.waitForTimeout(2000);
            return { type: 'search', query: action.value };
          } catch {}
        }
        return { type: 'search', error: 'Search input not found' };
      }

      default:
        return { type: action.type, skipped: true };
    }
  }

  async _extract(selector) {
    if (typeof selector === 'string') {
      // Extract text from CSS selector
      try {
        return await this._page.$$eval(selector, els => els.map(e => ({
          text: e.textContent?.trim(),
          href: e.href,
          src: e.src,
        })));
      } catch {
        return [];
      }
    }

    if (typeof selector === 'object') {
      // Structured extraction
      const results = {};
      for (const [key, sel] of Object.entries(selector)) {
        try {
          results[key] = await this._page.$eval(sel, el => el.textContent?.trim());
        } catch {
          results[key] = null;
        }
      }
      return results;
    }

    return [];
  }

  async _getPageContent() {
    try {
      return await this._page.evaluate(() => {
        // Remove scripts, styles, nav
        const remove = document.querySelectorAll('script,style,nav,footer,header,aside');
        remove.forEach(el => el.remove());
        return document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 5000) || '';
      });
    } catch {
      return '';
    }
  }

  async _closeBrowser() {
    try {
      if (this._browser) {
        await this._browser.close();
        this._browser = null;
        this._page = null;
      }
    } catch {}
  }

  async _ensurePlaywright() {
    if (this._playwrightAvailable !== null) return this._playwrightAvailable;
    try {
      await import('playwright');
      this._playwrightAvailable = true;
    } catch {
      this.log('Playwright not installed, using HTTP fallback', 'warn');
      this._playwrightAvailable = false;
    }
    return this._playwrightAvailable;
  }

  async _fallbackHttpFetch(url) {
    const axios = (await import('axios')).default;
    const cheerio = await import('cheerio');
    if (!url.startsWith('http')) url = 'https://' + url;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApexBot/1.0)' },
      timeout: 15000,
    });
    const $ = cheerio.load(resp.data);
    $('script,style,nav,footer').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000);
    return { url, content: text, method: 'http-fallback' };
  }

  // Convenience methods
  async browse(url) {
    return this.run({ objective: `Browse and extract content from ${url}`, url, screenshot: false });
  }

  async scrape(url, selectors) {
    return this.run({ objective: `Extract data from ${url}`, url, extract: selectors });
  }

  async screenshot(url) {
    return this.run({ objective: `Screenshot ${url}`, url, screenshot: true });
  }

  async findFreeAPIs(topic) {
    return this.run({
      objective: `Find free APIs for ${topic} — look for keyless or free-tier APIs`,
      url: `https://github.com/public-apis/public-apis`,
      actions: [
        { type: 'search', value: topic },
      ],
      extract: 'table tbody tr',
    });
  }
}

export default BrowserAgent;
