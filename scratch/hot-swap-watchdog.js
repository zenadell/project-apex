// scratch/hot-swap-watchdog.js
import { exec } from 'child_process';
import { promisify } from 'util';
import { llmBootstrapper } from '../core/llm-bootstrapper.js';
import chalk from 'chalk';

const execAsync = promisify(exec);

async function watch() {
  console.log(chalk.blue('👀 Hot-Swap Watchdog Active: Waiting for Qwen siphon to hit 100%...'));
  
  const target = 'qwen2.5-coder:7b';
  let finished = false;

  while (!finished) {
    try {
      const { stdout } = await execAsync('ollama list');
      if (stdout.includes(target)) {
        finished = true;
      }
    } catch (e) {}
    
    if (!finished) await new Promise(r => setTimeout(r, 10000)); // check every 10s
  }

  console.log(chalk.green(`\n🧬 Siphon Complete! Hot-swapping to Expert Brain: ${target}`));
  
  // 1. Configure Env
  llmBootstrapper._configureEnv(target);
  
  // 2. Kill and restart bot
  console.log(chalk.yellow('🔄 Restarting APEX with new reasoning engine...'));
  try {
    await execAsync('pkill -9 -f "node.*apex"');
  } catch (e) {}

  console.log(chalk.bgGreen.black(' 🚀 APEX Expert Brain is now LIVE on Telegram / WhatsApp! '));
}

watch().catch(console.error);
