// config/loader.js
// APEX Config Loader — reads agents.yaml, merges with .env, validates
import { readFileSync, existsSync } from 'fs';
import { load as yamlLoad } from 'js-yaml';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'agents.yaml');

let _config = null;

export function loadConfig() {
  if (_config) return _config;

  if (!existsSync(CONFIG_PATH)) {
    console.warn('⚠️  config/agents.yaml not found — using defaults');
    return getDefaults();
  }

  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const yaml = yamlLoad(raw);

  // Merge env vars into config
  _config = {
    ...yaml,
    env: {
      geminiKey: process.env.GEMINI_API_KEY,
      groqKey: process.env.GROQ_API_KEY,
      githubToken: process.env.GITHUB_TOKEN,
      telegramToken: process.env.TELEGRAM_BOT_TOKEN,
      elevenLabsKey: process.env.ELEVENLABS_API_KEY,
      openaiKey: process.env.OPENAI_API_KEY,
    },
  };

  validateConfig(_config);
  return _config;
}

function validateConfig(config) {
  const warnings = [];

  if (!config.env.geminiKey) {
    warnings.push('GEMINI_API_KEY not set — LLM will not work');
  }

  if (warnings.length) {
    console.log('\n⚠️  Config warnings:');
    warnings.forEach(w => console.log(`   • ${w}`));
    console.log('');
  }
}

export function getAgentConfig(agentName) {
  const config = loadConfig();
  const agent = config.agents?.find(a => a.name === agentName);
  return agent?.config || {};
}

export function isAgentEnabled(agentName) {
  const config = loadConfig();
  const agent = config.agents?.find(a => a.name === agentName);
  return agent?.enabled !== false; // default enabled
}

export function getAgentTimeout(agentName) {
  const config = loadConfig();
  const agent = config.agents?.find(a => a.name === agentName);
  return agent?.timeout || 120000;
}

export function getPipeline(name) {
  const config = loadConfig();
  return config.pipelines?.[name] || null;
}

export function getSystemConfig() {
  return loadConfig().system || getDefaults().system;
}

function getDefaults() {
  return {
    system: {
      llm: { primary: 'gemini-2.5-flash-preview-04-17', fallback: 'gemini-1.5-flash', temperature: 0.7, maxTokens: 8192 },
      selfMod: { enabled: true, gapFillInterval: 1800000, maxPluginsPerCycle: 3 },
      selfHealing: { enabled: true, healthCheckInterval: 300000, errorThreshold: 3 },
      memory: { maxEntries: 10000 },
    },
    agents: [],
    pipelines: {},
    kali: { enabled: 'auto' },
    channels: { telegram: { enabled: false }, whatsapp: { enabled: false } },
  };
}

export default loadConfig;
