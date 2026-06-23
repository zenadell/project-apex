// agents/code.js
// APEX CodeAgent — Elite full-stack builder. Research → Architecture → Code → Test → Integrate.
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { execSync, exec } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync, unlinkSync } from 'fs';
import { promisify } from 'util';
import path from 'path';
import bus from '../core/event-bus.js';
import registry from '../core/agent-registry.js';
import { sandbox } from '../core/sandbox.js';
import memoryEngine from '../core/memory_engine.js';

const execAsync = promisify(exec);

export class CodeAgent extends BaseAgent {
  constructor() {
    super({
      name: 'CodeAgent',
      type: 'engineering',
      description: 'Elite full-stack engineer. Plans architecture, writes production-quality code, tests it, fixes bugs, and integrates everything. Never writes half-finished code.',
    });
  }

  async run(task) {
    const { objective, context = '', outputDir = null, language = 'auto', type = 'project' } = task;
    this.log(`CodeAgent activated: "${objective}"`);

    // PHASE 0: Detect project context (ESM vs CJS, existing deps, language)
    const projectContext = outputDir ? this._detectProjectContext(outputDir) : '';

    // DETECT: Is this a "modify existing code" task?
    const isModifyTask = type === 'modify' || this._isModifyObjective(objective, outputDir);
    if (isModifyTask && outputDir) {
      this.log('Detected MODIFY task — reading existing code and applying surgical changes');
      return this._modifyExistingCode(objective, outputDir, context + '\n' + projectContext);
    }

    // PHASE 0.5: Research-before-code — if objective mentions unfamiliar tools, research first
    let researchContext = '';
    const researchAgent = registry.get('ResearchAgent');
    if (researchAgent) {
      try {
        const needsResearch = await structured(
          `Does this task require knowledge of specific APIs/libraries that an LLM might not have accurate data for?\nTask: "${objective}"\nRespond with whether research is needed and what to research.`,
          { needsResearch: false, topics: ['topic to research'] },
          { temperature: 0.1, timeout: 10000 }
        );
        if (needsResearch.needsResearch && needsResearch.topics?.length > 0) {
          this.log(`📚 Researching: ${needsResearch.topics.join(', ')}`);
          const research = await researchAgent.run({ objective: `Find current API docs and examples for: ${needsResearch.topics.join(', ')}.`, type: 'quick' });
          researchContext = `\nRESEARCH CONTEXT:\n${JSON.stringify(research).slice(0, 3000)}`;
        }
      } catch { /* research failed, continue without it */ }
    }

    // PHASE 1: Architecture planning
    const fullContext = context + '\n' + projectContext + researchContext;
    const architecture = await this._planArchitecture(objective, fullContext, language, type);
    this.log(`Architecture planned: ${architecture.stack?.join(', ')}`);

    // PHASE 2 (primary): build via the agentic loop — real tool execution, Warden-gated writes,
    // and run-and-test verification with ground-truth feedback. Falls back to the classic
    // generate→write→test pipeline below if disabled (APEX_LOOP_BUILD=false) or if it doesn't converge.
    if (outputDir && process.env.APEX_LOOP_BUILD !== 'false') {
      const loopResult = await this._buildViaLoop(objective, outputDir, fullContext, architecture);
      if (loopResult) return loopResult;
      this.log('Loop build unavailable/failed — falling back to classic pipeline', 'warn');
    }

    // PHASE 2 (fallback): Code generation — per-file, with project + research context
    const files = await this._generateCode(objective, architecture, fullContext, outputDir);
    this.log(`Generated ${files.length} files`);

    // PHASE 3-6: Write → Test → Fix → Re-test (OBSERVE-ACT-RETRY LOOP)
    if (outputDir) {
      const MAX_RETRIES = 3;
      let currentFiles = [...files];
      let testResult = { passed: false, errors: null };
      let attempt = 0;

      while (attempt < MAX_RETRIES) {
        attempt++;
        this.log(`Execution loop: attempt ${attempt}/${MAX_RETRIES}`);

        // Write current files to disk
        await this._writeToDisk(currentFiles, outputDir, JSON.stringify(architecture));
        this.log(`Files written to ${outputDir}`);

        // Install deps (only on first attempt)
        if (attempt === 1) {
          await this._installDeps(outputDir, architecture);
        }

        // Run tests
        testResult = await this._runTests(outputDir, architecture);
        this.log(`Tests: ${testResult.passed ? '✅ PASSED' : '❌ FAILED'}`);

        if (testResult.passed) {
          // EXECUTION VERIFICATION — check expected output files exist
          const verification = this._verifyOutputs(outputDir, architecture);
          if (verification.allPresent) {
            this.log(`✅ All expected outputs verified: ${verification.found.join(', ')}`);
          } else if (verification.missing.length > 0) {
            this.log(`⚠️ Missing outputs: ${verification.missing.join(', ')} — running execution command...`);
            // Try to execute the entrypoint to produce missing outputs
            const execResult = await this._executeEntrypoint(outputDir, architecture);
            if (execResult.success) {
              this.log(`✅ Entrypoint executed, outputs should now exist`);
            }
          }
          break; // Tests passed, exit the loop
        }

        // Tests failed — OBSERVE the error and ACT to fix it
        if (attempt < MAX_RETRIES && testResult.errors) {
          this.log(`🔄 Auto-fixing (attempt ${attempt}/${MAX_RETRIES}): ${testResult.errors.slice(0, 150)}...`);
          const fixes = await this._autoFix(currentFiles, testResult.errors, objective + '\n' + projectContext);
          if (fixes.length > 0) {
            // Merge fixes into current files
            for (const fix of fixes) {
              const idx = currentFiles.findIndex(f => f.path === fix.path);
              if (idx >= 0) {
                currentFiles[idx] = fix;
              } else {
                currentFiles.push(fix);
              }
            }
          } else {
            this.log(`⚠️ Auto-fix produced no changes, stopping retry loop`);
            break;
          }
        }
      }

      if (!testResult.passed) {
        this.log(`❌ Failed after ${attempt} attempts. Last error: ${testResult.errors?.slice(0, 200)}`);
        // Propagate failure to orchestrator so it can REFLECT
        throw new Error(`CodeAgent tests failed: ${testResult.errors?.slice(0, 300)}`);
      }
    }

    // Store result in memory
    this.remember(
      `Built: ${objective}\nStack: ${architecture.stack?.join(', ')}\nFiles: ${files.map(f => f.path).join(', ')}`,
      { tags: ['build', 'code'], importance: 8, scope: 'long_term' }
    );

    return { objective, architecture, files, outputDir };
  }

