// core/intent-classifier.js
// APEX Intent Classifier — The gatekeeper.
// Classifies every incoming message BEFORE touching any agent.
// Prevents "hi" from triggering a React app. Prevents burn.

import { complete } from './llm.js';

// Cheap fast classification — uses shortest possible prompt
// These patterns are checked BEFORE any LLM call (zero cost)
const PATTERNS = {
  // Pure chat — respond naturally, never invoke agents
  chat: [
    /^(hi|hello|hey|sup|yo|morning|good morning|good evening|good night|howdy|hiya|greetings)[\s!?.]*$/i,
    /^(how are you|how r u|how's it going|what's up|wyd|how do you do)[\s!?.]*$/i,
    /^(thanks|thank you|thx|ty|cheers|np|no problem|you're welcome|yw)[\s!?.]*$/i,
    /^(ok|okay|cool|nice|great|awesome|sure|got it|understood|alright|k|kk)[\s!?.]*$/i,
    /^(bye|goodbye|cya|see you|later|peace|ttyl)[\s!?.]*$/i,
    /^(lol|lmao|haha|hehe|😂|😄|👍|❤️|🔥)[\s!?.]*$/i,
    /^(yes|no|yep|nope|yeah|nah|yup)[\s!?.]*$/i,
    /^who are you[\s!?.]*$/i,
    /^(introduce yourself|tell me about yourself|what are you|what can you do)[\s!?.]*$/i,
    /^(what('?s| is) (your name|apex)|you are|are you)[\s!?.]*$/i,
  ],

  // System commands — handle internally, no LLM
  command: [
    /^\/\w+/,
    /^\/(status|agents|help|reset|clear|start|stop|pause|resume|audit|unlock|soul|profile|memory|schedule|predict|teams)\b/i,
  ],

  // Questions — use ResearchAgent or direct LLM, NOT CodeAgent/UIAgent
  question: [
    /^(what|how|why|when|where|who|which|can you|could you|would you|will you|is it|are there|do you know)\b/i,
    /\?$/,
  ],

  // Explicit code/build tasks
  build: [
    /\b(build|create|make|generate|write|code|develop|design|implement|program|scaffold)\b.{3,}/i,
    /\b(fix|debug|refactor|optimize|improve|update|add feature|add support)\b.{3,}/i,
  ],

  // Explicit research tasks
  research: [
    /\b(research|find|search|look up|look for|investigate|analyze|compare|review|summarize)\b.{3,}/i,
  ],

  // Security tasks (admin-gated)
  security: [
    /\b(scan|hack|pentest|vulnerability|exploit|osint|recon|attack|test security)\b/i,
  ],

  // Deployment/ops
  deploy: [
    /\b(deploy|launch|publish|host|server|vps|docker|fly\.io|vercel|railway|heroku)\b/i,
  ],
  
  // Real-world actions (capturing, showing, running)
  action: [
    /^(show|capture|take|grab|display|open|run|execute)\b/i,
    /\b(look|watch|record|shoot|snap)\b/i,
  ],

  // HARDWARE FAST-PATH (Bypass chat)
  hardware: [
    /\b(webcam|camera|room|cam|video stream|snap a photo|capture room)\b/i,
    /show me (the room|my room|myself)/i,
    /\b(from my phone|on my mobile|phone camera)\b/i,
  ],
};

export class IntentClassifier {
  constructor() {
    this._cache = new Map();
  }

  // Main classify method — returns intent with confidence
  async classify(message, context = {}) {
    const msg = message.trim();
    if (!msg) return { intent: 'chat', confidence: 1.0, response: '' };

    // Cache check
    const cacheKey = msg.toLowerCase().slice(0, 100);
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);

    // 1. Pattern matching first (zero cost, instant)
    const patternResult = this._patternMatch(msg);
    if (patternResult.confidence >= 0.9) {
      this._cache.set(cacheKey, patternResult);
      return patternResult;
    }

    // 2. LLM classification for ambiguous cases (fast, cheap)
    const llmResult = await this._llmClassify(msg, context);
    this._cache.set(cacheKey, llmResult);
    return llmResult;
  }

  _patternMatch(msg) {
    // Check each category
    for (const [intent, patterns] of Object.entries(PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(msg)) {
          return { intent, confidence: 0.95, method: 'pattern' };
        }
      }
    }
    return { intent: 'unknown', confidence: 0.3, method: 'pattern' };
  }

  async _llmClassify(msg, context) {
    try {
      const result = await complete(
        `Classify this message into ONE category. Reply with ONLY the category name.\n\nCategories:\n- chat: casual conversation, greetings, small talk, thanks\n- question: asking for information or explanation\n- build: requesting code, UI, app, or project to be created\n- research: requesting investigation or analysis\n- security: security testing or scanning\n- deploy: deployment or hosting requests\n- command: system command or control instruction\n\nMessage: "${msg.slice(0, 200)}"\n\nCategory:`,
        { temperature: 0.0, maxTokens: 10 }
      );
      const intent = result.trim().toLowerCase().replace(/[^a-z]/g, '');
      const validIntents = ['chat', 'question', 'build', 'research', 'security', 'deploy', 'command', 'action', 'hardware'];
      return {
        intent: validIntents.includes(intent) ? intent : 'chat',
        confidence: 0.85,
        method: 'llm',
      };
    } catch {
      // On LLM failure, default to chat (safe, never triggers agents)
      return { intent: 'chat', confidence: 0.5, method: 'fallback' };
    }
  }

  // Should this message trigger the full agent pipeline?
  requiresAgents(intent) {
    return ['build', 'research', 'security', 'deploy', 'action', 'hardware'].includes(intent);
  }

  // Is this a simple chat that needs only a direct LLM response?
  isChat(intent) {
    return ['chat', 'question'].includes(intent);
  }
}

export const intentClassifier = new IntentClassifier();
export default intentClassifier;
