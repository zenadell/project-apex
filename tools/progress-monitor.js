// tools/progress-monitor.js
import { readFileSync, existsSync } from 'fs';
import bus from '../core/event-bus.js';
import chalk from 'chalk';

export class ProgressMonitor {
  constructor(logPath) {
    this._logPath = logPath;
    this._interval = null;
    this._lastProgress = -1;
  }

  start() {
    if (this._interval) return;
    console.log(chalk.gray(`  [ProgressMonitor] Watching ${this._logPath}`));
    
    this._interval = setInterval(() => {
      this._check();
    }, 5000); // Check every 5s
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  _check() {
    if (!existsSync(this._logPath)) return;
    
    try {
      const content = readFileSync(this._logPath, 'utf8');
      const matches = content.match(/([0-9]{1,3})%/g);
      
      if (matches && matches.length > 0) {
        // Get the last percentage found
        const lastMatch = matches[matches.length - 1];
        const progress = parseInt(lastMatch.replace('%', ''));
        
        if (progress !== this._lastProgress) {
          this._lastProgress = progress;
          
          // Try to extract speed and eta if possible
          const lines = content.split('\n');
          const lastLine = lines[lines.length - 1] || lines[lines.length - 2] || '';
          const speedMatch = lastLine.match(/([0-9.]+ [A-Z]B\/s)/);
          const etaMatch = lastLine.match(/([0-9]+m[0-9]+s|[0-9]+s)/);
          
          bus.emit('llm:download_progress', {
            progress,
            speed: speedMatch ? speedMatch[0] : 'Calculating...',
            eta: etaMatch ? etaMatch[0] : '...'
          });
        }
      }
      
      // If content contains "success", we are done
      if (content.toLowerCase().includes('success')) {
        bus.emit('llm:download_progress', { progress: 100, status: 'complete' });
        this.stop();
      }
    } catch (err) {
      // console.error('[ProgressMonitor] Error reading log:', err.message);
    }
  }
}

export const progressMonitor = new ProgressMonitor('/Users/mac/Downloads/apex 4/ollama-pull.log');
export default progressMonitor;
