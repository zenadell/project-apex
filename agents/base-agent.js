// agents/base-agent.js
// Base class for all APEX agents
import { v4 as uuidv4 } from 'uuid';
import bus from '../core/event-bus.js';
import Memory from '../core/memory.js';

export class BaseAgent {
  constructor({ name, type, description, model = null }) {
    this.id = `agent_${name.toLowerCase().replace(/\s+/g, '_')}_${uuidv4().slice(0, 8)}`;
    this.name = name;
    this.type = type;
    this.description = description;
    this.model = model;
    this.status = 'idle';
    this._conversationHistory = [];
    this._taskQueue = [];
    this._startedAt = Date.now();

    Memory.registerAgent({ id: this.id, name, type, config: { description } });
    this._setupBusListeners();
  }

  _setupBusListeners() {
    bus.on('broadcast', (data) => this.onBroadcast(data));
    bus.on(`task:${this.name}`, (task) => this._handleTask(task));
  }

  async _handleTask(task) {
    this.setStatus('working');
    bus.emit('agent:started', { agent: this.name, taskId: task.id });
    try {
      const result = await this.run(task);
      bus.emit('agent:completed', { agent: this.name, taskId: task.id, result });
      this.setStatus('idle');
      return result;
    } catch (err) {
      bus.emit('agent:failed', { agent: this.name, taskId: task.id, error: err.message });
      this.setStatus('error');
      throw err;
    }
  }

  setStatus(status) {
    this.status = status;
    Memory.updateAgentStatus(this.id, status);
    bus.emit('agent:status', { agent: this.name, status });
  }

  // Store a memory from this agent
  remember(content, { key = null, tags = [], importance = 5, scope = 'session' } = {}) {
    return Memory.store({ scope, agent: this.name, key, content, tags, importance });
  }

  // Search memory
  recall(query, opts = {}) {
    return Memory.search(query, { agent: this.name, ...opts });
  }

  // Log to bus (visible to orchestrator)
  log(message, level = 'info') {
    bus.emit('agent:log', { agent: this.name, message, level, ts: Date.now() });
  }

  // Called on broadcast events — override in subclass if needed
  onBroadcast(data) {}

  // Must be implemented by each agent
  async run(task) {
    throw new Error(`${this.name}.run() not implemented`);
  }

  // Build LLM context for this agent (with memory injection)
  buildContext(task, extras = '') {
    const recentMems = Memory.recent(this.name, 5);
    const memContext = recentMems.length
      ? `\n\nYour recent memories:\n${recentMems.map(m => `- ${m.content}`).join('\n')}`
      : '';
    return `You are ${this.name}, an advanced AI agent in the APEX system.\n${this.description}\n${memContext}\n${extras}\n\nCurrent task: ${typeof task === 'string' ? task : JSON.stringify(task)}`;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      status: this.status,
      description: this.description,
    };
  }
}

export default BaseAgent;
