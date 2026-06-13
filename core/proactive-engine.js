// core/proactive-engine.js
// APEX Proactive Engine — Monitors context, anticipates needs, acts autonomously.
// This is what makes APEX feel alive. It watches, learns, and acts without prompts.

import bus from './event-bus.js';
import Memory from './memory.js';
import registry from './agent-registry.js';
import { complete, structured } from './llm.js';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

export class ProactiveEngine {
  constructor() {
    this._running = false;
    this._orchestrator = null;
    this._checkInterval = null;
    this._contextWindow = [];       // Recent events/observations
    this._actionsThisHour = 0;
    this._maxActionsPerHour = 10;   // Safety limit
    this._lastHourReset = Date.now();
    this._triggers = this._defineTriggers();
    this._pendingActions = [];
  }

  init(orchestrator) {
    this._orchestrator = orchestrator;
    this._listenToEverything();
    return this;
  }

  start() {
    if (this._running) return;
    this._running = true;

    // Check for proactive opportunities every 2 minutes
    this._checkInterval = setInterval(() => this._proactiveCheck(), 2 * 60 * 1000);

    // Reset hourly action counter
    setInterval(() => {
      this._actionsThisHour = 0;
      this._lastHourReset = Date.now();
    }, 60 * 60 * 1000);

    console.log('🔮 Proactive Engine active');
    bus.emit('proactive:started');
  }

  stop() {
    this._running = false;
    clearInterval(this._checkInterval);
    bus.emit('proactive:stopped');
  }

  // ─── LISTEN TO EVERYTHING ─────────────────────────────────────────────────

  _listenToEverything() {
    // Watch all bus events
    const observe = (event, data) => {
      this._contextWindow.push({ event, data, ts: Date.now() });
      if (this._contextWindow.length > 100) this._contextWindow.shift();
    };

    bus.on('task:completed', (d) => {
      observe('task_completed', d);
      this._onTaskCompleted(d);
    });

    bus.on('task:failed', (d) => {
      observe('task_failed', d);
      this._onTaskFailed(d);
    });

    bus.on('agent:failed', (d) => {
      observe('agent_failed', d);
    });

    bus.on('selfmod:gap_filled', (d) => {
      observe('new_capability', d);
      this._announceNewCapability(d);
    });

    bus.on('bridge:device_connected', (d) => {
      observe('device_connected', d);
      this._onDeviceConnected(d);
    });

    bus.on('healing:agent_respawned', (d) => {
      observe('agent_respawned', d);
    });
  }

  // ─── DEFINE TRIGGERS ─────────────────────────────────────────────────────

