// core/llm-bootstrapper.js
// APEX Core Brain Resuscitation
// Empowers APEX to autonomously evaluate device capabilities, check for Ollama, download reasoning models, and bootstrap itself when Cloud APIs die.

import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';
import bus from './event-bus.js';
import dotenv from 'dotenv';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { progressMonitor } from '../tools/progress-monitor.js';

const execAsync = promisify(exec);

export class LLMBootstrapper {
  constructor() {
    this._ollamaPath = 'ollama'; // default
  }

  // High-priority reasoning & coding models ranked by RAM requirements
  static PREFERRED_MODELS = [
    { name: 'qwen2.5-coder:7b', minRamGB: 16, tags: ['coding', 'expert', 'reasoning'] },
    { name: 'llama3.1:8b', minRamGB: 12, tags: ['reasoning', 'general'] },
    { name: 'mistral:latest', minRamGB: 8, tags: ['fast', 'reasoning'] },
    { name: 'llama3.2:3b', minRamGB: 4, tags: ['fast', 'general'] }
  ];

  async rescue() {
    console.log(chalk.bgRed.white(' 🚨 APEX SYSTEM CRITICAL: ALL LLM CLOUD PROVIDERS FAILED 🚨 '));
    console.log(chalk.yellow('🧬 Autonomously initiating local brain bootstrapping sequence...'));

    const ramGB = os.totalmem() / (1024 * 1024 * 1024);
    const platform = os.platform();
    console.log(chalk.blue(`💻 Host Environment: ${platform} | RAM: ${ramGB.toFixed(1)}GB`));

    // Detect path dynamically
    this._ollamaPath = await this._detectOllamaPath();
    console.log(chalk.gray(`  [Bootstrapper] Using Ollama path: ${this._ollamaPath}`));

    // 1. Check/Install Ollama
    await this._ensureOllamaInstalled(platform);

    // 2. Ensure service is running
    await this._startOllamaService(platform);

    // 3. Find existing capable model or pick optimal to download
    const model = await this._selectOrDownloadModel(ramGB);

    // 4. Hot-swap configuration
    this._configureEnv(model);
    
    console.log(chalk.green(`✅ APEX Brain Successfully Resuscitated on Local LLM (${model})`));
    bus.emit('llm:bootstrapped_local_model', { model });
    return true;
  }

  async _detectOllamaPath() {
    const commonPaths = ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/usr/bin/ollama'];
    for (const p of commonPaths) {
      if (existsSync(p)) return p;
    }
    // Try 'which'
    try {
      const { stdout } = await execAsync('which ollama');
      if (stdout.trim()) return stdout.trim();
    } catch {}
    return 'ollama';
  }

  async _ensureOllamaInstalled(platform) {
    try {
      await execAsync(`${this._ollamaPath} --version`, { timeout: 10000 });
      console.log(chalk.green('✓ Ollama engine detected.'));
    } catch {
      console.log(chalk.yellow('⚠️ Ollama missing. Autonomously installing...'));
      if (platform === 'darwin') {
        await execAsync('brew install ollama', { timeout: 120000 });
      } else {
        await execAsync('curl -fsSL https://ollama.com/install.sh | sh', { timeout: 120000 });
      }
      // Re-detect
      this._ollamaPath = await this._detectOllamaPath();
      console.log(chalk.green('✓ Ollama engine installed.'));
    }
  }

  async _startOllamaService(platform) {
    try {
      await execAsync('curl -s -f -o /dev/null http://localhost:11434/api/tags');
      console.log(chalk.green('✓ Ollama service running.'));
    } catch {
      console.log(chalk.yellow('🔄 Starting Ollama service...'));
      if (platform === 'darwin') {
        await execAsync('brew services start ollama').catch(() => {});
      }
      // On linux it's usually systemctl, or just start background process
      exec(`${this._ollamaPath} serve > /dev/null 2>&1 &`);
      
      // wait for it
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          await execAsync('curl -s -f -o /dev/null http://localhost:11434/api/tags');
          console.log(chalk.green('✓ Ollama service online.'));
          return;
        } catch {}
      }
      throw new Error('Failed to start Ollama service.');
    }
  }

  async _selectOrDownloadModel(ramGB) {
    const { stdout } = await execAsync(`${this._ollamaPath} list`);
    const existing = stdout.split('\n').slice(1).map(l => l.split(' ')[0]).filter(x => x);
    
    // Check if we already have a preferred model
    for (const pref of LLMBootstrapper.PREFERRED_MODELS) {
      if (existing.some(m => m.includes(pref.name.split(':')[0]))) {
        const match = existing.find(m => m.includes(pref.name.split(':')[0]));
        console.log(chalk.green(`✓ Found existing capable local model: ${match}`));
        return match;
      }
    }

    // Determine optimal
    const optimal = LLMBootstrapper.PREFERRED_MODELS.find(m => ramGB >= (m.minRamGB + 4)); // leaves extra room
    const targetModel = optimal ? optimal.name : 'llama3.2:3b';

    console.log(chalk.magenta(`📥 No capable local models found. Downloading optimal model: ${targetModel} (This will take a few minutes)...`));
    
    // Performance fix: Remove timeout for large model downloads and add retry resilience
    let downloadSuccess = false;
    let attempts = 0;
    
    // Start real-time monitoring
    progressMonitor.start();

    while (!downloadSuccess && attempts < 5) {
      try {
        attempts++;
        // Use the absolute path for the log that the monitor watches
        await execAsync(`${this._ollamaPath} pull ${targetModel} > "/Users/mac/Downloads/apex 4/ollama-pull.log" 2>&1`, { timeout: 3600000 }); 
        downloadSuccess = true;
      } catch (err) {
        console.log(chalk.yellow(`⚠️ Download glitch (attempt ${attempts}): ${err.message}. Resuming...`));
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    progressMonitor.stop();
    if (!downloadSuccess) throw new Error(`Failed to download ${targetModel} after multiple attempts.`);
    
    console.log(chalk.green(`✓ Model ${targetModel} downloaded and integrated.`));
    return targetModel;
  }

  _configureEnv(model) {
    let envData = '';
    try { envData = readFileSync('.env', 'utf-8'); } catch {}
    
    if (envData.includes('OLLAMA_MODEL=')) {
      envData = envData.replace(/OLLAMA_MODEL=.*/, `OLLAMA_MODEL=${model}`);
    } else {
      envData += `\nOLLAMA_MODEL=${model}`;
    }
    
    // Ensure Ollama URL and force flag are set
    if (!envData.includes('OLLAMA_URL=')) {
      envData += `\nOLLAMA_URL=http://localhost:11434`;
    }
    if (!envData.includes('FORCE_LOCAL_LLM=')) {
      envData += `\nFORCE_LOCAL_LLM=true`;
    }

    writeFileSync('.env', envData);
    dotenv.config({ override: true });
    
    // Also set dynamically for this session
    process.env.OLLAMA_MODEL = model;
    process.env.OLLAMA_URL = 'http://localhost:11434';
    process.env.FORCE_LOCAL_LLM = 'true';
  }
}

export const llmBootstrapper = new LLMBootstrapper();
export default llmBootstrapper;
