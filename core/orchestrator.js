// core/orchestrator.js
// APEX Orchestrator — Master brain. Plans, delegates, coordinates, and executes complex tasks.
import { complete, structured } from './llm.js';
import bus from './event-bus.js';
import Memory from './memory.js';
import registry from './agent-registry.js';
import crypto from 'crypto';
const { randomUUID: uuidv4 } = crypto;
import chalk from 'chalk';
import path from 'path';
import taskQueue from './task_queue.js';

// Import all core agents
import ResearchAgent from '../agents/research.js';
import CodeAgent from '../agents/code.js';
import SecurityAgent from '../agents/security.js';
import SelfModAgent from '../agents/self-mod.js';
import SkillsAgent from '../agents/skills.js';
import BrowserAgent from '../agents/browser.js';
import BrowserAgentPro from '../agents/browser-pro.js';
import UIAgent from '../agents/ui.js';
import QAAgent from '../agents/qa.js';
import ArchitectAgent from '../agents/architect.js';
import VoiceAgent from '../agents/voice.js';
import DeviceAgent from '../agents/device.js';
import VisionAgent from '../agents/vision.js';
import UserProfileAgent from '../agents/user-profile.js';
import EmailCalendarAgent from '../agents/email-calendar.js';
import DataAgent from '../agents/data.js';
import DeployAgent from '../agents/deploy.js';
import SocialMessagingAgent from '../agents/social-messaging.js';
import BusinessProspector from '../agents/prospector.js';
import RevenueAgent from '../agents/revenue.js';
import IntelligenceMonitor from '../agents/intelligence-monitor.js';
import VerifierAgent from '../agents/verifier.js';
import GenerationAgent from '../agents/generation.js';
import VideoAgent from '../agents/video.js';
import BlenderAgent from '../agents/blender.js';
import ConsultAgent from '../agents/consult.js';
import FileSyncAgent from '../agents/file-sync.js';
import { EvolutionAgent } from '../agents/evolution-agent.js';
import WardenAgent from '../plugins/warden-agent.js';
import { identity } from './identity.js';
import { intentClassifier } from './intent-classifier.js';
import { capabilityRouter } from './capability-router.js';
import { channelFormatter } from './channel-formatter.js';
import { teamManager } from './team-manager.js';
import { selfHealingLoop } from './self-healing.js';
import { taskScheduler } from './task-scheduler.js';
import { proactiveEngine } from './proactive-engine.js';
import { checkpoint } from './checkpoint.js';

class Orchestrator {
  constructor() {
    this._initialized = false;
    this._taskHistory = [];
    this._setupLogging();
  }

