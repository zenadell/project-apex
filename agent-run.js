#!/usr/bin/env node
// agent-run.js — drive APEX's agentic loop on a single task from the CLI.
//
// Usage:
//   node agent-run.js "your task here"
//   node agent-run.js "your task here" --workspace /tmp/demo --max-steps 20
//
// The agent reads/writes/runs ONLY inside the workspace (default: ./apex-workspace).

import { runAgentLoop } from './core/agent-loop.js';
import path from 'path';
import chalk from 'chalk';

const argv = process.argv.slice(2);
let workspace = path.resolve('./apex-workspace');
let maxSteps = 30;
const goalParts = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--workspace' || argv[i] === '-w') workspace = path.resolve(argv[++i]);
  else if (argv[i] === '--max-steps') maxSteps = parseInt(argv[++i], 10) || 30;
  else goalParts.push(argv[i]);
}

const goal = goalParts.join(' ').trim();
if (!goal) {
  console.error('Usage: node agent-run.js "<task>" [--workspace <dir>] [--max-steps <n>]');
  process.exit(1);
}

const C = { dim: chalk.gray, act: chalk.cyan, ok: chalk.green, err: chalk.red, info: chalk.yellow };

console.log(chalk.bold('\n⚡ APEX agentic loop'));
console.log(C.dim(`   task:      ${goal}`));
console.log(C.dim(`   workspace: ${workspace}\n`));

const res = await runAgentLoop(goal, {
  workspace,
  maxSteps,
  onEvent(ev) {
    if (ev.type === 'action') {
      const tag = ev.model === 'pro' ? chalk.magenta(' [pro]') : '';
      console.log(C.act(`▸ step ${ev.step}: ${ev.tool}`) + tag + C.dim(`  ${ev.thought || ''}`));
      const a = ev.args || {};
      if (a.path) console.log(C.dim(`    path: ${a.path}`));
      if (a.query) console.log(C.dim(`    search: ${a.query}`));
      if (a.command) console.log(C.dim(`    $ ${a.command}`));
    } else if (ev.type === 'escalate') {
      console.log(C.info(`    ⤴ stuck (${ev.errorStreak} errors) — escalating to pro reasoner`));
    } else if (ev.type === 'compact') {
      console.log(C.info(`    ⧉ context compacted (${ev.fromMessages} msgs → summary + recent)`));
    } else if (ev.type === 'snapshot') {
      console.log(C.dim('    📷 workspace snapshot taken (rollback armed)'));
    } else if (ev.type === 'rolledback') {
      console.log(C.err('    ⏪ build failed — workspace rolled back'));
    } else if (ev.type === 'observation') {
      const head = (ev.observation || '').split('\n').slice(0, 4).join('\n    ');
      console.log((ev.ok ? C.ok('    ✓ ') : C.err('    ✗ ')) + C.dim(head));
    } else if (ev.type === 'parse_fail') {
      console.log(C.err(`    ! step ${ev.step}: model did not return a valid tool call`));
    } else if (ev.type === 'llm_error') {
      console.log(C.err(`    ! LLM error: ${ev.error}`));
    } else if (ev.type === 'finish') {
      console.log('\n' + (ev.success ? C.ok('✅ finished: ') : C.err('⚠️  finished (not ok): ')) + ev.summary);
    } else if (ev.type === 'max_steps') {
      console.log(C.err(`\n⚠️  hit max steps (${ev.steps})`));
    }
  },
});

console.log(chalk.bold(`\n── done in ${res.steps} steps · success=${res.success} ──\n`));
process.exit(res.success ? 0 : 1);
