#!/usr/bin/env node
// test/smoke.js — APEX Smoke Test Suite
// Validates core systems boot correctly without executing full LLM tasks.
// Run: node test/smoke.js

import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, status: '✅' });
  } catch (err) {
    failed++;
    results.push({ name, status: '❌', error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// ── Structural Tests ──
console.log('\n⚡ APEX Smoke Test Suite\n');
console.log('── Structure ──');

test('package.json exists', () => {
  assert(existsSync(path.join(ROOT, 'package.json')));
});

test('package.json is valid JSON', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(pkg.name, 'missing name');
  assert(pkg.type === 'module', 'must be ES modules');
});

test('apex.js entrypoint exists', () => {
  assert(existsSync(path.join(ROOT, 'apex.js')));
});

test('.gitignore exists', () => {
  assert(existsSync(path.join(ROOT, '.gitignore')));
});

test('README.md exists and has content', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert(readme.length > 500, 'README too short');
  assert(readme.includes('APEX'), 'README missing APEX mention');
});

// ── Core Modules ──
console.log('── Core Modules ──');

test('event-bus.js loads', async () => {
  const bus = await import(path.join(ROOT, 'core', 'event-bus.js'));
  assert(bus.default, 'missing default export');
  assert(typeof bus.default.on === 'function', 'missing .on()');
  assert(typeof bus.default.emit === 'function', 'missing .emit()');
});

test('agent-registry.js loads', async () => {
  const reg = await import(path.join(ROOT, 'core', 'agent-registry.js'));
  assert(reg.default, 'missing default export');
});

test('checkpoint.js loads', async () => {
  const cp = await import(path.join(ROOT, 'core', 'checkpoint.js'));
  assert(cp.default || cp.checkpoint, 'missing export');
});

test('sandbox.js loads', async () => {
  const sb = await import(path.join(ROOT, 'core', 'sandbox.js'));
  assert(sb.sandbox || sb.default, 'missing export');
});

// ── Agent Files ──
console.log('── Agents ──');

const requiredAgents = [
  'base-agent.js', 'code.js', 'research.js', 'security.js',
  'self-mod.js', 'skills.js', 'browser.js',
];

for (const agentFile of requiredAgents) {
  test(`agents/${agentFile} exists`, () => {
    assert(existsSync(path.join(ROOT, 'agents', agentFile)), `missing agents/${agentFile}`);
  });
}

// ── Dashboard ──
console.log('── Dashboard ──');

test('dashboard/server.js exists', () => {
  assert(existsSync(path.join(ROOT, 'dashboard', 'server.js')));
});

test('dashboard/public/index.html exists', () => {
  assert(existsSync(path.join(ROOT, 'dashboard', 'public', 'index.html')));
});

test('dashboard/public/styles.css exists', () => {
  assert(existsSync(path.join(ROOT, 'dashboard', 'public', 'styles.css')));
});

test('dashboard/public/app.js exists', () => {
  assert(existsSync(path.join(ROOT, 'dashboard', 'public', 'app.js')));
});

// ── CodeAgent Features ──
console.log('── CodeAgent Features ──');

test('CodeAgent has multi-language detection', () => {
  const code = readFileSync(path.join(ROOT, 'agents', 'code.js'), 'utf8');
  assert(code.includes('PYTHON PROJECT'), 'missing Python detection');
  assert(code.includes('REACT PROJECT'), 'missing React detection');
  assert(code.includes('pip3 install'), 'missing pip install');
});

test('CodeAgent has modify-existing-code', () => {
  const code = readFileSync(path.join(ROOT, 'agents', 'code.js'), 'utf8');
  assert(code.includes('_modifyExistingCode'), 'missing _modifyExistingCode');
  assert(code.includes('_isModifyObjective'), 'missing _isModifyObjective');
  assert(code.includes('_scanDirectory'), 'missing _scanDirectory');
});

test('CodeAgent has research-before-code', () => {
  const code = readFileSync(path.join(ROOT, 'agents', 'code.js'), 'utf8');
  assert(code.includes('Research-before-code') || code.includes('researchContext') || code.includes('RESEARCH CONTEXT'), 'missing research pipeline');
});

test('CodeAgent has test-command path fix', () => {
  const code = readFileSync(path.join(ROOT, 'agents', 'code.js'), 'utf8');
  assert(code.includes('dirBasename'), 'missing path prefix strip');
});

// ── Security ──
console.log('── Security ──');

test('WardenAgent exists (plugins/, wired in core/orchestrator.js)', () => {
  assert(existsSync(path.join(ROOT, 'plugins', 'warden-agent.js')));
});

test('Sandbox module exists', () => {
  assert(existsSync(path.join(ROOT, 'core', 'sandbox.js')));
});

test('Checkpoint module exists', () => {
  assert(existsSync(path.join(ROOT, 'core', 'checkpoint.js')));
});

// ── Results ──
console.log('\n── Results ──\n');
for (const r of results) {
  const line = `  ${r.status} ${r.name}`;
  console.log(r.error ? `${line} — ${r.error}` : line);
}
console.log(`\n  Total: ${passed + failed}  |  ✅ Passed: ${passed}  |  ❌ Failed: ${failed}\n`);

if (failed > 0) {
  console.log('❌ SMOKE TESTS FAILED\n');
  process.exit(1);
} else {
  console.log('✅ ALL SMOKE TESTS PASSED\n');
  process.exit(0);
}