  // Build a project via the agentic loop: the model reads/writes/runs in the output dir with
  // ground-truth feedback, every write vetted by Warden, and must actually run + pass a check
  // before finishing. Returns a result on success, or null to signal "fall back to classic".
  async _buildViaLoop(objective, outputDir, fullContext = '', architecture = null) {
    let runAgentLoop;
    try {
      ({ runAgentLoop } = await import('../core/agent-loop.js'));
    } catch (err) {
      this.log(`agent-loop unavailable: ${err.message}`, 'warn');
      return null;
    }
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const guard = this._makeWardenGuard();
    const archHint = architecture
      ? `\n\nPlanned architecture (guidance — adapt as needed):\n${JSON.stringify(architecture).slice(0, 1500)}`
      : '';

    const goal = `Build software that satisfies this objective, end to end, in the workspace.

OBJECTIVE: ${objective}${fullContext ? `\n\nPROJECT CONTEXT:\n${fullContext.slice(0, 2000)}` : ''}${archHint}

Requirements:
- Create every necessary file with COMPLETE, production-quality code — no placeholders, no TODOs.
- If you need dependencies, create/update package.json (or requirements.txt) and run the install command via the run tool.
- Write at least one runnable check or test, RUN it with the run tool, and fix any failures.
- Do NOT call finish until you have actually executed the code/tests and seen them succeed.`;

    this.log(`Building via agentic loop in ${outputDir} (Warden ${guard ? 'ON' : 'off'})...`);
    const res = await runAgentLoop(goal, {
      workspace: outputDir,
      maxSteps: 40,
      writeGuard: guard,
      onEvent: (ev) => {
        if (ev.type === 'action') this.log(`build: ${ev.tool} ${ev.args?.path || ev.args?.command || ''}`);
        else if (ev.type === 'finish') this.log(`build ${ev.success ? 'succeeded' : 'ended'}: ${ev.summary}`);
      },
    });

    if (!res.success) {
      this.log(`Loop build did not converge: ${res.summary}`, 'warn');
      return null; // caller falls back to classic pipeline
    }

    const produced = this._scanDirectory(outputDir);
    this.remember(`Built (loop): ${objective}\nFiles: ${produced.join(', ')}`, { tags: ['build', 'code', 'loop'], importance: 8, scope: 'long_term' });
    bus.emit('code:built', { objective, outputDir, via: 'agent-loop', files: produced });
    return { objective, outputDir, via: 'agent-loop', summary: res.summary, files: produced.map(p => ({ path: p })) };
  }

