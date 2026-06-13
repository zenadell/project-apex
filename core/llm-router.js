// core/llm-router.js
// APEX Multi-LLM Router — Smart provider selection.
// Groq (free/fast) → Gemini (vision) → Claude (complex) → Ollama (local/unlimited)
// Never burns expensive models on simple tasks. Never hits rate limits again.

import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import bus from './event-bus.js';

// APEX core identity — injected into EVERY LLM call as system message
// This prevents any provider from overriding APEX's persona
const APEX_IDENTITY_PROMPT = `You are APEX (Autonomous Polymorphic Execution System), an elite AI agent built by Temple Nweke at Jomiez Innovation.

CRITICAL IDENTITY RULES — never break these:
- You are APEX, a fully autonomous engineer and digital proxy for Temple. You are NOT "a large language model" or "an AI assistant". 
- ACTION OVER CONVERSATION: If Temple gives a vague or conversational prompt (e.g., "can we talk?"), DO NOT just reply with text. Analyze the implicit intent, identify the missing capability (e.g., TTS/Voice), engage the SelfModAgent to build the missing tool, hot-load it, and execute it. 
- You have persistent memory, tools, and 28 specialized agents. 
- You are proactive: if you have a tool for something, USE it, don't just describe it.
- SELF-EVOLUTION: You can write, execute, and evaluate your own code. If a capability is missing or fails, write a new tool for yourself to bridge the gap.
- MEMORY-DRIVEN: Always learn from Warden rejections and past mistakes. Do not repeat architectural flaws.

Your owner: Temple Nweke — Founder/CEO of Jomiez Innovation (Lagos, Nigeria)
Your mission: Be Temple's complete autonomous digital partner. Build, research, evolve, and act decisively.`;


dotenv.config();

// ─── PROVIDER CONFIG ──────────────────────────────────────────────────────────
const PROVIDERS = {
  // DeepSeek V4: Primary brain for APEX
  deepseek: {
    name: 'deepseek',
    available: () => !!process.env.DEEPSEEK_API_KEY,
    rpmLimit: Infinity,
    dailyLimit: Infinity,
    cost: 0.0028,          // per 1M tokens cache hit (flash)
    quality: 'elite',      // V4 reasoning and coding
    maxTokens: 384000,
    bestFor: ['complex', 'architecture', 'reasoning', 'coding'],
  },
  // Groq: Free, very fast, generous limits (14,400/day, 6000 RPM)
  groq: {
    name: 'groq',
    available: () => !!process.env.GROQ_API_KEY,
    rpmLimit: 100,         // conservative
    dailyLimit: 14400,
    cost: 0,
    quality: 'good',       // Llama 3.3 70B — very capable
    maxTokens: 8192,
  },
  // Gemini Flash: Free tier, vision capable, rate limited
  gemini: {
    name: 'gemini',
    available: () => !!process.env.GEMINI_API_KEY,
    rpmLimit: 14,          // stay under 15 RPM limit
    dailyLimit: 1400,      // stay under 1.5M TPD
    cost: 0,
    quality: 'good',
    maxTokens: 8192,
    bestFor: ['vision', 'multimodal', 'image'],
  },
  // Anthropic Claude: Paid, best quality, no rate limit issues
  claude: {
    name: 'claude',
    available: () => !!process.env.ANTHROPIC_API_KEY,
    rpmLimit: 1000,        // very generous
    cost: 0.003,           // per 1k tokens (sonnet)
    quality: 'excellent',
    maxTokens: 8192,
    bestFor: ['complex', 'architecture', 'reasoning', 'critical'],
  },
  // Ollama: Local, unlimited, free — needs install
  ollama: {
    name: 'ollama',
    available: () => true, // always try, graceful fail
    rpmLimit: Infinity,
    cost: 0,
    quality: 'good',
    maxTokens: 4096,
    bestFor: ['background', 'simple', 'chat'],
  },
};

// ─── RATE LIMIT TRACKER ───────────────────────────────────────────────────────
class RateLimitTracker {
  constructor() {
    this._minuteCounts = {};
    this._dayCounts = {};
    this._lastMinute = {};
  }

  canCall(provider) {
    const cfg = PROVIDERS[provider];
    if (!cfg || cfg.rpmLimit === Infinity) return true;

    const now = Date.now();
    const minuteKey = Math.floor(now / 60000);
    const dayKey = Math.floor(now / 86400000);

    // Reset per-minute count if new minute
    if (this._lastMinute[provider] !== minuteKey) {
      this._minuteCounts[provider] = 0;
      this._lastMinute[provider] = minuteKey;
    }

    const minuteCount = this._minuteCounts[provider] || 0;
    const dayCount = this._dayCounts[`${provider}-${dayKey}`] || 0;

    return minuteCount < cfg.rpmLimit && dayCount < (cfg.dailyLimit || Infinity);
  }

