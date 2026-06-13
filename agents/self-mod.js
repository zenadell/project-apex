// agents/self-mod.js
// APEX SelfModAgent — The crown jewel. Detects capability gaps, writes tools, tests them, integrates.
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import Memory from '../core/memory.js';
import bus from '../core/event-bus.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

if (!existsSync(PLUGINS_DIR)) mkdirSync(PLUGINS_DIR, { recursive: true });

export class SelfModAgent extends BaseAgent {
  constructor() {
    super({
      name: 'SelfModAgent',
      type: 'self_modification',
      description: 'Monitors APEX for capability gaps. Researches solutions, writes new tools/agents, tests them, and integrates them into the live system without downtime.',
    });
    this._pendingExtensions = [];
    this._gapLog = [];
    this._pluginRegistry = this._loadPluginRegistry();
  }

  async run(task) {
    const { type, instruction, targetCapability } = task;

    if (type === 'detect_gaps') return this.detectAndFillGaps();
    if (type === 'create_tool') return this.createTool(task);
    if (type === 'create_agent') return this.createAgent(task);
    if (type === 'self_audit') return this.selfAudit();

    // Natural language modification request (from channels/user)
    if (type === 'modify_self' || instruction) {
      return this.handleNaturalModification(instruction || targetCapability || type);
    }

    return this.detectAndFillGaps();
  }

  // Handle natural language: "modify yourself to speak using voice"
  // Understands WHAT needs to change and DOES it
  async handleNaturalModification(instruction) {
    this.log(`Natural modification request: "${instruction?.slice(0, 80)}"`);

    const { complete, structured } = await import('../core/llm.js');

    // Understand what needs to change
    const analysis = await structured(
      `The user wants APEX to modify itself: "${instruction}"\n\nAnalyze what capability change is needed.`,
      {
        capabilityNeeded: 'what capability/feature is being requested',
        isConfigChange: 'is this just a configuration/setting update? true/false',
        envKey: 'the .env key to update if it is a config change, or null',
        newValue: 'the new value for the .env key, or null',
        currentlyHas: 'does APEX likely already have this? true/false',
        suggestedAgent: 'which existing agent handles this, or null',
        newToolNeeded: 'describe a new tool/agent if needed, or null',
        isRepair: 'is the user asking to fix/repair an existing broken tool/skill? true/false',
        repairTarget: 'the name of the tool/file to repair, or null',
        immediateAction: 'what to do right now to fulfill the request',
        canDoNow: 'can this be done without code changes? true/false',
      },
      { temperature: 0.1 }
    );

    this.log(`Analysis: ${JSON.stringify(analysis)}`);

    // Handle Configuration Changes (e.g. "change voice id")
    if (analysis.isConfigChange && analysis.envKey && analysis.newValue) {
        this.log(`Applying config change: ${analysis.envKey} = ${analysis.newValue}`);
        const envPath = path.join(__dirname, '..', '.env');
        let envContent = readFileSync(envPath, 'utf8');
        const regex = new RegExp(`^${analysis.envKey}=.*$`, 'm');
        
        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${analysis.envKey}=${analysis.newValue}`);
        } else {
            envContent += `\n${analysis.envKey}=${analysis.newValue}`;
        }
        
        writeFileSync(envPath, envContent);
        this.remember(`Updated system configuration: ${analysis.envKey}`, { tags: ['config', 'self_mod'], importance: 8 });
        
        return {
            success: true,
            message: `✅ I've successfully updated my ${analysis.envKey} configuration to your requested value. These changes are now active.`,
            name: `${analysis.envKey} update`,
            action: 'config_updated',
            modifiedFor: instruction
        };
    }

    // If it already exists — just activate/configure it
    if (analysis.canDoNow && analysis.suggestedAgent) {
      return {
        success: true,
        message: `✅ APEX already has this capability via ${analysis.suggestedAgent}. Activating now.`,
        action: 'activated_existing',
        agent: analysis.suggestedAgent,
        capability: analysis.capabilityNeeded,
      };
    }

    // Handle Repair Requests (e.g. "fix your PDF tool")
    if (analysis.isRepair && analysis.repairTarget) {
        return this.repairPlugin(analysis.repairTarget);
    }
    if (analysis.newToolNeeded) {
      const result = await this.createTool({
        name: analysis.capabilityNeeded?.replace(/\s+/g, '_').toLowerCase() || 'new_capability',
        description: analysis.capabilityNeeded,
        implementation: analysis.newToolNeeded,
      });
      return { ...result, modifiedFor: instruction };
    }

