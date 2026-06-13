// agents/qa.js
// APEX QAAgent — Tests everything. Finds bugs, red-teams outputs, runs security checks, approves final builds.
import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { exec } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export class QAAgent extends BaseAgent {
  constructor() {
    super({
      name: 'QAAgent',
      type: 'quality_assurance',
      description: 'Tests code quality, security, functionality, and performance. Red-teams outputs. Generates test suites. Approves or rejects builds with detailed reports.',
    });
  }

  async run(task) {
    const { objective, targetDir = null, files = [], code = null, type = 'full' } = task;

    this.log(`QAAgent: ${type} check on "${objective}"`);

    const report = {
      objective,
      passed: false,
      score: 0,
      checks: [],
      issues: [],
      approved: false,
    };

    if (type === 'code_review' || code) {
      return this._reviewCode(code || files, objective);
    }

    if (targetDir && existsSync(targetDir)) {
      // Full directory QA
      report.checks.push(await this._staticAnalysis(targetDir));
      report.checks.push(await this._securityScan(targetDir));
      report.checks.push(await this._runTests(targetDir));
      report.checks.push(await this._accessibilityCheck(targetDir));
      report.checks.push(await this._performanceCheck(targetDir));
    } else if (files.length) {
      report.checks.push(await this._reviewFiles(files, objective));
    }

    // Calculate score
    const scores = report.checks.filter(c => c.score !== undefined).map(c => c.score);
    report.score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 50;
    report.passed = report.score >= 70;
    report.approved = report.score >= 80;

    // AI red-team analysis
    report.redTeam = await this._redTeam(objective, report.checks, targetDir);

    // Generate fix recommendations
    report.fixes = await this._generateFixes(report);

    this.log(`QA Score: ${report.score}/100 — ${report.approved ? '✅ APPROVED' : '❌ NEEDS WORK'}`);
    this.remember(
      `QA for "${objective}": score=${report.score}, approved=${report.approved}`,
      { tags: ['qa', 'testing'], importance: 7 }
    );

    return report;
  }

  async _staticAnalysis(dir) {
    const check = { name: 'Static Analysis', score: 70, issues: [], passed: true };
    try {
      // Try ESLint if available
      try {
        const { stdout } = await execAsync(`npx eslint ${dir} --format json --quiet 2>/dev/null`, { timeout: 30000 });
        const results = JSON.parse(stdout);
        const errors = results.flatMap(r => r.messages.filter(m => m.severity === 2));
        const warnings = results.flatMap(r => r.messages.filter(m => m.severity === 1));
        check.errors = errors.length;
        check.warnings = warnings.length;
        check.score = Math.max(0, 100 - errors.length * 5 - warnings.length * 1);
        check.issues = errors.slice(0, 5).map(e => `${e.ruleId}: ${e.message}`);
      } catch {
        // ESLint not available — do manual analysis
        const files = this._getFiles(dir, ['.js', '.jsx', '.ts', '.tsx']);
        let issues = 0;
        for (const file of files.slice(0, 20)) {
          const content = readFileSync(file, 'utf8');
          if (content.includes('console.log')) issues++;
          if (content.includes('eval(')) { check.issues.push('eval() usage detected'); issues += 5; }
          if (content.includes('TODO') || content.includes('FIXME')) issues++;
          if (!content.includes('try') && content.includes('await')) issues++;
        }
        check.score = Math.max(40, 100 - issues * 3);
      }
    } catch (err) {
      check.error = err.message;
    }
    return check;
  }

  async _securityScan(dir) {
    const check = { name: 'Security Scan', score: 80, issues: [], passed: true };
    const dangerousPatterns = [
      { pattern: /eval\(/g, severity: 'critical', desc: 'eval() usage' },
      { pattern: /innerHTML\s*=/g, severity: 'high', desc: 'innerHTML assignment (XSS risk)' },
      { pattern: /exec\(.*req\./g, severity: 'critical', desc: 'Command injection risk' },
      { pattern: /SELECT.*FROM.*\+/g, severity: 'critical', desc: 'SQL injection risk' },
      { pattern: /require\(['"]\.\.\/\.\.\/\.\.\//g, severity: 'medium', desc: 'Path traversal attempt' },
      { pattern: /password\s*=\s*['"][^'"]{3,}/g, severity: 'critical', desc: 'Hardcoded password' },
      { pattern: /api_?key\s*=\s*['"][^'"]{10,}/gi, severity: 'critical', desc: 'Hardcoded API key' },
      { pattern: /secret\s*=\s*['"][^'"]{5,}/gi, severity: 'high', desc: 'Hardcoded secret' },
      { pattern: /http:\/\//g, severity: 'low', desc: 'HTTP (not HTTPS) usage' },
    ];

    const files = this._getFiles(dir, ['.js', '.jsx', '.ts', '.tsx', '.py']);
    let deductions = 0;

    for (const file of files.slice(0, 30)) {
      const content = readFileSync(file, 'utf8');
      for (const { pattern, severity, desc } of dangerousPatterns) {
        if (pattern.test(content)) {
          check.issues.push({ file: path.basename(file), severity, desc });
          deductions += severity === 'critical' ? 20 : severity === 'high' ? 10 : severity === 'medium' ? 5 : 2;
        }
        pattern.lastIndex = 0; // Reset regex
      }
    }

    check.score = Math.max(0, 100 - deductions);
    check.passed = check.score >= 60;
    return check;
  }

  async _runTests(dir) {
    const check = { name: 'Test Suite', score: 50, passed: false };

    // Detect test framework
    const pkgPath = path.join(dir, 'package.json');
    let testCmd = null;

    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified"') {
        testCmd = 'npm test';
      } else if (pkg.devDependencies?.jest || pkg.dependencies?.jest) {
        testCmd = 'npx jest --passWithNoTests';
      } else if (pkg.devDependencies?.vitest) {
        testCmd = 'npx vitest run';
      }
    }

    if (!testCmd) {
      check.score = 40;
      check.note = 'No test suite found — generating tests';
      check.generated = await this._generateTests(dir);
      return check;
    }

    try {
      const { stdout, stderr } = await execAsync(testCmd, { cwd: dir, timeout: 60000 });
      check.output = (stdout + stderr).slice(0, 2000);
      check.passed = !stderr.includes('FAIL') && !stdout.includes('0 tests');
      check.score = check.passed ? 90 : 40;
    } catch (err) {
      check.output = err.message.slice(0, 1000);
      check.score = 20;
      check.errors = err.stderr?.slice(0, 500);
    }

    return check;
  }

  async _accessibilityCheck(dir) {
    const check = { name: 'Accessibility', score: 70, issues: [] };
    const htmlFiles = this._getFiles(dir, ['.html', '.jsx', '.tsx']);

    for (const file of htmlFiles.slice(0, 10)) {
      const content = readFileSync(file, 'utf8');
      if (!content.includes('alt=')) check.issues.push('Missing alt attributes on images');
      if (!content.includes('aria-') && !content.includes('role=')) check.issues.push('No ARIA attributes found');
      if (!content.includes('lang=')) check.issues.push('Missing lang attribute on html element');
      if (content.includes('<button') && !content.includes('aria-label') && !content.includes('>')) {
        check.issues.push('Buttons may lack accessible labels');
      }
    }

    check.score = Math.max(40, 100 - check.issues.length * 10);
    return check;
  }

  async _performanceCheck(dir) {
    const check = { name: 'Performance', score: 75, issues: [] };
    const jsFiles = this._getFiles(dir, ['.js', '.jsx', '.ts', '.tsx']);
    let totalSize = 0;

    for (const file of jsFiles) {
      const { size } = (await import('fs')).statSync(file);
      totalSize += size;
      const content = readFileSync(file, 'utf8');
      if (content.split('\n').length > 500) check.issues.push(`Large file: ${path.basename(file)}`);
      if ((content.match(/import/g) || []).length > 30) check.issues.push(`Many imports in: ${path.basename(file)}`);
    }

    if (totalSize > 500000) check.issues.push(`Total JS size: ${(totalSize / 1024).toFixed(0)}KB (consider code splitting)`);
    check.totalSizeKB = (totalSize / 1024).toFixed(1);
    check.score = Math.max(50, 100 - check.issues.length * 8);
    return check;
  }

  async _reviewCode(code, objective) {
    const codeStr = Array.isArray(code) ? code.map(f => `// ${f.path}\n${f.content}`).join('\n\n') : code;

    return structured(
      `Perform expert code review for: "${objective}"\n\nCode:\n${codeStr.slice(0, 8000)}\n\nProvide thorough analysis.`,
      {
        score: 'overall quality score 0-100',
        approved: 'true/false',
        strengths: ['list of strong points'],
        issues: [{ severity: 'critical|high|medium|low', description: 'issue description', fix: 'how to fix' }],
        securityVulnerabilities: ['list of security concerns'],
        performanceIssues: ['list of performance problems'],
        bestPracticeViolations: ['coding standard violations'],
        suggestions: ['improvement suggestions'],
        summary: 'executive summary of code quality',
      }
    );
  }

  async _reviewFiles(files, objective) {
    return this._reviewCode(files, objective);
  }

  async _redTeam(objective, checks, dir) {
    const checkSummary = checks.map(c => `${c.name}: score=${c.score}, issues=${JSON.stringify(c.issues?.slice(0, 3))}`).join('\n');
    return complete(
      `Red-team analysis for: "${objective}"\n\nQA checks:\n${checkSummary}\n\nAs an adversarial tester, identify:\n1. What could go wrong in production?\n2. What attack vectors exist?\n3. What edge cases could crash this?\n4. What would a malicious user try?\n5. What monitoring is missing?\n\nBe specific and technical.`,
      { temperature: 0.6, maxTokens: 1500 }
    );
  }

  async _generateFixes(report) {
    const allIssues = report.checks.flatMap(c => c.issues || []);
    if (!allIssues.length) return [];

    return structured(
      `Generate specific fixes for these QA issues:\n${JSON.stringify(allIssues, null, 2)}\n\nProvide actionable fixes.`,
      {
        fixes: [
          {
            issue: 'issue description',
            fix: 'specific code or action to fix it',
            priority: 'critical|high|medium|low',
          }
        ]
      }
    );
  }

  async _generateTests(dir) {
    const files = this._getFiles(dir, ['.js', '.ts']).slice(0, 5);
    const testCode = await complete(
      `Generate a comprehensive test suite for these files:\n${files.map(f => `${path.basename(f)}:\n${readFileSync(f, 'utf8').slice(0, 1000)}`).join('\n---\n')}\n\nUse Jest syntax. Test all exported functions. Include edge cases.`,
      { temperature: 0.2, maxTokens: 3000 }
    );
    return testCode;
  }

  _getFiles(dir, extensions) {
    const results = [];
    const walk = (d) => {
      if (!existsSync(d)) return;
      try {
        const entries = readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(e.name)) continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (extensions.some(ext => e.name.endsWith(ext))) results.push(full);
        }
      } catch {}
    };
    walk(dir);
    return results;
  }
}

export default QAAgent;
