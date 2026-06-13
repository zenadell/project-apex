// core/capability-router.js
// APEX Capability Router — The brain that maps ANY natural language to the right tool.
// APEX should NEVER need explicit commands. If you say "speak to me", it sends a voice note.
// If you say "modify yourself to do X", it runs SelfModAgent. Always.

import bus from './event-bus.js';
import registry from './agent-registry.js';
import Memory from './memory.js';
import { complete, structured } from './llm.js';
import { v4 as uuidv4 } from 'uuid';

// ── CAPABILITY MAP ────────────────────────────────────────────────────────────
// Maps intent patterns → which agent handles it + how to call it
// Checked before anything else — pattern match first, LLM classify second

const CAPABILITIES = [
  // ── VOICE ─────────────────────────────────────────────────────────────────
  {
    id: 'voice_send',
    patterns: [
      /speak\s*(to|with)?\s*me/i,
      /send\s*(a\s*)?voice(\s*note|\s*message)?/i,
      /voice\s*(note|message|reply|response)/i,
      /talk\s*(to\s*me|out\s*loud)/i,
      /audio\s*(message|reply)/i,
      /say\s*that\s*(out\s*loud|as\s*voice)/i,
      /use\s*(your\s*)?voice/i,
      /hear\s*(you|apex)/i,
    ],
    agent: 'VoiceAgent',
    buildTask: (msg, context) => {
      // If the message is just a voice trigger (e.g. "speak to me"), don't voice the trigger.
      // Use the last conversation turn, or if that's also the trigger, ask for a fresh greeting.
      const isTriggerOnly = /speak\s*(to|with)?\s*me/i.test(msg) || /send\s*(a\s*)?voice/i.test(msg);
      let textToVoice = context?.lastApexMessage || msg;
      if (isTriggerOnly && (!context?.lastApexMessage || context.lastApexMessage === msg)) {
        textToVoice = "I'm here, Temple. How can I assist you today?";
      }
      
      return {
        action: 'speak_and_send',
        text: textToVoice,
        sendToChannel: true,
        platform: context?.platform,
        chatId: context?.chatId,
      };
    },
    isSlow: true,
    acknowledgmentTemplates: [
      'Speaking to you in just a second, Temple...',
      'One moment, Temple, generating that voice for you...',
      'Coming right up, let me find my voice...',
      'Speak to you in a sec...',
    ],
    description: 'Generate voice audio and send as voice note',
  },

  // ── WEBCAM / CAMERA CAPTURE ──────────────────────────────────────────────
  {
    id: 'webcam_capture',
    patterns: [
      /show\s*(me\s*)?(the\s*)?(room|surroundings|environment|desk|office|area|place)/i,
      /take\s*(a\s*)?(photo|picture|pic|snapshot|shot)/i,
      /capture\s*(a\s*)?(photo|picture|image|frame|snapshot)/i,
      /webcam/i,
      /what\s*(does|do)\s*(my\s*)?(room|desk|office|area|place)\s*look\s*like/i,
      /see\s*(my\s*)?(room|desk|surroundings)/i,
      /snap\s*(a\s*)?(photo|picture|pic)/i,
      /use\s*(the\s*)?(camera|webcam|facetime)/i,
      /look\s*(at|around)\s*(the\s*)?(room|my)/i,
      /what('s| is)\s*(around|in front)/i,
      /camera\s*(capture|shot|photo)/i,
    ],
    agent: null, // Handled internally — no agent needed
    buildTask: (msg) => ({ action: 'webcam_capture', instruction: msg }),
    isSlow: true,
    acknowledgmentTemplates: [
      '📸 Capturing the room for you, Temple...',
      '📷 Accessing webcam, one moment...',
      '👁️ Taking a look around for you...',
    ],
    description: 'Capture a photo using the Mac webcam (FaceTime camera)',
  },

  // ── SELF MODIFICATION ─────────────────────────────────────────────────────
  {
    id: 'self_mod',
    patterns: [
      /modify\s*(yourself|your\s*code|yourself\s*to)/i,
      /update\s*(yourself|your\s*(code|system|capabilities))/i,
      /upgrade\s*(yourself|your\s*capabilities)/i,
      /add\s*(this\s*)?capability/i,
      /improve\s*yourself/i,
      /self.?mod(ify|ification)?/i,
      /install\s*(a\s*new\s*)?(feature|capability|skill)/i,
      /heal\s*yourself/i,
      /fix\s*(your)?self/i,
      /build\s*(the\s*)?(skill|tool|capability)/i,
      /identify\s+.*?(gaps|features)/i,
      /self-engineer/i,
      /self.?engineer/i,
      /expand\s*(your\s*)?capabilities/i,
    ],
    agent: 'SelfModAgent',
    buildTask: (msg) => ({
      type: 'modify_self',
      instruction: msg,
      targetCapability: msg,
    }),
    description: 'Modify APEX\'s own code/capabilities',
  },

  // ── BUILD CODE ─────────────────────────────────────────────────────────────
  {
    id: 'build_code',
    patterns: [
      /build\s*(me\s*)?(a\s*)?(\w+\s*)?(app|application|website|api|server|script|tool|bot|system)/i,
      /create\s*(a\s*)?(\w+\s*)?(website|landing\s*page|dashboard|app)/i,
      /code\s*(a\s*|up\s*)?(for\s*me\s*)?/i,
      /write\s*(the\s*)?code\s*(for|to)/i,
      /develop\s*(a\s*)?(website|app|tool)/i,
      /make\s*(me\s*)?(a\s*)?(website|app|tool|script)/i,
    ],
    agent: 'CodeAgent',
    buildTask: (msg) => ({ objective: msg, type: 'project' }),
    isSlow: true,
    acknowledgmentTemplates: [
      'Building that for you right now, Temple...',
      'Starting the engineering process, one moment...',
      'I\'m on it. Creating the project structure now...',
    ],
    description: 'Build software projects',
  },

  // ── UI / DESIGN ─────────────────────────────────────────────────────────────
  {
    id: 'ui_design',
    patterns: [
      /design\s*(me\s*)?(a\s*)?(ui|ux|interface|landing\s*page|webpage|website)/i,
      /create\s*(a\s*)?(beautiful|stunning|modern|animated)\s*(ui|design|website)/i,
      /build\s*(a\s*)?(landing\s*page|frontend|ui)/i,
      /make\s*(it\s*)?(look|look\s+like|beautiful|better)/i,
      /framer.*(style|like|quality)/i,
      /animation(s)?\s*(like|similar|quality)/i,
    ],
    agent: 'UIAgent',
    buildTask: (msg) => ({
      objective: msg,
      useDesignRepo: true,
      searchForBestRepo: true,
    }),
    description: 'Design and build Framer-quality UIs',
  },

  // ── RESEARCH ──────────────────────────────────────────────────────────────
  {
    id: 'research',
    patterns: [
      /research\s+/i,
      /find\s*(out\s*)?(about|information|details|info)\s+(on|about)/i,
      /what\s*(is|are|does)\s+\w+/i,
      /tell\s*me\s*(about|more\s*about)/i,
      /look\s*(up|into)\s+/i,
      /search\s*(for|about)\s+/i,
      /investigate\s+/i,
      /analyze\s+/i,
    ],
    agent: 'ResearchAgent',
    buildTask: (msg) => ({ query: msg, depth: 'standard' }),
    description: 'Research any topic deeply',
  },

  // ── IMAGE GENERATION ──────────────────────────────────────────────────────
  {
    id: 'generate_image',
    patterns: [
      /generate\s*(me\s*)?(a\s*)?image/i,
      /create\s*(me\s*)?(a\s*)?(picture|photo|image|illustration)/i,
      /make\s*(me\s*)?(a\s*)?(picture|image|photo)/i,
      /draw\s*(me\s*)?(a\s*)?/i,
      /design\s*(me\s*)?(a\s*)?logo/i,
    ],
    agent: 'GenerationAgent',
    buildTask: (msg) => ({ action: 'image', prompt: msg }),
    description: 'Generate images using free AI models',
  },

  // ── 3D GENERATION ─────────────────────────────────────────────────────────
  {
    id: 'generate_3d',
    patterns: [
      /3d\s*(model|object|render|animation)/i,
      /create\s*(a\s*)?3d/i,
      /blender\s*(model|render|design)/i,
      /render\s*(a\s*)?3d/i,
    ],
    agent: 'BlenderAgent',
    buildTask: (msg) => ({ action: 'create', prompt: msg }),
    description: 'Create 3D models with Blender',
  },

  // ── VIDEO ─────────────────────────────────────────────────────────────────
  {
    id: 'video',
    patterns: [
      /replicate\s*(this|the)\s*(video|project)/i,
      /watch\s*(this|the)\s*video\s*(and|then)/i,
      /youtube\s*(video|link|url)/i,
      /https?:\/\/(www\.)?(youtube|youtu\.be)/i,
      /download\s*(this|the)?\s*video/i,
    ],
    agent: 'VideoAgent',
    buildTask: (msg) => ({
      action: msg.match(/https?:\/\/(www\.)?(youtube|youtu\.be)/i) ? 'replicate' : 'analyze',
      url: (msg.match(/https?:\/\/[^\s]+/) || [])[0],
    }),
    description: 'Download, transcribe, and replicate videos',
  },

  // ── DEPLOY ────────────────────────────────────────────────────────────────
  {
    id: 'deploy',
    patterns: [
      /deploy\s*(this|my|the)?\s*(project|app|website|code)/i,
      /host\s*(this|my|the)?\s*(website|app)/i,
      /publish\s*(to|on)\s*(vercel|fly|railway|heroku|netlify)/i,
      /put\s*(this|it)\s*(online|live)/i,
      /launch\s*(this|the|my)\s*(app|website)/i,
    ],
    agent: 'DeployAgent',
    buildTask: (msg) => ({ action: 'auto', instruction: msg }),
    description: 'Deploy projects to cloud platforms',
  },

  // ── SECURITY ──────────────────────────────────────────────────────────────
  {
    id: 'security',
    patterns: [
      /scan\s*(my\s*)?(website|server|app|system)\s*(for)?\s*(vulnerabilities|security)/i,
      /pentest\s+/i,
      /security\s*(test|scan|audit|check)/i,
      /hack\s*(check|test|proof)/i,
      /find\s*(vulnerabilities|security\s*issues)/i,
    ],
    agent: 'SecurityAgent',
    buildTask: (msg) => ({ objective: msg, authorization: false }),
    requiresAdmin: true,
    description: 'Security scanning and assessment',
  },

  // ── SEND MESSAGE ─────────────────────────────────────────────────────────
  {
    id: 'send_message',
    patterns: [
      /send\s*(a\s*)?(message|msg|dm|text)\s*(to|for)/i,
      /message\s+\w+\s*(on|via|through)\s*(whatsapp|telegram|linkedin|instagram|email)/i,
      /reach\s*out\s*to\s+/i,
      /contact\s+\w+\s*(via|through|on)/i,
      /email\s+\w+\s*(about|regarding)/i,
    ],
    agent: 'SocialMessagingAgent',
    buildTask: (msg) => ({ action: 'draft', objective: msg }),
    description: 'Send messages on your behalf',
  },

  // ── REVENUE ───────────────────────────────────────────────────────────────
  {
    id: 'revenue',
    patterns: [
      /find\s*(clients|customers|leads)/i,
      /make\s*(me\s*)?(some\s*)?money/i,
      /create\s*(an?\s*)?(invoice|payment\s*link)/i,
      /send\s*(an?\s*)?invoice/i,
      /revenue\s*(opportunities|ideas)/i,
      /i\s*(need|want)\s*(to\s*)?(earn|make)\s*/i,
    ],
    agent: 'RevenueAgent',
    buildTask: (msg) => ({ action: 'opportunities', context: msg }),
    description: 'Revenue generation and client acquisition',
  },

  // ── CLONE WEBSITE ─────────────────────────────────────────────────────────
  {
    id: 'clone_site',
    patterns: [
      /clone\s*(this|the)?\s*(website|site|design)/i,
      /copy\s*(this|the)?\s*(website|design|site)/i,
      /replicate\s*(this|the)?\s*(website|design|site|framer)/i,
      /extract\s*(this|the)?\s*(website|design|site)/i,
    ],
    agent: null, // handled by orchestrator directly
    buildTask: (msg) => ({
      capability: 'website_clone',
      url: (msg.match(/https?:\/\/[^\s]+/) || [])[0],
      instruction: msg,
    }),
    description: 'Clone and convert website designs',
  },

  // ── GIT / GITHUB ─────────────────────────────────────────────────────────
  {
    id: 'git',
    patterns: [
      /git\s*(clone|pull|push|commit)/i,
      /clone\s*(the|this|a)?\s*(repo|repository)/i,
      /find\s*(a\s*)?(repo|repository)\s*(on\s*github|for)/i,
      /github\s*(repo|project|repository)/i,
    ],
    agent: 'CodeAgent',
    buildTask: (msg) => ({ objective: msg, type: 'git_operation' }),
    description: 'GitHub and git operations',
  },

  // ── STATUS / SELF KNOWLEDGE ───────────────────────────────────────────────
  {
    id: 'self_knowledge',
    patterns: [
      /what\s*(tools?|capabilities?|agents?)\s*(do\s*you\s*have|can\s*you\s*use)/i,
      /what\s*can\s*you\s*(do|help\s*with)/i,
      /show\s*me\s*(your\s*)?(capabilities?|tools?|agents?)/i,
      /list\s*(your\s*)?(capabilities?|tools?|agents?|features?)/i,
      /your\s*(tools?|capabilities?|system|agents?)/i,
    ],
    agent: null, // handled internally
    buildTask: () => ({ capability: 'self_describe' }),
    description: 'Show APEX capabilities',
  },

  // ── SCHEDULE ──────────────────────────────────────────────────────────────
  {
    id: 'schedule',
    patterns: [
      /remind\s*me\s*(to|about)/i,
      /schedule\s*(this|a\s*task|for)\s*/i,
      /every\s*(day|morning|week|hour)/i,
      /at\s*\d{1,2}(:\d{2})?\s*(am|pm)/i,
      /set\s*(a\s*)?(reminder|alarm)/i,
    ],
    agent: 'EmailCalendarAgent',
    buildTask: (msg) => ({ action: 'schedule', objective: msg }),
    description: 'Schedule tasks and reminders',
  },

  // ── SIPHON PROGRESS ────────────────────────────────────────────────────────
  {
    id: 'siphon_progress',
    patterns: [
      /siphon\s*(progress|status)/i,
      /download\s*(progress|status)/i,
      /how\s*far\s*(with|on)\s*(the\s*)?(download|siphon|brain)/i,
      /check\s*(brain|download|siphon)\s*(progress|status)/i,
      /model\s*pull\s*status/i,
    ],
    agent: null, // handled internally
    buildTask: () => ({ capability: 'siphon_progress' }),
    isSlow: true,
    acknowledgmentTemplates: [
      'Checking the brain siphon status for you, Temple...',
      'One sec, let me check the siphoning progress...',
    ],
    description: 'Check real-time brain download progress',
  },
];

// ── CAPABILITY ROUTER CLASS ───────────────────────────────────────────────────

export class CapabilityRouter {
  constructor() {
    this._capabilities = CAPABILITIES;
    this._usageStats = {};
  }

  // Main routing method — returns null if no capability match
  async route(message, context = {}) {
    const msg = message.trim();

    // 1. Fast pattern matching
    for (const cap of this._capabilities) {
      for (const pattern of (cap.patterns || [])) {
        if (pattern.test(msg)) {
          this._usageStats[cap.id] = (this._usageStats[cap.id] || 0) + 1;
          bus.emit('capability:matched', { id: cap.id, pattern: pattern.toString().slice(0, 50), message: msg.slice(0, 50) });
          return { capability: cap, method: 'pattern', confidence: 0.95 };
        }
      }
    }

    // 1.5 Dynamic Plugin Keyword Matching (for self-generated tools)
    const dynamicMatch = await this._matchDynamicPlugin(msg);
    if (dynamicMatch) return dynamicMatch;

    // 2. LLM-based capability matching for ambiguous messages
    const match = await this._llmRoute(msg);
    if (match && match.capabilityId) {
      const cap = this._capabilities.find(c => c.id === match.capabilityId);
      if (cap) {
        bus.emit('capability:llm_matched', { id: cap.id, confidence: match.confidence });
        return { capability: cap, method: 'llm', confidence: match.confidence };
      }
    }

    return null; // No capability match — route to conversational AI
  }

  async _llmRoute(message) {
    const capList = this._capabilities.map(c => `${c.id}: ${c.description}`).join('\n');
    try {
      return await structured(
        `Given this user message, which APEX capability should handle it?

Message: "${message}"

Capabilities:
${capList}

CRITICAL ROUTING RULES:
1. If the user mentions "building skills", "identifying gaps", "expanding yourself", or "fixing your hardware limitations" → ALWAYS route to 'self_mod'.
2. If the message is a request for APEX to improve his own code or functionality → ALWAYS route to 'self_mod'.
3. Do NOT route to 'generate_image' if the request is for functional software or hardware capabilities.

If confidence < 0.6, return null for capabilityId.`,
        { capabilityId: 'capability id or null', confidence: 0.8 },
        { temperature: 0.1, simple: true }
      );
    } catch {
      return null;
    }
  }

  async _matchDynamicPlugin(message) {
    try {
      const { readFileSync, existsSync } = await import('fs');
      const registryPath = '/Users/mac/Downloads/apex 4/plugins/_registry.json';
      if (!existsSync(registryPath)) return null;

      const registryData = JSON.parse(readFileSync(registryPath, 'utf8'));
      const msg = message.toLowerCase();

      for (const [name, info] of Object.entries(registryData)) {
        if (!info.path || !existsSync(info.path)) continue; // Ensure plugin exists on disk physically

        const normalizedName = name.toLowerCase().replace(/[\s-]+/g, ' ');
        // If message contains key terms from plugin name or description
        const keywords = normalizedName.split(' ').filter(k => k.length > 3);
        
        const isMatch = keywords.some(k => msg.includes(k)) || 
                        (msg.includes('show') && normalizedName.includes('camera')) ||
                        (msg.includes('show') && normalizedName.includes('hardware'));
        
        if (isMatch) {
          return {
            capability: {
              id: `dynamic_${name}`,
              agent: info.agent || 'SelfModAgent', // Default to SelfMod for execution if no agent
              buildTask: (m, context) => ({ 
                type: 'run_plugin', 
                plugin: name, 
                pluginPath: info.path,
                instruction: m + ` (Context: Request originated from ${context?.platform || 'system'}. If the user specifies 'from my phone', instruct them to upload a photo via Telegram. Otherwise, use the Swift webcam driver to capture a high-quality .jpg from the Mac and return the absolute path so it can be sent to the user on Telegram.)` 
              }),
              description: info.description
            },
            method: 'dynamic_plugin',
            confidence: 0.9
          };
        }
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  // Execute a matched capability
  async execute(capabilityMatch, message, context = {}) {
    const { capability } = capabilityMatch;

    // Handle internal capabilities
    if (!capability.agent) {
      return this._executeInternal(capability.id, message, context);
    }

    // Get the agent
    const agent = registry.get(capability.agent);
    if (!agent) {
      // Try to respawn
      try {
        const { selfHealingLoop } = await import('./self-healing.js');
        await selfHealingLoop._respawnAgent(capability.agent);
        return { error: `${capability.agent} was offline — restarting. Try again in a moment.` };
      } catch {
        return { error: `${capability.agent} not available` };
      }
    }

    // Admin gate for restricted capabilities
    if (capability.requiresAdmin) {
      const { adminGate } = await import('./admin-gate.js');
      if (!adminGate.isUnlocked()) {
        return { requiresAdmin: true, message: '🔐 This capability requires admin unlock. Send your admin code.' };
      }
    }

    // Build and execute the task
    const task = capability.buildTask(message, context);
    task.id = task.id || uuidv4();

    // ── NATIVE PLUGIN EXECUTION ──
    if (task.type === 'run_plugin' && task.pluginPath) {
      try {
        const { default: pluginModule } = await import(task.pluginPath);
        
        let result;
        if (typeof pluginModule === 'function') {
           try {
             // Try calling it as a normal function first
             result = await pluginModule(task.instruction);
           } catch (err) {
             if (err.message && err.message.includes("cannot be invoked without 'new'")) {
               // It's an ES6 Class, instantiate it
               const instance = new pluginModule();
               if (typeof instance.execute === 'function') {
                 result = await instance.execute(task.instruction);
               } else {
                 result = `Plugin instantiated successfully, but no execute() method was found.`;
               }
             } else {
               throw err;
             }
           }
        } else if (pluginModule && pluginModule.execute) {
           result = await pluginModule.execute(task.instruction);
        } else {
           const exec = (await import('child_process')).exec;
           const promisifiedExec = (await import('util')).promisify(exec);
           const { stdout } = await promisifiedExec(`/usr/local/bin/node "${task.pluginPath}" "${task.instruction.replace(/"/g, '\\"')}"`);
           result = stdout;
        }
        
        bus.emit('capability:executed', { id: capability.id, agent: capability.agent, success: true });
        return { success: true, capability: capability.id, result };
      } catch (err) {
        return { success: false, error: err.message, capability: capability.id };
      }
    }

    try {
      const result = await agent._handleTask(task);
      bus.emit('capability:executed', { id: capability.id, agent: capability.agent, success: true });
      return { success: true, capability: capability.id, result };
    } catch (err) {
      bus.emit('capability:error', { id: capability.id, error: err.message });
      return { success: false, error: err.message, capability: capability.id };
    }
  }

  async _executeInternal(capId, message, context) {
    if (capId === 'self_describe') {
      const agents = registry.snapshot();
      return {
        success: true,
        result: `I am currently operational with ${agents.length} specialized agents and ${CAPABILITIES.length} core capabilities. My active systems include ${agents.slice(0, 5).map(a => a.name).join(', ')} and many others. How can I put them to work for you?`,
      };
    }

    if (capId === 'clone_site') {
      const { websiteCloner } = await import('../tools/website-cloner.js');
      const task = CAPABILITIES.find(c => c.id === 'clone_site').buildTask(message);
      const result = await websiteCloner.clone(task.url, { instructions: task.instruction });
      return { success: true, result };
    }

    if (capId === 'siphon_progress') {
      const { readFileSync, existsSync } = await import('fs');
      const logPath = '/Users/mac/Downloads/apex 4/ollama-pull.log';
      if (!existsSync(logPath)) return { success: true, result: 'No brain siphon active right now.' };
      
      const content = readFileSync(logPath, 'utf8');
      const matches = content.match(/([0-9]{1,3})%/g);
      if (!matches) return { success: true, result: 'Brain siphon initializing...' };
      
      const progress = matches[matches.length - 1];
      const lines = content.split('\n');
      const lastLine = lines[lines.length - 1] || lines[lines.length - 2] || '';
      const speed = (lastLine.match(/([0-9.]+ [A-Z]B\/s)/) || [])[0] || '...';
      const eta = (lastLine.match(/([0-9]+m[0-9]+s|[0-9]+s)/) || [])[0] || '...';
      
      return { 
        success: true, 
        result: `🧬 Brain Siphon Status: ${progress}\nSpeed: ${speed}\nETA: ${eta}\n\nI'll ping you as soon as the Expert Brain is ready.` 
      };
    }

    if (capId === 'webcam_capture') {
      try {
        const webcamPlugin = (await import('../plugins/webcam-capture.js')).default;
        const filePath = await webcamPlugin.execute(message);
        if (filePath && filePath.startsWith('/')) {
          return { success: true, result: filePath };
        }
        return { success: false, error: filePath || 'Webcam capture failed' };
      } catch (err) {
        return { success: false, error: `Webcam error: ${err.message}` };
      }
    }

    return { success: false, error: `Internal capability ${capId} not implemented` };
  }

  // Get capabilities summary for identity/help responses
  getSummary() {
    return CAPABILITIES.map(c => c.description);
  }

  getStats() {
    return this._usageStats;
  }
}

export const capabilityRouter = new CapabilityRouter();
export default capabilityRouter;
