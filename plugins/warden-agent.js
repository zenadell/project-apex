// plugins/warden-agent.js
// APEX WardenAgent v2 — Deterministic validation only. No LLM-as-judge.
import { BaseAgent } from '../agents/base-agent.js';
import fs from 'fs';
import path from 'path';

export default class WardenAgent extends BaseAgent {
  constructor() {
    super({
      name: 'WardenAgent',
      type: 'warden',
      description: 'Deterministic code gatekeeper. Validates syntax, blocks dangerous patterns, detects LLM narrative dumps. No LLM calls.',
    });
  }

  async run(task) {
    // validateOnly: return the verdict WITHOUT writing the file (used by the agentic loop,
    // which does its own writing). Default false preserves the original write-through behavior.
    const { fileContent, filePath, isSelfModifying, validateOnly = false } = task;
    this.log(`Intercepting write attempt to: ${filePath}`);

    const issues = [];

    // 1. CORE FILE PROTECTION — block writes to APEX brain unless authorized
    const protectedPaths = ['apex.js', 'core/orchestrator.js', 'core/llm-router.js', 'core/llm.js'];
    const relPath = path.relative(process.cwd(), filePath);
    if (protectedPaths.some(p => relPath.includes(p)) && !isSelfModifying) {
      issues.push({
        file: filePath,
        type: 'core_protection',
        description: `Blocked write to protected APEX core file: ${relPath}`,
        fix: 'Use isSelfModifying flag for authorized evolution operations.',
      });
    }

    // 2. DANGEROUS PATTERN CHECK — only truly destructive operations
    const dangerousPatterns = [
      { pattern: /rm\s+-rf\s+\//i, name: 'rm -rf /' },
      { pattern: /DROP\s+TABLE/i, name: 'DROP TABLE' },
      { pattern: /child_process.*exec.*\$\{/i, name: 'command injection via template literal' },
    ];
    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(fileContent)) {
        issues.push({
          file: filePath,
          type: 'security',
          description: `Dangerous pattern detected: ${name}`,
          fix: `Remove or replace the ${name} usage with a safe alternative.`,
        });
      }
    }

    // 3. NARRATIVE DETECTION — if a "code" file starts with conversational LLM text, it's not code
    const narrativeStarters = [
      /^Here's /i, /^Here is /i, /^Let's /i, /^I'll /i, /^Sure/i,
      /^Certainly/i, /^Below is /i, /^This is /i, /^Great/i, /^Absolutely/i,
      /^Of course/i, /^I've /i, /^The following/i,
    ];
    const codeExtensions = ['.js', '.ts', '.py', '.html', '.css', '.json', '.swift', '.dart', '.mjs'];
    const ext = path.extname(filePath).toLowerCase();
    if (codeExtensions.includes(ext)) {
      const firstLine = fileContent.split('\n')[0].trim();
      if (narrativeStarters.some(p => p.test(firstLine))) {
        issues.push({
          file: filePath,
          type: 'narrative_dump',
          description: `File starts with LLM narrative text: "${firstLine.slice(0, 80)}"`,
          fix: 'Strip narrative preamble — file should contain only valid source code.',
        });
      }
    }

    // 4. SYNTAX CHECK — for JS/JSON files, attempt to parse
    if (ext === '.json') {
      try { JSON.parse(fileContent); } catch (e) {
        issues.push({
          file: filePath,
          type: 'syntax_error',
          description: `Invalid JSON: ${e.message}`,
          fix: 'Fix the JSON syntax error.',
        });
      }
    }

    // 5. EMPTY FILE CHECK
    if (!fileContent || fileContent.trim().length === 0) {
      issues.push({
        file: filePath,
        type: 'empty_file',
        description: 'File is empty — nothing to write.',
        fix: 'Generate actual content for this file.',
      });
    }

    // VERDICT — no LLM involved, purely deterministic
    if (issues.length === 0) {
      if (validateOnly) {
        this.log(`✅ Passed Audit (validate-only): ${filePath}`);
        return { success: true, message: 'Code passed deterministic Warden audit.' };
      }
      this.log(`✅ Passed Audit. Promoting to live filesystem: ${filePath}`);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, fileContent, 'utf8');
      return { success: true, message: 'Code passed deterministic Warden audit.' };
    } else {
      this.log(`❌ FAILED AUDIT. Blocking write to ${filePath}. Found ${issues.length} issues.`);
      return { success: false, issues, rejected: true };
    }
  }
}
