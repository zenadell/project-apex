#!/usr/bin/env node
// apex.js — APEX CLI Entry Point
import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { orchestrator } from './core/orchestrator.js';
import Memory from './core/memory.js';
import registry from './core/agent-registry.js';
import { startDashboard } from './dashboard/server.js';
import { exec } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

dotenv.config();

// Workspace Manager helper
function getOutputDir(task, opts) {
  if (opts.output) return opts.output;
  if (opts.project) return path.join(process.cwd(), 'projects', opts.project);
  
  // Auto-generate project folder
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').substring(0, 30);
  const projectName = `${slug}-${Date.now()}`;
  return path.join(process.cwd(), 'projects', projectName);
}

// ─── Global Process Armor ──────────────────────────────────────────────────────
process.on('uncaughtException', async (err) => {
  console.log(chalk.bgRed.white('\n 🚨 UNCAUGHT EXCEPTION — FATAL PROCESS CRASH INTERCEPTED 🚨 '));
  console.log(chalk.red(err.stack));
  try {
    const { default: bus } = await import('./core/event-bus.js');
    bus.emit('system:fatal_crash', { error: err.stack, type: 'uncaughtException' });
  } catch {}
});

process.on('unhandledRejection', async (reason, promise) => {
  console.log(chalk.bgRed.white('\n 🚨 UNHANDLED REJECTION — FATAL PROMISE CRASH INTERCEPTED 🚨 '));
  console.log(chalk.red(reason?.stack || reason));
  try {
    const { default: bus } = await import('./core/event-bus.js');
    bus.emit('system:fatal_crash', { error: reason?.stack || reason, type: 'unhandledRejection' });
  } catch {}
});

const program = new Command();

// ─── ASCII Banner ──────────────────────────────────────────────────────────────
function printBanner() {
  console.log(chalk.cyan(`
 █████╗ ██████╗ ███████╗██╗  ██╗
██╔══██╗██╔══██╗██╔════╝╚██╗██╔╝
███████║██████╔╝█████╗   ╚███╔╝
██╔══██║██╔═══╝ ██╔══╝   ██╔██╗
██║  ██║██║     ███████╗██╔╝ ██╗
╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝
`));
  console.log(chalk.gray('  Autonomous Polymorphic Execution System'));
  console.log(chalk.gray('  Beyond OpenClaw. Beyond limits.\n'));
}

