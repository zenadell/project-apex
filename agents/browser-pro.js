// agents/browser-pro.js
// APEX BrowserAgentPro — Beyond OpenClaw's browser bridge.
// CDP + Playwright + AI Vision + Smart Forms + Multi-tab + Profiles + Full automation.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import bus from '../core/event-bus.js';
import Memory from '../core/memory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(__dirname, '..', '.apex-browser-profiles');
const SCREENSHOTS_DIR = path.join(__dirname, '..', '.apex-screenshots');
const DOWNLOADS_DIR = path.join(__dirname, '..', '.apex-downloads');

[PROFILES_DIR, SCREENSHOTS_DIR, DOWNLOADS_DIR].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

export class BrowserAgentPro extends BaseAgent {
  constructor() {
    super({
      name: 'BrowserAgentPro',
      type: 'browser_pro',
      description: 'Advanced browser automation. AI vision, smart form detection, multi-tab, browser profiles, cookie management, file downloads, full page interaction. Uses YOUR data to fill forms on YOUR behalf.',
    });
    this._browser = null;
    this._context = null;
    this._pages = new Map(); // tabId -> page
    this._activeTabId = null;
    this._profiles = this._loadProfiles();
    this._sessionCookies = {};
    this._playwrightAvailable = null;
  }

  async run(task) {
    const {
      objective, url, actions = [], extract, screenshot = false,
      profile = 'default', formData, multiTab = false, downloadFiles = false,
    } = task;

    this.log(`BrowserPro: ${objective || url}`);
    const available = await this._ensurePlaywright();

    try {
      if (multiTab) {
        return this._multiTabSession(objective, url, actions);
      }
      return this._session(objective, url, actions, extract, screenshot, profile, formData, downloadFiles);
    } finally {
      if (!multiTab) await this._closeAll();
    }
  }

  // ─── CORE SESSION ──────────────────────────────────────────────────────────

