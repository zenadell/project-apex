// agents/user-profile.js
// APEX UserProfileAgent — Learns who you are. Understands your preferences, patterns,
// goals, and context. Makes APEX proactive — it knows what you need before you say it.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bus from '../core/event-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.apex-data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'user-profile.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS profile (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    source TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    input TEXT NOT NULL,
    intent TEXT,
    outcome TEXT,
    satisfaction INTEGER,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS preferences (
    category TEXT NOT NULL,
    preference TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    confirmed INTEGER DEFAULT 0,
    ts INTEGER NOT NULL,
    PRIMARY KEY(category, preference)
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'active',
    progress TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS context_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_type TEXT NOT NULL,
    data TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
`);

export class UserProfileAgent extends BaseAgent {
  constructor() {
    super({
      name: 'UserProfileAgent',
      type: 'user_profile',
      description: 'Learns the user deeply. Tracks preferences, patterns, goals, context. Makes APEX proactive — predicts what you need, personalizes every response, works autonomously based on your established patterns.',
    });
    this._observeAllInteractions();
  }

  async run(task) {
    const { action = 'status' } = task;

    switch (action) {
      case 'learn':        return this.learn(task.input, task.context);
      case 'predict':      return this.predict(task.context);
      case 'profile':      return this.getProfile();
      case 'update':       return this.updateProfile(task.key, task.value);
      case 'goals':        return this.getGoals();
      case 'add_goal':     return this.addGoal(task.goal, task.priority);
      case 'preferences':  return this.getPreferences(task.category);
      case 'suggest':      return this.suggest(task.situation);
      case 'status':       return this.getFullContext();
      case 'onboard':      return this.onboard();
    }
  }

  // ─── OBSERVE ALL INTERACTIONS ──────────────────────────────────────────────

  _observeAllInteractions() {
    bus.on('task:started', ({ input }) => {
      if (input) this._recordInteraction(input);
    });

    bus.on('task:completed', ({ id }) => {
      this._updateInteractionOutcome(id, 'completed');
    });

    bus.on('task:failed', ({ id }) => {
      this._updateInteractionOutcome(id, 'failed');
    });

    bus.on('agent:completed', ({ agent, taskId }) => {
      this._signalContext('agent_success', { agent });
    });
  }

  // ─── LEARN FROM INPUT ──────────────────────────────────────────────────────

  async learn(input, context = '') {
    if (!input) return;

    // Analyze what we can learn from this input
    const insights = await structured(
      `Analyze this user input to learn about the user.\n\nInput: "${input}"\nContext: "${context}"\n\nExtract profile insights.`,
      {
        name: 'user name if mentioned, else null',
        location: 'location if mentioned, else null',
        occupation: 'job/role if mentioned, else null',
        skills: ['skills demonstrated or mentioned'],
        preferences: [{ category: 'category', preference: 'specific preference' }],
        goals: ['goals mentioned or implied'],
        tools: ['tools/technologies they use or prefer'],
        workStyle: 'how they prefer to work (e.g., direct, detailed, brief)',
        urgency: 'low/medium/high — how urgent this feels',
        expertise: 'beginner/intermediate/expert — their apparent level',
        impliedNeeds: ['things they might need that they did not explicitly ask for'],
      },
      { temperature: 0.3 }
    );

    // Store insights
    const now = Date.now();
    const updates = [];

    if (insights.name) this._updateProfileField('name', insights.name, 0.9, 'interaction');
    if (insights.location) this._updateProfileField('location', insights.location, 0.7, 'interaction');
    if (insights.occupation) this._updateProfileField('occupation', insights.occupation, 0.7, 'interaction');
    if (insights.expertise) this._updateProfileField('expertise', insights.expertise, 0.6, 'interaction');
    if (insights.workStyle) this._updateProfileField('workStyle', insights.workStyle, 0.6, 'interaction');

    for (const skill of (insights.skills || [])) {
      this._addPreference('skills', skill, 1.2);
    }
    for (const tool of (insights.tools || [])) {
      this._addPreference('tools', tool, 1.2);
    }
    for (const pref of (insights.preferences || [])) {
      this._addPreference(pref.category, pref.preference, 1.0);
    }
    for (const goal of (insights.goals || [])) {
      this._ensureGoal(goal);
    }

    bus.emit('profile:updated', { insights });
    return { learned: insights, stored: true };
  }

  // ─── PREDICT WHAT USER NEEDS ───────────────────────────────────────────────

  async predict(context = '') {
    const profile = this.getProfile();
    const recentInteractions = db.prepare(`
      SELECT input, intent, ts FROM interactions ORDER BY ts DESC LIMIT 10
    `).all();
    const goals = this.getGoals();
    const prefs = this.getAllPreferences();

    const prediction = await structured(
      `Based on this user profile, predict what they are likely to need next.\n\nProfile: ${JSON.stringify(profile)}\nRecent interactions: ${JSON.stringify(recentInteractions)}\nActive goals: ${JSON.stringify(goals.filter(g => g.status === 'active'))}\nPreferences: ${JSON.stringify(prefs)}\nCurrent context: "${context}"\n\nPredict their next needs and suggest proactive actions.`,
      {
        likelyNextAction: 'what they will probably ask for next',
        suggestedProactiveActions: ['actions APEX could take now without being asked'],
        personalizationTips: ['how to personalize the next response'],
        urgentGoals: ['goals that need attention soon'],
        contextualNote: 'anything important about current context',
      },
      { temperature: 0.4 }
    );

    return { profile: profile.summary, prediction };
  }

  // ─── GET FULL PROFILE ──────────────────────────────────────────────────────

  getProfile() {
    const fields = db.prepare(`SELECT * FROM profile ORDER BY updated_at DESC`).all();
    const profile = {};
    for (const f of fields) {
      try { profile[f.key] = JSON.parse(f.value); } catch { profile[f.key] = f.value; }
    }

    const interactionCount = db.prepare(`SELECT COUNT(*) as n FROM interactions`).get().n;
    const topSkills = db.prepare(`SELECT preference FROM preferences WHERE category='skills' ORDER BY weight DESC LIMIT 5`).all().map(p => p.preference);
    const topTools = db.prepare(`SELECT preference FROM preferences WHERE category='tools' ORDER BY weight DESC LIMIT 5`).all().map(p => p.preference);

    return {
      ...profile,
      topSkills,
      topTools,
      interactionCount,
      summary: `${profile.name || 'User'} | ${profile.occupation || 'unknown role'} | ${profile.expertise || 'unknown level'} | ${interactionCount} interactions`,
    };
  }

  // ─── PERSONALIZE RESPONSE ──────────────────────────────────────────────────

  async personalize(response, context = '') {
    const profile = this.getProfile();
    if (!profile.name && !profile.workStyle) return response; // not enough data yet

    const workStyle = profile.workStyle || 'balanced';
    const expertise = profile.expertise || 'intermediate';

    // Adjust based on known preferences
    let adjusted = response;
    if (workStyle.includes('direct') || workStyle.includes('brief')) {
      // Don't re-summarize — just trim unnecessary padding
      adjusted = response.replace(/^(Sure!|Of course!|Certainly!|Absolutely!)\s*/i, '');
    }

    return adjusted;
  }

  // ─── SMART SUGGEST ────────────────────────────────────────────────────────

  async suggest(situation) {
    const profile = this.getProfile();
    return complete(
      `Based on this user's profile, suggest the best approach for this situation.\n\nUser: ${JSON.stringify(profile)}\nSituation: "${situation}"\n\nGive a personalized, specific suggestion.`,
      { temperature: 0.4, maxTokens: 600 }
    );
  }

  // ─── GOALS ─────────────────────────────────────────────────────────────────

  getGoals() {
    return db.prepare(`SELECT * FROM goals ORDER BY priority DESC, created_at DESC`).all();
  }

  addGoal(goal, priority = 'medium') {
    const now = Date.now();
    db.prepare(`INSERT OR REPLACE INTO goals (goal, priority, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`).run(goal, priority, now, now);
    return { added: goal, priority };
  }

  updateGoalProgress(id, progress, status = 'active') {
    db.prepare(`UPDATE goals SET progress=?, status=?, updated_at=? WHERE id=?`).run(progress, status, Date.now(), id);
  }

  _ensureGoal(goal) {
    const existing = db.prepare(`SELECT id FROM goals WHERE goal LIKE ?`).get(`%${goal.slice(0, 30)}%`);
    if (!existing) this.addGoal(goal, 'medium');
  }

  // ─── PREFERENCES ───────────────────────────────────────────────────────────

  getPreferences(category = null) {
    if (category) {
      return db.prepare(`SELECT * FROM preferences WHERE category=? ORDER BY weight DESC`).all(category);
    }
    return db.prepare(`SELECT * FROM preferences ORDER BY weight DESC LIMIT 20`).all();
  }

  getAllPreferences() {
    const rows = db.prepare(`SELECT * FROM preferences ORDER BY category, weight DESC`).all();
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.category]) grouped[row.category] = [];
      grouped[row.category].push(row.preference);
    }
    return grouped;
  }

  _addPreference(category, preference, weight = 1.0) {
    const existing = db.prepare(`SELECT weight FROM preferences WHERE category=? AND preference=?`).get(category, preference);
    if (existing) {
      db.prepare(`UPDATE preferences SET weight=?, ts=? WHERE category=? AND preference=?`).run(
        Math.min(5.0, existing.weight + 0.2), Date.now(), category, preference
      );
    } else {
      db.prepare(`INSERT INTO preferences (category, preference, weight, ts) VALUES (?, ?, ?, ?)`).run(category, preference, weight, Date.now());
    }
  }

  // ─── ONBOARDING ────────────────────────────────────────────────────────────

  async onboard() {
    return {
      message: "I'm learning about you as we work together. The more we interact, the better I understand your needs. You can also tell me directly:",
      quickSetup: [
        "Tell me your name and what you do",
        "What are your main goals right now?",
        "What tools/languages do you prefer?",
        "How do you like responses: detailed or concise?",
      ],
      currentProfile: this.getProfile(),
    };
  }

  // ─── FULL CONTEXT SNAPSHOT ─────────────────────────────────────────────────

  getFullContext() {
    const profile = this.getProfile();
    const goals = this.getGoals().filter(g => g.status === 'active');
    const prefs = this.getAllPreferences();
    const recentInteractions = db.prepare(`SELECT input, ts FROM interactions ORDER BY ts DESC LIMIT 5`).all();

    return {
      profile,
      activeGoals: goals,
      preferences: prefs,
      recentActivity: recentInteractions,
      apex: {
        totalInteractions: profile.interactionCount,
        learningProgress: Math.min(100, profile.interactionCount * 5),
        autonomyLevel: this._autonomyLevel(profile.interactionCount),
      },
    };
  }

  _autonomyLevel(interactions) {
    if (interactions < 5) return 'learning';
    if (interactions < 20) return 'adapting';
    if (interactions < 50) return 'familiar';
    return 'autonomous';
  }

  // ─── INTERNAL HELPERS ──────────────────────────────────────────────────────

  _updateProfileField(key, value, confidence = 0.5, source = 'inferred') {
    const existing = db.prepare(`SELECT confidence FROM profile WHERE key=?`).get(key);
    if (!existing || confidence >= existing.confidence) {
      db.prepare(`INSERT OR REPLACE INTO profile (key, value, confidence, source, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
        key, JSON.stringify(value), confidence, source, Date.now()
      );
    }
  }

  updateProfile(key, value, confidence = 0.95) {
    this._updateProfileField(key, value, confidence, 'explicit');
    return { updated: key, value };
  }

  _recordInteraction(input) {
    db.prepare(`INSERT INTO interactions (input, ts) VALUES (?, ?)`).run(input?.slice(0, 500), Date.now());
    // Learn from it asynchronously
    this.learn(input).catch(() => {});
  }

  _updateInteractionOutcome(id, outcome) {
    db.prepare(`UPDATE interactions SET outcome=? WHERE id=(SELECT MAX(id) FROM interactions)`).run(outcome);
  }

  _signalContext(type, data) {
    db.prepare(`INSERT INTO context_signals (signal_type, data, ts) VALUES (?, ?, ?)`).run(type, JSON.stringify(data), Date.now());
  }
}

export default UserProfileAgent;