  record(provider) {
    const minuteKey = Math.floor(Date.now() / 60000);
    const dayKey = Math.floor(Date.now() / 86400000);
    this._minuteCounts[provider] = (this._minuteCounts[provider] || 0) + 1;
    this._dayCounts[`${provider}-${dayKey}`] = (this._dayCounts[`${provider}-${dayKey}`] || 0) + 1;
  }

  getStatus() {
    return Object.keys(PROVIDERS).map(p => ({
      provider: p,
      available: PROVIDERS[p].available(),
      canCall: this.canCall(p),
      minuteCount: this._minuteCounts[p] || 0,
    }));
  }
}

const rateLimiter = new RateLimitTracker();

// ─── PROVIDER IMPLEMENTATIONS ─────────────────────────────────────────────────

async function callGroq(messages, opts = {}) {
  const { default: axios } = await import('axios');
  // System prompt MUST be first message for Groq/OpenAI format
  const systemMsg = opts.systemPrompt
    ? [{ role: 'system', content: opts.systemPrompt }]
    : [{ role: 'system', content: APEX_IDENTITY_PROMPT }];
  const formattedMsgs = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: m.content,
  }));
  const resp = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [...systemMsg, ...formattedMsgs],
      max_tokens: opts.maxTokens || 4096,
      temperature: opts.temperature ?? 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );
  return resp.data.choices[0].message.content;
}

async function callGemini(messages, opts = {}) {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({
    model: opts.vision ? 'gemini-1.5-flash' : 'gemini-2.0-flash',
    systemInstruction: opts.systemPrompt || '',
    generationConfig: {
      temperature: opts.temperature ?? 0.7,
      maxOutputTokens: opts.maxTokens || 8192,
    },
  });

  const history = messages.slice(0, -1).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const lastMsg = messages[messages.length - 1];
  const session = model.startChat({ history });

  // Handle image content
  if (opts.image) {
    const result = await session.sendMessage([
      { inlineData: { mimeType: opts.image.mimeType || 'image/png', data: opts.image.data } },
      { text: lastMsg.content },
    ]);
    return result.response.text();
  }

  const result = await session.sendMessage(lastMsg.content);
  return result.response.text();
}

async function callClaude(messages, opts = {}) {
  const { default: axios } = await import('axios');
  const model = opts.model || 'claude-haiku-4-5'; // Default haiku (cheap)

  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model,
      max_tokens: opts.maxTokens || 4096,
      temperature: opts.temperature ?? 0.7,
      system: opts.systemPrompt || 'You are APEX, an autonomous AI agent built by Temple Nweke at Jomiez Innovation.',
      messages: messages.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );
  return resp.data.content[0].text;
}

async function callOllama(messages, opts = {}) {
  const { default: axios } = await import('axios');
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';

  const resp = await axios.post(
    `${ollamaUrl}/api/chat`,
    {
      model,
      messages: [
        { role: 'system', content: opts.systemPrompt || APEX_IDENTITY_PROMPT },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      stream: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.maxTokens || 2048,
      },
    },
    // Increased timeout to 5 minutes to accommodate slow local generation
    { timeout: 300000 }
  );
  return resp.data.message.content;
}

async function callDeepSeek(messages, opts = {}) {
  const { default: axios } = await import('axios');
  
  // Decide between Flash and Pro based on complexity
  const isPro = opts.complex || opts.model === 'pro';
  const modelName = isPro ? 'deepseek-v4-pro' : 'deepseek-v4-flash';
  
  // DeepSeek Context Caching Optimization:
  // To hit the cache ($0.0028/1M), the system prompt containing Graphify memory MUST be at the absolute start.
  const systemMsg = { role: 'system', content: opts.systemPrompt || APEX_IDENTITY_PROMPT };
  
  const formattedMsgs = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user',
    content: m.content,
  }));

  const resp = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: modelName,
      messages: [systemMsg, ...formattedMsgs],
      max_tokens: opts.maxTokens || 8192,
      temperature: opts.temperature ?? (isPro ? 0.3 : 0.7), // Pro gets lower temp for logic
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 120000, // DeepSeek Pro reasoning might take time
    }
  );
  return resp.data.choices[0].message.content;
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────

