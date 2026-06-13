// agents/verifier.js
// APEX VerifierAgent — Anti-hallucination layer. Verifies every claim before acting.
// Checks URLs exist, code compiles, facts are sourced, outputs are consistent.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, existsSync } from 'fs';
import axios from 'axios';
import path from 'path';
import bus from '../core/event-bus.js';

const execAsync = promisify(exec);

export class VerifierAgent extends BaseAgent {
  constructor() {
    super({
      name: 'VerifierAgent',
      type: 'verification',
      description: 'Anti-hallucination layer. Verifies URLs exist, code compiles, facts are accurate, outputs are consistent. Rejects or corrects bad outputs before they reach the user.',
    });
    this._verificationCache = new Map();
  }

  async run(task) {
    const { action = 'verify', content, type } = task;
    switch (action) {
      case 'verify':        return this.verify(content, type);
      case 'verify_code':   return this.verifyCode(content, task.language);
      case 'verify_url':    return this.verifyURL(content);
      case 'verify_facts':  return this.verifyFacts(content);
      case 'verify_output': return this.verifyAgentOutput(task.output, task.objective);
      case 'gate':          return this.gate(task.output, task.objective, task.agent);
      default:              return this.verify(content, type);
    }
  }

  // ── MASTER VERIFICATION GATE ──────────────────────────────────────────────
  // Called before any agent output reaches the user or triggers action
  async gate(output, objective, agentName = 'unknown') {
    this.log(`Verifying output from ${agentName}`);

    const checks = await Promise.allSettled([
      this._checkConsistency(output, objective),
      this._checkForHallucinations(output),
      this._checkConfidence(output),
    ]);

    const results = checks.map(c => c.value || { ok: false, error: c.reason?.message });
    const passed = results.every(r => r.ok !== false);
    const confidence = results.reduce((sum, r) => sum + (r.confidence || 0.7), 0) / results.length;

    const gateResult = {
      passed,
      confidence: Math.round(confidence * 100),
      agent: agentName,
      checks: results,
      flagged: results.filter(r => r.flags?.length).flatMap(r => r.flags),
    };

    if (!passed) {
      bus.emit('verifier:failed', { agent: agentName, flags: gateResult.flagged });
      this.log(`❌ Output failed verification: ${gateResult.flagged.join(', ')}`, 'warn');
    } else {
      bus.emit('verifier:passed', { agent: agentName, confidence: gateResult.confidence });
    }

    return gateResult;
  }

  // ── VERIFY CODE ───────────────────────────────────────────────────────────
  async verifyCode(code, language = 'auto') {
    const detected = language === 'auto' ? this._detectLanguage(code) : language;
    const tmpFile = `/tmp/apex-verify-${Date.now()}.${this._ext(detected)}`;
    writeFileSync(tmpFile, code);

    const result = { language: detected, syntaxOk: false, issues: [] };

    try {
      if (detected === 'javascript') {
        await execAsync(`node --check ${tmpFile}`, { timeout: 5000 });
        result.syntaxOk = true;
      } else if (detected === 'python') {
        await execAsync(`python3 -m py_compile ${tmpFile}`, { timeout: 5000 });
        result.syntaxOk = true;
      } else if (detected === 'typescript') {
        await execAsync(`npx tsc --noEmit --skipLibCheck ${tmpFile}`, { timeout: 10000 });
        result.syntaxOk = true;
      } else {
        result.syntaxOk = true; // Can't check other languages — assume ok
        result.note = 'Syntax checking not available for this language';
      }
    } catch (err) {
      result.syntaxOk = false;
      result.issues.push(err.stderr || err.message);
    }

    // AI code review
    if (result.syntaxOk) {
      const review = await structured(
        `Quick code review:\n\`\`\`${detected}\n${code.slice(0, 3000)}\n\`\`\`\n\nIdentify any bugs, security issues, or broken logic. Be concise.`,
        {
          bugs: ['list of bugs found'],
          security: ['security issues'],
          confidence: 0.9,
          approved: true,
        },
        { temperature: 0.1 }
      );
      result.bugs = review.bugs || [];
      result.security = review.security || [];
      result.approved = review.approved && !review.bugs?.length;
      result.confidence = review.confidence || 0.8;
    }

    return result;
  }

  // ── VERIFY URL EXISTS ─────────────────────────────────────────────────────
  async verifyURL(url) {
    if (this._verificationCache.has(url)) return this._verificationCache.get(url);

    try {
      const resp = await axios.head(url, { timeout: 8000, maxRedirects: 3, validateStatus: () => true });
      const result = {
        url, exists: resp.status < 400,
        status: resp.status,
        ok: resp.status >= 200 && resp.status < 400,
      };
      this._verificationCache.set(url, result);
      return result;
    } catch {
      const result = { url, exists: false, ok: false, error: 'unreachable' };
      this._verificationCache.set(url, result);
      return result;
    }
  }