  _defineTriggers() {
    return [
      {
        name: 'idle_gap_fill',
        description: 'Fill capability gaps when idle',
        condition: () => this._isIdle() && this._hoursSinceLastGapFill() > 4,
        action: async () => {
          const selfMod = registry.get('SelfModAgent');
          if (selfMod?.status === 'idle') {
            return selfMod._handleTask({ id: uuidv4(), type: 'detect_gaps' });
          }
        },
        cooldownMs: 4 * 60 * 60 * 1000,
        lastTriggered: 0,
      },
      {
        name: 'system_health_report',
        description: 'Log system health summary every hour',
        condition: () => this._minutesSinceLastEvent('health_report') > 60,
        action: async () => {
          const awareness = Memory.selfAwareness();
          const agents = registry.snapshot();
          const healthy = agents.filter(a => a.status === 'idle').length;
          const msg = `Health: ${healthy}/${agents.length} agents idle | ${awareness.capabilities?.[0]?.count || 0} capabilities | ${awareness.tasks?.total || 0} tasks run`;
          console.log(`💚 ${msg}`);
          Memory.store({ scope: 'session', agent: 'proactive', content: msg, tags: ['health'], importance: 3 });
          bus.emit('proactive:health_report', { healthy, total: agents.length });
        },
        cooldownMs: 60 * 60 * 1000,
        lastTriggered: 0,
      },
      {
        name: 'memory_summary',
        description: 'Summarize recent activity and store as long-term memory',
        condition: () => this._contextWindow.filter(e => Date.now() - e.ts < 30 * 60 * 1000).length > 10,
        action: async () => {
          const recent = this._contextWindow.slice(-20).map(e => `${e.event}: ${JSON.stringify(e.data).slice(0, 80)}`).join('\n');
          const summary = await complete(
            `Summarize these recent APEX system events into a compact memory:\n${recent}`,
            { temperature: 0.3, maxTokens: 300 }
          );
          Memory.store({ scope: 'long_term', agent: 'proactive', content: summary, tags: ['activity_summary'], importance: 6 });
        },
        cooldownMs: 30 * 60 * 1000,
        lastTriggered: 0,
      },
      {
        name: 'goal_progress_check',
        description: 'Check if any user goals can be advanced',
        condition: () => this._isIdle() && this._minutesSinceLastEvent('goal_check') > 120,
        action: async () => {
          const profileAgent = registry.get('UserProfileAgent');
          if (!profileAgent) return;
          const ctx = await profileAgent._handleTask({ id: uuidv4(), action: 'goals' });
          const activeGoals = (Array.isArray(ctx) ? ctx : []).filter(g => g.status === 'active');
          if (!activeGoals.length) return;

          // Pick the highest priority goal and see if we can advance it
          const goal = activeGoals[0];
          const canHelp = await complete(
            `Can APEX autonomously advance this goal without user input?\nGoal: "${goal.goal}"\nRespond with just: YES or NO`,
            { temperature: 0.1, maxTokens: 5 }
          );

          if (canHelp.trim().toUpperCase() === 'YES') {
            console.log(`\n🎯 Proactive: Working on goal — "${goal.goal}"`);
            bus.emit('proactive:goal_action', { goal: goal.goal });
            // Don't auto-execute — just note it and surface to user
            Memory.store({
              scope: 'session', agent: 'proactive',
              content: `Noticed goal ready for action: "${goal.goal}"`,
              tags: ['goal', 'proactive'], importance: 7,
            });
          }
          bus.emit('proactive:goal_checked', { ts: Date.now() });
        },
        cooldownMs: 2 * 60 * 60 * 1000,
        lastTriggered: 0,
      },
      {
        name: 'skill_freshness_check',
        description: 'Detect outdated or broken installed skills',
        condition: () => this._minutesSinceLastEvent('skill_check') > 1440, // once per day
        action: async () => {
          const skillsAgent = registry.get('SkillsAgent');
          if (!skillsAgent || skillsAgent.status !== 'idle') return;
          const skills = skillsAgent.listSkills();
          const count = Object.keys(skills.installed || {}).length;
          if (count > 0) {
            console.log(`📦 Proactive: ${count} installed skills — checking freshness`);
            bus.emit('proactive:skill_check', { count });
          }
        },
        cooldownMs: 24 * 60 * 60 * 1000,
        lastTriggered: 0,
      },
    ];
  }

  // ─── MAIN PROACTIVE CHECK ─────────────────────────────────────────────────

  async _proactiveCheck() {
    if (!this._running) return;
    if (this._actionsThisHour >= this._maxActionsPerHour) return;

    for (const trigger of this._triggers) {
      const cooldownPassed = Date.now() - trigger.lastTriggered > trigger.cooldownMs;
      if (!cooldownPassed) continue;

      try {
        const shouldTrigger = await Promise.resolve(trigger.condition());
        if (shouldTrigger) {
          this._actionsThisHour++;
          trigger.lastTriggered = Date.now();
          bus.emit('proactive:triggered', { trigger: trigger.name });
          await trigger.action();
        }
      } catch (err) {
        // Proactive actions should never crash the system
        bus.emit('proactive:error', { trigger: trigger.name, error: err.message });
      }
    }
  }

