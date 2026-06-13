// agents/deploy.js
// APEX DeployAgent — Deploys code everywhere. Fly.io, Railway, Vercel, VPS SSH, Docker, PM2.
// Zero-config deployment — figures out what to deploy and how.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

export class DeployAgent extends BaseAgent {
  constructor() {
    super({
      name: 'DeployAgent',
      type: 'deployment',
      description: 'Deploys code to any platform. Fly.io, Railway, Vercel, Heroku, VPS via SSH, Docker, PM2. Detects your project type and picks the best deployment strategy automatically.',
    });
  }

  async run(task) {
    const { action = 'auto', projectDir = process.cwd(), platform } = task;

    switch (action) {
      case 'auto':      return this.autoDeploy(projectDir, task);
      case 'fly':       return this.deployFly(projectDir, task);
      case 'railway':   return this.deployRailway(projectDir, task);
      case 'vercel':    return this.deployVercel(projectDir, task);
      case 'docker':    return this.deployDocker(projectDir, task);
      case 'pm2':       return this.deployPM2(projectDir, task);
      case 'ssh':       return this.deploySSH(task);
      case 'github':    return this.pushToGitHub(projectDir, task);
      case 'status':    return this.status(projectDir);
      case 'logs':      return this.logs(task);
      case 'rollback':  return this.rollback(task);
      default:          return this.autoDeploy(projectDir, task);
    }
  }

  // ─── AUTO DEPLOY — detects project type & best platform ──────────────────

  async autoDeploy(projectDir, opts) {
    this.log(`Auto-deploying: ${projectDir}`);

    const projectInfo = await this._analyzeProject(projectDir);
    this.log(`Project: ${projectInfo.type} | Framework: ${projectInfo.framework}`);

    const strategy = await this._pickStrategy(projectInfo, opts);
    this.log(`Strategy: ${strategy.platform} — ${strategy.reason}`);

    return this._executeStrategy(strategy, projectDir, opts);
  }

  // ─── FLY.IO DEPLOY ────────────────────────────────────────────────────────

  async deployFly(projectDir, { appName = null, region = 'iad', scale = 1 } = {}) {
    this.log('Deploying to Fly.io');

    // Check flyctl installed
    try {
      await execAsync('which flyctl || which fly');
    } catch {
      this.log('Installing flyctl...');
      await execAsync('curl -L https://fly.io/install.sh | sh');
    }

    // Generate fly.toml if not present
    if (!existsSync(path.join(projectDir, 'fly.toml'))) {
      const flyConfig = await this._generateFlyConfig(projectDir, appName, region);
      writeFileSync(path.join(projectDir, 'fly.toml'), flyConfig);
      this.log('Generated fly.toml');
    }

    // Deploy
    const { stdout, stderr } = await execAsync('fly deploy --wait-timeout 120', {
      cwd: projectDir, timeout: 300000,
    });

    // Get URL
    let url = '';
    try {
      const { stdout: urlOut } = await execAsync('fly status --json', { cwd: projectDir });
      const status = JSON.parse(urlOut);
      url = `https://${status.Hostname}`;
    } catch {}

    this.remember(`Deployed to Fly.io: ${url}`, { tags: ['deploy', 'fly'], importance: 8, scope: 'long_term' });
    return { platform: 'fly.io', url, output: (stdout + stderr).slice(0, 1000), success: true };
  }

  // ─── RAILWAY DEPLOY ───────────────────────────────────────────────────────

  async deployRailway(projectDir, opts = {}) {
    this.log('Deploying to Railway');

    try {
      await execAsync('which railway');
    } catch {
      await execAsync('npm install -g @railway/cli');
    }

    // Login check
    const { stdout } = await execAsync('railway deploy', { cwd: projectDir, timeout: 180000 });

    return { platform: 'railway', output: stdout.slice(0, 500), success: true };
  }

  // ─── VERCEL DEPLOY ────────────────────────────────────────────────────────

