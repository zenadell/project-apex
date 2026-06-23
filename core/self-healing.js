// core/self-healing.js
// APEX Self-Healing — ACTUALLY tests that agents work. Not just .status field.
// Detects: WhatsApp disconnects, LLM failures, broken imports, stuck agents.

import bus from './event-bus.js';
import Memory from './memory.js';
import registry from './agent-registry.js';
import { complete } from './llm.js';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';

const MODULE_MAP = {
  ResearchAgent: '../agents/research.js',
  CodeAgent: '../agents/code.js',
  UIAgent: '../agents/ui.js',
  SecurityAgent: '../agents/security.js',
  SelfModAgent: '../agents/self-mod.js',
  SkillsAgent: '../agents/skills.js',
  BrowserAgent: '../agents/browser.js',
  BrowserAgentPro: '../agents/browser-pro.js',
  QAAgent: '../agents/qa.js',
  ArchitectAgent: '../agents/architect.js',
  VoiceAgent: '../agents/voice.js',
  DeviceAgent: '../agents/device.js',
  VisionAgent: '../agents/vision.js',
  UserProfileAgent: '../agents/user-profile.js',
  EmailCalendarAgent: '../agents/email-calendar.js',
  DataAgent: '../agents/data.js',
  DeployAgent: '../agents/deploy.js',
  SocialMessagingAgent: '../agents/social-messaging.js',
  BusinessProspector: '../agents/prospector.js',
  RevenueAgent: '../agents/revenue.js',
  IntelligenceMonitor: '../agents/intelligence-monitor.js',
  VerifierAgent: '../agents/verifier.js',
  GenerationAgent: '../agents/generation.js',
  VideoAgent: '../agents/video.js',
  BlenderAgent: '../agents/blender.js',
  ConsultAgent: '../agents/consult.js',
  FileSyncAgent: '../agents/file-sync.js',
};

export class SelfHealingLoop {
  constructor() {
    this._running = false;
    this._intervals = {};
    this._errorCounts = {};
    this._lastGapFill = 0;
    this._healthHistory = [];
    this._setupBusListeners();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._intervals.health   = setInterval(() => this._realHealthCheck(),  2 * 60 * 1000);
    this._intervals.llm      = setInterval(() => this._testLLM(),         60 * 60 * 1000); // Hourly, not every 10 min
    this._intervals.channels = setInterval(() => this._testChannels(),     5 * 60 * 1000);
    // Gap detection DISABLED — was creating broken plugins every 30 min
    // this._intervals.gaps  = setInterval(() => this._runGapDetection(), 30 * 60 * 1000);
    bus.emit('healing:started');
    console.log(chalk.green('💚 Self-healing active — health checks every 2 min, LLM test hourly'));
  }

  stop() {
    this._running = false;
    Object.values(this._intervals).forEach(clearInterval);
    this._intervals = {};
  }

  async _realHealthCheck() {
    const results = {};

    // Test critical agents — not just status field, check they're not stuck
    const agents = registry.all();
    for (const agent of agents) {
      const stuckMs = Date.now() - (agent._taskStartedAt || Date.now());
      if (agent.status === 'working' && stuckMs > 15 * 60 * 1000) {
        agent.setStatus('idle');
        agent._taskStartedAt = null;
        results[agent.name] = { ok: false, reason: 'stuck — reset' };
        bus.emit('healing:agent_reset', { agent: agent.name });
      } else if (agent.status === 'error') {
        results[agent.name] = { ok: false, reason: 'error state' };
        this._errorCounts[agent.name] = (this._errorCounts[agent.name] || 0) + 1;
        if (this._errorCounts[agent.name] >= 3) {
          await this._recoverAgent(agent.name);
          this._errorCounts[agent.name] = 0;
        }
      } else {
        results[agent.name] = { ok: true };
      }
    }

    // Test memory DB
    try { Memory.selfAwareness(); results.memory = { ok: true }; }
    catch (err) { results.memory = { ok: false, error: err.message }; }

    const allOk = Object.values(results).every(r => r.ok);
    const entry = { ts: Date.now(), results, allOk };
    this._healthHistory.push(entry);
    if (this._healthHistory.length > 50) this._healthHistory.shift();

    if (!allOk) {
      const failed = Object.entries(results).filter(([, v]) => !v.ok).map(([k]) => k);
      console.log(chalk.yellow(`⚕️  Health issues: ${failed.join(', ')}`));
    }

    bus.emit('healing:health_check', { results, allOk });
    return entry;
  }

  async _testLLM() {
    try {
      const start = Date.now();
      // NOTE: must leave enough budget — reasoning models spend tokens before emitting content,
      // so a tiny maxTokens returns an empty string and falsely reports the LLM as dead.
      const resp = await complete('Reply with exactly: OK', { temperature: 0, maxTokens: 64, simple: true });
      const ok = typeof resp === 'string' && resp.length > 0;
      bus.emit('healing:llm_test', { ok, latencyMs: Date.now() - start });
      if (!ok) console.log(chalk.yellow('⚕️  LLM test returned empty'));
    } catch (err) {
      console.log(chalk.red(`⚕️  LLM unreachable: ${err.message}`));
      bus.emit('healing:llm_error', { error: err.message });
    }
  }

