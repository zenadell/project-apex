// core/checkpoint.js
// APEX Git Checkpointing — Save state before risky operations, rollback on failure.
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

class Checkpoint {
  constructor() {
    this._lastCheckpoint = null;
    this._backupDir = null;
  }

  /**
   * Check if a directory is inside a git repo
   */
  _isGitRepo(dir) {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd: dir, stdio: 'pipe' });
      return true;
    } catch { return false; }
  }

  /**
   * Save a checkpoint before risky operations.
   * Uses git if available, falls back to file backup.
   */
  save(label, workDir = process.cwd()) {
    try {
      if (this._isGitRepo(workDir)) {
        // Git-based checkpoint
        execSync('git add -A', { cwd: workDir, stdio: 'pipe' });
        execSync(`git commit --allow-empty -m "apex-checkpoint: ${label}" --no-verify`, { 
          cwd: workDir, stdio: 'pipe' 
        });
        this._lastCheckpoint = { type: 'git', label, dir: workDir };
        console.log(chalk.gray(`📌 Checkpoint saved (git): ${label}`));
      } else {
        // File-based backup fallback
        const backupDir = path.join(workDir, '.apex-backup', `${Date.now()}`);
        fs.mkdirSync(backupDir, { recursive: true });
        // Copy key files (not node_modules)
        const items = fs.readdirSync(workDir).filter(f => 
          !['node_modules', '.git', '.apex-backup', 'sandbox'].includes(f)
        );
        for (const item of items) {
          const src = path.join(workDir, item);
          const dst = path.join(backupDir, item);
          const stat = fs.statSync(src);
          if (stat.isFile()) {
            fs.copyFileSync(src, dst);
          }
        }
        this._lastCheckpoint = { type: 'file', label, dir: workDir, backupDir };
        this._backupDir = backupDir;
        console.log(chalk.gray(`📌 Checkpoint saved (file backup): ${label}`));
      }
      return true;
    } catch (err) {
      console.log(chalk.yellow(`⚠️ Checkpoint save failed: ${err.message}`));
      return false;
    }
  }

  /**
   * Rollback to the last checkpoint.
   */
  rollback() {
    if (!this._lastCheckpoint) {
      console.log(chalk.yellow('⚠️ No checkpoint to rollback to'));
      return false;
    }

    try {
      const { type, dir, backupDir } = this._lastCheckpoint;
      
      if (type === 'git') {
        execSync('git reset --hard HEAD~1', { cwd: dir, stdio: 'pipe' });
        console.log(chalk.yellow(`⏪ Rolled back to git checkpoint`));
      } else if (type === 'file' && backupDir) {
        const files = fs.readdirSync(backupDir);
        for (const file of files) {
          fs.copyFileSync(path.join(backupDir, file), path.join(dir, file));
        }
        console.log(chalk.yellow(`⏪ Rolled back to file checkpoint`));
      }
      
      this._lastCheckpoint = null;
      return true;
    } catch (err) {
      console.log(chalk.red(`❌ Rollback failed: ${err.message}`));
      return false;
    }
  }

  /**
   * Confirm the checkpoint is good — clears the rollback target.
   */
  confirm() {
    if (this._lastCheckpoint) {
      console.log(chalk.green(`✅ Checkpoint confirmed: ${this._lastCheckpoint.label}`));
      // Clean up file backup if used
      if (this._backupDir && fs.existsSync(this._backupDir)) {
        fs.rmSync(this._backupDir, { recursive: true, force: true });
      }
      this._lastCheckpoint = null;
    }
  }
}

export const checkpoint = new Checkpoint();
export default checkpoint;