// ─── Interactive REPL Mode ─────────────────────────────────────────────────────
async function interactiveMode() {
  printBanner();
  await orchestrator.init();
  
  // Start Dashboard UI Server
  startDashboard();

  // Auto-open Dashboard on macOS
  console.log(chalk.magenta('🌐 Launching APEX Live Dashboard...'));
  exec('open http://localhost:3456').on('error', () => {
    console.log(chalk.yellow('⚠️ Could not automatically open the browser. Please manually navigate to http://localhost:3456'));
  });

  console.log(chalk.cyan('💬 Interactive mode. Type your task or command.\n'));
  console.log(chalk.gray('  Commands: /status  /agents  /memory  /profile  /predict  /schedule'));
  console.log(chalk.gray('            /audit  /device <obj>  /browse <url>  /spawn <name>  /exit\n'));

  while (true) {
    const { input } = await inquirer.prompt([{
      type: 'input',
      name: 'input',
      message: chalk.cyan('APEX ›'),
      prefix: '',
    }]);

    const trimmed = input.trim();
    if (!trimmed) continue;
    if (trimmed === '/exit') { console.log(chalk.gray('Shutting down.')); process.exit(0); }

    // Handle providers command inline
    if (trimmed === '/providers') {
      const { getStatus } = await import('./core/llm-router.js');
      const status = getStatus();
      console.log(chalk.cyan('\n⚡ LLM Providers'));
      status.providers.forEach(p => {
        const a = p.available ? chalk.green('✓') : chalk.red('✗');
        const c = p.canCall ? 'ready' : 'limited';
        console.log(`  ${a} ${p.name.padEnd(10)} ${c.padEnd(8)} ${p.quality}`);
      });
      console.log('');
      continue;
    }

    // Built-in commands
    if (trimmed === '/status') {
      const status = orchestrator.status();
      console.log(chalk.cyan('\n📊 System Status'));
      console.log('Agents:', status.agents.map(a => `${a.name}[${a.status}]`).join(', '));
      console.log('Capabilities:', status.capabilities.length);
      console.log('Awareness:', JSON.stringify(status.awareness, null, 2));
      console.log('');
      continue;
    }

    if (trimmed === '/agents') {
      const agents = registry.snapshot();
      console.log(chalk.cyan('\n🤖 Agent Registry'));
      agents.forEach(a => {
        const statusColor = a.status === 'idle' ? chalk.green : a.status === 'working' ? chalk.yellow : chalk.red;
        console.log(`  ${a.name} — ${statusColor(a.status)} ${a.isDynamic ? chalk.magenta('[dynamic]') : ''}`);
      });
      console.log('');
      continue;
    }

    if (trimmed === '/memory') {
      const mems = Memory.selfAwareness();
      console.log(chalk.cyan('\n🧠 Memory System'));
      console.log(JSON.stringify(mems, null, 2));
      console.log('');
      continue;
    }

    if (trimmed === '/audit') {
      console.log(chalk.cyan('\n🔍 Running self-audit...'));
      const selfMod = registry.get('SelfModAgent');
      const audit = await selfMod._handleTask({ id: 'audit', type: 'self_audit' });
      console.log(JSON.stringify(audit?.result?.audit, null, 2));
      continue;
    }

    if (trimmed === '/profile') {
      const agent = registry.get('UserProfileAgent');
      const ctx = await agent._handleTask({ id: 'profile', action: 'status' });
      console.log(chalk.cyan('\n👤 Your Profile'));
      console.log(`  Name: ${ctx.profile?.name || 'unknown'}`);
      console.log(`  Role: ${ctx.profile?.occupation || 'unknown'}`);
      console.log(`  Level: ${ctx.profile?.expertise || 'unknown'}`);
      console.log(`  Interactions: ${ctx.profile?.interactionCount || 0}`);
      console.log(`  Autonomy: ${ctx.apex?.autonomyLevel || 'learning'}`);
      console.log(`  Top skills: ${ctx.profile?.topSkills?.join(', ') || 'none yet'}`);
      if (ctx.activeGoals?.length) {
        console.log(`  Goals: ${ctx.activeGoals.map(g => g.goal).slice(0,3).join(', ')}`);
      }
      console.log('');
      continue;
    }

    if (trimmed === '/schedule') {
      const { taskScheduler } = await import('./core/task-scheduler.js');
      const tasks = taskScheduler.list();
      console.log(chalk.cyan('\n🕐 Scheduled Tasks'));
      if (!tasks.length) console.log('  None scheduled');
      tasks.forEach(t => console.log(`  ${chalk.green(t.name)} ${chalk.gray(`[${t.schedule}] — ${t.nextRunIn}`)}`));
      console.log('');
      continue;
    }

    if (trimmed.startsWith('/device')) {
      const args = trimmed.replace('/device', '').trim();
      const agent = registry.get('DeviceAgent');
      if (args === 'screenshot') {
        const r = await agent._handleTask({ id: 'dev', action: 'screenshot' });
        console.log(chalk.green(`📸 Screenshot: ${r.path}`));
      } else if (args === 'sysinfo') {
        const r = agent.systemInfo();
        console.log(JSON.stringify(r, null, 2));
      } else if (args) {
        const r = await agent._handleTask({ id: 'dev', action: 'smart', objective: args });
        console.log(JSON.stringify(r, null, 2));
      } else {
        console.log('Usage: /device screenshot | /device sysinfo | /device <objective>');
      }
      continue;
    }

    if (trimmed.startsWith('/browse')) {
      const url = trimmed.replace('/browse', '').trim();
      if (!url) { console.log('Usage: /browse <url>'); continue; }
      const agent = registry.get('BrowserAgentPro');
      const spinner = ora(`Browsing ${url}...`).start();
      const r = await agent._handleTask({ id: 'browse', objective: `Browse ${url}`, url, screenshot: true });
      spinner.stop();
      console.log(chalk.cyan('\n📄 Page Summary:'), r.summary);
      if (r.screenshots?.[0]) console.log(chalk.gray('📸'), r.screenshots[0]);
      console.log('');
      continue;
    }

    if (trimmed.startsWith('/predict')) {
      const agent = registry.get('UserProfileAgent');
      const r = await agent._handleTask({ id: 'predict', action: 'predict', context: trimmed.replace('/predict', '').trim() });
      console.log(chalk.cyan('\n🔮 Prediction:'));
      console.log(r.prediction?.likelyNextAction);
      if (r.prediction?.suggestedProactiveActions?.length) {
        console.log(chalk.gray('Suggested proactive actions:'));
        r.prediction.suggestedProactiveActions.forEach(a => console.log(chalk.gray(`  • ${a}`)));
      }
      console.log('');
      continue;
    }

    if (trimmed.startsWith('/spawn')) {
      const agentName = trimmed.replace('/spawn', '').trim();
      if (!agentName) { console.log('Usage: /spawn <AgentName>'); continue; }
      const spawnedAgent = await registry.spawn({ name: agentName, type: 'dynamic', description: 'User-spawned agent' });
      console.log(chalk.green(`✅ Spawned: ${spawnedAgent.name}`));
      continue;
    }

        // Execute as task
    try {
      const spinner = ora({ text: 'Thinking...', color: 'cyan' }).start();
      const result = await orchestrator.execute(trimmed);
      spinner.stop();

      // Format output properly - no raw code dumps
      const { channelFormatter } = await import('./core/channel-formatter.js');
      const output = result.synthesis
        ? channelFormatter.formatChat(result.synthesis, 'dashboard')
        : JSON.stringify(result.result, null, 2).slice(0, 2000);
      console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(output);
      console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    } catch (err) {
      console.log(chalk.red(`\n❌ Error: ${err.message}\n`));
    }
  }
}

// ─── CLI Commands ──────────────────────────────────────────────────────────────
program
  .name('apex')
  .description('APEX — Autonomous Polymorphic Execution System')
  .version('1.0.0');

// Default: interactive mode
program
  .command('chat', { isDefault: true })
  .description('Start interactive APEX session')
  .action(interactiveMode);