  async deployVercel(projectDir, { prod = true } = {}) {
    this.log('Deploying to Vercel');

    try {
      await execAsync('which vercel');
    } catch {
      await execAsync('npm install -g vercel');
    }

    const flag = prod ? '--prod' : '';
    const { stdout } = await execAsync(`vercel ${flag} --yes`, { cwd: projectDir, timeout: 180000 });
    const urlMatch = stdout.match(/https:\/\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : '';

    this.remember(`Deployed to Vercel: ${url}`, { tags: ['deploy', 'vercel'], importance: 8, scope: 'long_term' });
    return { platform: 'vercel', url, output: stdout.slice(0, 500), success: true };
  }

  // ─── DOCKER DEPLOY ────────────────────────────────────────────────────────

  async deployDocker(projectDir, { imageName = null, tag = 'latest', port = 3000, envVars = {} } = {}) {
    this.log('Deploying via Docker');

    const name = imageName || path.basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, '-');

    // Generate Dockerfile if missing
    if (!existsSync(path.join(projectDir, 'Dockerfile'))) {
      const dockerfile = await this._generateDockerfile(projectDir);
      writeFileSync(path.join(projectDir, 'Dockerfile'), dockerfile);
      this.log('Generated Dockerfile');
    }

    // Build image
    await execAsync(`docker build -t ${name}:${tag} .`, { cwd: projectDir, timeout: 300000 });

    // Stop existing container
    await execAsync(`docker stop apex-${name} 2>/dev/null; docker rm apex-${name} 2>/dev/null`);

    // Run new container
    const envStr = Object.entries(envVars).map(([k, v]) => `-e ${k}="${v}"`).join(' ');
    const { stdout } = await execAsync(
      `docker run -d --name apex-${name} -p ${port}:${port} ${envStr} --restart unless-stopped ${name}:${tag}`,
    );

    this.remember(`Docker deployed: ${name} on port ${port}`, { tags: ['deploy', 'docker'], importance: 8, scope: 'long_term' });
    return { platform: 'docker', container: `apex-${name}`, port, image: `${name}:${tag}`, success: true };
  }

  // ─── PM2 DEPLOY (process manager for Node.js) ────────────────────────────

  async deployPM2(projectDir, { name = null, script = null, instances = 1, envVars = {} } = {}) {
    this.log('Deploying with PM2');

    try {
      await execAsync('which pm2');
    } catch {
      await execAsync('npm install -g pm2');
    }

    const appName = name || path.basename(projectDir);
    const entrypoint = script || await this._findEntrypoint(projectDir);
    const envStr = Object.entries(envVars).map(([k, v]) => `--env ${k}="${v}"`).join(' ');

    // Stop existing
    await execAsync(`pm2 stop ${appName} 2>/dev/null || true`);
    await execAsync(`pm2 delete ${appName} 2>/dev/null || true`);

    // Install deps
    if (existsSync(path.join(projectDir, 'package.json'))) {
      await execAsync('npm install --production', { cwd: projectDir, timeout: 120000 });
    }

    // Start with PM2
    await execAsync(
      `pm2 start ${entrypoint} --name ${appName} -i ${instances} ${envStr}`,
      { cwd: projectDir }
    );
    await execAsync('pm2 save');

    const { stdout } = await execAsync(`pm2 show ${appName}`);
    this.remember(`PM2 deployed: ${appName}`, { tags: ['deploy', 'pm2'], importance: 7, scope: 'long_term' });
    return { platform: 'pm2', name: appName, instances, output: stdout.slice(0, 500), success: true };
  }

  // ─── SSH REMOTE DEPLOY ────────────────────────────────────────────────────

  async deploySSH({ host, user, privateKey = null, projectDir, remoteDir, commands = [] }) {
    this.log(`SSH deploy to ${user}@${host}`);
    const keyArg = privateKey ? `-i "${privateKey}"` : '';
    const sshCmd = `ssh ${keyArg} -o StrictHostKeyChecking=no ${user}@${host}`;

    // Default deploy commands
    const deployCommands = commands.length ? commands : [
      `mkdir -p ${remoteDir}`,
      `cd ${remoteDir} && git pull 2>/dev/null || true`,
      `cd ${remoteDir} && npm install --production 2>/dev/null || true`,
      `cd ${remoteDir} && pm2 restart all 2>/dev/null || pm2 start index.js 2>/dev/null || true`,
    ];

    const results = [];
    for (const cmd of deployCommands) {
      try {
        const { stdout } = await execAsync(`${sshCmd} "${cmd}"`, { timeout: 60000 });
        results.push({ cmd, output: stdout.trim(), success: true });
      } catch (err) {
        results.push({ cmd, error: err.message, success: false });
      }
    }

    return { platform: 'ssh', host, results, success: results.every(r => r.success) };
  }

  // ─── PUSH TO GITHUB ───────────────────────────────────────────────────────

  async pushToGitHub(projectDir, { message = 'Deploy by APEX', branch = 'main', remote = 'origin' } = {}) {
    const git = (await import('simple-git')).default(projectDir);
    await git.addConfig('user.name', 'APEX Bot');
    await git.addConfig('user.email', 'apex@jomiez.com');
    await git.add('.');
    await git.commit(message);
    await git.push(remote, branch);
    return { pushed: true, branch, message };
  }

  // ─── STATUS & LOGS ────────────────────────────────────────────────────────

  async status(projectDir = process.cwd()) {
    const results = {};

    // PM2 status
    try {
      const { stdout } = await execAsync('pm2 jlist');
      results.pm2 = JSON.parse(stdout).map(p => ({ name: p.name, status: p.pm2_env.status, cpu: p.monit?.cpu }));
    } catch { results.pm2 = []; }

    // Docker status
    try {
      const { stdout } = await execAsync('docker ps --format "{{.Names}}|{{.Status}}|{{.Ports}}"');
      results.docker = stdout.trim().split('\n').filter(Boolean).map(l => {
        const [name, status, ports] = l.split('|');
        return { name, status, ports };
      });
    } catch { results.docker = []; }

    // Fly status
    try {
      const { stdout } = await execAsync('fly status --json', { cwd: projectDir });
      results.fly = JSON.parse(stdout);
    } catch {}

    return results;
  }