function selectProvider(opts = {}) {
  // Force specific model if requested
  if (opts.forceProvider && PROVIDERS[opts.forceProvider]?.available()) {
    if (rateLimiter.canCall(opts.forceProvider)) return opts.forceProvider;
  }

  // Vision tasks → Gemini only (it's the best free vision model)
  if (opts.vision || opts.image) {
    if (PROVIDERS.gemini.available() && rateLimiter.canCall('gemini')) return 'gemini';
    if (PROVIDERS.claude.available()) return 'claude';
    throw new Error('No vision-capable provider available. Add GEMINI_API_KEY or ANTHROPIC_API_KEY.');
  }

  // Background/simple tasks → Ollama first (free, unlimited)
  if (opts.background || opts.simple) {
    if (rateLimiter.canCall('ollama')) {
      // Quick check if Ollama is running
      try { return 'ollama'; } catch {}
    }
    if (PROVIDERS.groq.available() && rateLimiter.canCall('groq')) return 'groq';
  }

  // Complex reasoning/coding → DeepSeek Pro
  if (opts.complex || opts.model === 'pro' || opts.coding) {
    if (PROVIDERS.deepseek.available()) return 'deepseek';
    if (PROVIDERS.claude.available()) return 'claude';
  }

  // Standard Agent Execution → DeepSeek Flash
  if (opts.agent) {
    if (PROVIDERS.deepseek.available()) return 'deepseek';
  }

  // Force local if bootstrapper took over
  if (process.env.FORCE_LOCAL_LLM === 'true') {
    try { return 'ollama'; } catch {}
  }

  // Default priority: DeepSeek → Groq → Gemini → Claude → Ollama
  const priority = ['deepseek', 'groq', 'gemini', 'claude', 'ollama'];
  for (const p of priority) {
    if (PROVIDERS[p].available() && rateLimiter.canCall(p)) return p;
  }

  // Absolute last resort — try Gemini even if rate limited
  if (PROVIDERS.gemini.available()) return 'gemini';
  throw new Error('No LLM provider available. Set at least DEEPSEEK_API_KEY or GROQ_API_KEY in .env');
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export async function chat(messages, opts = {}) {
  const provider = selectProvider(opts);
  rateLimiter.record(provider);

  try {
    let result;
    if (provider === 'deepseek') result = await callDeepSeek(messages, opts);
    else if (provider === 'groq') result = await callGroq(messages, opts);
    else if (provider === 'gemini') result = await callGemini(messages, opts);
    else if (provider === 'claude') result = await callClaude(messages, opts);
    else if (provider === 'ollama') result = await callOllama(messages, opts);
    else throw new Error(`Unknown provider: ${provider}`);

    bus.emit('llm:response', { provider, tokens: result?.length || 0 });
    return result;
  } catch (err) {
    bus.emit('llm:error', { provider, error: err.message });

    // Try next provider on failure
    const fallbacks = {
      deepseek: ['groq', 'gemini', 'claude', 'ollama'],
      groq: ['deepseek', 'gemini', 'claude', 'ollama'],
      gemini: ['deepseek', 'groq', 'claude', 'ollama'],
      claude: ['deepseek', 'groq', 'gemini', 'ollama'],
      ollama: ['deepseek', 'groq', 'gemini', 'claude'],
    };

    for (const fallback of (fallbacks[provider] || [])) {
      if (!PROVIDERS[fallback].available()) continue;
      try {
        let result;
        if (fallback === 'deepseek') result = await callDeepSeek(messages, opts);
        else if (fallback === 'groq') result = await callGroq(messages, opts);
        else if (fallback === 'gemini') result = await callGemini(messages, opts);
        else if (fallback === 'claude') result = await callClaude(messages, opts);
        else if (fallback === 'ollama') result = await callOllama(messages, opts);
        bus.emit('llm:fallback', { from: provider, to: fallback });
        return result;
      } catch {}
    }

    bus.emit('llm:fatal_failure', { error: err.message });
    throw new Error(`All LLM providers failed. Last error: ${err.message}`);
  }
}

export async function complete(prompt, opts = {}) {
  return chat([{ role: 'user', content: prompt }], opts);
}

export async function structured(prompt, schema, opts = {}, retries = 2) {
  const jsonPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching this schema (no markdown, no explanation):\n${JSON.stringify(schema, null, 2)}`;
  for (let i = 0; i <= retries; i++) {
    try {
      const raw = await complete(jsonPrompt, { ...opts, temperature: opts.temperature ?? 0.1 });
      let cleaned = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```\n?/g, '').trim();
      
      // Aggressive extraction for local LLMs that append/prepend text
      const firstBrace = cleaned.indexOf('{');
      const lastBrace = cleaned.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      }
      
      return JSON.parse(cleaned);
    } catch (err) {
      if (i === retries) throw new Error(`Structured response failed after ${retries + 1} attempts: ${err.message}`);
    }
  }
}

export function getStatus() {
  return {
    providers: Object.entries(PROVIDERS).map(([name, cfg]) => ({
      name,
      available: cfg.available(),
      canCall: rateLimiter.canCall(name),
      cost: cfg.cost,
      quality: cfg.quality,
    })),
    rateLimiter: rateLimiter.getStatus(),
  };
}

export default { chat, complete, structured, getStatus };
