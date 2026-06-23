// core/llm.js
// APEX LLM — Re-exports from the multi-provider router.
// Drop-in replacement — all existing code continues to work.
// Automatically uses Groq → Gemini → Claude → Ollama based on task.

export { chat, complete, structured, getStatus, chatTools } from './llm-router.js';
export { default } from './llm-router.js';
