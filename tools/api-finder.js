// tools/api-finder.js
// APEX API Finder — Finds free/keyless APIs so APEX never gets stuck needing credentials.
import axios from 'axios';
import * as cheerio from 'cheerio';
import { complete, structured } from '../core/llm.js';
import Memory from '../core/memory.js';

// Known free APIs catalogue (curated, always available)
const FREE_APIS = {
  weather: [
    { name: 'Open-Meteo', url: 'https://api.open-meteo.com/v1/forecast', keyless: true, docs: 'https://open-meteo.com/en/docs' },
    { name: 'wttr.in', url: 'https://wttr.in/{city}?format=j1', keyless: true },
  ],
  geocoding: [
    { name: 'Nominatim (OpenStreetMap)', url: 'https://nominatim.openstreetmap.org/search', keyless: true },
    { name: 'ip-api.com', url: 'http://ip-api.com/json', keyless: true },
  ],
  news: [
    { name: 'HackerNews', url: 'https://hacker-news.firebaseio.com/v0', keyless: true },
    { name: 'NewsData.io', url: 'https://newsdata.io/api/1/news', keyless: false, freeTier: true },
  ],
  exchange: [
    { name: 'ExchangeRate-API', url: 'https://open.er-api.com/v6/latest', keyless: true },
    { name: 'Fixer.io', url: 'https://api.fixer.io/latest', keyless: false, freeTier: true },
  ],
  crypto: [
    { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3', keyless: true },
    { name: 'Binance', url: 'https://api.binance.com/api/v3', keyless: true },
  ],
  code: [
    { name: 'GitHub', url: 'https://api.github.com', keyless: true, rateLimit: '60/hr' },
    { name: 'npmjs', url: 'https://registry.npmjs.org', keyless: true },
    { name: 'PyPI', url: 'https://pypi.org/pypi', keyless: true },
  ],
  ai: [
    { name: 'Gemini Flash (free tier)', url: 'https://generativelanguage.googleapis.com', keyless: false, freeTier: true },
    { name: 'Groq (free tier)', url: 'https://api.groq.com', keyless: false, freeTier: true },
    { name: 'Ollama (local)', url: 'http://localhost:11434', keyless: true, local: true },
  ],
  image: [
    { name: 'Unsplash (limited)', url: 'https://api.unsplash.com', keyless: false, freeTier: true },
    { name: 'Picsum Photos', url: 'https://picsum.photos', keyless: true },
    { name: 'Lorem Flickr', url: 'https://loremflickr.com', keyless: true },
  ],
  database: [
    { name: 'JSONPlaceholder', url: 'https://jsonplaceholder.typicode.com', keyless: true, note: 'Mock data' },
    { name: 'Random User', url: 'https://randomuser.me/api', keyless: true },
    { name: 'FakeStore API', url: 'https://fakestoreapi.com', keyless: true },
  ],
  utilities: [
    { name: 'ipify', url: 'https://api.ipify.org?format=json', keyless: true },
    { name: 'QR Server', url: 'https://api.qrserver.com/v1/create-qr-code', keyless: true },
    { name: 'Is It Up?', url: 'https://isitup.org/{domain}.json', keyless: true },
  ],
};

export class APIFinder {
  // Find the best free API for a given need
  async find(need) {
    // Check local cache first
    const cached = Memory.search(`api:${need}`, { limit: 1 });
    if (cached.length && Date.now() - cached[0].created_at < 7 * 24 * 60 * 60 * 1000) {
      return JSON.parse(cached[0].content.replace('api:', ''));
    }

    // Check curated catalogue
    const category = await this._matchCategory(need);
    if (FREE_APIS[category]) {
      const keyless = FREE_APIS[category].filter(a => a.keyless);
      if (keyless.length) {
        return { apis: keyless, source: 'curated', category };
      }
    }

    // Search public-apis GitHub list
    const githubResults = await this._searchPublicAPIs(need);
    if (githubResults.length) {
      Memory.store({ scope: 'long_term', agent: 'api-finder', key: `api:${need}`, content: `api:${JSON.stringify(githubResults)}`, tags: ['api', category], importance: 6 });
      return { apis: githubResults, source: 'public-apis', category };
    }

    // AI-powered suggestion
    const aiSuggestion = await this._aiSuggestAPI(need);
    return { apis: aiSuggestion, source: 'ai-suggested', category };
  }

  async _matchCategory(need) {
    const needLower = need.toLowerCase();
    const categories = Object.keys(FREE_APIS);
    for (const cat of categories) {
      if (needLower.includes(cat)) return cat;
    }
    // AI match
    const match = await complete(
      `Which category best matches this API need: "${need}"?\nCategories: ${categories.join(', ')}\nRespond with just the category name or "other".`,
      { temperature: 0.1, maxTokens: 20 }
    );
    return match.trim().toLowerCase().replace(/[^a-z]/g, '');
  }

  async _searchPublicAPIs(query) {
    try {
      // Search the public-apis JSON directly
      const resp = await axios.get('https://api.publicapis.org/entries', {
        params: { title: query, https: true, cors: 'yes' },
        timeout: 10000,
      });
      const entries = resp.data?.entries || [];
      return entries.slice(0, 5).map(e => ({
        name: e.API,
        description: e.Description,
        url: e.Link,
        keyless: e.Auth === '' || e.Auth === 'No',
        freeTier: true,
        category: e.Category,
      }));
    } catch {
      return [];
    }
  }

  async _aiSuggestAPI(need) {
    return structured(
      `Suggest the best free/keyless APIs for: "${need}"\nPrefer APIs that require no authentication. List real, working APIs.`,
      {
        apis: [
          {
            name: 'API name',
            url: 'base URL',
            keyless: true,
            description: 'what it does',
            exampleCall: 'example API call',
          }
        ]
      }
    );
  }

  // Test if an API is actually reachable
  async test(url) {
    try {
      const resp = await axios.get(url, { timeout: 5000 });
      return { reachable: true, status: resp.status };
    } catch (err) {
      return { reachable: false, error: err.message };
    }
  }

  // Get all known keyless APIs
  getAllKeyless() {
    return Object.entries(FREE_APIS).flatMap(([category, apis]) =>
      apis.filter(a => a.keyless).map(a => ({ ...a, category }))
    );
  }

  // Generate example code for using an API
  async generateUsageCode(api, language = 'javascript') {
    return complete(
      `Write a ${language} code snippet to use this API:\nName: ${api.name}\nURL: ${api.url}\nDescription: ${api.description || ''}\n\nReturn only working code, no explanation.`,
      { temperature: 0.1, maxTokens: 500 }
    );
  }
}

export const apiFinder = new APIFinder();
export default apiFinder;