// Run a single task
program
  .command('run <task>')
  .description('Execute a single task')
  .option('-o, --output <dir>', 'Output directory for built files')
  .option('-p, --project <name>', 'Resume work in an existing project folder')
  .option('--json', 'Output raw JSON')
  .action(async (task, opts) => {
    printBanner();
    
    // Start Dashboard UI Server for visibility
    startDashboard();

    const finalOutputDir = getOutputDir(task, opts);
    console.log(chalk.green(`\n📂 Project Workspace: ${finalOutputDir}\n`));

    const spinner = ora({ text: 'Executing...', color: 'cyan' }).start();
    try {
      const result = await orchestrator.execute(task, { outputDir: finalOutputDir });
      spinner.stop();
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(chalk.cyan('\n━━━━━━━ RESULT ━━━━━━━'));
        console.log(result.synthesis);
        console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━\n'));
      }
    } catch (err) {
      spinner.stop();
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// Workspace Manager Commands
const projectsCmd = program.command('projects').description('Manage APEX project workspaces');

projectsCmd.command('list')
  .description('List all project workspaces')
  .action(() => {
    const projectsDir = path.join(process.cwd(), 'projects');
    if (!fs.existsSync(projectsDir)) {
      console.log(chalk.yellow('No projects found.'));
      return;
    }
    const projects = fs.readdirSync(projectsDir).filter(f => fs.statSync(path.join(projectsDir, f)).isDirectory());
    console.log(chalk.cyan('\n📂 APEX Workspaces:\n'));
    projects.forEach(p => console.log(chalk.white(`  - ${p}`)));
    console.log('\n');
  });

projectsCmd.command('delete <name>')
  .description('Delete a project workspace')
  .action((name) => {
    const targetDir = path.join(process.cwd(), 'projects', name);
    if (!fs.existsSync(targetDir)) {
      console.log(chalk.red(`Project '${name}' not found.`));
      return;
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
    console.log(chalk.green(`✅ Deleted project: ${name}`));
  });

// Security scan
program
  .command('scan <target>')
  .description('Run security assessment on a target')
  .option('--authorized', 'Confirm you have authorization to test this target')
  .action(async (target, opts) => {
    await orchestrator.init();
    const agent = registry.get('SecurityAgent');
    const spinner = ora(`Scanning ${target}...`).start();
    const result = await agent._handleTask({
      id: 'scan',
      objective: `Full security assessment of ${target}`,
      target,
      authorization: opts.authorized || false,
    });
    spinner.stop();
    console.log(JSON.stringify(result, null, 2));
  });

// Research command
program
  .command('research <query>')
  .description('Deep web research on a topic')
  .action(async (query) => {
    await orchestrator.init();
    const agent = registry.get('ResearchAgent');
    const spinner = ora(`Researching "${query}"...`).start();
    const result = await agent._handleTask({ id: 'research', query, depth: 'deep' });
    spinner.stop();
    console.log(chalk.cyan('\n📚 Research Results\n'));
    console.log(result.synthesis);
  });

// Build command
program
  .command('build <objective>')
  .description('Build a complete project')
  .option('-o, --output <dir>', 'Output directory', './apex-build-output')
  .action(async (objective, opts) => {
    await orchestrator.init();
    const agent = registry.get('CodeAgent');
    const spinner = ora(`Building: ${objective}...`).start();
    const result = await agent._handleTask({
      id: 'build',
      objective,
      outputDir: opts.output,
      type: 'project',
    });
    spinner.stop();
    console.log(chalk.green(`\n✅ Built to: ${opts.output}`));
    console.log('Files:', result.files?.map(f => f.path).join(', '));
  });

// Self-audit
program
  .command('audit')
  .description('APEX self-audit and gap detection')
  .action(async () => {
    await orchestrator.init();
    const selfMod = registry.get('SelfModAgent');
    const spinner = ora('Running self-audit...').start();
    const result = await selfMod._handleTask({ id: 'audit', type: 'self_audit' });
    spinner.stop();
    console.log(JSON.stringify(result?.result?.audit, null, 2));
  });

// Status
program
  .command('status')
  .description('Show APEX system status')
  .action(async () => {
    await orchestrator.init();
    const status = orchestrator.status();
    console.log(chalk.cyan('\n📊 APEX Status'));
    console.log('─────────────────────────');
    status.agents.forEach(a => {
      const statusColor = a.status === 'idle' ? chalk.green : chalk.yellow;
      console.log(`${a.name.padEnd(20)} ${statusColor(a.status)}`);
    });
    console.log('─────────────────────────');
    console.log(`Capabilities: ${status.capabilities.length}`);
    console.log(`Tasks run: ${status.awareness?.tasks?.total || 0}`);
    console.log('');
  });

// Channel integrations
program
  .command('channel <type>')
  .description('Start a messaging channel (telegram, whatsapp)')
  .option('--token <token>', 'Bot token (for Telegram)')
  .action(async (type, opts) => {
    await orchestrator.init();
    const { ChannelManager } = await import('./tools/channels.js');
    const mgr = new ChannelManager(orchestrator);

    if (type === 'telegram') {
      const token = opts.token || process.env.TELEGRAM_BOT_TOKEN;
      if (!token) { console.error('Provide --token or set TELEGRAM_BOT_TOKEN'); process.exit(1); }
      await mgr.startTelegram(token);
      console.log(chalk.green('✅ Telegram channel running. Send /start to your bot.'));
    } else if (type === 'whatsapp') {
      await mgr.startWhatsApp();
      console.log(chalk.yellow('📱 Scan the QR code with WhatsApp to connect.'));
    }

    // Keep alive
    process.on('SIGINT', () => { mgr.stopAll(); process.exit(0); });
    await new Promise(() => {});
  });

// UI build
program
  .command('ui <description>')
  .description('Design and build a UI/frontend')
  .option('-o, --output <dir>', 'Output directory', './apex-ui-output')
  .option('--framework <fw>', 'Framework (react|vanilla|vue)', 'auto')
  .action(async (description, opts) => {
    await orchestrator.init();
    const agent = registry.get('UIAgent');
    const spinner = ora(`Designing and building: ${description}...`).start();
    const result = await agent._handleTask({
      id: 'ui',
      objective: description,
      outputDir: opts.output,
      framework: opts.framework,
    });
    spinner.stop();
    console.log(chalk.green(`\n✅ UI built to: ${opts.output}`));
    console.log('Files:', result.files?.map(f => f.path).join(', '));
  });

// Full pipeline: research → architect → build UI + backend → QA
program
  .command('fullbuild <objective>')
  .description('Full pipeline: Research → Architect → Build → QA')
  .option('-o, --output <dir>', 'Output directory', './apex-fullbuild')
  .action(async (objective, opts) => {
    printBanner();
    await orchestrator.init();
    console.log(chalk.cyan(`\n🚀 Full Build Pipeline: "${objective}"\n`));

    const steps = [
      { name: '1. Research', agent: 'ResearchAgent', task: { query: objective, depth: 'deep' } },
      { name: '2. Architecture', agent: 'ArchitectAgent', task: { objective } },
      { name: '3. Backend Code', agent: 'CodeAgent', task: { objective: `Backend for: ${objective}`, outputDir: `${opts.output}/backend`, type: 'backend' } },
      { name: '4. Frontend UI', agent: 'UIAgent', task: { objective: `Frontend for: ${objective}`, outputDir: `${opts.output}/frontend` } },
      { name: '5. QA Check', agent: 'QAAgent', task: { objective, targetDir: opts.output } },
    ];

    const results = {};
    for (const step of steps) {
      const spinner = ora(chalk.blue(step.name)).start();
      try {
        const agent = registry.get(step.agent);
        results[step.name] = await agent._handleTask({ id: step.name, ...step.task });
        spinner.succeed(chalk.green(step.name));
      } catch (err) {
        spinner.fail(chalk.red(`${step.name}: ${err.message}`));
      }
    }

    console.log(chalk.cyan('\n━━━━━━━ BUILD COMPLETE ━━━━━━━'));
    console.log(chalk.green(`Output: ${opts.output}`));
    const qaResult = results['5. QA Check'];
    if (qaResult) {
      console.log(`QA Score: ${qaResult.score}/100 — ${qaResult.approved ? '✅ APPROVED' : '⚠️ NEEDS WORK'}`);
    }
  });

// Voice
program
  .command('speak <text>')
  .description('Convert text to speech')
  .action(async (text) => {
    await orchestrator.init();
    const agent = registry.get('VoiceAgent');
    await agent._handleTask({ id: 'speak', text, action: 'speak' });
  });

// Pipeline runner
program
  .command('pipeline <name>')
  .description('Run a named pipeline from config/agents.yaml')
  .option('--objective <obj>', 'Main objective variable')
  .option('--target <target>', 'Target variable (for security pipelines)')
  .action(async (name, opts) => {
    await orchestrator.init();
    const { pipelineRunner } = await import('./core/pipeline.js');
    const spinner = ora(`Running pipeline: ${name}...`).start();
    try {
      const result = await pipelineRunner.run(name, { objective: opts.objective, target: opts.target });
      spinner.stop();
      console.log(chalk.cyan('\n━━━━━━━ PIPELINE RESULT ━━━━━━━'));
      console.log(result.synthesis);
      console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));
    } catch (err) {
      spinner.fail(chalk.red(`Pipeline failed: ${err.message}`));
    }
  });

// Find free APIs
program
  .command('findapi <need>')
  .description('Find free/keyless APIs for a given need')
  .action(async (need) => {
    await orchestrator.init();
    const { apiFinder } = await import('./tools/api-finder.js');
    const spinner = ora(`Searching for APIs: ${need}...`).start();
    const result = await apiFinder.find(need);
    spinner.stop();
    console.log(chalk.cyan(`\n🔌 APIs for "${need}" (source: ${result.source})\n`));
    (result.apis || []).forEach(api => {
      console.log(chalk.green(`  • ${api.name}`) + chalk.gray(` — ${api.description || api.url}`));
      if (api.keyless) console.log(chalk.blue('    ✓ No API key required'));
      if (api.url) console.log(chalk.gray(`    ${api.url}`));
      console.log('');
    });
  });

// Device control
program
  .command('device <action>')
  .description('Control device: screenshot, type, click, notify, run-command, system-info')
  .option('--text <text>', 'Text to type')
  .option('--x <x>', 'X coordinate', parseInt)
  .option('--y <y>', 'Y coordinate', parseInt)
  .option('--path <path>', 'File path')
  .option('--app <app>', 'App name')
  .option('--command <command>', 'Command to run')
  .action(async (action, opts) => {
    await orchestrator.init();
    const agent = registry.get('DeviceAgent');
    const task = { action, ...opts };
    const spinner = ora(`Device: ${action}...`).start();
    try {
      const result = await agent._handleTask({ id: 'device', ...task });
      spinner.stop();
      console.log(chalk.green('\n✅ Done:'), JSON.stringify(result, null, 2));
    } catch (err) {
      spinner.fail(chalk.red(err.message));
    }
  });

// Advanced browser
program
  .command('browse <url>')
  .description('Open browser, interact, extract data')
  .option('--extract <what>', 'What to extract from the page')
  .option('--screenshot', 'Take a screenshot', false)
  .option('--profile <name>', 'Browser profile to use', 'default')
  .option('--fill <json>', 'Form data as JSON string to fill')
  .action(async (url, opts) => {
    await orchestrator.init();
    const agent = registry.get('BrowserAgentPro');
    const spinner = ora(`Browsing: ${url}...`).start();
    try {
      const formData = opts.fill ? JSON.parse(opts.fill) : undefined;
      const result = await agent._handleTask({
        id: 'browse',
        objective: `Browse ${url}${opts.extract ? ` and extract: ${opts.extract}` : ''}`,
        url,
        extract: opts.extract,
        screenshot: opts.screenshot,
        profile: opts.profile,
        formData,
      });
      spinner.stop();
      console.log(chalk.cyan('\n📄 Summary:'), result.summary);
      if (result.extracted) console.log(chalk.cyan('📦 Extracted:'), JSON.stringify(result.extracted, null, 2));
      if (result.screenshots?.length) console.log(chalk.gray('📸 Screenshot:'), result.screenshots[0]);
    } catch (err) {
      spinner.fail(chalk.red(err.message));
    }
  });

// User profile
program
  .command('profile [action]')
  .description('View or update your user profile (profile, goals, preferences)')
  .option('--key <key>', 'Profile field to update')
  .option('--value <value>', 'Value to set')
  .option('--goal <goal>', 'Add a goal')
  .action(async (action = 'status', opts) => {
    await orchestrator.init();
    const agent = registry.get('UserProfileAgent');
    let task = { action };
    if (opts.key && opts.value) task = { action: 'update', key: opts.key, value: opts.value };
    if (opts.goal) task = { action: 'add_goal', goal: opts.goal };
    const result = await agent._handleTask({ id: 'profile', ...task });
    console.log(chalk.cyan('\n👤 User Profile\n'));
    console.log(JSON.stringify(result, null, 2));
  });

// Task scheduler
program
  .command('schedule')
  .description('Manage scheduled tasks')
  .option('--list', 'List scheduled tasks')
  .option('--add <prompt>', 'Schedule a task')
  .option('--every <ms>', 'Run every N milliseconds')
  .option('--daily <time>', 'Run daily at HH:MM')
  .option('--cancel <id>', 'Cancel a task')
  .action(async (opts) => {
    await orchestrator.init();
    const { taskScheduler } = await import('./core/task-scheduler.js');

    if (opts.list) {
      const tasks = taskScheduler.list();
      console.log(chalk.cyan('\n🕐 Scheduled Tasks\n'));
      tasks.forEach(t => {
        console.log(chalk.green(`  ${t.name}`) + chalk.gray(` [${t.schedule}] — next: ${t.nextRunIn}`));
      });
      return;
    }

    if (opts.cancel) {
      taskScheduler.cancel(opts.cancel);
      console.log(chalk.green(`✅ Cancelled task: ${opts.cancel}`));
      return;
    }

    if (opts.add) {
      const schedule = opts.every ? `interval:${opts.every}` : opts.daily ? `daily:${opts.daily}` : 'daily:09:00';
      const id = taskScheduler.schedule({ name: opts.add.slice(0, 40), task: { prompt: opts.add }, schedule });
      console.log(chalk.green(`✅ Scheduled: ${opts.add} (${schedule}) — id: ${id}`));
    }
  });

// Deploy
program
  .command('deploy [dir]')
  .description('Deploy a project (auto-detects platform)')
  .option('--platform <p>', 'Platform: fly|railway|vercel|docker|pm2|ssh')
  .option('--name <n>', 'App name')
  .option('--prod', 'Production deploy', false)
  .action(async (dir = '.', opts) => {
    await orchestrator.init();
    const agent = registry.get('DeployAgent');
    const spinner = ora(`Deploying ${path.resolve(dir)}...`).start();
    try {
      const result = await agent._handleTask({
        id: 'deploy', action: opts.platform || 'auto',
        projectDir: path.resolve(dir), ...opts,
      });
      spinner.stop();
      console.log(chalk.green('\n✅ Deployed!'));
      if (result.url) console.log(chalk.cyan(`   URL: ${result.url}`));
      console.log(chalk.gray(JSON.stringify(result, null, 2)));
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

// Data analysis
program
  .command('data <source>')
  .description('Analyze a data file (CSV, JSON, URL)')
  .option('--query <q>', 'Natural language query about the data')
  .option('--chart', 'Generate a chart', false)
  .option('--report', 'Generate HTML report', false)
  .option('--stats', 'Show statistics', false)
  .action(async (source, opts) => {
    await orchestrator.init();
    const agent = registry.get('DataAgent');
    const spinner = ora(`Analyzing: ${source}...`).start();
    try {
      let result;
      if (opts.chart) result = await agent._handleTask({ id: 'data', action: 'visualize', filePath: source });
      else if (opts.report) result = await agent._handleTask({ id: 'data', action: 'report', filePath: source });
      else if (opts.stats) result = await agent._handleTask({ id: 'data', action: 'stats', filePath: source });
      else result = await agent._handleTask({ id: 'data', action: 'analyze', filePath: source, query: opts.query });
      spinner.stop();
      if (result.outputPath) console.log(chalk.green(`\n✅ Output: ${result.outputPath}`));
      if (result.analysis?.summary) console.log('\n' + result.analysis.summary);
      if (result.stats) console.log(JSON.stringify(result.stats, null, 2));
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

// Email
program
  .command('email <action>')
  .description('Email actions: inbox, send, draft, setup')
  .option('--to <to>', 'Recipient email')
  .option('--subject <s>', 'Email subject')
  .option('--body <b>', 'Email body')
  .option('--objective <obj>', 'Let AI draft the email from an objective')
  .action(async (action, opts) => {
    await orchestrator.init();
    const agent = registry.get('EmailCalendarAgent');
    if (action === 'setup') {
      const { email, password, service } = await inquirer.prompt([
        { type: 'input', name: 'email', message: 'Your email address:' },
        { type: 'password', name: 'password', message: 'App password (not your main password):' },
        { type: 'list', name: 'service', message: 'Email service:', choices: ['gmail', 'outlook', 'yahoo'] },
      ]);
      const result = await agent._handleTask({ id: 'email', action: 'setup', email, password, service });
      console.log(chalk.green('✅ Email configured:', result.email));
      return;
    }
    const result = await agent._handleTask({ id: 'email', action, ...opts });
    console.log(JSON.stringify(result, null, 2));
  });

// Vision
program
  .command('vision [imagePath]')
  .description('Analyze an image or screenshot with AI vision')
  .option('--screenshot', 'Take a screenshot first', false)
  .option('--url <url>', 'Analyze image from URL')
  .option('--prompt <p>', 'What to analyze/look for')
  .option('--ocr', 'Just extract text', false)
  .action(async (imagePath, opts) => {
    await orchestrator.init();
    const agent = registry.get('VisionAgent');
    const spinner = ora('Analyzing with AI vision...').start();
    try {
      const action = opts.ocr ? 'ocr' : opts.screenshot ? 'screenshot_and_analyze' : 'analyze';
      const result = await agent._handleTask({
        id: 'vision', action, imagePath, imageUrl: opts.url,
        prompt: opts.prompt, screenshot: opts.screenshot,
      });
      spinner.stop();
      console.log(chalk.cyan('\n👁️  Vision Analysis\n'));
      console.log(result.analysis);
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

// Bridge server
program
  .command('bridge')
  .description('Start APEX cross-device bridge server')
  .option('--port <port>', 'Port to listen on', '7331')
  .option('--connect <url>', 'Connect to a remote APEX bridge instead')
  .action(async (opts) => {
    await orchestrator.init();
    const { bridgeManager } = await import('./tools/device-bridge.js');

    if (opts.connect) {
      console.log(chalk.cyan(`Connecting to APEX at ${opts.connect}...`));
      const client = await bridgeManager.connectTo(opts.connect);
      const status = await client.status();
      console.log(chalk.green(`✅ Connected to APEX on ${status.host}`));
      console.log(`Agents: ${status.agents?.map(a => a.name).join(', ')}`);

      // Interactive remote session
      while (true) {
        const { input } = await inquirer.prompt([{ type: 'input', name: 'input', message: chalk.cyan('APEX Remote ›'), prefix: '' }]);
        if (input === '/exit') break;
        const result = await client.task(input);
        console.log(chalk.cyan('─'.repeat(40)));
        console.log(result);
        console.log(chalk.cyan('─'.repeat(40) + '\n'));
      }
    } else {
      const server = await bridgeManager.startServer(orchestrator, parseInt(opts.port));
      console.log(chalk.green(`✅ Bridge server running on port ${opts.port}`));
      console.log(chalk.gray('Waiting for devices to connect...\n'));
      process.on('SIGINT', () => { server.stop(); process.exit(0); });
      await new Promise(() => {}); // keep alive
    }
  });

// Proactive status
program
  .command('proactive')
  .description('Show proactive engine status')
  .action(async () => {
    await orchestrator.init();
    const { proactiveEngine } = await import('./core/proactive-engine.js');
    const status = proactiveEngine.getStatus();
    console.log(chalk.cyan('\n🔮 Proactive Engine Status'));
    console.log(`Running: ${status.running ? chalk.green('yes') : chalk.red('no')}`);
    console.log(`Actions this hour: ${status.actionsThisHour}/${status.maxActionsPerHour}`);
    console.log(`\nTriggers:`);
    status.triggers.forEach(t => {
      const ago = t.lastTriggered ? `${Math.round((Date.now()-t.lastTriggered)/60000)}min ago` : 'never';
      console.log(`  ${chalk.green(t.name)} — last: ${chalk.gray(ago)}`);
    });
    console.log('');
  });


// ─── Revenue ──────────────────────────────────────────────────────────────────
program
  .command('revenue [action]')
  .description('Revenue: opportunities, invoice, payment-link, report, pipeline')
  .option('--to <email>', 'Client email')
  .option('--name <name>', 'Client name')
  .option('--amount <amount>', 'Amount in USD', parseFloat)
  .option('--service <service>', 'Service description')
  .action(async (action = 'opportunities', opts) => {
    await orchestrator.init();
    const agent = registry.get('RevenueAgent');
    const spinner = ora(`Revenue: ${action}...`).start();
    try {
      const result = await agent._handleTask({
        id: 'revenue', action,
        clientEmail: opts.to, clientName: opts.name,
        amount: opts.amount,
        items: opts.amount ? [{ description: opts.service || 'Services', amount: opts.amount }] : undefined,
      });
      spinner.stop();
      console.log(JSON.stringify(result, null, 2));
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

// ─── Teams ────────────────────────────────────────────────────────────────────
program
  .command('team <teamId> [task]')
  .description('Run a team: dev_team, marketing_team, revenue_team, security_team, design_team...')
  .action(async (teamId, task) => {
    await orchestrator.init();
    const { teamManager } = await import('./core/team-manager.js');
    if (!task) {
      const teams = teamManager.listTeams();
      console.log(chalk.cyan('\nAvailable Teams:\n'));
      teams.forEach(t => console.log(`  ${t.emoji} ${chalk.green(t.id.padEnd(20))} ${t.name} — ${t.description}`));
      return;
    }
    const spinner = ora(`${teamId} working...`).start();
    const result = await teamManager.run(teamId, task);
    spinner.stop();
    console.log(chalk.cyan('\n' + '─'.repeat(40)));
    console.log(result.synthesis);
    console.log(chalk.cyan('─'.repeat(40) + '\n'));
  });

// ─── Generate ─────────────────────────────────────────────────────────────────
program
  .command('generate <type> <prompt>')
  .description('Generate image/video/3d/audio — type: image|video|3d|audio')
  .option('--width <w>', 'Width (images)', parseInt, 1024)
  .option('--height <h>', 'Height (images)', parseInt, 1024)
  .option('--provider <p>', 'Provider (auto by default)')
  .action(async (type, prompt, opts) => {
    await orchestrator.init();
    const agent = registry.get('GenerationAgent');
    const spinner = ora(`Generating ${type}...`).start();
    try {
      const result = await agent._handleTask({ id: 'gen', action: type, prompt, opts: { width: opts.width, height: opts.height, provider: opts.provider } });
      spinner.stop();
      if (result.imagePath) console.log(chalk.green(`\n✅ Image: ${result.imagePath}`));
      else if (result.videoPath) console.log(chalk.green(`\n✅ Video: ${result.videoPath}`));
      else if (result.modelPath) console.log(chalk.green(`\n✅ 3D Model: ${result.modelPath}`));
      else if (result.audioPath) console.log(chalk.green(`\n✅ Audio: ${result.audioPath}`));
      else console.log(JSON.stringify(result, null, 2));
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

// ─── Video Replicate ──────────────────────────────────────────────────────────
program
  .command('replicate <url>')
  .description('Replicate any project shown in a YouTube video or video file')
  .option('-o, --output <dir>', 'Output directory')
  .action(async (url, opts) => {
    await orchestrator.init();
    const agent = registry.get('VideoAgent');
    const spinner = ora(`Replicating from: ${url}`).start();
    try {
      const result = await agent._handleTask({ id: 'replicate', action: 'replicate', url, outputDir: opts.output });
      spinner.stop();
      console.log(chalk.green(`\n✅ Replicated: ${result.projectName}`));
      console.log(`Output: ${result.replication?.outputDir || opts.output}`);
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

// ─── 3D Blender ───────────────────────────────────────────────────────────────
program
  .command('3d <prompt>')
  .description('Create a 3D model with Blender from a text description')
  .option('--format <fmt>', 'Export format: glb/obj/stl/fbx', 'glb')
  .option('--image <path>', 'Reference image path')
  .action(async (prompt, opts) => {
    await orchestrator.init();
    const agent = registry.get('BlenderAgent');
    const spinner = ora(`Creating 3D model...`).start();
    try {
      const result = await agent._handleTask({ id: '3d', action: 'create', prompt, imagePath: opts.image, opts: { format: opts.format } });
      spinner.stop();
      if (result.modelPath) console.log(chalk.green(`\n✅ Model: ${result.modelPath}`));
      if (result.renderPath) console.log(chalk.green(`   Render: ${result.renderPath}`));
      if (result.error) console.log(chalk.red(`❌ ${result.error}`));
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

// ─── Intelligence ─────────────────────────────────────────────────────────────
program
  .command('intel')
  .description('Intelligence scan — find new tools, APIs, models to upgrade APEX')
  .option('--report', 'Show intelligence report instead of scanning')
  .action(async (opts) => {
    await orchestrator.init();
    const agent = registry.get('IntelligenceMonitor');
    const spinner = ora(opts.report ? 'Generating report...' : 'Scanning internet for new capabilities...').start();
    const result = await agent._handleTask({ id: 'intel', action: opts.report ? 'report' : 'scan' });
    spinner.stop();
    if (opts.report) {
      const r = result.report;
      console.log(chalk.cyan('\n🔍 Intelligence Report\n'));
      if (r.topOpportunities) { console.log(chalk.green('Top Opportunities:')); r.topOpportunities.forEach(o => console.log(`  • ${o}`)); }
      if (r.newFreeAPIs) { console.log(chalk.green('\nNew Free APIs:')); r.newFreeAPIs.forEach(a => console.log(`  • ${a}`)); }
    } else {
      console.log(chalk.green(`\n✅ Scan complete: ${result.findings?.length || 0} sources scanned`));
      if (result.relevant?.highPriority?.length) {
        console.log(chalk.cyan(`Auto-upgraded: ${result.relevant.highPriority.length} items`));
      }
    }
  });

// ─── MCP Server ───────────────────────────────────────────────────────────────
program
  .command('mcp')
  .description('Start APEX MCP server (connect from Cursor, Claude Desktop, Antigravity)')
  .option('--port <port>', 'Port', '7333')
  .option('--stdio', 'Stdio mode (for Claude Desktop)')
  .action(async (opts) => {
    await orchestrator.init();
    const { default: ApexMCPServer } = await import('./tools/mcp-server.js');
    const server = new ApexMCPServer(orchestrator, parseInt(opts.port));
    if (opts.stdio) {
      server.startStdio();
    } else {
      await server.start();
      console.log(chalk.gray('\nTo add to Cursor (.cursor/mcp.json):'));
      console.log(chalk.gray(JSON.stringify({ apex: { url: `http://localhost:${opts.port}/mcp` } }, null, 2)));
      process.on('SIGINT', () => process.exit(0));
      await new Promise(() => {});
    }
  });

// ─── Soul / Identity ──────────────────────────────────────────────────────────
program
  .command('soul')
  .description("Show APEX's soul — identity, values, self-model, achievements")
  .action(async () => {
    await orchestrator.init();
    const { identity } = await import('./core/identity.js');
    const soul = identity.getSoul();
    console.log(chalk.cyan('\n⚡ APEX Soul\n'));
    console.log(chalk.green('Mission:'), soul.core.purpose);
    console.log(chalk.green('Autonomy Level:'), identity._autonomyLevel());
    console.log(chalk.green('Agents:'), soul.selfModel.agentsCount);
    console.log(chalk.green('Tasks completed:'), soul.selfModel.tasksCompleted);
    console.log(chalk.green('Skills learned:'), soul.selfModel.skillsLearned.join(', ') || 'none yet');
    if (soul.achievements.length) {
      console.log(chalk.green('\nAchievements:'));
      soul.achievements.slice(-5).forEach(a => console.log(`  🏆 ${a.description}${a.value ? ' — ' + a.value : ''}`));
    }
    console.log('');
  });

// ─── Admin gate ───────────────────────────────────────────────────────────────
program
  .command('unlock <code>')
  .description('Unlock admin session for restricted features (30 min)')
  .action(async (code) => {
    const { adminGate } = await import('./core/admin-gate.js');
    const ok = adminGate.unlock(code);
    if (ok) console.log(chalk.green('✅ Admin session unlocked (30 minutes)'));
    else console.log(chalk.red('❌ Incorrect code'));
  });

program
  .command('audit-log')
  .description('Show security audit log')
  .action(async () => {
    const { adminGate } = await import('./core/admin-gate.js');
    const log = adminGate.getAuditLog(20);
    console.log(chalk.cyan('\n🔐 Security Audit Log\n'));
    log.forEach(e => {
      const color = e.authorized ? chalk.green : chalk.red;
      console.log(color(`  [${new Date(e.ts).toLocaleString()}] ${e.action} | ${e.category} | ${e.outcome} | agent: ${e.agent}`));
    });
    console.log('');
  });


// ─── LLM Providers status ─────────────────────────────────────────────────────
program
  .command('providers')
  .description('Show LLM provider status and rate limits')
  .action(async () => {
    const { getStatus } = await import('./core/llm-router.js');
    const status = getStatus();
    console.log(chalk.cyan('\n⚡ LLM Providers\n'));
    status.providers.forEach(p => {
      const avail = p.available ? chalk.green('✓') : chalk.red('✗');
      const can = p.canCall ? chalk.green('ready') : chalk.yellow('rate-limited');
      console.log(`  ${avail} ${p.name.padEnd(10)} ${can.padEnd(15)} quality:${p.quality} cost:$${p.cost}/1k`);
    });
    console.log('');
    console.log(chalk.gray('Add GROQ_API_KEY (free) for fast secondary LLM'));
    console.log(chalk.gray('Add ANTHROPIC_API_KEY for Claude Sonnet/Haiku (best quality)'));
    console.log(chalk.gray('Install Ollama for unlimited local inference'));
    console.log('');
  });


// ── Consult multiple AIs ──────────────────────────────────────────────────────
program
  .command('consult <question>')
  .description('Ask multiple AI models simultaneously and get synthesized best answer')
  .option('--compare', 'Show each model response separately without synthesizing')
  .option('--debate', 'Make models argue for and against, then judge')
  .action(async (question, opts) => {
    await orchestrator.init();
    const agent = registry.get('ConsultAgent');
    const spinner = ora('Consulting all available AI models...').start();
    try {
      let result;
      if (opts.debate) {
        result = await agent._handleTask({ id: 'debate', question, action: 'run', ...task });
        spinner.stop();
        console.log(chalk.cyan('\n⚖️  AI Debate\n'));
        console.log(chalk.green('Verdict:'), result.verdict || result);
      } else {
        result = await agent._handleTask({ id: 'consult', question, compare: opts.compare });
        spinner.stop();
        console.log(chalk.cyan(`\n🤖 ${result.modelsConsulted} models consulted\n`));
        if (opts.compare) {
          (result.responses || []).filter(r => r.success).forEach(r => {
            console.log(chalk.green(`[${r.model}]`));
            console.log(r.answer?.slice(0, 400));
            console.log('');
          });
        } else {
          console.log(result.synthesis || result);
        }
      }
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

// ── File sync ─────────────────────────────────────────────────────────────────
program
  .command('sync [action]')
  .description('File sync: status, push <file>, watch <dir>, setup-syncthing')
  .option('--file <path>', 'File to push')
  .option('--dir <dir>', 'Directory to watch/sync')
  .option('--target <target>', 'Target device/path')
  .action(async (action = 'status', opts) => {
    await orchestrator.init();
    const agent = registry.get('FileSyncAgent');
    let taskAction = action;
    if (action === 'push' && opts.file) taskAction = 'push';
    if (action === 'watch' && opts.dir) taskAction = 'watch';
    if (action === 'setup-syncthing') taskAction = 'setup';
    const result = await agent._handleTask({ id: 'sync', action: taskAction, filePath: opts.file, dir: opts.dir, target: opts.target });
    console.log(JSON.stringify(result, null, 2));
  });

// ── Wake on LAN ───────────────────────────────────────────────────────────────
program
  .command('wake [machine]')
  .description('Wake your PC remotely via magic packet (requires WoL enabled in BIOS)')
  .option('--mac <mac>', 'MAC address to wake')
  .option('--setup', 'Setup APEX as always-on service with PM2')
  .action(async (machine, opts) => {
    if (opts.setup) {
      const { setupAlwaysOn } = await import('./tools/wake-on-lan.js');
      const spinner = ora('Setting up always-on APEX...').start();
      const result = await setupAlwaysOn(process.cwd());
      spinner.stop();
      console.log(chalk.green('\n✅ APEX always-on configured'));
      result.steps.forEach(s => console.log(`  ${chalk.green('✓')} ${s.step}: ${s.status}`));
      console.log(chalk.cyan('\nCommands:'));
      Object.entries(result.commands).forEach(([k, v]) => console.log(`  ${k}: ${chalk.gray(v)}`));
      return;
    }
    const { wakeOnLAN } = await import('./tools/wake-on-lan.js');
    const target = machine || opts.mac;
    if (!target) {
      const machines = wakeOnLAN.listMachines();
      if (!machines.length) {
        console.log(chalk.yellow('No machines configured. Set APEX_MACHINES=name:mac:ip in .env'));
        console.log('Or use: node apex.js wake --mac AA:BB:CC:DD:EE:FF');
        return;
      }
      console.log(chalk.cyan('Configured machines:'));
      machines.forEach(m => console.log(`  ${m.name}: ${m.mac} (${m.ip})`));
      return;
    }
    const spinner = ora(`Waking ${target}...`).start();
    try {
      const result = await wakeOnLAN.wake(target);
      spinner.stop();
      console.log(result.woken ? chalk.green(`✅ ${result.machine} is online`) : chalk.yellow(`⚠️  Magic packet sent, couldn't verify`));
    } catch (err) { spinner.fail(chalk.red(err.message)); }
  });

program.parse();