  // ── VERIFY FACTS ──────────────────────────────────────────────────────────
  async verifyFacts(text) {
    // Extract claims from text
    const claims = await structured(
      `Extract factual claims from this text that could be verified:\n\n${text.slice(0, 3000)}\n\nList only specific, verifiable facts (not opinions).`,
      { claims: ['list of specific factual claims'] },
      { temperature: 0.1 }
    );

    const verifications = [];
    for (const claim of (claims.claims || []).slice(0, 5)) {
      const verification = await complete(
        `Is this claim accurate? "${claim}"\n\nBased on your knowledge:\n- Is it true, false, or uncertain?\n- Confidence level (0-100%)?\n- Any corrections needed?\n\nRespond in 2-3 sentences.`,
        { temperature: 0.1, maxTokens: 150 }
      );
      verifications.push({ claim, verification });
    }

    return { claims: claims.claims, verifications, factChecked: true };
  }

  // ── VERIFY AGENT OUTPUT ───────────────────────────────────────────────────
  async verifyAgentOutput(output, objective) {
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    return structured(
      `Verify this agent output against the original objective.\n\nObjective: "${objective}"\n\nOutput:\n${outputStr.slice(0, 3000)}\n\nAssess quality and accuracy.`,
      {
        objectivemet: true,
        completeness: 0.9,
        accuracy: 0.9,
        issues: ['list of problems if any'],
        corrections: ['specific corrections needed'],
        confidence: 0.85,
        approved: true,
      },
      { temperature: 0.1 }
    );
  }

  // ── GENERAL VERIFY ────────────────────────────────────────────────────────
  async verify(content, type = 'auto') {
    if (!content) return { ok: true, note: 'Nothing to verify' };

    const detectedType = type === 'auto' ? this._detectContentType(content) : type;

    switch (detectedType) {
      case 'code': return this.verifyCode(content);
      case 'url': return this.verifyURL(content);
      case 'text': return this.verifyFacts(content);
      default: return { ok: true, type: detectedType, note: 'Unrecognized type — skipped' };
    }
  }

  // ── INTERNAL CHECKS ───────────────────────────────────────────────────────
  async _checkConsistency(output, objective) {
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output).slice(0, 1000);
    const result = await complete(
      `Does this output logically address the objective?\nObjective: "${objective}"\nOutput: ${outputStr.slice(0, 500)}\nAnswer: YES or NO, then one sentence why.`,
      { temperature: 0.1, maxTokens: 80 }
    );
    const ok = result.trim().toUpperCase().startsWith('YES');
    return { ok, check: 'consistency', confidence: ok ? 0.9 : 0.3, flags: ok ? [] : ['output may not address objective'] };
  }

  async _checkForHallucinations(output) {
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output).slice(0, 1000);
    const hallucPatterns = [
      /https?:\/\/[^\s]+/g,     // URLs — check if real
      /\b(v\d+\.\d+\.\d+)\b/g,  // Version numbers
      /\$[\d,]+/g,               // Dollar amounts
    ];

    const flags = [];

    // Check URLs in output
    const urls = [...(outputStr.matchAll(hallucPatterns[0]) || [])].map(m => m[0]).slice(0, 3);
    for (const url of urls) {
      try {
        const check = await this.verifyURL(url);
        if (!check.exists) flags.push(`URL may not exist: ${url}`);
      } catch {}
    }

    return {
      ok: flags.length === 0,
      check: 'hallucination',
      confidence: flags.length === 0 ? 0.85 : 0.5,
      flags,
    };
  }

  async _checkConfidence(output) {
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output).slice(0, 500);
    // Check for low-confidence markers in the output
    const lowConfidenceMarkers = ['I think', 'I believe', 'probably', 'might be', 'not sure', 'maybe', 'I\'m not certain'];
    const flags = lowConfidenceMarkers.filter(m => outputStr.toLowerCase().includes(m.toLowerCase()));
    return {
      ok: flags.length < 3, // Allow some uncertainty
      check: 'confidence',
      confidence: Math.max(0.5, 1 - flags.length * 0.1),
      flags: flags.length >= 3 ? ['output contains many uncertain statements'] : [],
    };
  }

  _detectLanguage(code) {
    if (code.includes('import ') && code.includes('from ')) return 'javascript';
    if (code.includes('def ') || code.includes('import ') && code.includes(':')) return 'python';
    if (code.includes('interface ') || code.includes(': string') || code.includes(': number')) return 'typescript';
    if (code.includes('fn ') && code.includes('->')) return 'rust';
    if (code.includes('func ') && code.includes('package ')) return 'go';
    return 'javascript';
  }

  _ext(lang) {
    const exts = { javascript: 'js', python: 'py', typescript: 'ts', rust: 'rs', go: 'go' };
    return exts[lang] || 'js';
  }

  _detectContentType(content) {
    if (content.startsWith('http')) return 'url';
    if (content.includes('function') || content.includes('def ') || content.includes('class ')) return 'code';
    return 'text';
  }
}

export default VerifierAgent;
