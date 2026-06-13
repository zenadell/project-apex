// agents/prospector.js
// APEX BusinessProspector — Finds businesses that need your services.
// OSINT on public business info, identifies needs, builds personalized proposals.
// Powers Jomiez Prospector — your autonomous client acquisition engine.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { launchStealthBrowser } from '../tools/human-cursor.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Memory from '../core/memory.js';
import bus from '../core/event-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROSPECTS_DIR = path.join(__dirname, '..', '.apex-data', 'prospects');
if (!existsSync(PROSPECTS_DIR)) mkdirSync(PROSPECTS_DIR, { recursive: true });

export class BusinessProspector extends BaseAgent {
  constructor() {
    super({
      name: 'BusinessProspector',
      type: 'prospector',
      description: 'Finds businesses that need web/app/automation services. Uses public OSINT to research them, identifies their pain points, builds personalized proposals. Autonomous client acquisition.',
    });
  }

  async run(task) {
    const { action = 'find' } = task;

    switch (action) {
      case 'find':      return this.findProspects(task);
      case 'research':  return this.researchBusiness(task);
      case 'propose':   return this.buildProposal(task);
      case 'full':      return this.fullPipeline(task);
      case 'list':      return this.listProspects();
      default:          return this.findProspects(task);
    }
  }

  // ── FIND PROSPECTS ────────────────────────────────────────────────────────
  async findProspects({ niche, location, service = 'website', count = 10, targetCountries = ['US', 'UK', 'CA', 'AU', 'UAE'] }) {
    this.log(`Finding ${count} ${niche} businesses in ${targetCountries.join(', ')}`);

    const prospects = [];

    // Search strategies: Google Maps, DuckDuckGo, Yelp, LinkedIn
    const searches = [
      `${niche} business ${location || targetCountries[0]} no website`,
      `${niche} company ${location || 'USA'} looking for web design`,
      `${niche} small business ${location || ''} site:yelp.com`,
    ];

    for (const query of searches) {
      try {
        const found = await this._searchForBusinesses(query, niche);
        prospects.push(...found);
        if (prospects.length >= count) break;
      } catch (err) {
        this.log(`Search failed: ${err.message}`, 'warn');
      }
    }

    // Also check public directories
    const directoryProspects = await this._searchDirectories(niche, location);
    prospects.push(...directoryProspects);

    // Deduplicate by business name
    const unique = prospects.filter((p, i, arr) =>
      arr.findIndex(x => x.name?.toLowerCase() === p.name?.toLowerCase()) === i
    ).slice(0, count);

    // Qualify each prospect
    const qualified = await this._qualifyProspects(unique, service);

    bus.emit('prospector:found', { count: qualified.length, niche });
    return { niche, service, prospects: qualified, total: qualified.length };
  }

  async _searchForBusinesses(query, niche) {
    const encoded = encodeURIComponent(query);
    const resp = await axios.get(`https://html.duckduckgo.com/html/?q=${encoded}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchBot)' },
      timeout: 10000,
    });

    const $ = cheerio.load(resp.data);
    const results = [];

    $('.result').slice(0, 8).each((i, el) => {
      const title = $(el).find('.result__title').text().trim();
      const snippet = $(el).find('.result__snippet').text().trim();
      const url = $(el).find('.result__url').text().trim();

      if (title && snippet) {
        results.push({
          name: title,
          description: snippet,
          website: url,
          niche,
          source: 'web-search',
          discovered: Date.now(),
        });
      }
    });

    return results;
  }

  async _searchDirectories(niche, location) {
    const prospects = [];

    // Yelp search (no auth needed for basic search)
    try {
      const resp = await axios.get(`https://www.yelp.com/search?find_desc=${encodeURIComponent(niche)}&find_loc=${encodeURIComponent(location || 'United States')}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ResearchBot)' },
        timeout: 10000,
      });
      const $ = cheerio.load(resp.data);