  async logs({ platform = 'pm2', name = null, lines = 50 } = {}) {
    if (platform === 'pm2' && name) {
      const { stdout } = await execAsync(`pm2 logs ${name} --lines ${lines} --nostream`);
      return { platform, name, logs: stdout };
    }
    if (platform === 'docker' && name) {
      const { stdout } = await execAsync(`docker logs ${name} --tail ${lines}`);
      return { platform, name, logs: stdout };
    }
    if (platform === 'fly') {
      const { stdout } = await execAsync(`fly logs`, { timeout: 10000 });
      return { platform, logs: stdout };
    }
    return { error: 'Specify platform and name' };
  }

  async rollback({ platform = 'fly', steps = 1 } = {}) {
    if (platform === 'fly') {
      const { stdout } = await execAsync(`fly releases list --json`);
      const releases = JSON.parse(stdout);
      const target = releases[steps];
      if (!target) return { error: 'No previous release to roll back to' };
      await execAsync(`fly deploy --image ${target.ImageRef}`);
      return { rolledBack: true, to: target.Version };
    }
    if (platform === 'pm2') {
      // Restart previous version via git
      await execAsync('git stash');
      return { rolledBack: true, note: 'Stashed current changes' };
    }
    return { error: `Rollback not supported for ${platform}` };
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  async _analyzeProject(dir) {
    const files = existsSync(dir) ? readdirSync(dir) : [];
    const hasPkg = files.includes('package.json');
    const hasRequirements = files.includes('requirements.txt');
    const hasFly = files.includes('fly.toml');
    const hasDockerfile = files.includes('Dockerfile');
    const hasVercelJson = files.includes('vercel.json');
    const hasNextConfig = files.includes('next.config.js') || files.includes('next.config.mjs');

    let pkg = {};
    if (hasPkg) {
      try { pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
    }

    return {
      type: hasPkg ? 'node' : hasRequirements ? 'python' : 'unknown',
      framework: hasNextConfig ? 'next' : pkg.dependencies?.react ? 'react' : pkg.dependencies?.express ? 'express' : 'unknown',
      hasFly, hasDockerfile, hasVercelJson, hasPkg,
      name: pkg.name || path.basename(dir),
      scripts: pkg.scripts || {},
    };
  }

  async _pickStrategy(projectInfo, opts) {
    if (opts.platform) return { platform: opts.platform, reason: 'explicitly specified' };
    if (projectInfo.hasFly) return { platform: 'fly', reason: 'fly.toml found' };
    if (projectInfo.hasDockerfile) return { platform: 'docker', reason: 'Dockerfile found' };
    if (projectInfo.hasVercelJson || projectInfo.framework === 'next') return { platform: 'vercel', reason: 'Next.js/Vercel config found' };
    if (projectInfo.type === 'node') return { platform: 'pm2', reason: 'Node.js project — using PM2' };
    return { platform: 'docker', reason: 'fallback to Docker' };
  }

  async _executeStrategy(strategy, projectDir, opts) {
    switch (strategy.platform) {
      case 'fly':     return this.deployFly(projectDir, opts);
      case 'railway': return this.deployRailway(projectDir, opts);
      case 'vercel':  return this.deployVercel(projectDir, opts);
      case 'docker':  return this.deployDocker(projectDir, opts);
      case 'pm2':     return this.deployPM2(projectDir, opts);
      default:        return { error: `Unknown platform: ${strategy.platform}` };
    }
  }

  async _generateFlyConfig(projectDir, appName, region) {
    const name = appName || path.basename(projectDir).toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `app = "${name}"
primary_region = "${region}"

[build]

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

[[vm]]
  memory = "256mb"
  cpu_kind = "shared"
  cpus = 1
`;
  }

  async _generateDockerfile(projectDir) {
    const hasPkg = existsSync(path.join(projectDir, 'package.json'));
    const hasRequirements = existsSync(path.join(projectDir, 'requirements.txt'));

    if (hasPkg) {
      const entrypoint = await this._findEntrypoint(projectDir);
      return `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "${entrypoint}"]
`;
    }
    if (hasRequirements) {
      return `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "app.py"]
`;
    }
    return `FROM ubuntu:22.04
WORKDIR /app
COPY . .
EXPOSE 3000
CMD ["bash", "start.sh"]
`;
  }

  async _findEntrypoint(projectDir) {
    const candidates = ['index.js', 'server.js', 'app.js', 'main.js', 'src/index.js', 'src/server.js'];
    for (const c of candidates) {
      if (existsSync(path.join(projectDir, c))) return c;
    }
    try {
      const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
      return pkg.main || 'index.js';
    } catch { return 'index.js'; }
  }
}

export default DeployAgent;
