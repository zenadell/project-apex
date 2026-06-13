// tools/git-tool.js
// APEX Git Tool — Clone repos, read files, commit changes, push results.
import simpleGit from 'simple-git';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import bus from '../core/event-bus.js';

export class GitTool {
  constructor() {
    this._git = null;
    this._repoDir = null;
  }

  // Clone a repository
  async clone(url, targetDir = null) {
    const dir = targetDir || `/tmp/apex-git-${Date.now()}`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const git = simpleGit();
    await git.clone(url, dir, ['--depth', '1']);

    this._repoDir = dir;
    this._git = simpleGit(dir);

    bus.emit('git:cloned', { url, dir });
    return { dir, success: true };
  }

  // Read files from a repo
  async readFiles(dir, extensions = ['.js', '.ts', '.py', '.md', '.json'], maxFiles = 20) {
    const { globSync } = await import('glob');
    const pattern = `${dir}/**/*{${extensions.join(',')}}`;
    const files = globSync(pattern, {
      ignore: [`${dir}/node_modules/**`, `${dir}/.git/**`, `${dir}/dist/**`],
    }).slice(0, maxFiles);

    return files.map(f => ({
      path: f.replace(dir, ''),
      content: readFileSync(f, 'utf8').slice(0, 3000),
    }));
  }

  // Initialize a new git repo
  async init(dir) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this._git = simpleGit(dir);
    this._repoDir = dir;
    await this._git.init();
    return { dir, initialized: true };
  }

  // Commit changes
  async commit(message, dir = this._repoDir) {
    const git = simpleGit(dir);
    await git.addConfig('user.name', 'APEX Bot');
    await git.addConfig('user.email', 'apex@jomiez.com');
    await git.add('.');
    const result = await git.commit(message);
    bus.emit('git:committed', { message, dir });
    return result;
  }

  // Push to remote
  async push(remote = 'origin', branch = 'main', dir = this._repoDir) {
    const git = simpleGit(dir);
    await git.push(remote, branch);
    bus.emit('git:pushed', { remote, branch });
    return { success: true };
  }

  // Get repo status
  async status(dir = this._repoDir) {
    const git = simpleGit(dir || process.cwd());
    return git.status();
  }

  // Get recent commits
  async log(dir = this._repoDir, maxCount = 10) {
    const git = simpleGit(dir || process.cwd());
    return git.log({ maxCount });
  }

  // Create and switch to a branch
  async branch(name, dir = this._repoDir) {
    const git = simpleGit(dir);
    await git.checkoutLocalBranch(name);
    return { branch: name };
  }

  // Pull latest
  async pull(dir = this._repoDir) {
    const git = simpleGit(dir);
    return git.pull();
  }

  // Diff
  async diff(dir = this._repoDir) {
    const git = simpleGit(dir);
    return git.diff();
  }

  // Full cycle: init + add files + commit
  async initAndCommit(dir, files, message = 'Initial commit by APEX') {
    await this.init(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file.path);
      const fileDir = path.dirname(fullPath);
      if (!existsSync(fileDir)) mkdirSync(fileDir, { recursive: true });
      writeFileSync(fullPath, file.content);
    }
    return this.commit(message, dir);
  }

  // Search GitHub for repos matching a query (no auth required)
  async searchGitHub(query, options = {}) {
    const axios = (await import('axios')).default;
    const params = {
      q: query,
      sort: options.sort || 'stars',
      order: 'desc',
      per_page: options.limit || 5,
    };
    const headers = {};
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
    }
    const resp = await axios.get('https://api.github.com/search/repositories', { params, headers, timeout: 10000 });
    return resp.data.items.map(r => ({
      name: r.full_name,
      description: r.description,
      stars: r.stargazers_count,
      url: r.html_url,
      cloneUrl: r.clone_url,
      language: r.language,
      topics: r.topics,
    }));
  }

  // Download and install a GitHub skill/tool
  async installFromGitHub(url, targetDir) {
    const { dir } = await this.clone(url, targetDir);
    // Auto-detect type and install
    if (existsSync(path.join(dir, 'package.json'))) {
      execSync('npm install --production', { cwd: dir, timeout: 120000 });
      return { dir, type: 'node' };
    }
    if (existsSync(path.join(dir, 'requirements.txt'))) {
      execSync('pip3 install -r requirements.txt --quiet', { cwd: dir, timeout: 120000 });
      return { dir, type: 'python' };
    }
    if (existsSync(path.join(dir, 'setup.py'))) {
      execSync('pip3 install -e . --quiet', { cwd: dir, timeout: 120000 });
      return { dir, type: 'python-package' };
    }
    return { dir, type: 'unknown' };
  }
}

export const gitTool = new GitTool();
export default gitTool;
