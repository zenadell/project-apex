#!/usr/bin/env node
// test/agent-loop.test.js — regression tests for the agentic core.
// Deterministic, no LLM calls. Locks in the behaviors that make the loop safe and correct.
// Run: node test/agent-loop.test.js

import {
  buildToolSchemas, safeResolve, extractToolCall, safeParseArgs,
  snapshotWorkspace, restoreWorkspace,
} from '../core/agent-loop.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (err) { failed++; console.log(`  ❌ ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

console.log('\n⚡ APEX agent-loop regression suite\n');

// ── Tool schemas ──
console.log('── tool schemas ──');
test('default exposes all 12 tools (incl. call_agent, call_mcp)', () => {
  const s = buildToolSchemas();
  const names = s.map(t => t.function.name);
  assert(s.length === 12, `expected 12, got ${s.length}`);
  assert(names.includes('call_agent') && names.includes('call_mcp'), 'missing call_agent/call_mcp');
  assert(s.every(t => t.type === 'function' && t.function?.name && t.function?.parameters), 'bad schema shape');
});
test('allowedTools restricts the offered set (verifier is read-only)', () => {
  const s = buildToolSchemas(['list_dir', 'read_file', 'search', 'run', 'finish']);
  const names = s.map(t => t.function.name);
  assert(s.length === 5, `expected 5, got ${s.length}`);
  assert(!names.includes('write_file') && !names.includes('edit_file') && !names.includes('delegate'), 'verifier must not get write/edit/delegate');
});

// ── Workspace containment ──
console.log('── workspace containment ──');
test('safeResolve allows paths inside the workspace', () => {
  const ws = '/tmp/apex-ws-test';
  assert(safeResolve(ws, 'a/b.js') === path.resolve(ws, 'a/b.js'), 'inside path mismatch');
  assert(safeResolve(ws, '.') === path.resolve(ws), 'root mismatch');
});
test('safeResolve rejects escapes (../, absolute outside)', () => {
  const ws = '/tmp/apex-ws-test';
  let threw = false; try { safeResolve(ws, '../../etc/passwd'); } catch { threw = true; }
  assert(threw, 'should reject ../ escape');
  threw = false; try { safeResolve(ws, '/etc/passwd'); } catch { threw = true; }
  assert(threw, 'should reject absolute path outside workspace');
});

// ── JSON fallback parsing ──
console.log('── parsing (JSON fallback path) ──');
test('extractToolCall parses a bare JSON object', () => {
  const c = extractToolCall('{"tool":"run","args":{"command":"node x.js"}}');
  assert(c && c.tool === 'run' && c.args.command === 'node x.js', 'parse failed');
});
test('extractToolCall handles code fences and surrounding prose', () => {
  const c = extractToolCall('Sure!\n```json\n{"tool":"finish","args":{"summary":"done"}}\n```');
  assert(c && c.tool === 'finish', 'fenced parse failed');
});
test('extractToolCall returns null on non-JSON', () => {
  assert(extractToolCall('no json here at all') === null, 'should be null');
});
test('safeParseArgs handles strings, objects, fences, and garbage', () => {
  assert(safeParseArgs('{"path":"x"}').path === 'x', 'string parse');
  assert(safeParseArgs({ path: 'y' }).path === 'y', 'object passthrough');
  assert(safeParseArgs('```json\n{"a":1}\n```').a === 1, 'fenced parse');
  assert(JSON.stringify(safeParseArgs('not json')) === '{}', 'garbage → {}');
});

// ── Rollback (file-based snapshot/restore) ──
console.log('── rollback ──');
test('snapshot + restore recovers corrupted, added, and deleted files', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-rb-'));
  fs.mkdirSync(path.join(ws, 'sub'));
  fs.writeFileSync(path.join(ws, 'keep.txt'), 'ORIGINAL');
  fs.writeFileSync(path.join(ws, 'sub', 'nested.txt'), 'NESTED');
  const backup = snapshotWorkspace(ws);
  fs.writeFileSync(path.join(ws, 'keep.txt'), 'CORRUPT');     // corrupt
  fs.writeFileSync(path.join(ws, 'junk.txt'), 'JUNK');         // add
  fs.rmSync(path.join(ws, 'sub', 'nested.txt'));               // delete
  restoreWorkspace(backup, ws);
  assert(fs.readFileSync(path.join(ws, 'keep.txt'), 'utf8') === 'ORIGINAL', 'corrupt not restored');
  assert(!fs.existsSync(path.join(ws, 'junk.txt')), 'junk not removed');
  assert(fs.readFileSync(path.join(ws, 'sub', 'nested.txt'), 'utf8') === 'NESTED', 'deleted not restored');
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(backup, { recursive: true, force: true });
});

console.log(`\n  Total: ${passed + failed}  |  ✅ ${passed}  |  ❌ ${failed}\n`);
process.exit(failed ? 1 : 0);
