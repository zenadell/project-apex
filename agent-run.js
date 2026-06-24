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
  verify: true,   // an independent read-only agent must confirm the work before finish is accepted
  learn: true,    // recall lessons from similar past tasks; distill this one on success
  onEvent(ev) {
    const pad = '  '.repeat(ev.depth || 0);   // indent sub-agents by delegation depth
    if (ev.verifier) {
      // tag verifier sub-agent lines so they're visually distinct
      if (ev.type === 'action') console.log(pad + chalk.blue(`  🔍 verify: ${ev.tool} `) + C.dim(ev.args?.command || ev.args?.path || ''));
      return;
    }
    if (ev.type === 'action') {
      const tag = ev.model === 'pro' ? chalk.magenta(' [pro]') : '';
      console.log(pad + C.act(`▸ step ${ev.step}: ${ev.tool}`) + tag + C.dim(`  ${ev.thought || ''}`));
      const a = ev.args || {};
      if (a.path) console.log(pad + C.dim(`    path: ${a.path}`));
      if (a.query) console.log(pad + C.dim(`    search: ${a.query}`));
      if (a.command) console.log(pad + C.dim(`    $ ${a.command}`));
    } else if (ev.type === 'plan') {
      console.log(pad + C.info('    ☑ plan:'));
      for (const t of ev.todos) {
        const box = t.status === 'done' ? C.ok('[x]') : t.status === 'in_progress' ? C.info('[~]') : C.dim('[ ]');
        console.log(pad + `      ${box} ${t.task}`);
      }
    } else if (ev.type === 'delegate_start') {
      console.log(pad + chalk.magenta(`    ⇣ delegating to sub-agent: `) + C.dim(ev.task.slice(0, 80)));
    } else if (ev.type === 'delegate_end') {
      console.log(pad + (ev.success ? C.ok('    ⇡ sub-agent done: ') : C.err('    ⇡ sub-agent failed: ')) + C.dim((ev.summary || '').slice(0, 90)));
    } else if (ev.type === 'stuck') {
      console.log(pad + C.info(`    ⤴ stuck (${ev.errorStreak} fails) — self-healing: diagnose + adapt (pro reasoner)`));
    } else if (ev.type === 'degrade') {
      console.log(pad + C.info(`    ⬇ giving up the ideal path — shipping best partial result from what works`));
    } else if (ev.type === 'compact') {
      console.log(pad + C.info(`    ⧉ context compacted (${ev.fromMessages} msgs → summary + recent)`));
    } else if (ev.type === 'snapshot') {
      console.log(pad + C.dim('    📷 workspace snapshot taken (rollback armed)'));
    } else if (ev.type === 'rolledback') {
      console.log(pad + C.err('    ⏪ build failed — workspace rolled back'));
    } else if (ev.type === 'verify_start') {
      console.log(pad + chalk.blue('    🔍 independent verifier checking the claim (read-only, runs the code)...'));
    } else if (ev.type === 'verify_end') {
      console.log(pad + (ev.verified ? C.ok('    ✓ verified: ') : C.err('    ✗ NOT verified: ')) + C.dim((ev.reason || '').slice(0, 100)));
    } else if (ev.type === 'verify_rejected') {
      console.log(pad + C.err(`    ↩ finish rejected by verifier — agent must keep working`));
    } else if (ev.type === 'recall') {
      console.log(pad + C.info(`    🧠 recalled ${ev.count} lesson(s) from similar past tasks`));
    } else if (ev.type === 'learned') {
      console.log(pad + C.info(`    🧠 distilled a reusable lesson from this run`));
    } else if (ev.type === 'observation') {
      const head = (ev.observation || '').split('\n').slice(0, 4).join('\n' + pad + '    ');
      console.log(pad + (ev.ok ? C.ok('    ✓ ') : C.err('    ✗ ')) + C.dim(head));
    } else if (ev.type === 'parse_fail') {
      console.log(pad + C.err(`    ! step ${ev.step}: model did not return a valid tool call`));
    } else if (ev.type === 'llm_error') {
      console.log(pad + C.err(`    ! LLM error: ${ev.error}`));
    } else if (ev.type === 'finish') {
      if (!ev.depth) console.log('\n' + (ev.success ? C.ok('✅ finished: ') : C.err('⚠️  finished (not ok): ')) + ev.summary);
    } else if (ev.type === 'max_steps') {
      console.log(pad + C.err(`⚠️  hit max steps (${ev.steps})`));
    }
  },
});

console.log(chalk.bold(`\n── done in ${res.steps} steps · success=${res.success} ──\n`));
process.exit(res.success ? 0 : 1);