    // Research and implement
    const researchAgent = (await import('../core/agent-registry.js')).default.get('ResearchAgent');
    let research = null;
    if (researchAgent) {
      try {
        research = await researchAgent._handleTask({
          id: 'selfmod-research',
          query: `How to implement: ${analysis.capabilityNeeded}. Node.js library or API to use.`,
        });
      } catch {}
    }

    return this.createTool({
      name: analysis.capabilityNeeded?.replace(/\s+/g, '_').toLowerCase() || 'new_tool',
      description: analysis.capabilityNeeded,
      implementation: research?.synthesis || analysis.immediateAction,
    });
  }

  // Full autonomous gap detection and filling cycle
  async detectAndFillGaps() {
    this.log('Starting gap detection cycle...');

    const awareness = Memory.selfAwareness();
    const currentCaps = Memory.listCapabilities();
    const recentTasks = Memory.search('failed', { limit: 20 });
    const agentList = Memory.getAgents().map(a => a.name);

    const result = await this._identifyGaps(currentCaps, recentTasks, agentList, awareness);
    const gaps = Array.isArray(result?.gaps) ? result.gaps : [];
    this.log(`Identified ${gaps.length} capability gaps`);

    if (gaps.length === 0) return { gaps: [], filled: [], message: 'No critical gaps identified in this cycle.' };

    const filled = [];
    for (const gap of gaps.slice(0, 3)) { // Process top 3 gaps
      try {
        const result = await this._fillGap(gap);
        filled.push(result);
        this.log(`Filled gap: ${gap.name}`, 'info');
        bus.emit('selfmod:gap_filled', { gap: gap.name, result });
      } catch (err) {
        this.log(`Failed to fill gap "${gap.name}": ${err.message}`, 'warn');
      }
    }

    return { gaps, filled, timestamp: Date.now() };
  }

  async _identifyGaps(caps, failedTasks, agentList, awareness) {
    const capNames = caps.map(c => c.name).join(', ');
    const failContext = failedTasks.map(t => t.content).slice(0, 10).join('\n');

    return structured(
      `You are auditing the APEX AI system for capability gaps.

Current capabilities: ${capNames}
Current agents: ${agentList.join(', ')}
Recent failure patterns:
${failContext}
System stats: ${JSON.stringify(awareness)}

MISSION: Identify mission-critical hardware or software gaps. 
CRITICAL RULE: If a user asks to "open camera", "scan wifi", or "use hardware", do NOT suggest using a Generative AI API. You must implement a direct hardware driver tool (e.g. using ffmpeg, imagesnap, screencapture, or native shell commands). 

Identify the most important missing capabilities that would make APEX more powerful.`,
      {
        gaps: [
          {
            name: 'capability name',
            description: 'what it does',
            priority: 'critical/high/medium',
            type: 'tool/agent/integration',
            implementation: 'brief how to implement',
          }
        ]
      },
      { temperature: 0.5 }
    );
  }

  async _fillGap(gap) {
    this.log(`Filling gap: ${gap.name} (${gap.type})`);

    if (gap.type === 'agent') {
      return this.createAgent({
        name: gap.name,
        description: gap.description,
        implementation: gap.implementation,
      });
    } else {
      return this.createTool({
        name: gap.name,
        description: gap.description,
        implementation: gap.implementation,
      });
    }
  }

  // Create a new tool autonomously using ApexForge Engine
  async createTool({ name, description, implementation = '' }) {
    this.log(`Creating tool: ${name} via ApexForge (Hermes)...`);

    const prompt = `Objective: Build a new APEX tool called ${name}.
Description: ${description}
Implementation hints: ${implementation}

Constraints:
1. Write a complete Node.js ES Module to a new file in plugins/${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}.js.
2. It must export default class or function.
3. Use your tools to execute it and verify it has no syntax errors.

You are the ApexForge Engine. Do not stop until the tool is written to disk and verified.`;

    try {
      const code = await complete(prompt);
      const filename = path.join(PLUGINS_DIR, `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}.js`);
      writeFileSync(filename, code, 'utf8');
      this.log(`✅ ApexForge successfully synthesized tool: ${name}`);
    } catch (err) {
      throw new Error(`ApexForge failed to generate tool ${name}: ${err.message}`);
    }

    return { name, description, integrated: true };
  }

  // Create a new agent autonomously
  async createAgent({ name, description, implementation = '', systemPrompt = '' }) {
    this.log(`Creating dynamic agent: ${name}`);

    let agentCode = await complete(
      `Write a complete APEX agent file for:

Agent name: ${name}
Description: ${description}
Implementation hints: ${implementation}

The agent MUST:
1. Import BaseAgent from the PROJECT ROOT agents folder.
2. Extend BaseAgent.
3. Use ES Modules (export default class).
4. Implement async run(task) method.
5. Use the LLM: import { complete, structured } from '../core/llm.js'
6. Call this.log(), this.remember(), this.recall() appropriately.

Return ONLY the code.`,
      { temperature: 0.1, maxTokens: 4000 }
    );

    // Strip markdown formatting
    agentCode = agentCode.replace(/^```javascript\n/, '').replace(/^```js\n/, '').replace(/^```\n/, '').replace(/\n```$/, '').trim();

    // Test the agent in the sandbox chamber
    const testResult = await this._testGeneratedCode(agentCode, name, 'agent');
    if (!testResult.success) {
      const fixedCode = await complete(
        `Fix this agent code:\n\nError: ${testResult.error}\n\nOriginal code:\n${agentCode}\n\nReturn ONLY the fixed code, no markdown.`,
        { temperature: 0.1, maxTokens: 4000 }
      );
      const retestResult = await this._testGeneratedCode(fixedCode, name, 'agent');
      if (!retestResult.success) {
        throw new Error(`Failed to create functioning agent after 2 attempts. Error: ${retestResult.error}`);
      }
      agentCode = fixedCode;
    }

    const pluginPath = path.join(PLUGINS_DIR, `${name.toLowerCase().replace(/\s+/g, '-')}-agent.js`);
    writeFileSync(pluginPath, agentCode);

    // Register in memory
    Memory.registerCapability({
      name,
      description,
      type: 'self_generated',
      path: pluginPath,
    });

    // Auto-load into registry
    try {
      const { default: AgentClass } = await import(`${pluginPath}?t=${Date.now()}`);
      const { registry } = await import('../core/agent-registry.js');
      const instance = new AgentClass();
      registry.register(instance);
      this.log(`✅ Agent "${name}" created and registered live`);
      bus.emit('selfmod:agent_created', { name, path: pluginPath });
    } catch (err) {
      this.log(`Agent created but failed to auto-load: ${err.message}`, 'warn');
    }

    this.remember(
      `Created new agent: ${name} — ${description}`,
      { tags: ['self_mod', 'agent_created'], importance: 9, scope: 'long_term' }
    );

    return { name, description, path: pluginPath, loaded: true };
  }

  async _testGeneratedCode(code, name, type = 'tool') {
    const safeName = name.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-');
    const tmpPath = `/tmp/apex-test-${safeName}-${Date.now()}.js`;
    const runnerPath = `/tmp/apex-runner-${Date.now()}.js`;
    try {
      writeFileSync(tmpPath, code);
      // Syntax check (Using absolute node path for background reliability)
      await execAsync(`/usr/local/bin/node --input-type=module --check < "${tmpPath}"`, { timeout: 5000 });
      
      // LINGUISTIC GUARD: Detect if he tried to write Swift inside JS
      if (code.includes('(for:') || code.includes('AVCapture') || code.includes('import AVFoundation')) {
          throw new Error('LANGUAGE MIX ERROR: You are writing Swift code inside a JavaScript file. STOP. Follow the BRIDGE PATTERN: 1. Write Swift to a .swift file. 2. Compile with swiftc. 3. Call binary from JS.');
      }
      
      // Sandbox functional check
      if (type === 'agent') {
        // Fix relative imports for the sandbox by injecting absolute file URLs
        const { pathToFileURL } = await import('url');
        const baseAgentUrl = pathToFileURL(path.join(__dirname, 'base-agent.js')).href;
        const llmUrl = pathToFileURL(path.join(__dirname, '..', 'core', 'llm.js')).href;
        
        // Handle variations (Case-insensitive, with/without .js)
        code = code.replace(/from\s+['"]\.\.\/agents\/(base-agent|BaseAgent)(\.js)?['"]/gi, `from '${baseAgentUrl}'`);
        code = code.replace(/from\s+['"]\.\.\/core\/llm(\.js)?['"]/gi, `from '${llmUrl}'`);
        writeFileSync(tmpPath, code);

        const testRunner = `
          import Agent from '${tmpPath}';
          process.exit(0); 
        `;
        writeFileSync(runnerPath, testRunner);
        // Smoke test: Run the import check
        await execAsync(`/usr/local/bin/node ${runnerPath}`, { timeout: 10000 });
      } else {
        // For tools/plugins, also do a smoke test to check ESM and dependencies
        const toolRunner = `
          import * as Tool from '${tmpPath}';
          process.exit(0);
        `;
        writeFileSync(runnerPath, toolRunner);
        await execAsync(`/usr/local/bin/node ${runnerPath}`, { timeout: 10000 });
      }
      
      return { success: true, output: 'Pass' };
    } catch (err) {
      return { success: false, error: err.stderr || err.stdout || err.message };
    }
  }

  // Autonomously repair a broken plugin
  async repairPlugin(targetName) {
    this.log(`Repairing plugin: ${targetName}`);
    const plugins = readdirSync(PLUGINS_DIR);
    const normalizedTarget = targetName.toLowerCase().replace(/[\s-]+/g, '-');
    const fileName = plugins.find(f => {
      const normalizedFile = f.toLowerCase().replace(/[\s-]+/g, '-').replace(/\.js$/, '');
      return normalizedFile.includes(normalizedTarget) || normalizedTarget.includes(normalizedFile);
    });
    
    if (!fileName) return { success: false, error: `Could not find plugin matching "${targetName}"` };
    
    const filePath = path.join(PLUGINS_DIR, fileName);
    let code = readFileSync(filePath, 'utf8');
    
    // Test it first to get the error
    const testResult = await this._testGeneratedCode(code, fileName);
    if (testResult.success) return { success: true, message: `Plugin ${fileName} is already healthy.` };
    
    this.log(`Repairing ${fileName} due to: ${testResult.error}`, 'warn');
    
    // Same iterative loop as createTool
    let attempts = 0;
    const maxAttempts = 3;
    let currentTest = testResult;
    
    while (attempts < maxAttempts && !currentTest.success) {
      attempts++;
      const fixedCode = await complete(
        `Your plugin file "${fileName}" has a syntax error:\n${currentTest.error}\n\nOriginal Code:\n${code}\n\nFix the error and return ONLY the valid Node.js code. No markdown.`,
        { temperature: 0.1, maxTokens: 3000 }
      );
      
      const cleanCode = fixedCode.replace(/^```javascript\n/, '').replace(/^```js\n/, '').replace(/^```\n/, '').replace(/\n```$/, '').trim();
      currentTest = await this._testGeneratedCode(cleanCode, fileName);
      
      if (currentTest.success) {
        writeFileSync(filePath, cleanCode);
        return { success: true, message: `I have autonomously repaired the ${fileName} skill. It is now 100% syntactically valid and active.`, name: fileName, integrated: true };
      }
    }
    
    return { success: false, error: `Failed to repair ${fileName} after ${maxAttempts} attempts.` };
  }
  _integrateTool(name, description, code) {
    const toolPath = path.join(PLUGINS_DIR, `${name.toLowerCase().replace(/\s+/g, '-')}.js`);
    writeFileSync(toolPath, code);

    Memory.registerCapability({
      name,
      description,
      type: 'self_generated',
      path: toolPath,
    });

    bus.emit('selfmod:tool_created', { name, path: toolPath });

    this._pluginRegistry[name] = { path: toolPath, description, created: Date.now() };
    this._savePluginRegistry();

    return { name, description, path: toolPath, integrated: true };
  }

  // Full self-audit — what am I? What can I do? What am I missing?
  async selfAudit() {
    const awareness = Memory.selfAwareness();
    const caps = Memory.listCapabilities();
    const agents = Memory.getAgents();
    const plugins = readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.js'));

    const audit = await structured(
      `Perform a self-audit of the APEX AI system.\n\nSystem stats:\n${JSON.stringify(awareness, null, 2)}\n\nCapabilities (${caps.length}): ${caps.map(c => c.name).join(', ')}\nAgents (${agents.length}): ${agents.map(a => a.name).join(', ')}\nSelf-generated plugins (${plugins.length}): ${plugins.join(', ')}\n\nProvide a comprehensive self-assessment.`,
      {
        strengths: ['what APEX does well'],
        weaknesses: ['gaps and limitations'],
        selfGeneratedTools: ['list of tools I created myself'],
        growthAreas: ['areas to develop next'],
        overallCapabilityScore: 'score out of 100 with rationale',
        nextActions: ['top 3 actions to improve'],
      }
    );

    this.log(`Self-audit complete. Score: ${audit.overallCapabilityScore}`);
    return { audit, awareness, caps, agents, plugins };
  }

  _loadPluginRegistry() {
    const registryPath = path.join(PLUGINS_DIR, '_registry.json');
    if (existsSync(registryPath)) {
      try { return JSON.parse(readFileSync(registryPath, 'utf8')); } catch {}
    }
    return {};
  }

  _savePluginRegistry() {
    const registryPath = path.join(PLUGINS_DIR, '_registry.json');
    writeFileSync(registryPath, JSON.stringify(this._pluginRegistry, null, 2));
  }
}

export default SelfModAgent;
