// agents/intelligence-monitor.js
// APEX IntelligenceMonitor — Watches the internet for new tools, APIs, models, and
// techniques. Automatically evaluates and integrates improvements into APEX.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Memory from '../core/memory.js';
import bus from '../core/event-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTEL_DIR = path.join(__dirname, '..', '.apex-data', 'intelligence');
if (!existsSync(INTEL_DIR)) mkdirSync(INTEL_DIR, { recursive: true });

const MONITOR_SOURCES = [
  { name: 'GitHub Trending', url: 'https://github.com/trending', type: 'github', category: 'tools' },
  { name: 'Hacker News', url: 'https://hacker-news.firebaseio.com/v0/topstories.json', type: 'hn', category: 'news' },
  { name: 'npm Latest AI', url: 'https://registry.npmjs.org/-/v1/search?text=ai+agent+automation&size=10', type: 'npm', category: 'packages' },
  { name: 'GitHub AI Repos', url: 'https://api.github.com/search/repositories?q=ai+agent+automation+stars:>100&sort=updated&per_page=10', type: 'github_api', category: 'tools' },
  { name: 'Free APIs', url: 'https://api.publicapis.org/entries?https=true&cors=yes', type: 'public_apis', category: 'apis' },
];

export class IntelligenceMonitor extends BaseAgent {
  constructor() {
    super({
      name: 'IntelligenceMonitor',
      type: 'intelligence',
      description: 'Monitors GitHub trending, Hacker News, npm, and public APIs. Evaluates new tools, models, and techniques. Auto-integrates improvements that benefit APEX.',
    });
    this._lastScan = 0;
    this._knownItems = this._loadKnownItems();
    this._autoUpgradeEnabled = process.env.APEX_AUTO_UPGRADE !== 'false';
  }

  async run(task) {
    const { action = 'scan' } = task;
    switch (action) {
      case 'scan':      return this.scan();
      case 'evaluate':  return this.evaluate(task.item);
      case 'upgrade':   return this.autoUpgrade(task.items);
      case 'report':    return this.intelligenceReport();
      case 'watch':     return this.startWatching();
      default:          return this.scan();
    }
  }

  // ── FULL INTELLIGENCE SCAN ────────────────────────────────────────────────
  async scan() {
    this.log('Starting intelligence scan...');
    const findings = [];

    for (const source of MONITOR_SOURCES) {
      try {
        const items = await this._fetchSource(source);
        const newItems = items.filter(item => !this._isKnown(item));

        if (newItems.length) {
          this.log(`${source.name}: ${newItems.length} new items`);
          findings.push({ source: source.name, category: source.category, items: newItems });
        }
      } catch (err) {
        this.log(`Failed to scan ${source.name}: ${err.message}`, 'warn');
      }
    }

    // Evaluate findings for APEX relevance
    const relevant = await this._evaluateRelevance(findings);
    this._saveFindings(findings);

    // Auto-upgrade if enabled
    if (this._autoUpgradeEnabled && relevant.highPriority?.length) {
      this.log(`Auto-upgrading: ${relevant.highPriority.length} high-priority items`);
      await this.autoUpgrade(relevant.highPriority);
    }

    this._lastScan = Date.now();
    bus.emit('intelligence:scan_complete', { findings: findings.length, relevant: relevant.highPriority?.length || 0 });

    return { findings, relevant, scannedAt: new Date().toISOString() };
  }

  // ── EVALUATE AN ITEM FOR APEX RELEVANCE ──────────────────────────────────
  async evaluate(item) {
    return structured(
      `Evaluate this tool/library/API for the APEX autonomous agent system.\n\nItem: ${JSON.stringify(item)}\n\nAPEX currently has: web research, code generation, browser automation, device control, security (Kali), voice TTS, image generation, deployment (Fly.io/Vercel), email, social messaging, data analysis, self-modification.\n\nEvaluate if this adds meaningful new capability.`,
      {
        relevant: true,
        priority: 'high/medium/low',
        capability: 'what new capability this adds to APEX',
        integrationPlan: 'how to integrate it (new agent, new tool, upgrade existing)',
        effort: 'low/medium/high',
        freeToUse: true,
        recommendation: 'integrate/skip/monitor',
        reasoning: 'why',
      },
      { temperature: 0.3 }
    );
  }

  // ── AUTO-UPGRADE APEX ─────────────────────────────────────────────────────
  async autoUpgrade(items) {
    const registry = (await import('../core/agent-registry.js')).default;
    const selfMod = registry.get('SelfModAgent');
    const results = [];

    for (const item of (items || []).slice(0, 3)) { // Max 3 auto-upgrades per scan
      this.log(`Auto-upgrading: ${item.name || item.title}`);
      try {
        if (!selfMod) continue;

        // Tell SelfModAgent to integrate this tool
        const result = await selfMod._handleTask({
          id: `upgrade-${Date.now()}`,
          type: 'create_tool',
          name: item.name || item.title,
          description: item.description || item.capability,
          implementation: `Use the ${item.url || item.npmName || item.name} package/API`,
        });

        results.push({ item: item.name, success: true, result });
        this._markKnown(item);

        Memory.store({
          scope: 'long_term', agent: 'IntelligenceMonitor',
          content: `Auto-integrated: ${item.name} — ${item.description?.slice?.(0, 100)}`,
          tags: ['upgrade', 'auto-integration'], importance: 8,
        });

        bus.emit('intelligence:upgraded', { item: item.name });
        this.log(`✅ Integrated: ${item.name}`);
      } catch (err) {
        results.push({ item: item.name, success: false, error: err.message });
      }

      // Delay between upgrades
      await new Promise(r => setTimeout(r, 5000));
    }

    return { upgraded: results.filter(r => r.success).length, results };
  }