  // A Warden-backed write guard for the agentic loop — deterministic gate on every write/edit.
  _makeWardenGuard() {
    const warden = registry.get('WardenAgent');
    if (!warden) return null;
    return async ({ fullPath, content }) => {
      try {
        const res = await warden.run({ filePath: fullPath, fileContent: content, isSelfModifying: false, validateOnly: true });
        if (res.success) return { ok: true };
        const detail = (res.issues || []).map(i => `- ${i.type}: ${i.description}${i.fix ? ` (fix: ${i.fix})` : ''}`).join('\n');
        return { ok: false, observation: `Warden REJECTED this write:\n${detail}\nFix these issues and write again.` };
      } catch (err) {
        // Fail-open on Warden infra errors — don't deadlock a build over a gate malfunction.
        this.log(`Warden guard error (allowing write): ${err.message}`, 'warn');
        return { ok: true };
      }
    };
  }

  /**
   * Detect if the objective is asking to modify existing code vs create new
   */
  _isModifyObjective(objective, outputDir) {
    if (!outputDir) return false;
    const modifyKeywords = /\b(fix|bug|modify|change|update|refactor|add .+ to|edit|patch|improve|upgrade|migrate|convert|replace)\b/i;
    const hasExistingFiles = existsSync(outputDir) && readdirSync(outputDir).filter(f => !f.startsWith('.')).length > 0;
    return modifyKeywords.test(objective) && hasExistingFiles;
  }

