// agents/dynamic-agent.js
// APEX DynamicAgent — Spawned at runtime by orchestrator for specific tasks
import { BaseAgent } from './base-agent.js';
import { chat } from '../core/llm.js';

export class DynamicAgent extends BaseAgent {
  constructor({ name, type = 'dynamic', description, systemPrompt = '', tools = [] }) {
    super({ name, type, description });
    this._systemPrompt = systemPrompt || `You are ${name}, a specialized APEX agent. ${description}`;
    this._tools = tools;
    this._history = [];
  }

  async run(task) {
    const { prompt, context = '' } = typeof task === 'string' ? { prompt: task } : task;

    this._history.push({ role: 'user', content: `${context ? context + '\n\n' : ''}${prompt}` });

    const response = await chat(this._history, {
      systemPrompt: this._systemPrompt,
      temperature: 0.5,
    });

    this._history.push({ role: 'assistant', content: response });

    this.remember(
      `Task: ${prompt?.slice(0, 100)}\nResponse: ${response?.slice(0, 200)}`,
      { tags: ['dynamic', this.type], importance: 5 }
    );

    return { agent: this.name, response, history: this._history.length };
  }

  // Continue a conversation
  async continue(message) {
    return this.run({ prompt: message });
  }
}

export default DynamicAgent;
