// core/memory.js
// APEX Memory System — persistent, searchable, scoped to sessions + long-term
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.apex-data');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'apex-memory.db'));

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,          -- 'session', 'long_term', 'skill', 'agent'
    agent TEXT,                   -- which agent stored this
    key TEXT,                     -- optional named key
    content TEXT NOT NULL,        -- the actual memory content
    tags TEXT,                    -- JSON array of tags
    importance INTEGER DEFAULT 5, -- 1-10
    created_at INTEGER NOT NULL,
    last_accessed INTEGER,
    access_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS task_history (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    plan TEXT,
    result TEXT,
    agents_used TEXT,
    success INTEGER DEFAULT 0,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT,                    -- 'builtin', 'skill', 'plugin', 'self_generated'
    path TEXT,                    -- file path if applicable
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT DEFAULT 'idle',
    config TEXT,
    spawned_at INTEGER,
    last_active INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);
  CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent);
  CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags);
`);

export class Memory {
  // Store a memory
  static store({ scope = 'session', agent = 'system', key = null, content, tags = [], importance = 5 }) {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO memories (id, scope, agent, key, content, tags, importance, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, scope, agent, key, content, JSON.stringify(tags), importance, Date.now());
    return id;
  }

  // Search memories by keyword
  static search(query, { scope = null, agent = null, limit = 20 } = {}) {
    let sql = `SELECT * FROM memories WHERE content LIKE ?`;
    const params = [`%${query}%`];
    if (scope) { sql += ` AND scope = ?`; params.push(scope); }
    if (agent) { sql += ` AND agent = ?`; params.push(agent); }
    sql += ` ORDER BY importance DESC, last_accessed DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    // Update access stats
    if (rows.length) {
      const ids = rows.map(r => r.id);
      db.prepare(`UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(Date.now(), ...ids);
    }
    return rows.map(r => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
  }

  // Get by key
  static get(key, scope = 'long_term') {
    return db.prepare(`SELECT * FROM memories WHERE key = ? AND scope = ? ORDER BY created_at DESC LIMIT 1`).get(key, scope);
  }

  // Get recent memories for an agent
  static recent(agent, limit = 10) {
    return db.prepare(`SELECT * FROM memories WHERE agent = ? ORDER BY created_at DESC LIMIT ?`).all(agent, limit);
  }

  // Store task result
  static storeTask({ id, task, plan, result, agentsUsed = [], success = false, durationMs = 0 }) {
    db.prepare(`
      INSERT OR REPLACE INTO task_history (id, task, plan, result, agents_used, success, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, task, JSON.stringify(plan), JSON.stringify(result), JSON.stringify(agentsUsed), success ? 1 : 0, durationMs, Date.now());
  }

  // Register a capability
  static registerCapability({ name, description, type = 'builtin', path: filePath = null }) {
    const id = `cap_${name.replace(/\s+/g, '_').toLowerCase()}`;
    db.prepare(`
      INSERT OR REPLACE INTO capabilities (id, name, description, type, path, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).run(id, name, description, type, filePath, Date.now());
    return id;
  }

  // List all capabilities
  static listCapabilities() {
    return db.prepare(`SELECT * FROM capabilities WHERE active = 1 ORDER BY type, name`).all();
  }

  // Register agent
  static registerAgent({ id, name, type, config = {} }) {
    db.prepare(`
      INSERT OR REPLACE INTO agent_registry (id, name, type, status, config, spawned_at, last_active)
      VALUES (?, ?, ?, 'idle', ?, ?, ?)
    `).run(id, name, type, JSON.stringify(config), Date.now(), Date.now());
  }

  static updateAgentStatus(id, status) {
    db.prepare(`UPDATE agent_registry SET status = ?, last_active = ? WHERE id = ?`).run(status, Date.now(), id);
  }

  static getAgents() {
    return db.prepare(`SELECT * FROM agent_registry ORDER BY spawned_at DESC`).all();
  }

  // Summarize what APEX knows (for self-awareness)
  static selfAwareness() {
    const caps = db.prepare(`SELECT COUNT(*) as count, type FROM capabilities WHERE active = 1 GROUP BY type`).all();
    const mems = db.prepare(`SELECT COUNT(*) as count, scope FROM memories GROUP BY scope`).all();
    const tasks = db.prepare(`SELECT COUNT(*) as total, SUM(success) as succeeded FROM task_history`).get();
    const agents = db.prepare(`SELECT COUNT(*) as count FROM agent_registry`).get();
    return { capabilities: caps, memories: mems, tasks, agents };
  }

  // ─── GRAPHIFY MEMORY LAYER ──────────────────────────────────────────────────
  // Reads the Graphify output for instantaneous repository awareness.
  // This is injected at the start of LLM arrays for DeepSeek Context Caching.
  static getGraphifyContext(targetDir = process.cwd()) {
    try {
      const reportPath = path.join(targetDir, 'graphify-out', 'GRAPH_REPORT.md');
      if (existsSync(reportPath)) {
        const reportContent = readFileSync(reportPath, 'utf-8');
        // We only want the God Nodes, Surprising Connections, and maybe top-level summary to save tokens,
        // though with DeepSeek V4 (1M context + cache), we can safely pass the whole report!
        return `
=== GRAPHIFY REPOSITORY CONTEXT ===
This is the live memory layer of the repository you are working on.
${reportContent}
====================================`;
      }
      return ''; // No graphify context yet
    } catch (err) {
      console.error(`Graphify read error: ${err.message}`);
      return '';
    }
  }
}

export default Memory;
