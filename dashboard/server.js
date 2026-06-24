import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';
import bus from '../core/event-bus.js';
import registry from '../core/agent-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.DASHBOARD_PORT || 3456;
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const state = { startTime: Date.now(), tasks: [], logs: [], loop: [], agentActivity: {}, metrics: { completed: 0, failed: 0, totalTime: 0 } };

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ status: 'operational', uptime: Math.floor((Date.now() - state.startTime) / 1000), agents: registry.all().length, tasksCompleted: state.metrics.completed }));
app.get('/api/agents', (req, res) => res.json(registry.all().map(a => ({ name: a.name, type: a.type, description: a.description, status: state.agentActivity[a.name]?.status || 'idle' }))));
app.get('/api/tasks', (req, res) => res.json(state.tasks.slice(-50)));
app.get('/api/logs', (req, res) => res.json(state.logs.slice(-200)));
app.get('/api/metrics', (req, res) => {
  const m = state.metrics;
  res.json({ ...m, avgTime: m.completed > 0 ? Math.round(m.totalTime / m.completed / 1000) : 0, successRate: (m.completed + m.failed) > 0 ? Math.round((m.completed / (m.completed + m.failed)) * 100) : 100 });
});

function broadcast(type, data) { const msg = JSON.stringify({ type, data, ts: Date.now() }); wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); }); }

bus.on('task:start', d => { const t = { id: d.taskId, input: d.input, status: 'PLANNING', startTime: Date.now() }; state.tasks.push(t); broadcast('task:start', t); });
bus.on('task:state', d => { const t = state.tasks.find(x => x.id === d.taskId); if (t) { t.status = d.status; broadcast('task:state', d); } });
bus.on('task:complete', d => { const t = state.tasks.find(x => x.id === d.taskId); if (t) { t.status = 'COMPLETED'; t.duration = Date.now() - t.startTime; state.metrics.completed++; state.metrics.totalTime += t.duration; } broadcast('task:complete', d); });
bus.on('task:failed', d => { const t = state.tasks.find(x => x.id === d.taskId); if (t) t.status = 'FAILED'; state.metrics.failed++; broadcast('task:failed', d); });

// Live agentic-loop stream → structured 'loop' messages (the "watch APEX think" panel). Args are
// trimmed so we never ship a whole file's content over the socket.
bus.on('agentloop:event', ev => {
  const e = {
    ts: Date.now(), type: ev.type, step: ev.step, depth: ev.depth || 0, model: ev.model,
    tool: ev.tool, path: ev.args?.path, command: ev.args?.command, query: ev.args?.query,
    ok: ev.ok, observation: typeof ev.observation === 'string' ? ev.observation.slice(0, 240) : undefined,
    todos: ev.todos, task: ev.task, agent: ev.agent, parallel: ev.parallel,
    summary: ev.summary, success: ev.success, verified: ev.verified, reason: ev.reason, errorStreak: ev.errorStreak,
  };
  state.loop.push(e); if (state.loop.length > 400) state.loop.shift();
  broadcast('loop', e);
});

const originalEmit = bus.emit.bind(bus);
bus.emit = function(event, data) {
  // agentloop:* is handled by the dedicated 'loop' stream above — keep it out of the noisy log feed.
  if (!String(event).startsWith('agentloop:')) {
    const entry = { ts: Date.now(), event, summary: typeof data === 'string' ? data : JSON.stringify(data)?.slice(0, 200) };
    state.logs.push(entry); if (state.logs.length > 500) state.logs.shift();
    broadcast('log', entry);
    if (data?.agentName) { state.agentActivity[data.agentName] = { status: event.includes('complete') ? 'idle' : 'working', lastTask: data.task || event, lastUpdate: Date.now() }; broadcast('agent:activity', { name: data.agentName, ...state.agentActivity[data.agentName] }); }
  }
  return originalEmit(event, data);
};

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', data: { agents: registry.all().map(a => ({ name: a.name, type: a.type, description: a.description, status: state.agentActivity[a.name]?.status || 'idle' })), tasks: state.tasks.slice(-20), logs: state.logs.slice(-100), loop: state.loop.slice(-120), metrics: state.metrics, uptime: Math.floor((Date.now() - state.startTime) / 1000) } }));
});

server.listen(PORT, () => console.log(`\n🖥️  APEX Dashboard running at http://localhost:${PORT}\n`));
export default server;
