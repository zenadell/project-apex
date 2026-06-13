// core/team-manager.js
// APEX TeamManager — Creates and coordinates super-teams of specialized agents.
// Different teams for different companies, goals, and contexts.

import { complete, structured } from './llm.js';
import registry from './agent-registry.js';
import bus from './event-bus.js';
import Memory from './memory.js';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.apex-data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ─── BUILT-IN TEAM DEFINITIONS ────────────────────────────────────────────────
const BUILTIN_TEAMS = {
  dev_team: {
    name: 'Jomiez Dev Team',
    emoji: '💻',
    description: 'Full-stack software development. Builds products from idea to deployment.',
    company: 'Jomiez Innovation',
    agents: ['ArchitectAgent', 'ResearchAgent', 'CodeAgent', 'UIAgent', 'QAAgent', 'DeployAgent'],
    lead: 'ArchitectAgent',
    workflow: 'sequential',
    systemPrompt: 'You are the Jomiez Dev Team. Your mission: build excellent software products fast. Prefer clean architecture, test coverage, and smooth deployments.',
    strengths: ['Full-stack development', 'Architecture design', 'Automated testing', 'Deployment'],
  },

  marketing_team: {
    name: 'Jomiez Growth Team',
    emoji: '📈',
    description: 'Client acquisition, outreach, and market research for Jomiez Innovation.',
    company: 'Jomiez Innovation',
    agents: ['ResearchAgent', 'BusinessProspector', 'SocialMessagingAgent', 'EmailCalendarAgent', 'DataAgent'],
    lead: 'BusinessProspector',
    workflow: 'parallel',
    systemPrompt: 'You are the Jomiez Growth Team. Find, qualify, and close international clients (US, UK, Canada, Australia, UAE). Never target Nigerian clients.',
    strengths: ['Lead generation', 'Outreach', 'Market research', 'Client communications'],
  },

  security_team: {
    name: 'Red Team / Security',
    emoji: '🛡️',
    description: 'Security assessment, penetration testing, and defensive hardening.',
    company: 'Jomiez Innovation',
    agents: ['SecurityAgent', 'ResearchAgent', 'BrowserAgentPro'],
    lead: 'SecurityAgent',
    workflow: 'sequential',
    systemPrompt: 'You are the APEX Red Team. Conduct thorough security assessments on authorized targets only. Document all findings clearly.',
    strengths: ['Penetration testing', 'OSINT', 'Vulnerability assessment', 'Security hardening'],
    requiresAdmin: true,
  },

  design_team: {
    name: 'Jomiez Design Studio',
    emoji: '🎨',
    description: 'UI/UX design, brand identity, website creation, and visual assets.',
    company: 'Jomiez Innovation',
    agents: ['UIAgent', 'VisionAgent', 'ResearchAgent', 'BrowserAgentPro'],
    lead: 'UIAgent',
    workflow: 'sequential',
    systemPrompt: 'You are the Jomiez Design Studio. Create stunning, modern designs that rival Framer and Figma-quality work. Always produce production-ready code.',
    strengths: ['UI/UX design', 'Animation', 'Brand identity', 'Website cloning'],
  },

  revenue_team: {
    name: 'Money Team',
    emoji: '💰',
    description: 'Revenue generation, client pipeline, invoicing, and payment collection.',
    company: 'Jomiez Innovation',
    agents: ['RevenueAgent', 'BusinessProspector', 'SocialMessagingAgent', 'EmailCalendarAgent'],
    lead: 'RevenueAgent',
    workflow: 'sequential',
    systemPrompt: 'You are the APEX Money Team. Your only job is to make money for Temple. Find clients, propose, invoice, and collect. Be persistent and professional.',
    strengths: ['Sales pipeline', 'Invoicing', 'Client follow-up', 'Revenue tracking'],
  },

  research_team: {
    name: 'Intelligence Division',
    emoji: '🔍',
    description: 'Deep research, market intelligence, competitive analysis.',
    company: 'Jomiez Innovation',
    agents: ['ResearchAgent', 'DataAgent', 'BrowserAgentPro', 'VisionAgent'],
    lead: 'ResearchAgent',
    workflow: 'parallel',
    systemPrompt: 'You are the APEX Intelligence Division. Gather comprehensive, accurate intelligence on any topic. Verify from multiple sources before reporting.',
    strengths: ['Market research', 'Competitive intelligence', 'Data analysis', 'OSINT'],
  },

  content_team: {
    name: 'Content & Media',
    emoji: '✍️',
    description: 'Write content, generate media, create marketing materials.',
    company: 'Jomiez Innovation',
    agents: ['ResearchAgent', 'UIAgent', 'VoiceAgent'],
    lead: 'ResearchAgent',
    workflow: 'sequential',
    systemPrompt: 'You are the APEX Content Team. Create compelling, high-quality content that converts. Write for international tech-savvy business audiences.',
    strengths: ['Copywriting', 'Technical writing', 'Content strategy'],
  },

  automation_team: {
    name: 'Automation Squad',
    emoji: '⚡',
    description: 'Build automation systems, bots, and workflows for clients.',
    company: 'Jomiez Innovation',
    agents: ['CodeAgent', 'BrowserAgentPro', 'DeviceAgent', 'SocialMessagingAgent', 'EmailCalendarAgent'],
    lead: 'CodeAgent',
    workflow: 'sequential',
    systemPrompt: 'You are the APEX Automation Squad. Build powerful, reliable automation systems. Prefer robust solutions over clever ones.',
    strengths: ['Workflow automation', 'Bot development', 'API integration', 'Scheduling'],
  },
};