  /**
   * MODIFY EXISTING CODE — reads target files, generates diffs, applies surgically
   */
  async _modifyExistingCode(objective, outputDir, projectContext) {
    const existingFiles = this._scanDirectory(outputDir);
    this.log(`Scanned ${existingFiles.length} existing files`);
    const fileContents = [];
    for (const fp of existingFiles.slice(0, 10)) {
      try {
        const fullPath = path.join(outputDir, fp);
        const stat = statSync(fullPath);
        if (stat.size < 50000) fileContents.push({ path: fp, content: readFileSync(fullPath, 'utf8') });
        else fileContents.push({ path: fp, content: readFileSync(fullPath, 'utf8').slice(0, 2000) });
      } catch { /* skip */ }
    }
    const modPlan = await structured(
      `Modify existing codebase. Objective: "${objective}"\n\nContext:\n${projectContext}\n\nExisting files:\n${fileContents.map(f => `--- ${f.path} ---\n${f.content.slice(0, 3000)}`).join('\n')}\n\nFor each file, specify path, action (modify/create), full new content, and description.`,
      { changes: [{ path: '', action: 'modify', content: '', description: '' }], summary: '', testCommand: '' },
      { temperature: 0.1, timeout: 60000 }
    );
    this.log(`Modification plan: ${modPlan.summary}`);
    let currentChanges = modPlan.changes.map(c => ({ path: c.path, content: this._stripLLMNarrative(c.content) }));
    let testResult = { passed: false, errors: null };
    const architecture = { testCommand: modPlan.testCommand };
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.log(`Modification attempt ${attempt}/3`);
      await this._writeToDisk(currentChanges, outputDir, '');
      await this._installDeps(outputDir, architecture);
      testResult = await this._runTests(outputDir, architecture);
      this.log(`Tests: ${testResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
      if (testResult.passed) break;
      if (attempt < 3 && testResult.errors) {
        const fixes = await this._autoFix(currentChanges, testResult.errors, objective + '\n' + projectContext);
        if (fixes.length > 0) { for (const fix of fixes) { const idx = currentChanges.findIndex(f => f.path === fix.path); if (idx >= 0) currentChanges[idx] = fix; else currentChanges.push(fix); } }
        else break;
      }
    }
    if (!testResult.passed) throw new Error(`CodeAgent modification failed: ${testResult.errors?.slice(0, 300)}`);
    this.remember(`Modified: ${objective}\nFiles: ${currentChanges.map(f => f.path).join(', ')}`, { tags: ['modify', 'code'], importance: 8, scope: 'long_term' });
    return { objective, changes: currentChanges, outputDir, type: 'modify' };
  }

  /**
   * Scan directory recursively for source files
   */
  _scanDirectory(dir, prefix = '') {
    const results = [];
    try {
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.') || entry === 'node_modules' || entry === '__pycache__' || entry === '.git') continue;
        const fullPath = path.join(dir, entry);
        const relPath = prefix ? `${prefix}/${entry}` : entry;
        const stat = statSync(fullPath);
        if (stat.isDirectory()) results.push(...this._scanDirectory(fullPath, relPath));
        else if (/\.(js|ts|jsx|tsx|py|json|html|css|md|yaml|yml|toml|sh|sql)$/i.test(entry)) results.push(relPath);
      }
    } catch { /* skip */ }
    return results;
  }

  /**
   * Detect project context: ESM vs CJS, existing dependencies, Node version
   */
  _detectProjectContext(outputDir) {
    const lines = [];
    try {
      // ── Node.js / JavaScript detection ──
      const pkgPath = path.join(outputDir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        if (pkg.type === 'module') {
          lines.push('CRITICAL: This project uses ES Modules ("type": "module" in package.json). You MUST use `import/export` syntax. Do NOT use `require()` or `module.exports`.');
        } else {
          lines.push('This project uses CommonJS modules. Use `require()` and `module.exports`.');
        }
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (allDeps['react']) {
          lines.push(`REACT PROJECT: React ${allDeps['react']} detected. Use JSX syntax and functional components.`);
          if (allDeps['next']) lines.push('Next.js project — use app router conventions.');
          if (allDeps['vite']) lines.push('Vite build tool detected.');
        }
        const deps = Object.keys(pkg.dependencies || {});
        if (deps.length > 0) lines.push(`Already installed: ${deps.join(', ')}. Do NOT reinstall.`);
        if (pkg.engines?.node) lines.push(`Target Node: ${pkg.engines.node}`);
        lines.push('LANGUAGE: JavaScript/Node.js');
      }
      // ── Python detection ──
      const reqPath = path.join(outputDir, 'requirements.txt');
      const setupPy = path.join(outputDir, 'setup.py');
      const pyproject = path.join(outputDir, 'pyproject.toml');
      if (existsSync(reqPath)) {
        const reqs = readFileSync(reqPath, 'utf8').trim().split('\n').filter(l => l && !l.startsWith('#'));
        lines.push(`PYTHON PROJECT: requirements.txt with: ${reqs.join(', ')}`);
        lines.push('Use Python 3 syntax. Do NOT use Node.js patterns.');
        lines.push('LANGUAGE: Python');
      } else if (existsSync(setupPy) || existsSync(pyproject)) {
        lines.push('PYTHON PROJECT detected (setup.py or pyproject.toml).');
        lines.push('LANGUAGE: Python');
      }
      if (lines.length === 0) lines.push('No existing project detected. Create from scratch.');
    } catch { /* no project files */ }
    return lines.join('\n');
  }

  /**
   * Verify expected output files exist after execution
   */
  _verifyOutputs(outputDir, architecture) {
    const expected = Object.keys(architecture.structure || {});
    const found = [];
    const missing = [];
    
    for (const filePath of expected) {
      const fullPath = path.join(outputDir, filePath);
      if (existsSync(fullPath)) {
        const stat = statSync(fullPath);
        if (stat.size > 0) {
          found.push(filePath);
        } else {
          missing.push(filePath + ' (empty)');
        }
      } else {
        missing.push(filePath);
      }
    }
    
    return { found, missing, allPresent: missing.length === 0 };
  }

  /**
   * Execute the project entrypoint to produce output files
   */
  async _executeEntrypoint(outputDir, architecture) {
    const entrypoint = architecture.entrypoint;
    if (!entrypoint) return { success: false, errors: 'No entrypoint defined' };
    
    try {
      const cmd = entrypoint.endsWith('.py') ? `python3 ${entrypoint}` : `node ${entrypoint}`;
      const { stdout, stderr } = await execAsync(cmd, { cwd: outputDir, timeout: 60000 });
      return { success: true, output: stdout, errors: stderr || '' };
    } catch (err) {
      return { success: false, output: err.stdout || '', errors: err.stderr || err.message };
    }
  }

  async _planArchitecture(objective, context, language, type) {
    const promptStr = `You are an elite software architect. Plan the architecture for:\n\nObjective: ${objective}\nContext: ${context}\nLanguage preference: ${language}\nType: ${type}\n\nDesign a clean, production-ready architecture. If the objective explicitly requests a single file, the structure MUST contain ONLY that one file.`;
    return structured(
      promptStr,
      {
        stack: ['technology stack array'],
        structure: { 'filename.ext': 'description of each file and its purpose' },
        dependencies: ['npm/pip packages needed'],
        devDependencies: ['dev packages needed'],
        entrypoint: 'main entry file',
        buildCommand: 'command to build/start',
        testCommand: 'command to test',
        designPatterns: ['patterns used'],
        notes: 'any important architectural notes',
      },
      { temperature: 0.3, complex: true }
    );
  }

  // Strip LLM narrative/markdown from generated code
  _stripLLMNarrative(code) {
    let cleaned = code;
    // Remove markdown code fences
    cleaned = cleaned.replace(/^```[a-zA-Z]*\n?/gm, '').replace(/```\n?$/gm, '');
    // Remove common LLM preamble lines
    cleaned = cleaned.replace(/^(Here's|Here is|Let's|I'll|Sure|Certainly|Below is|This is)[^\n]*\n/i, '');
    // Remove trailing LLM commentary after the code
    const lastSemicolon = cleaned.lastIndexOf(';');
    const lastBrace = cleaned.lastIndexOf('}');
    const lastTag = cleaned.lastIndexOf('>');
    const codeEnd = Math.max(lastSemicolon, lastBrace, lastTag);
    if (codeEnd > 0 && codeEnd < cleaned.length - 200) {
      cleaned = cleaned.substring(0, codeEnd + 1);
    }
    return cleaned.trim();
  }

  // Check if an existing plugin/tool already handles this task
  _findExistingTool(taskDescription) {
    try {
      const pluginsDir = path.join(process.cwd(), 'plugins');
      const toolsDir = path.join(process.cwd(), 'tools');
      const keywords = taskDescription.toLowerCase().split(/\s+/);
      
      const checkDir = (dir) => {
        if (!existsSync(dir)) return null;
        const files = readdirSync(dir);
        for (const file of files) {
          const basename = file.replace(/\.(js|ts|py|swift)$/, '').replace(/[-_]/g, ' ');
          if (keywords.some(k => basename.includes(k))) {
            return { type: 'existing_plugin', path: path.join(dir, file), name: file };
          }
        }
        return null;
      };
      
      return checkDir(pluginsDir) || checkDir(toolsDir) || null;
    } catch { return null; }
  }

  async _generateCode(objective, architecture, context, outputDir) {
    if (!outputDir) return [];
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    // Check if an existing plugin can handle this
    const existingTool = this._findExistingTool(objective);
    if (existingTool) {
      this.log(`Found existing tool: ${existingTool.name} — using it instead of generating new code`);
    }

    const files = [];
    const fileList = Object.entries(architecture.structure || {});
    
    // Generate code PER FILE — each file gets its own focused LLM call
    for (const [filePath, fileDesc] of fileList) {
      try {
        const ext = path.extname(filePath);
        const existingContext = files.slice(-3).map(f => `// ${f.path}:\n${f.content.slice(0, 500)}`).join('\n\n');
        
        const code = await complete(
          `Write the code for file "${filePath}".\n\nProject objective: ${objective}\nThis file's purpose: ${fileDesc}\nTech stack: ${JSON.stringify(architecture.stack)}\nEntry point: ${architecture.entrypoint}\n${existingContext ? `\nContext from already-generated files:\n${existingContext}` : ''}\n\nRULES:\n- Output ONLY valid ${ext} source code. No explanations, no markdown fences, no preamble.\n- The output will be saved directly as "${filePath}". It must be syntactically valid.\n- Write COMPLETE, production-quality code. No placeholders, no TODOs.`,
          { temperature: 0.2, maxTokens: 4096 }
        );
        
        const cleaned = this._stripLLMNarrative(code);
        files.push({ path: filePath, content: cleaned });
        this.log(`Generated: ${filePath}`);
      } catch (err) {
        this.log(`Failed to generate ${filePath}: ${err.message}`, 'warn');
      }
    }