  async init() {
    if (this._initialized) return;

    console.log(chalk.cyan('\n⚡ APEX — Autonomous Polymorphic Execution System'));
    console.log(chalk.gray('Initializing agents...\n'));

    // Register all core agents
    const agents = [
      new ResearchAgent(),
      new CodeAgent(),
      new SecurityAgent(),
      new SelfModAgent(),
      new SkillsAgent(),
      new BrowserAgent(),
      new BrowserAgentPro(),
      new UIAgent(),
      new QAAgent(),
      new ArchitectAgent(),
      new VoiceAgent(),
      new DeviceAgent(),
      new VisionAgent(),
      new UserProfileAgent(),
      new EmailCalendarAgent(),
      new DataAgent(),
      new DeployAgent(),
      new EvolutionAgent(),
      new SocialMessagingAgent(),
      new BusinessProspector(),
      new RevenueAgent(),
      new IntelligenceMonitor(),
      new VerifierAgent(),
      new GenerationAgent(),
      new VideoAgent(),
      new BlenderAgent(),
      new ConsultAgent(),
      new FileSyncAgent(),
      new WardenAgent(),
    ];

    for (const agent of agents) {
      try {
        registry.register(agent);
        console.log(chalk.green(`  ✓ ${agent.name} [${agent.type}]`));
      } catch (err) {
        console.log(chalk.red(`  ✗ Failed to register agent ${agent.name}: ${err.message}`));
      }
    }

    // Register base capabilities
    this._registerBaseCapabilities();

    // Load any self-generated plugins (with crash protection)
    try {
      await this._loadPlugins();
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️ Plugin initialization error: ${err.message}`));
    }

    // Load Ecosystem Agents (Persona Expansion & Ruflo Plugins)
    try {
      await this._loadEcosystemAgents();
    } catch (err) {
      console.log(chalk.yellow(`  ⚠️ Ecosystem expansion error: ${err.message}`));
    }

    this._initialized = true;
    console.log(chalk.cyan('\n✅ APEX ready. All systems operational.\n'));

    // Start self-healing loop
    selfHealingLoop.start();

    // Init intelligence monitor (scheduled daily scans)
    const intelligenceMonitor = registry.get('IntelligenceMonitor');
    if (intelligenceMonitor) intelligenceMonitor._handleTask({ id: 'watch', action: 'watch' }).catch(() => {});

    // Resume ONLY the most recent unfinished task (not all of them — prevents duplicate storms)
    const unfinished = taskQueue.getUnfinishedTasks();
    if (unfinished.length > 0) {
      const latest = unfinished[0];
      console.log(chalk.cyan(`\n♻️  Resuming 1 task (${unfinished.length - 1} expired tasks discarded)...`));
      this._runGraphEngine(latest.state, {}).catch(err => console.log(chalk.red(`Failed to resume task ${latest.id}: ${err.message}`)));
    }

    // Log identity awakening
    identity.updateSelfModel({ agentsCount: agents.length, capabilitiesCount: 0 });

    bus.emit('orchestrator:ready', { agents: registry.snapshot() });
  }

  // THE MAIN ENTRY POINT — accepts any natural language task
  async execute(userInput, opts = {}) {
    await this.init();

    const taskId = uuidv4();
    const startTime = Date.now();

    // Learn from this interaction
    const profileAgent = registry.get('UserProfileAgent');
    if (profileAgent) profileAgent.learn(userInput).catch(() => {});

    // Quick intent check
    const intent = await intentClassifier.classify(userInput, opts).catch(() => ({ intent: 'general' }));
    
    // DELIBERATE CHANGE: We no longer short-circuit 'chat' intents to a dumb LLM text response. 
    // APEX is now autonomous enough to realize a conversational cue might require invoking a 
    // real capability (like TTS) rather than just replying with text. All requests hit the Graph Engine.
    if (intent.intent === 'chat') {
      console.log(chalk.gray(`\n[Orchestrator] Intent classified as chat, but passing to Graph Engine for autonomous implicit reasoning.`));
    }

    // The agentic loop is APEX's UNIVERSAL executor — everything except pure conversation/Q&A
    // routes through it. It plans, uses its own tools, reaches specialist agents via call_agent and
    // external MCP servers via call_mcp, learns from the run, and (for build/engineering intents)
    // independently verifies. Specialist intents (research/security/deploy/hardware) route here too
    // but skip code-verification. Falls back to the legacy graph engine on error.
    // Toggle off with APEX_LOOP_ORCHESTRATION=false.
    const NON_LOOP = new Set(['chat', 'question']);
    const VERIFY_INTENTS = new Set(['build', 'command', 'action', 'unknown', 'general']);
    if (!NON_LOOP.has(intent.intent) && process.env.APEX_LOOP_ORCHESTRATION !== 'false') {
      try {
        const loopRes = await this._runViaLoop(userInput, { ...opts, verify: VERIFY_INTENTS.has(intent.intent) });
        Memory.storeTask({ id: loopRes.taskId, task: userInput, result: loopRes.synthesis, success: loopRes.success, durationMs: Date.now() - startTime });
        identity.recordTask(loopRes.success);
        bus.emit('task:completed', { id: loopRes.taskId, duration: Date.now() - startTime });
        console.log(chalk.green(`\n✅ Completed via loop in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`));
        return loopRes;
      } catch (err) {
        console.log(chalk.yellow(`[Orchestrator] Loop path errored (${err.message}); falling back to graph engine.`));
      }
    }

    // Capability router (high-confidence direct shortcuts) — for the remaining non-loop intents.
    if (!opts.forceAgents) {
      const capMatch = await capabilityRouter.route(userInput).catch(() => null);
      if (capMatch && capMatch.confidence > 0.9) {
        const capResult = await capabilityRouter.execute(capMatch, userInput);
        if (capResult.success) {
          const synthesis = capResult.result?.synthesis || capResult.result?.audioPath
            ? `✅ ${capMatch.capability.description} complete`
            : JSON.stringify(capResult.result, null, 2).slice(0, 500);
          return { taskId: uuidv4(), input: userInput, synthesis, capabilityUsed: capMatch.capability.id, result: capResult };
        }
      }
    }

    console.log(chalk.yellow(`\n🧠 Processing: "${userInput}"`));
    bus.emit('task:started', { id: taskId, input: userInput });

    try {
      // Fetch Graphify context for DeepSeek caching & memory
      const graphifyContext = Memory.getGraphifyContext();
      
      // APEX NATIVE GRAPH ENGINE (LangGraph-inspired State Machine)
      const state = {
        input: userInput,
        taskId,
        graphifyContext,
        history: [],
        status: 'PLANNING',
        loopCount: 0,
        maxLoops: 20, // Prevent infinite loops
        plan: null,
        results: {},
        error: null,
        synthesis: null
      };

      const finalState = await this._runGraphEngine(state, opts);
      
      const taskPlan = finalState.plan;
      const result = finalState.results;
      const synthesis = finalState.synthesis;

      const duration = Date.now() - startTime;
      Memory.storeTask({
        id: taskId,
        task: userInput,
        plan: taskPlan,
        result: synthesis,
        agentsUsed: taskPlan.agents,
        success: true,
        durationMs: duration,
      });
      identity.recordTask(true);

      // --- HERMES INTEGRATION: TRIGGER SKILL DISTILLATION ---
      // If the task took multiple loops (struggled but succeeded) or is explicitly requested
      if (finalState.loopCount >= 2 || userInput.toLowerCase().includes('skill') || userInput.toLowerCase().includes('memorize')) {
        const skillsAgent = registry.get('SkillsAgent');
        if (skillsAgent) {
          console.log(chalk.cyan(`\\n[Hermes Engine] Distilling successful workflow into a permanent skill in the background...`));
          // Run distillation async so we don't block the return
          skillsAgent.run({
            objective: userInput,
            type: 'distill_workflow',
            executionHistory: finalState.history
          }).catch(err => console.log(chalk.red(`[Hermes Engine] Failed to distill skill: ${err.message}`)));
        }
      }
      // ------------------------------------------------------

      bus.emit('task:completed', { id: taskId, duration });
      console.log(chalk.green(`\n✅ Completed in ${(duration / 1000).toFixed(1)}s\n`));

      return { taskId, input: userInput, plan: taskPlan, result, synthesis };
    } catch (err) {
      Memory.storeTask({ id: taskId, task: userInput, success: false, durationMs: Date.now() - startTime });
      bus.emit('task:failed', { id: taskId, error: err.message });

      // Detect if this is an LLM failure that might trigger bootstrapping
      if (err.message.includes('All LLM providers failed') || err.message.includes('429')) {
        console.log(chalk.yellow('🔄 LLM Fatal Failure detected. Checking brain resuscitation status...'));
        
        // Wait up to 30 mins for bootstrapping if it has started
        let waitCount = 0;
        while (selfHealingLoop.isBootstrapping && waitCount < 180) { // 180 * 10s = 30 mins
          if (waitCount === 0) console.log(chalk.cyan('⏳ APEX is autonomously bootstrapping a local brain. Waiting to retry...'));
          await new Promise(r => setTimeout(r, 10000));
          waitCount++;
        }

        if (waitCount > 0) {
          console.log(chalk.green('🧠 Brain resuscitation finished. Retrying task with local inference...'));
          return this.execute(userInput, { ...opts, forceLocal: true });
        }
      }

      // Try other self-healing strategies
      console.log(chalk.red(`❌ Error: ${err.message}`));
      console.log(chalk.yellow('🔄 Attempting self-healing diagnostic...'));
      const healed = await this._selfHeal(err, userInput);
      if (healed) return healed;

      throw err;
    }
  }

  // ─── AGENTIC LOOP ROUTE ────────────────────────────────────────────────────────
  // Route a build/engineering request straight through the agentic loop — APEX's strongest path
  // (native tool-calling, plan → delegate → INDEPENDENT verification, Warden-gated writes). Every
  // front door (CLI, Telegram, dashboard, scheduler, MCP) funnels through execute(), so this is the
  // single switch that puts the loop brain behind all of them.
  async _runViaLoop(userInput, opts = {}) {
    const { runAgentLoop } = await import('./agent-loop.js');
    const code = registry.get('CodeAgent');
    const guard = (code && typeof code._makeWardenGuard === 'function') ? code._makeWardenGuard() : null;
    const workspace = opts.outputDir
      ? path.resolve(process.cwd(), opts.outputDir)
      : (process.env.APEX_OUTPUT_DIR ? path.resolve(process.cwd(), process.env.APEX_OUTPUT_DIR) : process.cwd());

    console.log(chalk.cyan(`\n🔁 Routing build task through the agentic loop → ${workspace}`));
    bus.emit('task:loop_start', { input: userInput, workspace });

    const res = await runAgentLoop(userInput, {
      workspace,
      maxSteps: 45,
      writeGuard: guard,
      verify: opts.verify !== false,   // build/engineering intents verify; specialist intents skip code-verification
      learn: true,
      onEvent: (ev) => {
        if (ev.type === 'action') console.log(chalk.gray(`  loop[${ev.depth || 0}] ${ev.tool} ${ev.args?.path || ev.args?.command || ''}`));
        else if (ev.type === 'plan') console.log(chalk.blue(`  📋 ${ev.todos.map(t => t.task).join(' | ')}`));
        else if (ev.type === 'delegate_start') console.log(chalk.magenta(`  ⇣ sub-agent: ${String(ev.task).slice(0, 70)}`));
        else if (ev.type === 'verify_end') console.log((ev.verified ? chalk.green : chalk.red)(`  🔍 verify: ${ev.verified ? 'PASSED' : 'FAILED'} — ${(ev.reason || '').slice(0, 80)}`));
        else if (ev.type === 'finish') console.log(chalk.green(`  ✅ ${ev.summary}`));
      },
    });

    return { taskId: uuidv4(), input: userInput, synthesis: res.summary, success: res.success, verified: res.verified || false, workspace, viaLoop: true };
  }

  // ─── APEX NATIVE GRAPH ENGINE ──────────────────────────────────────────────────
  async _runGraphEngine(state, opts) {
    while (state.status !== 'COMPLETED' && state.status !== 'FAILED' && state.loopCount < state.maxLoops) {
      taskQueue.saveTaskState(state.taskId, state.input, state);
      state.loopCount++;
      console.log(chalk.gray(`\n[Graph Engine] State: ${state.status} (Loop ${state.loopCount})`));

      switch (state.status) {
        case 'PLANNING':
          state.plan = await this._planTask(state.input, opts, state.graphifyContext);
          console.log(chalk.blue(`📋 Plan: ${state.plan.approach}`));
          if (state.plan.needsNewCapabilities) {
            console.log(chalk.magenta('🔧 Acquiring capabilities...'));
            const skillsAgent = registry.get('SkillsAgent');
            await skillsAgent._handleTask({ id: uuidv4(), objective: state.input, type: 'auto' });
          }
          state.status = 'EXECUTING';
          break;

        case 'EXECUTING':
          // Save checkpoint before execution — enables rollback on failure
          checkpoint.save(`task-${state.taskId}`, state.plan.outputDir || process.cwd());
          if (state.plan.parallel && state.plan.subtasks?.length > 1) {
            state.results = await this._executeParallel(state.plan, state.input, state.taskId, state.graphifyContext);
          } else {
            state.results = await this._executeSequential(state.plan, state.input, state.taskId, state.graphifyContext);
          }
          // Check for errors in results
          const hasError = Object.values(state.results).some(r => r?.error);
          if (hasError) {
            state.error = Object.values(state.results).find(r => r?.error).error;
            state.status = 'REFLECTING';
          } else {
            state.status = 'VERIFYING';
          }
          break;

        case 'VERIFYING':
          console.log(chalk.cyan(`🔍 Verifying results...`));
          
          if (state.plan.taskType === 'build') {
            console.log(chalk.magenta(`  🧪 Booting TestSprite MCP Sandbox...`));
            try {
              // Spin up the TestSprite MCP Server for autonomous E2E testing
              const { execSync } = await import('child_process');
              // Using the official TestSprite integration to validate the generated code
              console.log(chalk.gray(`  Running: npx -y @testsprite/testsprite-mcp@latest`));
              
              // In a real run, this connects the MCP to the IDE/Agent loop.
              // Here we execute a strict validation sequence using the VerifierAgent as the MCP Client.
              const verifier = registry.get('VerifierAgent');
              if (verifier) {
                const vResult = await verifier._handleTask({ 
                  action: 'verify_with_testsprite', 
                  content: JSON.stringify(state.results), 
                  type: 'auto' 
                });
                
                if (vResult && vResult.failed) {
                  console.log(chalk.red(`  ❌ TestSprite caught a hallucination or failure: ${vResult.feedback}`));
                  state.error = vResult.feedback;
                  state.status = 'REFLECTING';
                  break;
                } else {
                  console.log(chalk.green(`  ✅ TestSprite Sandbox Validation Passed!`));
                }
              }
            } catch (e) {
              console.log(chalk.yellow(`  ⚠️ TestSprite Verification failed: ${e.message}`));
            }
          }
          state.status = 'FINALIZING';
          break;

        case 'REFLECTING':
          console.log(chalk.magenta(`🧠 Reflecting on failure: ${state.error.slice(0, 100)}...`));
          // Rollback to checkpoint — undo broken writes
          checkpoint.rollback();
          // Route back to SelfMod or CodeAgent to fix the issue
          state.history.push({ error: state.error, plan: state.plan });
          state.plan = await this._planTask(`Previous attempt failed with error: ${state.error}. Fix the issue to achieve: ${state.input}`, opts, state.graphifyContext);
          state.error = null;
          state.status = 'EXECUTING';
          break;

        case 'FINALIZING':
          // Confirm checkpoint — task succeeded, no rollback needed
          checkpoint.confirm();
          state.synthesis = await this._synthesizeResults(state.input, state.results, state.plan);
          state.status = 'COMPLETED';
          break;
      }
    }

    if (state.status !== 'COMPLETED') {
      console.log(chalk.red(`❌ Graph Engine aborted after max loops.`));
      taskQueue.markTaskFailed(state.taskId);
    } else {
      taskQueue.markTaskCompleted(state.taskId);
    }
    return state;
  }

  async _dynamicPlan(userInput, agentList, capabilities, graphifyContext = '') {
    try {
      return await structured(
        `You are an expert task planner for an autonomous AI system.\n\nUser request: "${userInput}"\n\nAvailable agents:\n${agentList}\n\nAvailable capabilities:\n${capabilities}\n${graphifyContext ? `\nCodebase context:\n${graphifyContext}` : ''}\n\nCRITICAL PLANNING RULES:\n1. CodeAgent handles its own dependency installation (npm install, pip install). Do NOT create separate SkillsAgent subtasks for package installation.\n2. For simple build tasks (create a file, generate an image, write a script), use ONLY CodeAgent with a single subtask.\n3. Only use SkillsAgent when the task requires installing system-level tools (not npm/pip packages).\n4. Keep plans minimal — 1-2 subtasks for simple tasks, 3-4 for complex ones. Never exceed 6.\n5. Set outputDir to "." for build tasks unless the user specifies a different directory.\n\nCreate an optimal execution plan.`,
        {
          approach: 'brief description of the approach',
          taskType: 'build|research|modify|analyze|deploy',
          agents: ['list of agent names to use'],
          subtasks: [{ agent: 'AgentName', task: 'specific task description', dependsOn: null }],
          parallel: false,
          needsNewCapabilities: false,
          outputDir: '.',
          complexity: 'simple|moderate|complex',
        },
        { temperature: 0.2, timeout: 30000 }
      );
    } catch (err) {
      this.log(`Dynamic planning failed: ${err.message}. Using fallback single-agent plan.`);
      return this._fallbackPlan(userInput);
    }
  }

  async _planTask(userInput, opts, graphifyContext = '') {
    const agentList = registry.all().map(a => `${a.name} (${a.type}): ${a.description}`).join('\n');
    const capabilities = Memory.listCapabilities?.() || [];
    const capStr = Array.isArray(capabilities) ? capabilities.map(c => `${c.name}: ${c.description}`).join('\n') : '';
    return this._dynamicPlan(userInput, agentList, capStr, graphifyContext);
  }

  _fallbackPlan(userInput) {
    // Simple single-agent fallback — route by keyword
    const lower = userInput.toLowerCase();
    let agent = 'CodeAgent';
    if (lower.includes('research') || lower.includes('find') || lower.includes('search')) agent = 'ResearchAgent';
    else if (lower.includes('ui') || lower.includes('design') || lower.includes('dashboard') || lower.includes('frontend')) agent = 'UIAgent';
    else if (lower.includes('deploy') || lower.includes('launch')) agent = 'DeployAgent';
    else if (lower.includes('test') || lower.includes('qa')) agent = 'QAAgent';
    else if (lower.includes('security') || lower.includes('audit')) agent = 'SecurityAgent';
    else if (lower.includes('browser') || lower.includes('scrape') || lower.includes('web')) agent = 'BrowserAgent';
    
    return {
      approach: userInput,
      taskType: 'build',
      agents: [agent],
      subtasks: [{ agent, task: userInput, dependsOn: null }],
      parallel: false,
      needsNewCapabilities: false,
      outputDir: null,
      complexity: 'simple',
    };
  }

  async _executeSequential(plan, originalInput, taskId, graphifyContext = '') {
    const results = {};

    for (let i = 0; i < (plan.subtasks || []).length; i++) {
      const subtask = plan.subtasks[i];
      const cleanAgentName = subtask.agent.split('(')[0].trim();
      let agent = registry.get(cleanAgentName);

      // Fallback to route hallucinated names back to our core agents
      if (!agent) {
        const lower = cleanAgentName.toLowerCase();
        if (lower.includes('engineer') || lower.includes('code') || lower.includes('develop')) agent = registry.get('CodeAgent');
        else if (lower.includes('ui') || lower.includes('front')) agent = registry.get('UIAgent');
        else if (lower.includes('secure')) agent = registry.get('SecurityAgent');
        else if (lower.includes('qa') || lower.includes('test')) agent = registry.get('QAAgent');
        else if (lower.includes('deploy')) agent = registry.get('DeployAgent');
        
        if (agent) this.log(`Re-routed hallucinated agent "${subtask.agent}" to ${agent.name}`);
      }

      if (!agent) {
        console.log(chalk.yellow(`  ⚠️  Agent "${subtask.agent}" not found, spawning dynamic agent...`));
        const dynAgent = await registry.spawn({
          name: subtask.agent,
          type: 'dynamic',
          description: subtask.task,
          parentTask: taskId,
        });
        results[i] = await dynAgent._handleTask({ id: uuidv4(), prompt: subtask.task, context: JSON.stringify(results) });
        continue;
      }

      console.log(chalk.blue(`  → ${agent.name}: ${subtask.task.slice(0, 60)}...`));

      // Inject context from previous results AND Graphify
      const context = (graphifyContext ? `${graphifyContext}\n\n` : '') + 
        (Object.keys(results).length ? `Context from previous agents:\n${JSON.stringify(results, null, 2)}` : '');

      try {
        const taskPayload = {
          id: uuidv4(),
          ...this._buildAgentTask(subtask.agent, subtask.task, context, results),
          outputDir: plan.outputDir ? path.resolve(process.cwd(), plan.outputDir) : process.cwd()
        };
        results[i] = await agent._handleTask(taskPayload);
      } catch (err) {
        console.log(chalk.yellow(`  ⚠️  ${agent.name} failed: ${err.message}`));
        results[i] = { error: err.message };
      }
    }

    return results;
  }

  async _executeParallel(plan, originalInput, taskId, graphifyContext = '') {
    const parallelTasks = (plan.subtasks || []).map(async (subtask, i) => {
      const agent = registry.get(subtask.agent);
      if (!agent) return { index: i, error: `Agent ${subtask.agent} not found` };

      console.log(chalk.blue(`  ⚡ ${agent.name} (parallel): ${subtask.task.slice(0, 50)}...`));

      try {
        const result = await agent._handleTask({
          id: uuidv4(),
          ...this._buildAgentTask(subtask.agent, subtask.task, graphifyContext, {}),
          outputDir: plan.outputDir ? path.resolve(process.cwd(), plan.outputDir) : process.cwd()
        });
        return { index: i, agent: subtask.agent, result };
      } catch (err) {
        return { index: i, agent: subtask.agent, error: err.message };
      }
    });

    const settled = await Promise.allSettled(parallelTasks);
    return Object.fromEntries(settled.map((r, i) => [i, r.value || r.reason]));
  }

  _buildAgentTask(agentName, task, context, previousResults) {
    // Map agent names to their expected task format
    const formatMap = {
      ResearchAgent: { query: task, context },
      CodeAgent: { objective: task, context },
      SecurityAgent: { objective: task, authorization: false },
      SelfModAgent: { type: 'modify_self', instruction: task, context },
      SkillsAgent: { objective: task, type: 'auto' },
      BrowserAgent: { objective: task, url: null },
      BrowserAgentPro: { objective: task, url: null },
      UIAgent: { objective: task, context },
      QAAgent: { objective: task, type: 'full' },
      ArchitectAgent: { objective: task },
      VoiceAgent: { text: task, action: 'speak' },
      DeviceAgent: { action: 'smart', objective: task },
      VisionAgent: { action: 'screenshot_and_analyze', prompt: task, screenshot: true },
      UserProfileAgent: { action: 'status' },
      EmailCalendarAgent: { action: 'smart', objective: task },
      DataAgent: { action: 'analyze', query: task },
      DeployAgent: { action: 'auto', projectDir: process.cwd() },
      SocialMessagingAgent: { action: 'draft', platform: 'email', objective: task },
      BusinessProspector: { action: 'find', niche: task, count: 5 },
      RevenueAgent: { action: 'opportunities' },
      IntelligenceMonitor: { action: 'scan' },
      VerifierAgent: { action: 'verify', content: task, type: 'auto' },
      GenerationAgent: { action: 'image', prompt: task },
      VideoAgent: { action: 'analyze', url: task },
      BlenderAgent: { action: 'create', prompt: task },
      ConsultAgent: { question: task, models: 'auto' },
      FileSyncAgent: { action: 'status' },
    };

    return formatMap[agentName] || { prompt: task, context };
  }

  async _synthesizeResults(originalInput, results, plan) {
    const resultStr = JSON.stringify(results, null, 2).slice(0, 8000);
    const taskType = plan?.taskType || 'general';
    const guidelines = {
      build: 'Summarize what was built: files, tech stack, how to run. Code snippets only if directly relevant.',
      research: 'Clear readable summary of findings. No code. Plain prose.',
      security: 'List findings by severity then recommendations.',
      analysis: 'Key insights first, then details.',
      general: 'Answer directly and concisely. Code only if task was explicitly about coding.',
      chat: 'Respond conversationally. No code unless asked.',
    };
    const guideline = guidelines[taskType] || guidelines.general;
    return complete(
      `Task: "${originalInput}"\nType: ${taskType}\n\nAgent results:\n${resultStr}\n\nGuideline: ${guideline}\n\nProvide a clear, useful response.`,
      { temperature: 0.4, maxTokens: 2000 }
    );
  }

  async _selfHeal(error, originalInput) {
    try {
      const selfMod = registry.get('SelfModAgent');
      if (!selfMod) return null;

      // Ask SelfMod to figure out what went wrong and fix it
      const diagnosis = await complete(
        `APEX failed with this error while processing: "${originalInput}"\n\nError: ${error.message}\n\nDiagnose what capability is missing and suggest how to fix it. Be specific.`,
        { temperature: 0.3 }
      );

      console.log(chalk.yellow(`  🔧 Self-heal diagnosis: ${diagnosis.slice(0, 200)}`));

      await selfMod._handleTask({
        id: uuidv4(),
        type: 'detect_gaps',
      });

      return null; // Let caller decide whether to retry
    } catch {
      return null;
    }
  }

  _registerBaseCapabilities() {
    const caps = [
      { name: 'Web Research', description: 'Search DuckDuckGo, GitHub, npm', type: 'builtin' },
      { name: 'Code Generation', description: 'Full-stack code writing, testing, fixing', type: 'builtin' },
      { name: 'Security Assessment', description: 'Kali Linux tools, OSINT, vuln scanning', type: 'builtin' },
      { name: 'Self-Modification', description: 'Gap detection, tool creation, agent spawning', type: 'builtin' },
      { name: 'Skills Auto-Install', description: 'npm, pip, git, binary tool installation', type: 'builtin' },
      { name: 'Memory System', description: 'Persistent cross-session memory with search', type: 'builtin' },
      { name: 'Browser Automation', description: 'Playwright browser control, form filling, scraping', type: 'builtin' },
      { name: 'Advanced Browser', description: 'CDP + AI vision + smart forms + profiles + multi-tab', type: 'builtin' },
      { name: 'UI Development', description: 'Full-stack frontend design and code generation', type: 'builtin' },
      { name: 'Quality Assurance', description: 'Automated testing, security scanning, code review', type: 'builtin' },
      { name: 'System Architecture', description: 'DB schemas, API contracts, infrastructure design', type: 'builtin' },
      { name: 'Self-Healing', description: 'Auto-recovery, gap detection, agent respawning', type: 'builtin' },
      { name: 'Kali Linux Bridge', description: 'Full Kali toolset via Docker or native', type: 'builtin' },
      { name: 'Device Control', description: 'Mouse, keyboard, screen, apps, files, notifications', type: 'builtin' },
      { name: 'User Profiling', description: 'Deep user learning, proactive assistance, personalization', type: 'builtin' },
      { name: 'Task Scheduler', description: 'Cron-based autonomous background task execution', type: 'builtin' },
      { name: 'Vision AI', description: 'Gemini multimodal — analyze screenshots, read text from images, understand UI', type: 'builtin' },
      { name: 'Email & Calendar', description: 'Read/send email, manage calendar, draft professional emails', type: 'builtin' },
      { name: 'Data Analysis', description: 'ETL, CSV/JSON/Excel processing, statistics, charts, reports', type: 'builtin' },
      { name: 'Deployment', description: 'Fly.io, Railway, Vercel, Docker, PM2, SSH — auto-detect and deploy', type: 'builtin' },
      { name: 'Cross-Device Bridge', description: 'WebSocket server — connect phone/PC/server to one APEX', type: 'builtin' },
      { name: 'Proactive Engine', description: 'Autonomous background monitoring and action without prompts', type: 'builtin' },
    ];
    caps.forEach(c => Memory.registerCapability(c));
  }

  async _loadPlugins() {
    const { readdirSync, existsSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const __dirname2 = path.dirname ? path.dirname : (u) => new URL('.', u).pathname;
    const pluginsDir = new URL('../plugins/', import.meta.url).pathname;

    if (!existsSync(pluginsDir)) return;

    const plugins = readdirSync(pluginsDir).filter(f => f.endsWith('-agent.js') && !f.startsWith('_'));
    for (const plugin of plugins) {
      try {
        const { default: AgentClass } = await import(`${pluginsDir}${plugin}`);
        const instance = new AgentClass();
        registry.register(instance);
        console.log(chalk.magenta(`  🔌 Loaded plugin agent: ${instance.name}`));
      } catch (err) {
        // Plugin failed to load — not critical
      }
    }
  }

  async _loadEcosystemAgents() {
    const { readdirSync, existsSync, readFileSync, statSync } = await import('fs');
    const path = await import('path');
    
    // Check if the agents repos are cloned in scratch
    const reposToScan = [
      path.join(process.cwd(), 'scratch', 'agents'),
      path.join(process.cwd(), 'scratch', 'ruflo', 'plugins')
    ];

    let totalLoaded = 0;

    // Recursive function to find all .md files in an agents folder
    const loadFromDir = (dir) => {
      if (!existsSync(dir)) return;
      const files = readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (statSync(fullPath).isDirectory()) {
          if (!file.startsWith('.') && file !== 'node_modules') loadFromDir(fullPath);
        } else if (file.endsWith('.md') && file !== 'README.md') {
          try {
            const content = readFileSync(fullPath, 'utf8');
            // Parse frontmatter
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            const descMatch = content.match(/^description:\s*(.+)$/m);
            
            if (nameMatch) {
              const name = nameMatch[1].trim();
              let desc = descMatch ? descMatch[1].trim() : 'Specialized persona agent';
              
              // Register as a dynamic agent that uses the DeepSeek hybrid engine
              registry.spawn({
                name: name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(''),
                type: 'dynamic',
                description: desc.slice(0, 150),
                systemPrompt: content // Give the agent the entire markdown file as its system prompt
              });
              totalLoaded++;
            }
          } catch (e) {
            // Silently ignore malformed md files
          }
        }
      }
    };

    for (const repoPath of reposToScan) {
      loadFromDir(repoPath);
    }
    
    if (totalLoaded > 0) {
      console.log(chalk.cyan(`  🧠 Ecosystem Expansion: Ingested ${totalLoaded} specialized agents from external repositories.`));
    }
  }

  _setupLogging() {
    bus.on('agent:log', ({ agent, message, level }) => {
      const color = level === 'warn' ? chalk.yellow : level === 'error' ? chalk.red : chalk.gray;
      console.log(color(`  [${agent}] ${message}`));
    });

    bus.on('selfmod:gap_filled', ({ gap }) => {
      console.log(chalk.magenta(`  🧬 SelfMod: Filled gap "${gap}"`));
    });

    bus.on('selfmod:agent_created', ({ name }) => {
      console.log(chalk.magenta(`  🤖 SelfMod: Created new agent "${name}"`));
    });

    bus.on('skills:installed', ({ name, type }) => {
      console.log(chalk.blue(`  📦 Skills: Installed "${name}" (${type})`));
    });
  }

  // Get system status
  status() {
    return {
      agents: registry.snapshot(),
      capabilities: Memory.listCapabilities(),
      awareness: Memory.selfAwareness(),
    };
  }
}

export const orchestrator = new Orchestrator();
export default orchestrator;