      $('[class*="businessName"], h3 a').slice(0, 5).each((i, el) => {
        const name = $(el).text().trim();
        const href = $(el).attr('href');
        if (name && href) {
          prospects.push({ name, website: 'https://www.yelp.com' + href, source: 'yelp', niche });
        }
      });
    } catch {}

    return prospects;
  }

  async _qualifyProspects(prospects, service) {
    const qualified = [];

    for (const prospect of prospects.slice(0, 20)) {
      try {
        // Quick check: does this business have a website?
        const hasWebsite = prospect.website && !prospect.website.includes('yelp.com') && !prospect.website.includes('yellowpages');
        const websiteQuality = hasWebsite ? await this._checkWebsiteQuality(prospect.website) : { score: 0, hasWebsite: false };

        qualified.push({
          ...prospect,
          hasWebsite: websiteQuality.hasWebsite,
          websiteScore: websiteQuality.score,
          needsService: websiteQuality.score < 60 || !websiteQuality.hasWebsite,
          qualificationReason: websiteQuality.hasWebsite
            ? (websiteQuality.score < 60 ? 'Has website but poor quality' : 'Has decent website')
            : 'No website found — perfect prospect',
          priority: !websiteQuality.hasWebsite ? 'high' : websiteQuality.score < 40 ? 'high' : websiteQuality.score < 60 ? 'medium' : 'low',
        });
      } catch {
        qualified.push({ ...prospect, needsService: true, priority: 'medium' });
      }
    }

    return qualified.sort((a, b) => {
      const prio = { high: 0, medium: 1, low: 2 };
      return prio[a.priority] - prio[b.priority];
    });
  }

  async _checkWebsiteQuality(url) {
    if (!url || !url.startsWith('http')) return { hasWebsite: false, score: 0 };
    try {
      const resp = await axios.get(url, {
        timeout: 8000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GoogleBot)' },
      });
      const $ = cheerio.load(resp.data);
      let score = 50; // base

      // Quality signals
      if ($('meta[name="viewport"]').length) score += 10; // mobile-friendly
      if ($('img[alt]').length > 0) score += 5; // has alt text
      if (resp.data.includes('ssl') || url.startsWith('https')) score += 10; // HTTPS
      if ($('title').text().length > 10) score += 5; // has title
      if ($('meta[name="description"]').length) score += 5; // has meta desc

      // Negative signals
      if (resp.data.includes('Under Construction')) score -= 30;
      if (resp.data.includes('Coming Soon')) score -= 30;
      if (!resp.data.includes('<nav') && !resp.data.includes('<header')) score -= 10;

      return { hasWebsite: true, score: Math.max(0, Math.min(100, score)) };
    } catch {
      return { hasWebsite: false, score: 0 };
    }
  }

  // ── RESEARCH A SPECIFIC BUSINESS ─────────────────────────────────────────
  async researchBusiness({ name, website = null, domain = null }) {
    this.log(`Researching: ${name}`);

    const research = {
      name, website: website || domain,
      publicInfo: {}, socialProfiles: {}, techStack: {},
      painPoints: [], opportunities: [],
    };

    // 1. Check their website if they have one
    if (website || domain) {
      const url = website || `https://${domain}`;
      try {
        const resp = await axios.get(url, { timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(resp.data);

        research.publicInfo = {
          title: $('title').text().trim(),
          description: $('meta[name="description"]').attr('content') || '',
          phone: $('[href^="tel:"]').first().attr('href')?.replace('tel:', '') || '',
          email: $('[href^="mailto:"]').first().attr('href')?.replace('mailto:', '') || '',
          address: $('[class*="address"], [id*="address"]').first().text().trim().slice(0, 200) || '',
          hasContactForm: $('form').length > 0,
          pageCount: $('a[href^="/"]').length,
          lastUpdated: $('time, [class*="date"]').first().text().trim() || 'unknown',
        };

        // Detect tech stack
        const html = resp.data;
        research.techStack = {
          wordpress: html.includes('wp-content') || html.includes('wordpress'),
          wix: html.includes('wixstatic') || html.includes('wix.com'),
          squarespace: html.includes('squarespace'),
          shopify: html.includes('cdn.shopify'),
          bootstrap: html.includes('bootstrap'),
          jquery: html.includes('jquery'),
          react: html.includes('react') || html.includes('__reactFiber'),
          googleAnalytics: html.includes('google-analytics') || html.includes('gtag'),
          mobileFriendly: html.includes('viewport'),
          hasSEO: html.includes('meta name="description"'),
          hasSSL: url.startsWith('https'),
        };
      } catch {}
    }

    // 2. Quick social search
    try {
      const googleSearch = await axios.get(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`"${name}" site:linkedin.com OR site:instagram.com OR site:facebook.com`)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 }
      );
      const $ = cheerio.load(googleSearch.data);
      $('.result__url').each((i, el) => {
        const url = $(el).text().trim();
        if (url.includes('linkedin.com')) research.socialProfiles.linkedin = url;
        if (url.includes('instagram.com')) research.socialProfiles.instagram = url;
        if (url.includes('facebook.com')) research.socialProfiles.facebook = url;
      });
    } catch {}

    // 3. AI analysis of pain points and opportunities
    const analysis = await structured(
      `Analyze this business and identify opportunities for web/app/automation services.\n\nBusiness: ${name}\nPublic info: ${JSON.stringify(research.publicInfo)}\nTech stack: ${JSON.stringify(research.techStack)}\nSocial profiles: ${JSON.stringify(research.socialProfiles)}\n\nIdentify their likely pain points and what services would help them most.`,
      {
        painPoints: ['list of likely business pain points based on findings'],
        opportunities: ['specific services that would help this business'],
        estimatedBudget: 'rough estimate of what they could spend',
        approachStrategy: 'how to best approach them',
        urgency: 'low/medium/high — how urgent their need seems',
        bestContact: 'best way to reach them based on findings',
      },
      { temperature: 0.4 }
    );

    research.painPoints = analysis.painPoints || [];
    research.opportunities = analysis.opportunities || [];
    research.analysis = analysis;

    // Save to prospects DB
    const prospectPath = path.join(PROSPECTS_DIR, `${name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.json`);
    writeFileSync(prospectPath, JSON.stringify(research, null, 2));

    this.remember(`Researched: ${name} | Opportunities: ${(analysis.opportunities || []).slice(0, 2).join(', ')}`, {
      tags: ['prospect', 'research', name], importance: 7,
    });

    return research;
  }

  // ── BUILD PROPOSAL ────────────────────────────────────────────────────────
  async buildProposal({ prospect, service, senderName = null, companyName = 'Jomiez Innovation', customNote = '' }) {
    const profile = await this._getUserProfile();
    const sender = senderName || profile?.name || 'Temple';

    const research = prospect.analysis || {};
    const businessName = prospect.name;
    const opportunities = prospect.opportunities || [service];

    const proposal = await complete(
      `Write a compelling, personalized business proposal from ${sender} at ${companyName}.\n\nProspect: ${businessName}\nService: ${service}\nIdentified needs: ${opportunities.slice(0, 3).join(', ')}\nPain points: ${(prospect.painPoints || []).slice(0, 3).join(', ')}\nApproach: ${research.approachStrategy || 'warm and direct'}\nCustom note: ${customNote}\n\nWrite a proposal that:\n1. Opens with something specific about THEIR business (shows research)\n2. Identifies their specific problem clearly\n3. Proposes your solution with real benefits\n4. Is concise (3-4 paragraphs max)\n5. Has a clear call-to-action\n6. Sounds human, not templated\n\nDo NOT use: "I hope this finds you well", "I am writing to", generic openers.\nDO use: specific references to their business, concrete value propositions.`,
      { temperature: 0.7, maxTokens: 800 }
    );

    const outreachPlan = {
      businessName, service, sender,
      proposal,
      channels: this._rankChannels(prospect),
      followUpSchedule: ['Day 0: Send initial message', 'Day 3: Follow up if no response', 'Day 7: Final follow up', 'Day 14: Move to cold list'],
      estimatedValue: research.estimatedBudget || '$500-$5000',
    };

    this.remember(`Proposal built for: ${businessName} — ${service}`, { tags: ['proposal', 'prospect'], importance: 8 });
    bus.emit('prospector:proposal_built', { business: businessName, service });

    return outreachPlan;
  }

  // ── FULL PIPELINE ────────────────────────────────────────────────────────
  // Find → Research → Propose → Outreach (with approval gate)
  async fullPipeline({ niche, location, service, count = 5, autoSend = false }) {
    this.log(`Full pipeline: ${niche} | ${service} | ${count} prospects`);

    // 1. Find prospects
    const { prospects } = await this.findProspects({ niche, location, service, count });
    const highPriority = prospects.filter(p => p.priority === 'high').slice(0, count);

    const pipeline = [];

    for (const prospect of highPriority) {
      try {
        // 2. Research
        const research = await this.researchBusiness({
          name: prospect.name,
          website: prospect.website,
        });

        // 3. Build proposal
        const proposal = await this.buildProposal({
          prospect: { ...prospect, ...research },
          service,
        });

        pipeline.push({ prospect, research, proposal });

        // 4. Auto-send (only if explicitly enabled)
        if (autoSend && research.publicInfo?.email) {
          const emailAgent = (await import('../core/agent-registry.js')).default.get('EmailCalendarAgent');
          if (emailAgent) {
            await emailAgent._handleTask({
              id: 'outreach',
              action: 'send',
              to: research.publicInfo.email,
              subject: `Quick question about ${prospect.name}'s online presence`,
              body: proposal.proposal,
            });
            pipeline[pipeline.length - 1].sent = true;
          }
        }

        // Respectful delay between prospects
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
      } catch (err) {
        this.log(`Failed to process ${prospect.name}: ${err.message}`, 'warn');
      }
    }

    return { niche, service, pipeline, readyToSend: pipeline.filter(p => !p.sent) };
  }

  listProspects() {
    const { readdirSync, readFileSync } = require('fs');
    try {
      const files = readdirSync(PROSPECTS_DIR).filter(f => f.endsWith('.json'));
      return files.map(f => {
        try { return JSON.parse(readFileSync(path.join(PROSPECTS_DIR, f), 'utf8')); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  _rankChannels(prospect) {
    const channels = [];
    if (prospect.publicInfo?.email) channels.push({ platform: 'email', contact: prospect.publicInfo.email, priority: 1 });
    if (prospect.socialProfiles?.linkedin) channels.push({ platform: 'linkedin', contact: prospect.socialProfiles.linkedin, priority: 2 });
    if (prospect.publicInfo?.phone) channels.push({ platform: 'phone', contact: prospect.publicInfo.phone, priority: 3 });
    if (prospect.socialProfiles?.instagram) channels.push({ platform: 'instagram', contact: prospect.socialProfiles.instagram, priority: 4 });
    return channels;
  }

  async _getUserProfile() {
    try {
      const reg = (await import('../core/agent-registry.js')).default;
      const p = reg.get('UserProfileAgent');
      if (p) return await p._handleTask({ id: 'profile', action: 'profile' });
    } catch {}
    return {};
  }
}

export default BusinessProspector;