  // ── INTELLIGENCE REPORT ────────────────────────────────────────────────────
  async intelligenceReport() {
    const findings = this._loadFindings();
    const recentFindings = findings.slice(-50);

    const report = await structured(
      `Generate an intelligence briefing for APEX based on recent monitoring.\n\nRecent findings (${recentFindings.length} items):\n${JSON.stringify(recentFindings.slice(0, 20), null, 2)}\n\nProvide actionable intelligence.`,
      {
        topOpportunities: ['top 3 new capabilities APEX should add'],
        trendingTechnologies: ['what tech is trending that APEX should know about'],
        newFreeAPIs: ['valuable new free APIs discovered'],
        competitorUpdates: ['notable updates from similar tools (OpenClaw, etc)'],
        recommendations: ['specific actions to take this week'],
        threatLandscape: ['new security tools or threats to be aware of'],
      }
    );

    return { report, scannedItems: recentFindings.length, lastScan: new Date(this._lastScan).toISOString() };
  }

  // ── START BACKGROUND WATCHING ─────────────────────────────────────────────
  async startWatching() {
    const { taskScheduler } = await import('../core/task-scheduler.js');
    taskScheduler.schedule({
      name: 'Intelligence Monitor — Daily Scan',
      description: 'Scan internet for new tools and auto-upgrade APEX',
      task: { agent: 'IntelligenceMonitor', action: 'scan' },
      schedule: 'daily:06:00',
    });
    this.log('Intelligence monitoring scheduled — daily at 06:00');
    return { watching: true, schedule: 'daily:06:00' };
  }

  // ── FETCH SOURCES ─────────────────────────────────────────────────────────
  async _fetchSource(source) {
    const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; ApexBot/1.0)' };

    if (source.type === 'github') {
      const resp = await axios.get(source.url, { headers, timeout: 10000 });
      const $ = cheerio.load(resp.data);
      const repos = [];
      $('article.Box-row').slice(0, 10).each((i, el) => {
        const name = $(el).find('h2 a').text().trim().replace(/\s+/g, '');
        const desc = $(el).find('p').text().trim();
        const lang = $(el).find('[itemprop="programmingLanguage"]').text().trim();
        if (name) repos.push({ name, description: desc, language: lang, source: 'github-trending' });
      });
      return repos;
    }

    if (source.type === 'hn') {
      const ids = await axios.get(source.url, { timeout: 8000 });
      const top5 = ids.data.slice(0, 5);
      const stories = await Promise.all(top5.map(id =>
        axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 5000 })
          .then(r => r.data).catch(() => null)
      ));
      return stories.filter(Boolean).map(s => ({ name: s.title, url: s.url, score: s.score, source: 'hacker-news' }));
    }

    if (source.type === 'npm') {
      const resp = await axios.get(source.url, { timeout: 8000 });
      return resp.data.objects.map(p => ({
        name: p.package.name,
        description: p.package.description,
        version: p.package.version,
        npmName: p.package.name,
        source: 'npm',
      }));
    }

    if (source.type === 'github_api') {
      const resp = await axios.get(source.url, {
        headers: process.env.GITHUB_TOKEN ? { ...headers, Authorization: `token ${process.env.GITHUB_TOKEN}` } : headers,
        timeout: 10000,
      });
      return resp.data.items.map(r => ({
        name: r.full_name,
        description: r.description,
        stars: r.stargazers_count,
        url: r.html_url,
        language: r.language,
        source: 'github',
      }));
    }

    if (source.type === 'public_apis') {
      const resp = await axios.get(source.url, { timeout: 8000 });
      return (resp.data.entries || []).slice(0, 20).map(e => ({
        name: e.API,
        description: e.Description,
        url: e.Link,
        category: e.Category,
        auth: e.Auth,
        source: 'public-apis',
      }));
    }

    return [];
  }

  async _evaluateRelevance(findings) {
    const allItems = findings.flatMap(f => f.items).slice(0, 20);
    if (!allItems.length) return { highPriority: [], medium: [], low: [] };

    return structured(
      `Evaluate these discovered items for relevance to an autonomous AI agent system (APEX).\nAPEX capabilities: code generation, web automation, device control, voice, image gen, security, deployment.\n\nItems:\n${JSON.stringify(allItems, null, 2)}\n\nCategorize by priority for integration.`,
      {
        highPriority: [{ name: 'item name', reason: 'why high priority', type: 'tool/api/library' }],
        medium: [{ name: 'item name', reason: 'why' }],
        skip: ['item names to skip'],
      },
      { temperature: 0.3 }
    );
  }

  _isKnown(item) {
    const key = item.name || item.title || '';
    return this._knownItems.has(key.toLowerCase());
  }

  _markKnown(item) {
    const key = (item.name || item.title || '').toLowerCase();
    this._knownItems.add(key);
    const arr = [...this._knownItems];
    writeFileSync(path.join(INTEL_DIR, 'known.json'), JSON.stringify(arr));
  }

  _loadKnownItems() {
    const p = path.join(INTEL_DIR, 'known.json');
    if (existsSync(p)) {
      try { return new Set(JSON.parse(readFileSync(p, 'utf8'))); } catch {}
    }
    return new Set();
  }

  _saveFindings(findings) {
    const p = path.join(INTEL_DIR, 'findings.json');
    let existing = [];
    if (existsSync(p)) { try { existing = JSON.parse(readFileSync(p, 'utf8')); } catch {} }
    existing.push({ ts: Date.now(), findings });
    if (existing.length > 30) existing = existing.slice(-30);
    writeFileSync(p, JSON.stringify(existing, null, 2));
  }

  _loadFindings() {
    const p = path.join(INTEL_DIR, 'findings.json');
    if (existsSync(p)) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch {} }
    return [];
  }
}

export default IntelligenceMonitor;