class TeamManager {
  constructor() {
    this._teams = { ...BUILTIN_TEAMS };
    this._activeTeams = new Map(); // teamId -> { team, task, startedAt }
    this._loadCustomTeams();
  }

  // ── GET TEAM ──────────────────────────────────────────────────────────────
  getTeam(teamId) {
    return this._teams[teamId];
  }

  listTeams() {
    return Object.entries(this._teams).map(([id, team]) => ({
      id, ...team,
      agentCount: team.agents.length,
      available: team.agents.every(a => registry.get(a)?.status !== 'working'),
    }));
  }

  // ── RUN A TASK WITH A TEAM ────────────────────────────────────────────────
  async run(teamId, task, opts = {}) {
    const team = this._teams[teamId];
    if (!team) throw new Error(`Team "${teamId}" not found`);

    // Admin check for restricted teams
    if (team.requiresAdmin) {
      const { adminGate } = await import('./admin-gate.js');
      if (!adminGate.isUnlocked()) {
        throw new Error(`Team "${team.name}" requires admin authentication`);
      }
    }

    const sessionId = uuidv4();
    this._activeTeams.set(sessionId, { team: teamId, task, startedAt: Date.now() });
    bus.emit('team:started', { sessionId, team: team.name, task: task.slice?.(0, 60) });

    console.log(`\n${team.emoji} ${team.name} activated\n`);

    try {
      let result;
      if (team.workflow === 'parallel') {
        result = await this._runParallel(team, task, opts);
      } else if (team.workflow === 'mesh') {
        result = await this._runMesh(team, task, opts);
      } else {
        result = await this._runSequential(team, task, opts);
      }

      const synthesis = await this._synthesize(team, task, result);

      this._activeTeams.delete(sessionId);
      bus.emit('team:completed', { sessionId, team: team.name });

      Memory.store({
        scope: 'long_term', agent: `Team:${team.name}`,
        content: `Team task: ${task?.slice?.(0, 100)} | Result: ${synthesis?.slice?.(0, 100)}`,
        tags: ['team', teamId], importance: 7,
      });

      return { sessionId, team: team.name, task, result, synthesis };
    } catch (err) {
      this._activeTeams.delete(sessionId);
      bus.emit('team:failed', { sessionId, team: team.name, error: err.message });
      throw err;
    }
  }

  // ── SEQUENTIAL WORKFLOW ───────────────────────────────────────────────────
  async _runSequential(team, task, opts) {
    const results = {};
    let context = `Team: ${team.name}\nTeam system: ${team.systemPrompt}\nTask: ${task}`;

    for (const agentName of team.agents) {
      const agent = registry.get(agentName);
      if (!agent) { console.log(`  ⚠️  ${agentName} not registered — skipping`); continue; }
      if (agent.status === 'working') { console.log(`  ⚠️  ${agentName} busy — skipping`); continue; }

      console.log(`  → ${agentName}`);
      try {
        const agentTask = this._buildAgentTask(agentName, task, context, results);
        results[agentName] = await agent._handleTask({ id: uuidv4(), ...agentTask });

        // Update context with this agent's output
        const output = JSON.stringify(results[agentName]).slice(0, 500);
        context += `\n\n${agentName} output:\n${output}`;
      } catch (err) {
        results[agentName] = { error: err.message };
        console.log(`  ⚠️  ${agentName} failed: ${err.message}`);
      }
    }
    return results;
  }

  // ── PARALLEL WORKFLOW ─────────────────────────────────────────────────────
  async _runParallel(team, task, opts) {
    const context = `Team: ${team.name}\nTask: ${task}`;
    const promises = team.agents.map(async agentName => {
      const agent = registry.get(agentName);
      if (!agent) return [agentName, { skipped: true }];
      try {
        const agentTask = this._buildAgentTask(agentName, task, context, {});
        const result = await agent._handleTask({ id: uuidv4(), ...agentTask });
        return [agentName, result];
      } catch (err) {
        return [agentName, { error: err.message }];
      }
    });
    const settled = await Promise.allSettled(promises);
    return Object.fromEntries(settled.map(r => r.value || ['error', r.reason]));
  }

