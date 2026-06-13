// agents/consult.js
// APEX ConsultAgent — The AI council. Asks multiple models simultaneously,
// compares their answers, and synthesizes the best combined response.
// Like having Gemini, Claude, and GPT in a room together.

import { BaseAgent } from './base-agent.js';
import bus from '../core/event-bus.js';
import Memory from '../core/memory.js';

export class ConsultAgent extends BaseAgent {
  constructor() {
    super({
      name: 'ConsultAgent',
      type: 'consult',
      description: 'Consults multiple AI models simultaneously. Gets perspectives from Gemini, Claude, GPT, and Groq/Llama, then synthesizes the strongest combined answer. Use for hard decisions, complex architecture, or when you need the best possible answer.',
    });
  }

  async run(task) {
    const { question, models = 'auto', synthesize = true, compare = false } = task;
    if (!question) return { error: 'question required' };

    this.log(`Consulting ${models === 'auto' ? 'all available' : models} models on: "${question.slice(0, 60)}"`);

    // Gather responses from all available models in parallel
    const responses = await this._consultAll(question);
    this.log(`Got ${responses.filter(r => r.success).length}/${responses.length} responses`);

    if (compare) return { question, responses, synthesis: null };

    // Synthesize the best answer
    const synthesis = synthesize ? await this._synthesize(question, responses) : null;

    this.remember(
      `Consulted ${responses.length} models on: "${question.slice(0, 80)}"`,
      { tags: ['consult', 'multi-ai'], importance: 7, scope: 'long_term' }
    );

    bus.emit('consult:complete', { models: responses.map(r => r.model), question: question.slice(0, 60) });

    return { question, responses, synthesis, modelsConsulted: responses.filter(r => r.success).length };
  }

  async _consultAll(question) {
    const { default: axios } = await import('axios');
    const { readFileSync } = await import('fs');

    const providers = [
      {
        name: 'Gemini Flash',
        model: 'gemini-2.0-flash',
        available: !!process.env.GEMINI_API_KEY,
        fn: () => this._askGemini(question),
      },
      {
        name: 'Groq/Llama 3.3',
        model: 'llama-3.3-70b',
        available: !!process.env.GROQ_API_KEY,
        fn: () => this._askGroq(question),
      },
      {
        name: 'Claude Haiku',
        model: 'claude-haiku-4-5',
        available: !!process.env.ANTHROPIC_API_KEY,
        fn: () => this._askClaude(question, 'claude-haiku-4-5'),
      },
      {
        name: 'Claude Sonnet',
        model: 'claude-sonnet-4-5',
        available: !!process.env.ANTHROPIC_API_KEY,
        fn: () => this._askClaude(question, 'claude-sonnet-4-5'),
      },
      {
        name: 'OpenAI GPT-4o',
        model: 'gpt-4o',
        available: !!process.env.OPENAI_API_KEY,
        fn: () => this._askOpenAI(question, 'gpt-4o'),
      },
      {
        name: 'Ollama Local',
        model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
        available: true, // always try
        fn: () => this._askOllama(question),
      },
    ].filter(p => p.available);

    // Ask all in parallel
    const results = await Promise.allSettled(
      providers.map(async p => {
        const start = Date.now();
        try {
          const answer = await p.fn();
          return { model: p.name, answer, success: true, latencyMs: Date.now() - start };
        } catch (err) {
          return { model: p.name, error: err.message, success: false, latencyMs: Date.now() - start };
        }
      })
    );

    return results.map(r => r.value || r.reason);
  }

  async _synthesize(question, responses) {
    const successful = responses.filter(r => r.success);
    if (!successful.length) return 'No models responded successfully.';
    if (successful.length === 1) return successful[0].answer;

    const { complete } = await import('../core/llm.js');

    const responseBlock = successful.map(r =>
      `[${r.model}]:\n${r.answer?.slice(0, 1000)}`
    ).join('\n\n---\n\n');

    return complete(
      `You are synthesizing answers from ${successful.length} different AI models.\n\nQuestion: "${question}"\n\nModel responses:\n${responseBlock}\n\nCreate the definitive best answer by:\n1. Identifying where models agree (high confidence)\n2. Noting where they differ and why\n3. Taking the best insights from each\n4. Producing a single comprehensive, accurate answer\n\nDo NOT mention the models or say "according to X". Just give the best answer.`,
      { temperature: 0.3, maxTokens: 2000, complex: true }
    );
  }

  async _askGemini(question) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const result = await model.generateContent(question);
    return result.response.text();
  }

  async _askGroq(question) {
    const { default: axios } = await import('axios');
    const resp = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: question }], max_tokens: 2048 },
      { headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, timeout: 30000 }
    );
    return resp.data.choices[0].message.content;
  }

  async _askClaude(question, model = 'claude-haiku-4-5') {
    const { default: axios } = await import('axios');
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model, max_tokens: 2048, messages: [{ role: 'user', content: question }] },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );
    return resp.data.content[0].text;
  }

  async _askOpenAI(question, model = 'gpt-4o') {
    const { default: axios } = await import('axios');
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      { model, messages: [{ role: 'user', content: question }], max_tokens: 2048 },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, timeout: 60000 }
    );
    return resp.data.choices[0].message.content;
  }

  async _askOllama(question) {
    const { default: axios } = await import('axios');
    const url = process.env.OLLAMA_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'llama3.2:3b';
    const resp = await axios.post(
      `${url}/api/chat`,
      { model, messages: [{ role: 'user', content: question }], stream: false },
      { timeout: 120000 }
    );
    return resp.data.message.content;
  }

  // Quick single-model ask with explicit provider
  async ask(question, provider = 'auto') {
    const { complete } = await import('../core/llm.js');
    return complete(question, {
      forceProvider: provider !== 'auto' ? provider : undefined,
      temperature: 0.5, maxTokens: 2000,
    });
  }

  // Debate mode — models argue, ConsultAgent judges
  async debate(topic, iterations = 1) {
    const { complete } = await import('../core/llm.js');
    const sides = await this._consultAll(`Argue FOR this position: "${topic}". Give the strongest possible argument.`);
    const against = await this._consultAll(`Argue AGAINST this position: "${topic}". Give the strongest possible counter-argument.`);

    const for_args = sides.filter(r => r.success).map(r => r.answer).slice(0, 2).join('\n\n');
    const against_args = against.filter(r => r.success).map(r => r.answer).slice(0, 2).join('\n\n');

    const verdict = await complete(
      `Topic: "${topic}"\n\nArguments FOR:\n${for_args}\n\nArguments AGAINST:\n${against_args}\n\nAs an impartial judge, give the most balanced and accurate verdict. What is the truth here?`,
      { temperature: 0.3, maxTokens: 1500, complex: true }
    );

    return { topic, for_args, against_args, verdict };
  }
}

export default ConsultAgent;
