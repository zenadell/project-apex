// dashboard/server.js
// APEX Dashboard Server — serves the UI and exposes REST API for all agents
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import cors from 'cors';
import chalk from 'chalk';
import bus from '../core/event-bus.js';
import registry from '../core/agent-registry.js';
import Memory from '../core/memory.js';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class DashboardServer {
  constructor(orchestrator, port = 7332) {
    this._orchestrator = orchestrator;
    this._port = port;
    this._app = express();
    this._server = createServer(this._app);
    this._wss = new WebSocketServer({ server: this._server });
    this._clients = new Set();
    this._setupMiddleware();
    this._setupRoutes();
    this._setupWebSocket();
    this._bridgeBusToWS();
  }

  _setupMiddleware() {
    this._app.use(cors());
    this._app.use(express.json());
    // Serve dashboard static files
    this._app.use(express.static(join(__dirname)));
  }

  _setupRoutes() {
    const app = this._app;

    // ── STATUS ─────────────────────────────────────────
    app.get('/api/status', (req, res) => {
      res.json({
        ok: true,
        agents: registry.snapshot(),
        capabilities: Memory.listCapabilities(),
        awareness: Memory.selfAwareness(),
        uptime: process.uptime(),
      });
    });

    // ── EXECUTE TASK ────────────────────────────────────
    app.post('/api/task', async (req, res) => {
      const { input, opts = {} } = req.body;
      if (!input) return res.status(400).json({ error: 'input required' });

      try {
        const result = await this._orchestrator.execute(input, opts);
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ── AGENT DISPATCH ──────────────────────────────────
    app.post('/api/agent/:name', async (req, res) => {
      const agent = registry.get(req.params.name);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      try {
        const result = await agent._handleTask({ id: uuidv4(), ...req.body });
        res.json({ ok: true, agent: req.params.name, result });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    // ── AGENTS LIST ─────────────────────────────────────
    app.get('/api/agents', (req, res) => {
      res.json({ agents: registry.snapshot() });
    });

    // ── MEMORY ──────────────────────────────────────────
    app.get('/api/memory', (req, res) => {
      const { q, limit = 20 } = req.query;
      const results = q ? Memory.search(q, { limit: parseInt(limit) }) : Memory.recent('system', parseInt(limit));
      res.json({ results, awareness: Memory.selfAwareness() });
    });

    // ── CAPABILITIES ────────────────────────────────────
    app.get('/api/capabilities', (req, res) => {
      res.json({ capabilities: Memory.listCapabilities() });
    });

    // ── TASK HISTORY ────────────────────────────────────
    app.get('/api/history', (req, res) => {
      const mems = Memory.search('task', { limit: 50 });
      res.json({ history: mems });
    });

    // ── SPAWN AGENT ─────────────────────────────────────
    app.post('/api/spawn', async (req, res) => {
      const { name, type, description } = req.body;
      const agent = await registry.spawn({ name, type, description });
      res.json({ ok: true, agent: agent.toJSON() });
    });

    // ── SECURITY SCAN ────────────────────────────────────
    app.post('/api/security/scan', async (req, res) => {
      const secAgent = registry.get('SecurityAgent');
      if (!secAgent) return res.status(503).json({ error: 'SecurityAgent not available' });
      const result = await secAgent._handleTask({ id: uuidv4(), ...req.body });
      res.json({ ok: true, result });
    });

    // ── BROWSER ACTION ───────────────────────────────────
    app.post('/api/browser', async (req, res) => {
      const browser = registry.get('BrowserAgentPro');
      if (!browser) return res.status(503).json({ error: 'BrowserAgentPro not available' });
      const result = await browser._handleTask({ id: uuidv4(), ...req.body });
      res.json({ ok: true, result });
    });

    // ── SELF-MOD ─────────────────────────────────────────
    app.post('/api/selfmod', async (req, res) => {
      const selfMod = registry.get('SelfModAgent');
      if (!selfMod) return res.status(503).json({ error: 'SelfModAgent not available' });
      const result = await selfMod._handleTask({ id: uuidv4(), type: req.body.type || 'detect_gaps' });
      res.json({ ok: true, result });
    });

    // ── PROACTIVE STATUS ─────────────────────────────────
    app.get('/api/proactive', async (req, res) => {
      const { proactiveEngine } = await import('../core/proactive-engine.js');
      res.json(proactiveEngine.getStatus());
    });

    // ── SCHEDULER ────────────────────────────────────────
    app.get('/api/schedule', async (req, res) => {
      const { taskScheduler } = await import('../core/task-scheduler.js');
      res.json({ tasks: taskScheduler.list() });
    });

    app.post('/api/schedule', async (req, res) => {
      const { taskScheduler } = await import('../core/task-scheduler.js');
      const id = taskScheduler.schedule(req.body);
      res.json({ ok: true, id });
    });

    // ── PROFILE ──────────────────────────────────────────
    app.get('/api/profile', async (req, res) => {
      const profile = registry.get('UserProfileAgent');
      if (!profile) return res.status(503).json({ error: 'UserProfileAgent not available' });
      const result = await profile._handleTask({ id: uuidv4(), action: 'status' });
      res.json({ ok: true, ...result });
    });

    // ── VOICE ─────────────────────────────────────────────
    app.post('/api/voice', async (req, res) => {
      const voice = registry.get('VoiceAgent');
      if (!voice) return res.status(503).json({ error: 'VoiceAgent not available' });
      const result = await voice._handleTask({ id: uuidv4(), text: req.body.text, action: 'speak' });
      res.json({ ok: true, result });
    });

    // ── CATCH ALL → serve dashboard ───────────────────────
    app.get('*', (req, res) => {
      res.sendFile(join(__dirname, 'index.html'));
    });
  }

  _setupWebSocket() {
    this._wss.on('connection', (ws) => {
      this._clients.add(ws);

      // Send initial state
      ws.send(JSON.stringify({
        type: 'init',
        agents: registry.snapshot(),
        capabilities: Memory.listCapabilities(),
        awareness: Memory.selfAwareness(),
      }));

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'task') {
            const result = await this._orchestrator.execute(msg.input);
            ws.send(JSON.stringify({ type: 'task_result', taskId: msg.taskId, result }));
          }
          if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', error: err.message }));
        }
      });

      ws.on('close', () => this._clients.delete(ws));
    });
  }

  _bridgeBusToWS() {
    // Forward all bus events to connected dashboard clients
    const forward = (event, data) => {
      const msg = JSON.stringify({ type: 'event', event, data, ts: Date.now() });
      for (const ws of this._clients) {
        if (ws.readyState === 1) ws.send(msg);
      }
    };

    const events = [
      'task:started', 'task:completed', 'task:failed',
      'agent:log', 'agent:started', 'agent:completed', 'agent:failed', 'agent:status',
      'selfmod:gap_filled', 'selfmod:agent_created', 'selfmod:tool_created',
      'healing:agent_recovered', 'healing:agent_respawned',
      'proactive:triggered', 'proactive:health_report',
      'skills:installed', 'bridge:device_connected',
      'orchestrator:ready', 'pipeline:completed',
    ];

    events.forEach(e => bus.on(e, (data) => forward(e, data)));
  }

  async start() {
    return new Promise((resolve) => {
      this._server.listen(this._port, () => {
        console.log(chalk.cyan(`\n🖥️  APEX Dashboard: http://localhost:${this._port}`));
        bus.emit('dashboard:started', { port: this._port });
        resolve(this);
      });
    });
  }

  stop() { this._server.close(); }
}

export default DashboardServer;