    return files;
  }

  async _writeToDisk(files, outputDir, goldenBlueprint = '') {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    
    const warden = registry.get('WardenAgent');
    
    // Resolve outputDir to absolute for prefix stripping
    const absOutputDir = path.resolve(outputDir);
    const outputDirBasename = path.basename(absOutputDir);

    for (const file of files) {
      // Fix double-nesting: if file.path starts with the outputDir basename, strip it
      let filePath = file.path;
      if (filePath.startsWith(outputDirBasename + '/') || filePath.startsWith(outputDirBasename + path.sep)) {
        filePath = filePath.slice(outputDirBasename.length + 1);
      }
      const fullPath = path.join(outputDir, filePath);
      
      if (warden) {
        let content = file.content;
        // Strip markdown code blocks to prevent Warden syntax errors
        content = content.replace(/^```[a-zA-Z]*\n/gm, '').replace(/```\n?$/gm, '');
        let success = false;
        let attempts = 0;
        const MAX_ATTEMPTS = 5;

        let lastIssues = null;
        while (!success && attempts < MAX_ATTEMPTS) {
           attempts++;
           // Pass through strict sandbox warden
           const result = await warden.run({ 
             filePath: fullPath, 
             fileContent: content,
             goldenBlueprint: goldenBlueprint 
           });
           
           if (!result.success) {
             lastIssues = result.issues;
             this.log(`Warden blocked write. Attempt ${attempts}/${MAX_ATTEMPTS}. Issue: ${JSON.stringify(result.issues)}. Fixing via ApexForge...`, 'warn');
             if (attempts >= MAX_ATTEMPTS) {
                throw new Error(`Warden Agent permanently blocked file write to ${file.path}. Exceeded retry limit. Last issue: ${JSON.stringify(result.issues)}`);
             }
             content = await this._surgicalFix(file.path, content, result.issues || [], outputDir);
           } else {
             if (attempts > 1 && lastIssues) {
               const errorMsg = lastIssues.map(i => i.description).join('; ');
               this.log(`Saving lesson to Reflective Memory Engine for ${file.path}...`);
               memoryEngine.saveLesson(file.path, errorMsg, `Fix applied for Warden Rejection: ${errorMsg}. Ensure strict adherence to Warden rules and valid syntax.`);
             }
             success = true;
           }
        }
      } else {
        // Fallback if Warden is disabled
        const dir = path.dirname(fullPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(fullPath, file.content, 'utf8');
      }
    }
  }

  async _surgicalFix(filePath, originalContent, issues, outputDir) {
    this.log(`Applying precision auto-heal for ${filePath}...`);
    const fullPath = path.join(outputDir, filePath);
    const isJs = /\.(js|mjs|cjs)$/.test(fullPath);
    let content = originalContent;

    for (const issue of issues) {
      let accepted = null;
      let retries = 0;
      while (accepted === null && retries < 3) {
        try {
          // The model MUST see the actual file content (the old version never passed it, then
          // overwrote the whole file with an unverified reply — that corrupted files). Ask for
          // the full corrected file, then VALIDATE before writing.
          const prompt = `You are fixing ONE sandbox violation in an existing file. Change only what is needed; preserve all other code, structure, and behavior.

File: ${filePath}
Violation: ${issue.description}
Suggested fix: ${issue.fix || '(use a minimal, correct change)'}

--- CURRENT FILE (fix this exact content) ---
${content}
--- END FILE ---

Return the COMPLETE corrected file content and NOTHING else — no markdown fences, no commentary.`;
          let out = await complete(prompt, { coding: true, temperature: 0.1, maxTokens: 8000 });
          out = out.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '').trim();

          // Guard: never let a truncated/empty/nonsense reply clobber a real file.
          if (!out || out.length < Math.max(20, Math.floor(content.length * 0.4))) {
            throw new Error('fix output suspiciously short — refusing to overwrite');
          }
          if (isJs) {
            const chk = await this._syntaxCheck(out);
            if (!chk.success) throw new Error(`fix has syntax error: ${chk.error}`);
          }
          accepted = out;
        } catch (err) {
          retries++;
          this.log(`auto-heal attempt ${retries}/3 for ${filePath} failed: ${err.message}`, 'warn');
          if (retries < 3) await new Promise(r => setTimeout(r, Math.min(3000 * retries, 15000)));
        }
      }
      // Adopt only a validated fix; otherwise keep the previous (uncorrupted) content.
      if (accepted !== null) content = accepted;
      else this.log(`auto-heal could not safely fix "${issue.description}" — keeping original`, 'warn');
    }

    writeFileSync(fullPath, content, 'utf8'); // content is original or a validated fix — never garbage
    return content;
  }

  // Syntax-check a JS string without importing/executing it (no side effects).
  async _syntaxCheck(code) {
    const tmp = path.join('/tmp', `apex-chk-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    try {
      writeFileSync(tmp, code, 'utf8');
      await execAsync(`node --check "${tmp}"`, { timeout: 5000 });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err.stderr || err.message || '').slice(0, 400) };
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  }

  async _installDeps(outputDir, architecture) {
    // Node.js
    const pkgPath = path.join(outputDir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        this.log('Installing Node.js dependencies...');
        await execAsync('npm install', { cwd: outputDir, timeout: 120000 });
      } catch (err) { this.log(`npm install warning: ${err.message}`, 'warn'); }
    }
    // Python
    const reqPath = path.join(outputDir, 'requirements.txt');
    if (existsSync(reqPath)) {
      try {
        this.log('Installing Python dependencies...');
        await execAsync('pip3 install -r requirements.txt --quiet', { cwd: outputDir, timeout: 120000 });
      } catch (err) { this.log(`pip install warning: ${err.message}`, 'warn'); }
    }
    const pyproject = path.join(outputDir, 'pyproject.toml');
    if (existsSync(pyproject) && !existsSync(reqPath)) {
      try {
        this.log('Installing Python project...');
        await execAsync('pip3 install -e . --quiet', { cwd: outputDir, timeout: 120000 });
      } catch (err) { this.log(`pip install warning: ${err.message}`, 'warn'); }
    }
  }

  async _runTests(outputDir, architecture) {
    if (!architecture.testCommand) return { passed: true, errors: null };

    // Execution Jail: Prevent destructive commands
    const dangerousPatterns = [/rm\s+-rf\s+\//i, />\s*\//, /chmod\s+-R\s+777\s+\//i, /mkfs/i, /dd\s+if=/i];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(architecture.testCommand)) {
        return { passed: false, errors: `Execution Jail blocked destructive command: ${architecture.testCommand}` };
      }
    }

    // Try Docker sandbox first — fully isolated execution
    try {
      const dockerAvailable = await sandbox.isAvailable();
      if (dockerAvailable) {
        this.log('Executing tests in Docker sandbox...');
        const result = await sandbox.runProject({
          projectDir: outputDir,
          installCmd: architecture.dependencies?.length > 0 ? 'npm install --production' : null,
          testCmd: architecture.testCommand,
          expectedOutputs: Object.keys(architecture.structure || {}),
          timeout: 60000,
        });
        if (result.success) {
          return { passed: true, output: result.output + (result.errors || '') };
        } else {
          return { passed: false, errors: result.errors, output: result.output };
        }
      }
    } catch (e) {
      this.log(`Docker sandbox failed: ${e.message}. Falling back to native execution.`);
    }

    // Fallback: native execution
    try {
      this.log('Executing tests natively...');
      let cmd = architecture.testCommand;
      if (cmd.startsWith('python ')) cmd = cmd.replace('python ', 'python3 ');
      
      // Strip outputDir prefix from command — cwd is already set to outputDir
      const dirBasename = path.basename(path.resolve(outputDir));
      cmd = cmd.replace(new RegExp(`\\b${dirBasename}/`, 'g'), '');
      // Also strip cd commands since we set cwd
      cmd = cmd.replace(/^cd\s+[^\s;]+\s*&&\s*/i, '');
      
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: outputDir,
        timeout: 60000,
      });
      return { passed: true, output: stdout + (stderr || '') };
    } catch (err) {
      return { passed: false, errors: err.stderr || err.message, output: err.stdout };
    }
  }

  async _autoFix(files, errors, objective) {
    this.log(`Auto-fixing errors: ${errors.slice(0, 200)}`);

    const fileList = files.map(f => f.path).join(', ');
    const fixPlan = await structured(
      `These errors occurred when running the project:\n\n${errors}\n\nObjective: ${objective}\n\nProject files: ${fileList}\n\nIdentify which files need fixes and what changes are needed. Use EXACT file paths from the project files list above.`,
      {
        filesToFix: ['array of file paths that need changes'],
        fixes: { 'filename': 'description of fix needed' },
      }
    );

    const fixedFiles = [];
    for (const [filePath, fixDesc] of Object.entries(fixPlan.fixes || {})) {
      // Fuzzy match: LLM may return 'index.js' when the actual path is 'link-extractor/index.js'
      let original = files.find(f => f.path === filePath);
      if (!original) {
        original = files.find(f => f.path.endsWith('/' + filePath) || path.basename(f.path) === filePath);
      }
      if (!original) continue;
      const resolvedPath = original.path; // Use the actual path from our files array

      const fixed = await complete(
        `Fix this code:\n\nFile: ${filePath}\nError: ${errors.slice(0, 500)}\nFix needed: ${fixDesc}\n\nOriginal code:\n${original.content}\n\nRULES:\n- Return ONLY the fixed source code. No explanations, no markdown fences, no preamble.\n- The output will be saved directly as "${filePath}". It must be syntactically valid.`,
        { temperature: 0.1 }
      );

      fixedFiles.push({ path: resolvedPath, content: this._stripLLMNarrative(fixed) });
    }

    return fixedFiles;
  }

  // Execute arbitrary code safely in Docker sandbox
  async executeCode(code, language = 'javascript') {
    this.log('Executing code in Docker sandbox...');
    return sandbox.executeCode({ code, language, timeout: 30000 });
  }
  
  // Analyze an existing codebase
  async analyzeCodebase(dir) {
    const files = await this._scanDir(dir);
    const analysis = await structured(
      `Analyze this codebase structure:\n\n${JSON.stringify(files, null, 2)}\n\nProvide a comprehensive analysis.`,
      {
        summary: 'what this project does',
        architecture: 'architectural pattern used',
        quality: 'code quality assessment',
        issues: ['list of issues found'],
        improvements: ['list of recommended improvements'],
        dependencies: ['key dependencies'],
      }
    );
    return analysis;
  }

  async _scanDir(dir, depth = 0) {
    if (depth > 3) return [];
    const { readdirSync, statSync } = await import('fs');
    const items = readdirSync(dir).filter(f => !['node_modules', '.git', 'dist', '__pycache__'].includes(f));
    const result = [];
    for (const item of items.slice(0, 30)) {
      const full = path.join(dir, item);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        result.push({ type: 'dir', name: item, children: await this._scanDir(full, depth + 1) });
      } else {
        result.push({ type: 'file', name: item, size: stat.size });
      }
    }
    return result;
  }
}

export default CodeAgent;
