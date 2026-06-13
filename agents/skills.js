// agents/skills.js
// APEX SkillsAgent — Autonomously finds, downloads, installs, and wraps external tools
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { execSync, exec } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { promisify } from 'util';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import Memory from '../core/memory.js';
import bus from '../core/event-bus.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.join(__dirname, '..', 'skills');
if (!existsSync(SKILLS_DIR)) mkdirSync(SKILLS_DIR, { recursive: true });

export class SkillsAgent extends BaseAgent {
  constructor() {
    super({
      name: 'SkillsAgent',
      type: 'skills',
      description: 'Autonomously discovers, downloads, installs, and wraps external tools. Also acts as a Hermes Distillation Engine, converting successful APEX workflows into hardened, reusable internal skills.',
    });
    this._installedSkills = this._loadInstalledSkills();
  }

  async run(task) {
    const { objective, type = 'auto' } = task;

    if (type === 'find') return this.findSkill(objective);
    if (type === 'install') return this.installSkill(task);
    if (type === 'list') return this.listSkills();
    if (type === 'distill_workflow') return this.distillSkill(task.objective, task.executionHistory);
    if (type === 'auto') return this.autoProvision(objective);

    return this.autoProvision(objective);
  }

  // Auto-provision: figure out what's needed and install it
  async autoProvision(objective) {
    this.log(`Auto-provisioning skills for: "${objective}"`);

    const needed = await this._identifyNeededSkills(objective);
    const results = [];

    for (const skill of needed.skills || []) {
      try {
        const result = await this._installSkillByType(skill);
        results.push({ skill: skill.name, success: true, result });
        bus.emit('skills:installed', { name: skill.name, type: skill.type });
      } catch (err) {
        this.log(`Failed to install ${skill.name}: ${err.message}`, 'warn');
        results.push({ skill: skill.name, success: false, error: err.message });
      }
    }

    return { objective, needed, results };
  }

  async _identifyNeededSkills(objective) {
    const currentCaps = Memory.listCapabilities().map(c => c.name);
    return structured(
      `You are identifying what tools/skills APEX needs for: "${objective}"\nCurrently installed: ${currentCaps.join(', ')}\n\nIdentify missing skills needed. Prefer free, open-source tools.`,
      {
        skills: [
          {
            name: 'skill name',
            type: 'npm/pip/git/binary',
            source: 'npm package name OR github url OR binary name',
            description: 'what it does',
            priority: 'critical/high/medium',
          }
        ],
        analysis: 'why these skills are needed',
      }
    );
  }

  async _installSkillByType(skill) {
    switch (skill.type) {
      case 'npm': return this.installNpmSkill(skill);
      case 'pip': return this.installPipSkill(skill);
      case 'git': return this.installGitSkill(skill);
      case 'binary': return this.installBinarySkill(skill);
      case 'mcp': return this.installMcpSkill(skill);
      default: return this.installNpmSkill(skill);
    }
  }

  // Install MCP (Model Context Protocol) using Hermes engine
  async installMcpSkill({ name, source, description }) {
    this.log(`Installing MCP skill via ApexForge (Hermes): ${source || name}`);
    
    // Use Hermes to install the MCP tool globally
    const hermesCmd = `npx hermes mcp install ${source || name}`;
    await execAsync(hermesCmd, { timeout: 60000 });
    
    this._registerSkill({ name, type: 'mcp', source, path: 'mcp-internal', description });
    Memory.registerCapability({ name, description, type: 'mcp' });
    
    return { name, type: 'mcp', installed: true };
  }