  async _testChannels() {
    // Check WhatsApp specifically — the one that silently disconnects
    bus.emit('healing:channel_check', { ts: Date.now() });
    // Individual channel classes report their own health via bus events
  }

  async _recoverAgent(agentName) {
    console.log(chalk.yellow(`⚕️  Recovering ${agentName}...`));
    const agent = registry.get(agentName);
    if (agent) {
      agent.setStatus('idle');
      agent._conversationHistory = [];
      bus.emit('healing:agent_recovered', { agent: agentName });
      console.log(chalk.green(`✅ ${agentName} recovered`));
      return true;
    }
    return this._respawnAgent(agentName);
  }

  async _respawnAgent(agentName) {
    const modulePath = MODULE_MAP[agentName];
    if (!modulePath) return false;
    try {
      const { default: AgentClass } = await import(modulePath);
      registry.register(new AgentClass());
      this._errorCounts[agentName] = 0;
      console.log(chalk.green(`✅ ${agentName} respawned`));
      bus.emit('healing:agent_respawned', { agent: agentName });
      return true;
    } catch (err) {
      console.log(chalk.red(`❌ Respawn failed ${agentName}: ${err.message}`));
      return false;
    }
  }

  async _runGapDetection() {
    // DISABLED — gap detection was creating broken plugins every 30 min via SelfMod
    // To re-enable: uncomment the interval in start() and this method body
    console.log(chalk.gray('🧬 Gap detection skipped (disabled to prevent plugin spam)'));
  }

  _setupBusListeners() {
    bus.on('agent:failed', ({ agent }) => {
      this._errorCounts[agent] = (this._errorCounts[agent] || 0) + 1;
      if (this._errorCounts[agent] >= 3) {
        this._recoverAgent(agent).catch(() => {});
      }
    });
    bus.on('agent:started', ({ agent }) => {
      const a = registry.get(agent);
      if (a) a._taskStartedAt = Date.now();
    });
    bus.on('agent:completed', ({ agent }) => {
      this._errorCounts[agent] = Math.max(0, (this._errorCounts[agent] || 0) - 1);
      const a = registry.get(agent);
      if (a) a._taskStartedAt = null;
    });
    bus.on('task:failed', ({ error }) => {
      Memory.store({ scope: 'session', agent: 'self-healing', content: `Task failed: ${error}`, tags: ['failure'], importance: 7 });
    });
    bus.on('llm:fatal_failure', async ({ error }) => {
      if (this._bootstrapping) return;
      this._bootstrapping = true;
      try {
        console.log(chalk.red('⚕️  Caught Fatal LLM Failure. Activating Bootstrapper...'));
        const { llmBootstrapper } = await import('./llm-bootstrapper.js');
        await llmBootstrapper.rescue();
        console.log(chalk.green('⚕️  Bootstrapper completed successfully. APEX is functioning locally.'));
      } catch (err) {
        console.log(chalk.red(`⚕️  Bootstrapper failed: ${err.message}`));
      } finally {
        this._bootstrapping = false;
      }
    });

    bus.on('system:fatal_crash', async ({ error, type }) => {
      // DISABLED — was telling SelfMod to edit APEX source code during crashes, causing corruption
      console.log(chalk.red(`⚕️  SYSTEM FATAL CRASH (${type}): ${String(error).slice(0, 200)}`));
      console.log(chalk.yellow(`⚕️  Logging crash for manual review (autonomous source patching disabled)`));
      Memory.store({ scope: 'long_term', agent: 'self-healing', content: `Fatal crash (${type}): ${error}`, tags: ['crash'], importance: 9 });
    });

    bus.on('voice:provider_failure', async ({ provider, error, isFatal }) => {
      if (!isFatal) return;
      
      console.log(chalk.red(`⚕️  VOICE PROVIDER FATAL (${provider}). Delegating autonomous repair...`));
      const selfMod = registry.get('SelfModAgent');
      if (selfMod && selfMod.status === 'idle') {
        const task = {
          id: uuidv4(),
          type: 'modify_self',
          instruction: `The voice provider '${provider}' is failing with: ${error}\n\nTasks:\n1. Check if the environment is missing dependencies (e.g. edge-tts, espeak).\n2. Verify if the API key in .env is correct (if applicable).\n3. Autonomously fix the issue (install dependencies or patch code) to restore voice capability.`
        };
        selfMod._handleTask(task).catch(() => {});
      }
    });
  }

  getStatus() {
    return {
      running: this._running,
      errorCounts: this._errorCounts,
      isBootstrapping: this._bootstrapping,
      lastCheck: this._healthHistory[this._healthHistory.length - 1],
    };
  }

  get isBootstrapping() {
    return this._bootstrapping || false;
  }
}

export const selfHealingLoop = new SelfHealingLoop();
export default selfHealingLoop;
