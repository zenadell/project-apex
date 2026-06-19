// agents/code.js
// APEX CodeAgent — Elite full-stack builder. Research → Architecture → Code → Test → Integrate.
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { execSync, exec } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync } from 'fs';
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

    // PHASE 0: Detect project context (ESM vs CJS, existing deps)
    const projectContext = outputDir ? this._detectProjectContext(outputDir) : '';

    // PHASE 1: Architecture planning
    const architecture = await this._planArchitecture(objective, context + '\n' + projectContext, language, type);
    this.log(`Architecture planned: ${architecture.stack?.join(', ')}`);

    // PHASE 2: Code generation — per-file, with project context
    const files = await this._generateCode(objective, architecture, context + '\n' + projectContext, outputDir);
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

  /**
   * Detect project context: ESM vs CJS, existing dependencies, Node version
   */
  _detectProjectContext(outputDir) {
    const lines = [];
    try {
      const pkgPath = path.join(outputDir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        
        // Module type
        if (pkg.type === 'module') {
          lines.push('CRITICAL: This project uses ES Modules ("type": "module" in package.json). You MUST use `import/export` syntax. Do NOT use `require()` or `module.exports` — they will cause ReferenceError at runtime.');
        } else {
          lines.push('This project uses CommonJS modules. Use `require()` and `module.exports`.');
        }
        
        // Existing dependencies
        const deps = Object.keys(pkg.dependencies || {});
        if (deps.length > 0) {
          lines.push(`Already installed dependencies: ${deps.join(', ')}. Do NOT reinstall these.`);
        }
        
        // Node engine
        if (pkg.engines?.node) {
          lines.push(`Target Node version: ${pkg.engines.node}`);
        }
      }
    } catch { /* no package.json, no context */ }
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
    this.log(`Applying precision ApexForge auto-heal for ${filePath}...`);
    
    const fullPath = path.join(outputDir, filePath);
    // Ensure the disk file has the latest content so Hermes can read it
    writeFileSync(fullPath, originalContent, 'utf8');

    for (const issue of issues) {
      const hermesPrompt = `CRITICAL PRESERVATION RULE: You are applying a precision security fix to an existing file. DO NOT rewrite, delete, or re-architect the entire file. Fix ONLY the following Warden sandbox violation: ${issue.description}. Suggested fix: ${issue.fix}.`;
      
      let success = false;
      let retries = 0;
      while (!success && retries < 3) {
        try {
           let code = await complete(hermesPrompt);
           code = code.replace(/^```[a-zA-Z]*\n/gm, '').replace(/```\n?$/gm, '');
           writeFileSync(fullPath, code, 'utf8');
           success = true;
        } catch (err) {
           retries++;
           const waitTime = Math.min(5000 * Math.pow(2, retries), 60000);
           this.log(`ApexForge auto-heal failed: ${err.message}. Retrying in ${waitTime/1000}s...`, 'warn');
           if (retries < 3) await new Promise(r => setTimeout(r, waitTime));
        }
      }
    }
    
    // Read the perfectly fixed file back from disk
    return readFileSync(fullPath, 'utf8');
  }

  async _installDeps(outputDir, architecture) {
    const pkgPath = path.join(outputDir, 'package.json');
    if (!existsSync(pkgPath)) return;

    try {
      this.log('Installing dependencies...');
      await execAsync('npm install', { cwd: outputDir, timeout: 120000 });
    } catch (err) {
      this.log(`Dep install warning: ${err.message}`, 'warn');
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