  // Install npm package as a skill
  async installNpmSkill({ name, source, description }) {
    const pkgName = source || name;
    const skillDir = path.join(SKILLS_DIR, pkgName.replace(/[^a-z0-9-]/gi, '_'));

    this.log(`Installing npm skill: ${pkgName}`);
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });

    await execAsync(`npm install ${pkgName} --prefix ${skillDir}`, { timeout: 60000 });

    // Generate a wrapper
    const wrapper = await this._generateWrapper(name, pkgName, description, 'npm');
    const wrapperPath = path.join(skillDir, 'apex-wrapper.js');
    writeFileSync(wrapperPath, wrapper);

    this._registerSkill({ name, type: 'npm', source: pkgName, path: wrapperPath, description });
    Memory.registerCapability({ name, description, type: 'skill', path: wrapperPath });

    return { name, path: wrapperPath, type: 'npm' };
  }

  // Install pip package as a skill
  async installPipSkill({ name, source, description }) {
    const pkgName = source || name;
    this.log(`Installing pip skill: ${pkgName}`);
    await execAsync(`pip3 install ${pkgName} --quiet`, { timeout: 60000 });

    const skillDir = path.join(SKILLS_DIR, `pip_${pkgName.replace(/[^a-z0-9-]/gi, '_')}`);
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });

    // Generate Python runner + Node bridge
    const bridge = await this._generatePythonBridge(name, pkgName, description);
    const bridgePath = path.join(skillDir, 'bridge.py');
    writeFileSync(bridgePath, bridge);

    this._registerSkill({ name, type: 'pip', source: pkgName, path: bridgePath, description });
    Memory.registerCapability({ name, description, type: 'skill', path: bridgePath });

    return { name, path: bridgePath, type: 'pip' };
  }

  // Clone, Graphify, and install a GitHub repo as a skill
  async installGitSkill({ name, source, description }) {
    const skillDir = path.join(SKILLS_DIR, name.replace(/\s+/g, '-').toLowerCase());

    this.log(`Cloning git skill: ${source}`);
    const command = `git clone --depth 1 ${source} "${skillDir}"`;
    await execAsync(command, { timeout: 60000 });

    // Detect type and install deps
    if (existsSync(path.join(skillDir, 'package.json'))) {
      await execAsync('npm install', { cwd: skillDir, timeout: 90000 });
    } else if (existsSync(path.join(skillDir, 'requirements.txt'))) {
      await execAsync(`pip3 install -r requirements.txt`, { cwd: skillDir, timeout: 60000 });
    }

    // Run Graphify to map the entire repository
    this.log(`Mapping external repository architecture using Graphify...`);
    try {
      await execAsync(`graphify . --no-viz`, { cwd: skillDir, timeout: 120000 });
    } catch (err) {
      this.log(`Graphify mapping failed, falling back to basic extraction: ${err.message}`, 'warn');
    }

    let graphifyContext = '';
    const reportPath = path.join(skillDir, 'graphify-out', 'GRAPH_REPORT.md');
    if (existsSync(reportPath)) {
      graphifyContext = readFileSync(reportPath, 'utf8');
    } else {
      const readmePath = path.join(skillDir, 'README.md');
      if (existsSync(readmePath)) graphifyContext = readFileSync(readmePath, 'utf8').slice(0, 4000);
    }

    const wrapper = await this._generateGitWrapper(name, skillDir, description, graphifyContext);
    const wrapperPath = path.join(skillDir, 'apex-wrapper.js');
    writeFileSync(wrapperPath, wrapper);

    this._registerSkill({ name, type: 'git', source, path: wrapperPath, description });
    Memory.registerCapability({ name, description, type: 'skill', path: wrapperPath });

    return { name, path: wrapperPath, type: 'git' };
  }

  // Install a system binary skill
  async installBinarySkill({ name, source, description }) {
    this.log(`Installing binary skill: ${source || name}`);

    // Try apt-get, brew, or pip
    let installed = false;
    for (const cmd of [
      `apt-get install -y ${source || name} 2>/dev/null`,
      `brew install ${source || name} 2>/dev/null`,
      `pip3 install ${source || name} --quiet 2>/dev/null`,
    ]) {
      try {
        await execAsync(cmd, { timeout: 60000 });
        installed = true;
        break;
      } catch {}
    }

    if (installed) {
      Memory.registerCapability({ name, description, type: 'skill' });
      return { name, type: 'binary', installed };
    }

    throw new Error(`Could not install binary: ${name}`);
  }

  async _generateWrapper(name, pkgName, description, type) {
    return complete(
      `Write a Node.js ES module wrapper for the npm package "${pkgName}".\nPurpose: ${description}\n\nThe wrapper should:\n1. Import ${pkgName}\n2. Export a class with useful methods that APEX agents can call\n3. Handle errors\n4. Be easy to use\n\nReturn ONLY the code.`,
      { temperature: 0.2, maxTokens: 2000 }
    );
  }

  async _generatePythonBridge(name, pkgName, description) {
    return complete(
      `Write a Python script that acts as a CLI bridge for the package "${pkgName}".\nPurpose: ${description}\n\nThe script should:\n1. Accept JSON input via stdin or args\n2. Use ${pkgName}\n3. Output JSON results\n4. Handle errors gracefully\n\nReturn ONLY the Python code.`,
      { temperature: 0.2, maxTokens: 2000 }
    );
  }

  async _generateGitWrapper(name, skillDir, description, context) {
    return complete(
      `Write a Node.js ES module wrapper for this cloned git tool.\nTool: ${name}\nDirectory: ${skillDir}\nDescription: ${description}\n\n=== REPOSITORY GRAPHIFY CONTEXT ===\n${context}\n=====================\n\nThe wrapper should:\n1. Use child_process or imports to expose the tool's core functionality\n2. Export a class with methods APEX agents can use\n3. Parse output intelligently\n\nReturn ONLY the valid JS code.`,
      { temperature: 0.2, maxTokens: 4000, model: 'pro' } // Use DeepSeek Pro for complex code writing
    );
  }

  // Find a skill on clawhub / npm / github
  async findSkill(query) {
    const [npmResults, ghResults] = await Promise.allSettled([
      this._searchNpm(query),
      this._searchGithub(query),
    ]);

    return {
      npm: npmResults.value || [],
      github: ghResults.value || [],
    };
  }

  async _searchNpm(query) {
    const resp = await axios.get(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=5`);
    return resp.data.objects.map(p => ({
      name: p.package.name,
      description: p.package.description,
      version: p.package.version,
      source: 'npm',
    }));
  }

  async _searchGithub(query) {
    const resp = await axios.get(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=5`);
    return resp.data.items.map(r => ({
      name: r.full_name,
      description: r.description,
      stars: r.stargazers_count,
      url: r.html_url,
      source: 'github',
    }));
  }

  listSkills() {
    return {
      installed: this._installedSkills,
      capabilities: Memory.listCapabilities(),
    };
  }

  // ==========================================
  // HERMES DISTILLATION ENGINE
  // ==========================================
  async distillSkill(objective, executionHistory) {
    this.log(`HERMES DISTILLATION TRIGGERED: Distilling workflow for "${objective}" into a permanent skill.`);

    // 1. Send execution history to LLM to write a deterministic script
    const scriptCode = await complete(
      `You are the Hermes Distillation Engine. APEX just successfully completed a complex task after struggling.
      
Objective: "${objective}"

Execution History & Logs:
${JSON.stringify(executionHistory).slice(0, 8000)}

Your job is to convert this workflow into a hardened, highly reliable Node.js module that executes deterministically.
The exported module should expose a class with an 'execute(params)' method.
It must NOT rely on open-ended LLM planning. It should use standard Node.js libraries (fs, child_process, etc) to achieve the goal reliably.

Return ONLY the valid raw JavaScript code for the module.`,
      { temperature: 0.1, maxTokens: 4000, model: 'pro' }
    );

    // 2. Determine a filename for the new skill
    const skillName = objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
    const skillFileName = `distilled-${skillName}.js`;
    const skillPath = path.join(SKILLS_DIR, skillFileName);

    // 3. Security Audit via WardenAgent
    this.log(`Auditing distilled skill: ${skillFileName}`);
    const registry = (await import('../core/agent-registry.js')).default;
    const warden = registry.get('WardenAgent');
    if (warden) {
      const audit = await warden.auditCode(scriptCode, skillFileName);
      if (!audit.safe) {
        this.log(`Warden blocked the distilled skill due to security issues.`, 'warn');
        return { success: false, error: 'Failed Warden Audit', issues: audit.issues };
      }
    }

    // 4. Save to disk
    writeFileSync(skillPath, scriptCode, 'utf8');

    // 5. Register in Memory Engine
    const description = `Automated workflow for: ${objective}. Distilled via Hermes Engine.`;
    this._registerSkill({ name: skillFileName, type: 'distilled', source: 'internal', path: skillPath, description });
    Memory.registerCapability({ name: skillFileName, description, type: 'skill', path: skillPath });

    this.log(`Successfully distilled and hardened skill: ${skillFileName}`);
    
    // 6. Notify the bus
    bus.emit('skills:distilled', { name: skillFileName, objective });

    return { success: true, name: skillFileName, path: skillPath };
  }

  _registerSkill(skill) {
    this._installedSkills[skill.name] = { ...skill, installedAt: Date.now() };
    const registryPath = path.join(SKILLS_DIR, '_registry.json');
    writeFileSync(registryPath, JSON.stringify(this._installedSkills, null, 2));
  }

  _loadInstalledSkills() {
    const registryPath = path.join(SKILLS_DIR, '_registry.json');
    if (existsSync(registryPath)) {
      try { return JSON.parse(readFileSync(registryPath, 'utf8')); } catch {}
    }
    return {};
  }
}

export default SkillsAgent;