  // ─── REACTIVE HANDLERS ────────────────────────────────────────────────────

  _onTaskCompleted(data) {
    // Log insight from every completed task
    const recentSuccesses = this._contextWindow
      .filter(e => e.event === 'task_completed' && Date.now() - e.ts < 60 * 60 * 1000)
      .length;

    if (recentSuccesses % 5 === 0 && recentSuccesses > 0) {
      console.log(`🌟 Proactive: ${recentSuccesses} tasks completed this hour`);
    }
  }

  _onTaskFailed(data) {
    // After failures, check if we need new capabilities
    const recentFailures = this._contextWindow
      .filter(e => e.event === 'task_failed' && Date.now() - e.ts < 10 * 60 * 1000)
      .length;

    if (recentFailures >= 2) {
      console.log('🔧 Proactive: Multiple failures detected — triggering gap analysis');
      const selfMod = registry.get('SelfModAgent');
      if (selfMod?.status === 'idle') {
        selfMod._handleTask({ id: uuidv4(), type: 'detect_gaps' }).catch(() => {});
      }
    }
  }

  _onDeviceConnected(data) {
    console.log(`\n📱 Proactive: New device connected (${data.ip}) — APEX ready`);
  }

  _announceNewCapability(data) {
    console.log(`\n✨ Proactive: New capability added — "${data.gap}"`);
  }

  // ─── SMART CONTEXT ANALYSIS ───────────────────────────────────────────────

  async analyzeContext() {
    const events = this._contextWindow.slice(-30).map(e => `${e.event}: ${JSON.stringify(e.data).slice(0, 60)}`).join('\n');
    const profile = registry.get('UserProfileAgent');
    const profileData = profile ? await profile._handleTask({ id: uuidv4(), action: 'profile' }) : {};

    return structured(
      `Based on these recent APEX events and user profile, what proactive actions should APEX take?\n\nEvents:\n${events}\n\nUser profile: ${JSON.stringify(profileData)}\n\nSuggest actions APEX should take autonomously RIGHT NOW.`,
      {
        immediateActions: [{ action: 'description', priority: 'high/medium/low', agent: 'which agent', why: 'reason' }],
        observations: ['key observations about current state'],
        userMood: 'inferred user state/mood from activity',
        recommendations: ['what to tell the user proactively'],
      },
      { temperature: 0.4 }
    );
  }

  // ─── REGISTER CUSTOM TRIGGER ──────────────────────────────────────────────

  addTrigger({ name, description, condition, action, cooldownMs = 60 * 60 * 1000 }) {
    this._triggers.push({ name, description, condition, action, cooldownMs, lastTriggered: 0 });
    Memory.store({
      scope: 'long_term', agent: 'proactive',
      content: `Registered proactive trigger: ${name} — ${description}`,
      tags: ['trigger', 'proactive'], importance: 6,
    });
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  _isIdle() {
    const agents = registry.all();
    const working = agents.filter(a => a.status === 'working').length;
    return working === 0;
  }

  _minutesSinceLastEvent(eventType) {
    const last = this._contextWindow.filter(e => e.event === eventType).pop();
    if (!last) return Infinity;
    return (Date.now() - last.ts) / (60 * 1000);
  }

  _hoursSinceLastGapFill() {
    const last = Memory.search('gap_fill', { limit: 1 });
    if (!last.length) return Infinity;
    return (Date.now() - last[0].created_at) / (60 * 60 * 1000);
  }

  getStatus() {
    return {
      running: this._running,
      actionsThisHour: this._actionsThisHour,
      maxActionsPerHour: this._maxActionsPerHour,
      triggers: this._triggers.map(t => ({ name: t.name, lastTriggered: t.lastTriggered, cooldownMs: t.cooldownMs })),
      recentEvents: this._contextWindow.slice(-10).map(e => e.event),
    };
  }
}

export const proactiveEngine = new ProactiveEngine();
export default proactiveEngine;
