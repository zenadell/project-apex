// core/sandbox.js
// APEX Docker Sandbox — Isolated code execution in Docker containers.
// Generates code in a temp dir, runs it inside Docker, copies results only on success.
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { v4 as uuidv4 } from 'uuid';

const execAsync = promisify(exec);

class DockerSandbox {
  constructor() {
    this._available = null;
    this._image = 'node:20-slim'; // Default image
  }

  /**
   * Check if Docker is available
   */
  async isAvailable() {
    if (this._available !== null) return this._available;
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      this._available = true;
    } catch {
      this._available = false;
    }
    return this._available;
  }

  /**
   * Execute code inside a Docker container.
   * @param {Object} opts
   * @param {string} opts.code - Code string to execute
   * @param {string} opts.language - 'javascript' | 'python'
   * @param {number} opts.timeout - Max execution time in ms (default 60s)
   * @returns {{ success: boolean, output: string, errors: string }}
   */
  async executeCode({ code, language = 'javascript', timeout = 60000 }) {
    if (!(await this.isAvailable())) {
      return this._fallbackExec(code, language, timeout);
    }

    const sandboxId = `apex-sandbox-${uuidv4().slice(0, 8)}`;
    const tmpDir = path.join(process.cwd(), 'sandbox', sandboxId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const ext = language === 'python' ? 'py' : 'js';
    const filename = `run.${ext}`;
    fs.writeFileSync(path.join(tmpDir, filename), code, 'utf8');

    const image = language === 'python' ? 'python:3.11-slim' : this._image;
    const cmd = language === 'python' ? `python3 /workspace/${filename}` : `node /workspace/${filename}`;

    try {
      const { stdout, stderr } = await execAsync(
        `docker run --rm --name ${sandboxId} ` +
        `--memory=512m --cpus=1 ` +       // Resource limits
        `--network=none ` +                 // No network access
        `--read-only ` +                    // Read-only filesystem
        `--tmpfs /tmp:rw,noexec,size=64m ` +// Temp space
        `-v "${tmpDir}":/workspace:ro ` +   // Mount code read-only
        `-w /workspace ` +
        `${image} ${cmd}`,
        { timeout, maxBuffer: 1024 * 1024 }
      );
      return { success: true, output: stdout, errors: stderr };
    } catch (err) {
      return { success: false, output: err.stdout || '', errors: err.stderr || err.message };
    } finally {
      // Kill container if still running
      try { execSync(`docker rm -f ${sandboxId}`, { stdio: 'pipe' }); } catch {}
      // Clean up temp dir
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Run a full project inside Docker.
   * @param {Object} opts
   * @param {string} opts.projectDir - Directory containing the project files
   * @param {string} opts.installCmd - e.g. 'npm install'
   * @param {string} opts.testCmd - e.g. 'node generate-qr.js'
   * @param {string[]} opts.expectedOutputs - Files expected to be created
   * @param {number} opts.timeout - Max execution time in ms
   * @returns {{ success: boolean, output: string, errors: string, outputFiles: string[] }}
   */
  async runProject({ projectDir, installCmd, testCmd, expectedOutputs = [], timeout = 120000 }) {
    if (!(await this.isAvailable())) {
      return this._fallbackRunProject({ projectDir, installCmd, testCmd, expectedOutputs, timeout });
    }

    const sandboxId = `apex-project-${uuidv4().slice(0, 8)}`;
    // Copy project to sandbox temp dir (so we don't mount host dirs read-write)
    const tmpDir = path.join(process.cwd(), 'sandbox', sandboxId);
    fs.mkdirSync(tmpDir, { recursive: true });
    this._copyDir(projectDir, tmpDir);

    try {
      // Build command chain
      let dockerCmd = '';
      if (installCmd) {
        dockerCmd += `${installCmd} && `;
      }
      dockerCmd += testCmd;

      const { stdout, stderr } = await execAsync(
        `docker run --rm --name ${sandboxId} ` +
        `--memory=1g --cpus=2 ` +
        `-v "${tmpDir}":/workspace ` +
        `-w /workspace ` +
        `${this._image} sh -c "${dockerCmd}"`,
        { timeout, maxBuffer: 2 * 1024 * 1024 }
      );

      // Check expected outputs
      const outputFiles = [];
      for (const expected of expectedOutputs) {
        const fp = path.join(tmpDir, expected);
        if (fs.existsSync(fp) && fs.statSync(fp).size > 0) {
          outputFiles.push(expected);
          // Copy output to real project dir
          const destPath = path.join(projectDir, expected);
          const destDir = path.dirname(destPath);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(fp, destPath);
        }
      }

      return { 
        success: true, 
        output: stdout, 
        errors: stderr, 
        outputFiles,
        allOutputsPresent: outputFiles.length === expectedOutputs.length 
      };
    } catch (err) {
      return { 
        success: false, 
        output: err.stdout || '', 
        errors: err.stderr || err.message, 
        outputFiles: [],
        allOutputsPresent: false 
      };
    } finally {
      try { execSync(`docker rm -f ${sandboxId}`, { stdio: 'pipe' }); } catch {}
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Fallback: run in isolated temp directory on host (no Docker)
   */
  _fallbackExec(code, language, timeout) {
    const tmpDir = `/tmp/apex-exec-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    const ext = language === 'python' ? 'py' : 'js';
    const tmpFile = path.join(tmpDir, `run.${ext}`);
    fs.writeFileSync(tmpFile, code);

    try {
      const cmd = language === 'python' ? `python3 ${tmpFile}` : `node ${tmpFile}`;
      const { stdout, stderr } = execSync(cmd, { timeout, cwd: tmpDir, encoding: 'utf8' });
      return { success: true, output: stdout, errors: stderr || '' };
    } catch (err) {
      return { success: false, output: err.stdout || '', errors: err.stderr || err.message };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Fallback: run project in temp dir on host
   */
  async _fallbackRunProject({ projectDir, installCmd, testCmd, expectedOutputs, timeout }) {
    const tmpDir = `/tmp/apex-project-${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });
    this._copyDir(projectDir, tmpDir);

    try {
      if (installCmd) {
        await execAsync(installCmd, { cwd: tmpDir, timeout: 120000 });
      }
      const { stdout, stderr } = await execAsync(testCmd, { cwd: tmpDir, timeout });

      const outputFiles = [];
      for (const expected of expectedOutputs) {
        const fp = path.join(tmpDir, expected);
        if (fs.existsSync(fp) && fs.statSync(fp).size > 0) {
          outputFiles.push(expected);
          const destPath = path.join(projectDir, expected);
          const destDir = path.dirname(destPath);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(fp, destPath);
        }
      }

      return { success: true, output: stdout, errors: stderr || '', outputFiles, allOutputsPresent: outputFiles.length === expectedOutputs.length };
    } catch (err) {
      return { success: false, output: err.stdout || '', errors: err.stderr || err.message, outputFiles: [], allOutputsPresent: false };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  /**
   * Copy a directory recursively (skip node_modules, .git)
   */
  _copyDir(src, dst) {
    const SKIP = ['node_modules', '.git', '.apex-backup', 'sandbox'];
    const items = fs.readdirSync(src);
    for (const item of items) {
      if (SKIP.includes(item)) continue;
      const srcPath = path.join(src, item);
      const dstPath = path.join(dst, item);
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        fs.mkdirSync(dstPath, { recursive: true });
        this._copyDir(srcPath, dstPath);
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

export const sandbox = new DockerSandbox();
export default sandbox;