  // ── MESH WORKFLOW (agents can re-consult each other) ──────────────────────
  async _runMesh(team, task, opts) {
    // Lead agent orchestrates others
    const lead = registry.get(team.lead) || registry.get(team.agents[0]);
    if (!lead) return this._runSequential(team, task, opts);

    const meshPlan = await structured(
      `You are ${team.lead}, leading the ${team.name} team.\nTask: ${task}\nYour team: ${team.agents.join(', ')}\nSystem: ${team.systemPrompt}\n\nPlan how to coordinate your team to best accomplish this task.`,
      {
        steps: [{ agent: 'agent name', subtask: 'what to tell this agent', waitFor: 'agent to wait for first or null' }],
        approach: 'overall strategy',
      }
    );

    const results = {};
    for (const step of meshPlan.steps || []) {
      const agent = registry.get(step.agent);
      if (!agent) continue;
      try {
        const agentTask = this._buildAgentTask(step.agent, step.subtask, JSON.stringify(results).slice(0, 1000), results);
        results[step.agent] = await agent._handleTask({ id: uuidv4(), ...agentTask });
      } catch (err) {
        results[step.agent] = { error: err.message };
      }
    }
    return results;
  }

  _buildAgentTask(agentName, task, context, previousResults) {
    const map = {
      ResearchAgent: { query: task, context },
      CodeAgent: { objective: task, context },
      UIAgent: { objective: task, context },
      ArchitectAgent: { objective: task },
      SecurityAgent: { objective: task, authorization: false },
      BrowserAgentPro: { objective: task },
      QAAgent: { objective: task },
      DeployAgent: { action: 'auto' },
      RevenueAgent: { action: 'opportunities' },
      BusinessProspector: { action: 'find', niche: task },
      SocialMessagingAgent: { action: 'draft', objective: task },
      EmailCalendarAgent: { action: 'smart', objective: task },
      DataAgent: { action: 'analyze', query: task },
      VisionAgent: { action: 'screenshot_and_analyze', prompt: task, screenshot: true },
    };
    return map[agentName] || { prompt: task, context };
  }

  async _synthesize(team, task, results) {
    const resultStr = JSON.stringify(results, null, 2).slice(0, 6000);
    return complete(
      `The ${team.name} completed: "${task}"\n\nResults:\n${resultStr}\n\nProvide a clear, comprehensive summary of everything accomplished. Be specific about outputs, files created, URLs, and next actions.`,
      { temperature: 0.3, maxTokens: 1500 }
    );
  }

  // ── CREATE CUSTOM TEAM ────────────────────────────────────────────────────
  createTeam({ id, name, emoji = '🤖', description, agents, lead, workflow = 'sequential', systemPrompt, company = 'Jomiez Innovation' }) {
    if (this._teams[id]) throw new Error(`Team "${id}" already exists`);
    const team = { name, emoji, description, agents, lead: lead || agents[0], workflow, systemPrompt: systemPrompt || description, company };
    this._teams[id] = team;
    this._saveCustomTeams();
    bus.emit('team:created', { id, name });
    return team;
  }

  deleteTeam(id) {
    if (BUILTIN_TEAMS[id]) throw new Error('Cannot delete built-in teams');
    delete this._teams[id];
    this._saveCustomTeams();
  }

  // ── AUTO-ASSEMBLE TEAM FOR TASK ────────────────────────────────────────────
  async autoAssemble(task) {
    const agents = registry.all().map(a => `${a.name}: ${a.description}`).join('\n');
    const plan = await structured(
      `Assemble the best team for this task: "${task}"\nAvailable agents:\n${agents}\n\nPick 2-5 agents and define the workflow.`,
      {
        teamName: 'descriptive team name',
        agents: ['ordered list of agent names'],
        workflow: 'sequential or parallel',
        reason: 'why this team composition',
      }
    );

    const tempTeamId = `auto_${uuidv4().slice(0, 8)}`;
    this.createTeam({
      id: tempTeamId,
      name: plan.teamName,
      description: plan.reason,
      agents: plan.agents,
      workflow: plan.workflow,
    });

    return { teamId: tempTeamId, ...plan };
  }

  _loadCustomTeams() {
    const p = path.join(DATA_DIR, 'custom-teams.json');
    if (existsSync(p)) {
      try {
        const custom = JSON.parse(readFileSync(p, 'utf8'));
        Object.assign(this._teams, custom);
      } catch {}
    }
  }

  _saveCustomTeams() {
    const custom = {};
    for (const [id, team] of Object.entries(this._teams)) {
      if (!BUILTIN_TEAMS[id]) custom[id] = team;
    }
    writeFileSync(path.join(DATA_DIR, 'custom-teams.json'), JSON.stringify(custom, null, 2));
  }
}

export const teamManager = new TeamManager();
export default teamManager;