  async _session(objective, url, actions, extract, screenshot, profile, formData, downloadFiles) {
    const pw = await import('playwright');
    const profileDir = path.join(PROFILES_DIR, profile);

    // Launch with persistent context (keeps cookies/session across runs)
    this._context = await pw.chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled', // hide bot signals
        '--disable-dev-shm-usage',
      ],
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      // Download config
      ...(downloadFiles ? { acceptDownloads: true, downloadsPath: DOWNLOADS_DIR } : {}),
    });

    const page = await this._context.newPage();
    const tabId = `tab_${Date.now()}`;
    this._pages.set(tabId, page);
    this._activeTabId = tabId;

    // Stealth patches — prevent detection as bot
    await this._applyStealthPatches(page);

    const results = { objective, url, tabs: [], extracted: [], screenshots: [], downloads: [] };

    // Navigate
    if (url) {
      await this._navigate(page, url);
      results.tabs.push({ url: page.url(), title: await page.title() });
      this.log(`Navigated to: ${await page.title()}`);
    }

    // Smart form fill if formData provided
    if (formData) {
      const fillResult = await this._smartFormFill(page, formData);
      results.formFill = fillResult;
    }

    // If no explicit actions, use AI to plan them
    const allActions = actions.length ? actions : await this._planActionsAI(page, objective, url);

    // Execute all actions
    for (const action of allActions) {
      try {
        const r = await this._executeAction(page, action);
        results.tabs.push(r);
      } catch (err) {
        this.log(`Action "${action.type}" failed: ${err.message}`, 'warn');
        results.tabs.push({ error: err.message, action: action.type });
      }
    }

    // Extract
    if (extract) {
      results.extracted = await this._smartExtract(page, extract);
    }

    // Screenshot
    if (screenshot) {
      const p = path.join(SCREENSHOTS_DIR, `apex-pro-${Date.now()}.png`);
      await page.screenshot({ path: p, fullPage: true });
      results.screenshots.push(p);
    }

    // AI summary of what happened / what's on screen
    const pageContent = await this._getPageText(page);
    results.pageContent = pageContent.slice(0, 3000);
    results.summary = await complete(
      `Summarize what happened and what is currently on screen:\nObjective: ${objective}\nURL: ${page.url()}\nPage content: ${pageContent.slice(0, 2000)}\nBe concise and factual.`,
      { temperature: 0.2, maxTokens: 400 }
    );

    // Save cookies for this profile
    await this._saveCookies(page, profile);

    this.remember(
      `Browser session: ${objective} | URL: ${url} | Result: ${results.summary?.slice(0, 100)}`,
      { tags: ['browser', 'web', profile], importance: 7 }
    );

    return results;
  }

  // ─── STEALTH PATCHES ───────────────────────────────────────────────────────

  async _applyStealthPatches(page) {
    // Hide WebDriver flag
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });
  }

  // ─── AI ACTION PLANNING ────────────────────────────────────────────────────

  async _planActionsAI(page, objective, startUrl) {
    if (!objective) return [];
    // Get aria snapshot of current page (like OpenClaw does) for AI context
    const snapshot = await this._getAriaSnapshot(page);

    const plan = await structured(
      `You are controlling a real browser.\n\nObjective: "${objective}"\nCurrent URL: ${page.url()}\nPage elements (ARIA snapshot):\n${snapshot.slice(0, 3000)}\n\nPlan the exact browser actions needed to accomplish this objective.`,
      {
        actions: [
          {
            type: 'navigate|click|fill|select|check|scroll|wait|key|download|screenshot',
            selector: 'CSS selector or text to find element',
            text: 'text to search/click if no selector',
            value: 'value to fill/select',
            key: 'keyboard key to press',
            url: 'URL to navigate to',
            description: 'what this step does',
            waitAfter: 1000,
          }
        ],
        reasoning: 'why these steps will work',
      },
      { temperature: 0.2 }
    );

    return plan.actions || [];
  }

  // ─── ACTION EXECUTION (SMARTER THAN OPENCLAW) ─────────────────────────────

  async _executeAction(page, action) {
    const wait = action.waitAfter || 800;

    switch (action.type) {
      case 'navigate':
        await this._navigate(page, action.url);
        return { type: 'navigate', url: page.url(), title: await page.title() };

      case 'click':
        await this._smartClick(page, action.selector, action.text);
        await page.waitForTimeout(wait);
        return { type: 'click', target: action.selector || action.text };

      case 'fill':
        await this._smartFill(page, action.selector, action.text, action.value);
        await page.waitForTimeout(wait);
        return { type: 'fill', field: action.selector, value: action.value };

      case 'select':
        await page.selectOption(action.selector, action.value, { timeout: 10000 });
        return { type: 'select', field: action.selector, value: action.value };

      case 'check':
        await page.check(action.selector, { timeout: 10000 });
        return { type: 'check', field: action.selector };

      case 'scroll':
        await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`);
        await page.waitForTimeout(500);
        return { type: 'scroll' };

      case 'wait':
        await page.waitForTimeout(action.value || 2000);
        return { type: 'wait', ms: action.value };

      case 'key':
        await page.keyboard.press(action.key || action.value);
        await page.waitForTimeout(wait);
        return { type: 'key', key: action.key };

      case 'screenshot': {
        const p = path.join(SCREENSHOTS_DIR, `step-${Date.now()}.png`);
        await page.screenshot({ path: p });
        return { type: 'screenshot', path: p };
      }

      case 'download': {
        const [download] = await Promise.all([
          page.waitForEvent('download'),
          this._smartClick(page, action.selector, action.text),
        ]);
        const destPath = path.join(DOWNLOADS_DIR, download.suggestedFilename());
        await download.saveAs(destPath);
        return { type: 'download', path: destPath, filename: download.suggestedFilename() };
      }

      case 'new_tab': {
        const newPage = await this._context.newPage();
        const tabId = `tab_${Date.now()}`;
        this._pages.set(tabId, newPage);
        if (action.url) await this._navigate(newPage, action.url);
        return { type: 'new_tab', tabId };
      }

      default:
        return { type: action.type, skipped: true };
    }
  }

  // ─── SMART CLICK — tries multiple strategies ───────────────────────────────

  async _smartClick(page, selector, text) {
    // Try selector first
    if (selector) {
      try {
        await page.click(selector, { timeout: 8000 });
        return;
      } catch {}
    }
    // Try text match
    if (text) {
      const strategies = [
        () => page.click(`text="${text}"`, { timeout: 5000 }),
        () => page.click(`[aria-label="${text}"]`, { timeout: 5000 }),
        () => page.click(`button:has-text("${text}")`, { timeout: 5000 }),
        () => page.click(`a:has-text("${text}")`, { timeout: 5000 }),
        () => page.getByText(text).first().click({ timeout: 5000 }),
        () => page.getByRole('button', { name: text }).click({ timeout: 5000 }),
        () => page.getByRole('link', { name: text }).click({ timeout: 5000 }),
      ];
      for (const strategy of strategies) {
        try { await strategy(); return; } catch {}
      }
    }
    throw new Error(`Could not click: selector="${selector}" text="${text}"`);
  }

  // ─── SMART FILL ────────────────────────────────────────────────────────────

  async _smartFill(page, selector, label, value) {
    if (!value && !selector) return;
    const val = String(value || '');

    // Try direct selector
    if (selector) {
      try {
        await page.fill(selector, val, { timeout: 8000 });
        return;
      } catch {}
    }

    // Try label-based lookup
    if (label) {
      const strategies = [
        () => page.fill(`input[placeholder*="${label}" i]`, val, { timeout: 5000 }),
        () => page.fill(`input[name*="${label}" i]`, val, { timeout: 5000 }),
        () => page.fill(`input[id*="${label}" i]`, val, { timeout: 5000 }),
        () => page.getByLabel(label, { exact: false }).fill(val, { timeout: 5000 }),
        () => page.getByPlaceholder(label, { exact: false }).fill(val, { timeout: 5000 }),
      ];
      for (const strategy of strategies) {
        try { await strategy(); return; } catch {}
      }
    }
    throw new Error(`Could not fill field: ${selector || label}`);
  }

  // ─── SMART FORM FILL — AI-powered form detection ─────────────────────────

  async _smartFormFill(page, formData) {
    this.log(`Smart form fill: ${JSON.stringify(Object.keys(formData))}`);

    // Get all form fields from page
    const fields = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, textarea, select')).map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        label: document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        required: el.required,
        visible: el.offsetWidth > 0 && el.offsetHeight > 0,
      }));
    });

    // AI maps formData keys to actual page fields
    const mapping = await structured(
      `Map these form data keys to the correct form fields on the page.\n\nData to fill: ${JSON.stringify(formData)}\n\nPage fields: ${JSON.stringify(fields.filter(f => f.visible).slice(0, 30))}\n\nCreate a mapping of which value fills which field.`,
      {
        mappings: [
          {
            dataKey: 'key from formData',
            fieldIdentifier: 'name|id|placeholder to target',
            fieldType: 'input|select|textarea',
            value: 'value to fill',
          }
        ]
      },
      { temperature: 0.1 }
    );

    const results = [];
    for (const m of mapping.mappings || []) {
      try {
        const selector = `[name="${m.fieldIdentifier}"], [id="${m.fieldIdentifier}"], [placeholder="${m.fieldIdentifier}"]`;
        if (m.fieldType === 'select') {
          await page.selectOption(selector, m.value, { timeout: 8000 });
        } else if (m.fieldType === 'checkbox') {
          if (m.value === true || m.value === 'true') await page.check(selector, { timeout: 8000 });
        } else {
          await page.fill(selector, String(m.value), { timeout: 8000 });
        }
        results.push({ field: m.dataKey, filled: true });
      } catch (err) {
        results.push({ field: m.dataKey, filled: false, error: err.message });
      }
    }

    return { mappings: mapping.mappings, results };
  }

  // ─── SMART EXTRACT ─────────────────────────────────────────────────────────

  async _smartExtract(page, query) {
    if (typeof query === 'string') {
      // AI decides what to extract
      const content = await this._getPageText(page);
      const extracted = await complete(
        `Extract: "${query}"\n\nFrom this page content:\n${content.slice(0, 5000)}\n\nReturn the extracted information clearly.`,
        { temperature: 0.1, maxTokens: 1000 }
      );
      return { query, data: extracted };
    }

    if (typeof query === 'object') {
      // Structured extraction
      const results = {};
      for (const [key, selector] of Object.entries(query)) {
        try {
          results[key] = await page.$$eval(selector, els => els.map(e => e.textContent?.trim()));
        } catch {
          results[key] = null;
        }
      }
      return results;
    }

    return {};
  }

  // ─── MULTI-TAB SESSION ─────────────────────────────────────────────────────

  async _multiTabSession(objective, startUrl, actions) {
    const pw = await import('playwright');
    this._context = await pw.chromium.launchPersistentContext(
      path.join(PROFILES_DIR, 'multitab'),
      { headless: true, args: ['--no-sandbox'] }
    );

    const results = { tabs: [] };
    const mainPage = await this._context.newPage();
    await this._applyStealthPatches(mainPage);
    if (startUrl) await this._navigate(mainPage, startUrl);

    // Let AI orchestrate multi-tab work
    const plan = await structured(
      `You are controlling multiple browser tabs to accomplish: "${objective}"\nPlan a multi-tab strategy.`,
      {
        tabs: [
          { url: 'URL for this tab', purpose: 'what to do here', actions: [] }
        ]
      }
    );

    for (const tab of plan.tabs || []) {
      const page = await this._context.newPage();
      await this._applyStealthPatches(page);
      await this._navigate(page, tab.url);
      const content = await this._getPageText(page);
      results.tabs.push({ url: tab.url, purpose: tab.purpose, content: content.slice(0, 1000) });
    }

    return results;
  }

  // ─── ARIA SNAPSHOT (like OpenClaw pw-role-snapshot) ────────────────────────

  async _getAriaSnapshot(page) {
    try {
      return await page.evaluate(() => {
        const getAriaInfo = (el, depth = 0) => {
          if (depth > 4) return '';
          const role = el.getAttribute('role') || el.tagName.toLowerCase();
          const label = el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 50) || '';
          const id = el.id ? `#${el.id}` : '';
          const name = el.getAttribute('name') ? `[name=${el.getAttribute('name')}]` : '';
          const placeholder = el.getAttribute('placeholder') ? `[placeholder="${el.getAttribute('placeholder')}"]` : '';
          const type = el.getAttribute('type') ? `[type=${el.getAttribute('type')}]` : '';
          const interactive = ['input', 'button', 'a', 'select', 'textarea'].includes(el.tagName.toLowerCase());
          if (!interactive && !label) return '';
          return `${' '.repeat(depth * 2)}${role}${id}${name}${type}${placeholder}: "${label}"\n`;
        };
        const interactives = document.querySelectorAll('input, button, a, select, textarea, [role], [aria-label]');
        return Array.from(interactives).slice(0, 60).map(el => getAriaInfo(el)).filter(Boolean).join('');
      });
    } catch {
      return '';
    }
  }

  // ─── UTILITIES ─────────────────────────────────────────────────────────────

  async _navigate(page, url) {
    if (!url.startsWith('http')) url = 'https://' + url;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);
  }

  async _getPageText(page) {
    try {
      return await page.evaluate(() => {
        document.querySelectorAll('script,style,nav,footer,header').forEach(e => e.remove());
        return document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 8000) || '';
      });
    } catch { return ''; }
  }

  async _saveCookies(page, profile) {
    try {
      const cookies = await this._context.cookies();
      const cookiePath = path.join(PROFILES_DIR, `${profile}-cookies.json`);
      writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    } catch {}
  }

  async _loadCookies(profile) {
    const cookiePath = path.join(PROFILES_DIR, `${profile}-cookies.json`);
    if (existsSync(cookiePath)) {
      try {
        const cookies = JSON.parse(readFileSync(cookiePath, 'utf8'));
        await this._context.addCookies(cookies);
        return cookies.length;
      } catch {}
    }
    return 0;
  }

  async _closeAll() {
    try {
      if (this._context) { await this._context.close(); this._context = null; }
      this._pages.clear();
    } catch {}
  }

  async _ensurePlaywright() {
    if (this._playwrightAvailable !== null) return this._playwrightAvailable;
    try {
      await import('playwright');
      this._playwrightAvailable = true;
    } catch {
      this._playwrightAvailable = false;
    }
    return this._playwrightAvailable;
  }

  _loadProfiles() {
    const profilesFile = path.join(PROFILES_DIR, '_profiles.json');
    if (existsSync(profilesFile)) {
      try { return JSON.parse(readFileSync(profilesFile, 'utf8')); } catch {}
    }
    return { default: { name: 'Default', created: Date.now() } };
  }

  // ─── PUBLIC API ────────────────────────────────────────────────────────────

  async browse(url, objective) {
    return this.run({ objective: objective || `Browse ${url}`, url });
  }

  async fillForm(url, formData, submitSelector = null) {
    const result = await this.run({ objective: `Fill and submit form at ${url}`, url, formData });
    return result;
  }

  async extract(url, what) {
    return this.run({ objective: `Extract: ${what}`, url, extract: what });
  }

  async loginAssist(url, credentials) {
    // Helps YOU log into a site using YOUR credentials
    return this.run({
      objective: `Log in to ${url}`,
      url,
      formData: credentials,
      actions: [{ type: 'key', key: 'Enter', description: 'Submit login form' }],
    });
  }

  async signup(url, userInfo) {
    // Helps YOU sign up for a service using YOUR information
    return this.run({
      objective: `Sign up at ${url} using the provided user information`,
      url,
      formData: userInfo,
      screenshot: true,
    });
  }

  async downloadFile(url, downloadTrigger) {
    return this.run({
      objective: `Download file from ${url}`,
      url,
      actions: [{ type: 'download', text: downloadTrigger || 'Download', description: 'Download the file' }],
      downloadFiles: true,
    });
  }

  async screenshot(url) {
    return this.run({ objective: `Screenshot ${url}`, url, screenshot: true, actions: [] });
  }
}

export default BrowserAgentPro;
