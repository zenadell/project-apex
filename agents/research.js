// agents/research.js
// APEX ResearchAgent — deep web research, repo reading, context building
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { execSync } from 'child_process';

export class ResearchAgent extends BaseAgent {
  constructor() {
    super({
      name: 'ResearchAgent',
      type: 'research',
      description: 'Scrapes the web, reads GitHub repos, finds APIs, builds comprehensive research context for other agents.',
    });
  }

  async run(task) {
    const { query, depth = 'standard', type = 'general' } = task;
    this.log(`Starting research: "${query}" (depth: ${depth})`);

    const plan = await this._planResearch(query, type);
    const results = await this._executeResearch(plan, query);
    const synthesis = await this._synthesize(query, results);

    this.remember(synthesis, {
      key: `research:${query.slice(0, 40)}`,
      tags: ['research', type],
      importance: 7,
      scope: 'session',
    });

    return { query, plan, results, synthesis };
  }

  async _planResearch(query, type) {
    return structured(
      `You are planning a research strategy for: "${query}"\nType: ${type}\nPlan 3-5 specific search queries and data sources to thoroughly research this topic.`,
      {
        searches: ['array of specific search queries'],
        sources: ['array of source types: web, github, npm, docs'],
        approach: 'brief description of research strategy',
      }
    );
  }

  async _executeResearch(plan, originalQuery) {
    const results = [];

    // Web scraping via DuckDuckGo (no API key needed)
    for (const searchQuery of (plan.searches || []).slice(0, 3)) {
      try {
        const webResults = await this._duckduckgoSearch(searchQuery);
        results.push({ source: 'web', query: searchQuery, data: webResults });
      } catch (err) {
        this.log(`Web search failed for "${searchQuery}": ${err.message}`, 'warn');
      }
    }

    // GitHub search if relevant
    if (plan.sources?.includes('github')) {
      try {
        const ghResults = await this._githubSearch(originalQuery);
        results.push({ source: 'github', data: ghResults });
      } catch (err) {
        this.log(`GitHub search failed: ${err.message}`, 'warn');
      }
    }

    // npm search if relevant
    if (plan.sources?.includes('npm')) {
      try {
        const npmResults = await this._npmSearch(originalQuery);
        results.push({ source: 'npm', data: npmResults });
      } catch (err) {
        this.log(`NPM search failed: ${err.message}`, 'warn');
      }
    }

    return results;
  }

  async _duckduckgoSearch(query) {
    try {
      const encoded = encodeURIComponent(query);
      const resp = await axios.get(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApexBot/1.0)' },
        timeout: 10000,
      });
      const $ = cheerio.load(resp.data);
      const results = [];
      $('.result').slice(0, 5).each((i, el) => {
        const title = $(el).find('.result__title').text().trim();
        const snippet = $(el).find('.result__snippet').text().trim();
        const url = $(el).find('.result__url').text().trim();
        if (title) results.push({ title, snippet, url });
      });
      return results;
    } catch (err) {
      return [{ error: err.message }];
    }
  }

  async _githubSearch(query) {
    const resp = await axios.get(`https://api.github.com/search/repositories`, {
      params: { q: query, sort: 'stars', per_page: 5 },
      headers: { Accept: 'application/vnd.github.v3+json' },
      timeout: 8000,
    });
    return resp.data.items.map(r => ({
      name: r.full_name,
      description: r.description,
      stars: r.stargazers_count,
      url: r.html_url,
      language: r.language,
    }));
  }

  async _npmSearch(query) {
    const resp = await axios.get(`https://registry.npmjs.org/-/v1/search`, {
      params: { text: query, size: 5 },
      timeout: 8000,
    });
    return resp.data.objects.map(p => ({
      name: p.package.name,
      description: p.package.description,
      version: p.package.version,
      keywords: p.package.keywords,
    }));
  }

  // Fetch and parse a URL
  async fetchUrl(url) {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ApexBot/1.0)' },
      timeout: 12000,
    });
    const $ = cheerio.load(resp.data);
    $('script, style, nav, footer, header').remove();
    return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000);
  }

  // Clone and read a GitHub repo
  async readRepo(repoUrl, { maxFiles = 10, extensions = ['.js', '.ts', '.py', '.md'] } = {}) {
    const tmpDir = `/tmp/apex-repo-${Date.now()}`;
    try {
      const command = `git clone --depth 1 ${repoUrl} "${tmpDir}"`;
      execSync(command, { timeout: 30000 });
      const { globSync } = await import('glob');
      const files = globSync(`${tmpDir}/**/*{${extensions.join(',')}}`, { nodir: true }).slice(0, maxFiles);
      const { readFileSync } = await import('fs');
      return files.map(f => ({
        path: f.replace(tmpDir, ''),
        content: readFileSync(f, 'utf8').slice(0, 2000),
      }));
    } finally {
      execSync(`rm -rf ${tmpDir}`, { timeout: 5000 });
    }
  }

  async _synthesize(query, results) {
    const context = results.map(r => {
      if (r.source === 'web') return `WEB RESULTS for "${r.query}":\n${JSON.stringify(r.data, null, 2)}`;
      if (r.source === 'github') return `GITHUB REPOS:\n${JSON.stringify(r.data, null, 2)}`;
      if (r.source === 'npm') return `NPM PACKAGES:\n${JSON.stringify(r.data, null, 2)}`;
      return JSON.stringify(r);
    }).join('\n\n---\n\n');

    return complete(
      `Based on this research data, provide a comprehensive synthesis for: "${query}"\n\n${context}\n\nProvide: key findings, best approaches, recommended tools/libraries, potential pitfalls, and a recommended implementation strategy.`,
      { temperature: 0.4, maxTokens: 3000 }
    );
  }
}

export default ResearchAgent;
