// core/agent-registry.js
// APEX Agent Registry — spawn, kill, query, and manage all agents
import bus from './event-bus.js';
import Memory from './memory.js';
import { v4 as uuidv4 } from 'uuid';

class AgentRegistry {
  constructor() {
    this._agents = new Map();    // name -> agent instance
    this._dynamicAgents = [];    // self-spawned agents
  }

  // Register a core agent
  register(agent) {
    this._agents.set(agent.name, agent);
    bus.emit('registry:registered', { agent: agent.name });
  }

  // Get agent by name
  get(name) {
    return this._agents.get(name);
  }

  // Get all agents
  all() {
    return [...this._agents.values()];
  }

  // Spawn a new dynamic agent on the fly
  async spawn({ name, type, description, systemPrompt, tools = [], parentTask = null }) {
    const { DynamicAgent } = await import('../agents/dynamic-agent.js');
    const agent = new DynamicAgent({ name, type, description, systemPrompt, tools });
    this._agents.set(name, agent);
    this._dynamicAgents.push(name);
    bus.emit('registry:spawned', { agent: name, type, parentTask });
    Memory.store({
      scope: 'long_term',
      agent: 'registry',
      content: `Spawned dynamic agent: ${name} (${type}) - ${description}`,
      tags: ['spawn', 'agent', type],
      importance: 7,
    });
    return agent;
  }

  // Kill an agent
  kill(name) {
    const agent = this._agents.get(name);
    if (agent) {
      agent.setStatus('killed');
      this._agents.delete(name);
      bus.emit('registry:killed', { agent: name });
    }
  }

  // Get all idle agents
  available() {
    return [...this._agents.values()].filter(a => a.status === 'idle');
  }

  // Get status snapshot
  snapshot() {
    return [...this._agents.entries()].map(([name, agent]) => ({
      name,
      type: agent.type,
      status: agent.status,
      isDynamic: this._dynamicAgents.includes(name),
    }));
  }

  // Dispatch a task to a specific agent
  async dispatch(agentName, task) {
    const agent = this.get(agentName);
    if (!agent) throw new Error(`Agent "${agentName}" not found in registry`);
    return agent._handleTask({ id: uuidv4(), ...task });
  }

  // Dispatch to multiple agents in parallel (mesh execution)
  async meshDispatch(tasks) {
    const promises = tasks.map(({ agent, task }) => this.dispatch(agent, task));
    return Promise.allSettled(promises);
  }
}

export const registry = new AgentRegistry();
export default registry;
