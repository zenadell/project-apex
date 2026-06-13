// agents/file-sync.js
// APEX FileSyncAgent — Syncs files across all your devices.
// Uses the device bridge when online, queues when offline.
// Supports Syncthing (self-hosted), shared folders, and direct transfer.

import { BaseAgent } from './base-agent.js';
import { complete } from '../core/llm.js';
import {
  existsSync, mkdirSync, writeFileSync, readFileSync,
  readdirSync, statSync, copyFileSync, watchFile,
} from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import bus from '../core/event-bus.js';
import Memory from '../core/memory.js';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DIR = path.join(__dirname, '..', '.apex-data', 'sync');
const QUEUE_FILE = path.join(SYNC_DIR, 'queue.json');
if (!existsSync(SYNC_DIR)) mkdirSync(SYNC_DIR, { recursive: true });

export class FileSyncAgent extends BaseAgent {
  constructor() {
    super({
      name: 'FileSyncAgent',
      type: 'file_sync',
      description: 'Syncs files across your devices. Creates files that appear on your PC/Mac even when offline via queue. Supports Syncthing, SCP, rsync, and the APEX cross-device bridge.',
    });
    this._queue = this._loadQueue();
    this._watchers = new Map();
    this._syncthingAvailable = null;
  }

  async run(task) {
    const { action = 'status' } = task;
    switch (action) {
      case 'push':    return this.pushFile(task.filePath, task.devices, task.content);
      case 'pull':    return this.pullFile(task.filePath, task.device);
      case 'sync_dir':return this.syncDirectory(task.dir, task.target);
      case 'watch':   return this.watchAndSync(task.dir, task.target);
      case 'queue':   return this.queueForOffline(task.filePath, task.content, task.targetPath);
      case 'flush':   return this.flushQueue();
      case 'status':  return this.syncStatus();
      case 'setup':   return this.setupSyncthing();
      default:        return this.syncStatus();
    }
  }

  // ── PUSH FILE TO DEVICES ──────────────────────────────────────────────────
  async pushFile(filePath, devices = 'all', content = null) {
    this.log(`Pushing: ${filePath}`);

    // If content provided, write locally first
    if (content) {
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, content);
    }

    if (!existsSync(filePath)) return { error: `File not found: ${filePath}` };

    const results = [];

    // Try bridge first (real-time if devices connected)
    const bridgeResult = await this._pushViaBridge(filePath, content);
    if (bridgeResult.sent > 0) results.push(bridgeResult);

    // Try SCP for known remote hosts
    const remoteHosts = this._getRemoteHosts();
    for (const host of remoteHosts) {
      try {
        const scpResult = await this._pushViaSCP(filePath, host);
        results.push(scpResult);
      } catch (err) {
        // Queue for when device comes online
        await this.queueForOffline(filePath, null, `${host.user}@${host.ip}:${host.targetDir || '~/apex-sync/'}`);
        results.push({ host: host.ip, queued: true });
      }
    }

    // Syncthing — just copying to sync folder triggers auto-sync
    if (await this._isSyncthingRunning()) {
      const syncFolder = process.env.SYNCTHING_FOLDER || path.join(process.env.HOME, 'Sync');
      const dest = path.join(syncFolder, path.basename(filePath));
      copyFileSync(filePath, dest);
      results.push({ method: 'syncthing', dest, success: true });
    }

    Memory.store({
      scope: 'session', agent: 'FileSyncAgent',
      content: `Pushed: ${filePath} → ${results.length} targets`,
      tags: ['sync', 'push'], importance: 5,
    });

    bus.emit('filesync:pushed', { file: filePath, targets: results.length });
    return { pushed: true, file: filePath, results };
  }

  // ── QUEUE FOR OFFLINE DELIVERY ─────────────────────────────────────────────
  async queueForOffline(filePath, content = null, targetPath = null) {
    const entry = {
      id: `sync_${Date.now()}`,
      filePath,
      content,
      targetPath: targetPath || filePath,
      queued: Date.now(),
      attempts: 0,
    };
    this._queue.push(entry);
    this._saveQueue();

    // Set up listener for when device comes online
    bus.on('bridge:device_connected', () => this.flushQueue());

    this.log(`Queued: ${filePath} → will sync when device online`);
    return { queued: true, id: entry.id, file: filePath };
  }

  // ── FLUSH QUEUE when devices come online ─────────────────────────────────
  async flushQueue() {
    if (!this._queue.length) return { flushed: 0 };
    this.log(`Flushing ${this._queue.length} queued files`);

    const results = [];
    const remaining = [];

    for (const entry of this._queue) {
      try {
        const content = entry.content || (existsSync(entry.filePath) ? readFileSync(entry.filePath, 'utf8') : null);
        if (!content) { remaining.push(entry); continue; }

        // Try to deliver via bridge
        const bridgeResult = await this._pushViaBridge(entry.filePath, content);
        if (bridgeResult.sent > 0) {
          results.push({ id: entry.id, delivered: true });
          bus.emit('filesync:delivered', { file: entry.filePath });
        } else {
          entry.attempts++;
          if (entry.attempts < 10) remaining.push(entry);
        }
      } catch {
        entry.attempts++;
        if (entry.attempts < 10) remaining.push(entry);
      }
    }

    this._queue = remaining;
    this._saveQueue();
    return { flushed: results.length, remaining: remaining.length, results };
  }

  // ── WATCH DIRECTORY AND AUTO-SYNC ─────────────────────────────────────────
  async watchAndSync(dir, target) {
    if (!existsSync(dir)) return { error: `Directory not found: ${dir}` };
    this.log(`Watching: ${dir}`);

    // Use chokidar if available, fallback to fs.watchFile
    try {
      const { watch } = await import('chokidar');
      const watcher = watch(dir, { ignoreInitial: true, persistent: true });

      watcher.on('change', async (filePath) => {
        this.log(`Changed: ${filePath} — syncing`);
        await this.pushFile(filePath, target);
      });

      watcher.on('add', async (filePath) => {
        this.log(`Added: ${filePath} — syncing`);
        await this.pushFile(filePath, target);
      });

      this._watchers.set(dir, watcher);
      return { watching: true, dir, target };
    } catch {
      return { error: 'chokidar not available. Run: npm install chokidar' };
    }
  }

  // ── SYNC DIRECTORY ─────────────────────────────────────────────────────────
  async syncDirectory(sourceDir, targetDir) {
    if (!existsSync(sourceDir)) return { error: `Source not found: ${sourceDir}` };

    const remoteHosts = this._getRemoteHosts();
    const results = [];

    for (const host of remoteHosts) {
      try {
        const { stdout } = await execAsync(
          `rsync -avz --progress "${sourceDir}/" "${host.user}@${host.ip}:${targetDir || '~/apex-sync/'}"`,
          { timeout: 120000 }
        );
        results.push({ host: host.ip, success: true, output: stdout.slice(0, 500) });
      } catch (err) {
        results.push({ host: host.ip, success: false, error: err.message });
      }
    }

    return { synced: results.filter(r => r.success).length, results };
  }

  // ── PULL FILE FROM DEVICE ─────────────────────────────────────────────────
  async pullFile(filePath, device) {
    const host = this._getRemoteHosts().find(h => h.ip === device || h.name === device);
    if (!host) return { error: `Device ${device} not configured. Add to APEX_SYNC_HOSTS in .env` };

    try {
      const localPath = path.join(SYNC_DIR, path.basename(filePath));
      await execAsync(`scp "${host.user}@${host.ip}:${filePath}" "${localPath}"`, { timeout: 30000 });
      return { pulled: true, localPath, from: host.ip };
    } catch (err) {
      return { error: err.message };
    }
  }

  // ── SETUP SYNCTHING ───────────────────────────────────────────────────────
  async setupSyncthing() {
    this.log('Setting up Syncthing...');
    try {
      // Check if installed
      await execAsync('which syncthing', { timeout: 3000 });
    } catch {
      // Install
      try {
        await execAsync('curl -s https://installsyncthing.net/install.sh | bash', { timeout: 300000 });
      } catch {
        try {
          await execAsync('apt-get install -y syncthing 2>/dev/null || brew install syncthing 2>/dev/null', { timeout: 300000 });
        } catch {}
      }
    }

    // Start syncthing
    try {
      await execAsync('syncthing --no-browser &', { timeout: 5000 });
      this._syncthingAvailable = true;
      return {
        installed: true,
        webUI: 'http://localhost:8384',
        note: 'Open http://localhost:8384 on each device and pair them. Files in ~/Sync auto-sync.',
      };
    } catch (err) {
      return { error: err.message, note: 'Manual install: https://syncthing.net/downloads/' };
    }
  }

  // ── STATUS ────────────────────────────────────────────────────────────────
  async syncStatus() {
    const hosts = this._getRemoteHosts();
    const syncthingRunning = await this._isSyncthingRunning();

    return {
      queuedFiles: this._queue.length,
      watchedDirs: this._watchers.size,
      configuredHosts: hosts.length,
      syncthingRunning,
      methods: {
        bridge: '✓ Active (cross-device WebSocket)',
        syncthing: syncthingRunning ? '✓ Running' : '✗ Not running',
        scp: hosts.length > 0 ? `✓ ${hosts.length} hosts configured` : '✗ No hosts (set APEX_SYNC_HOSTS)',
        rsync: hosts.length > 0 ? '✓ Available' : '✗ No hosts',
      },
      setupHelp: 'Set APEX_SYNC_HOSTS=user@ip1,user@ip2 in .env to enable SCP/rsync sync',
    };
  }

  // ── PRIVATE HELPERS ────────────────────────────────────────────────────────
  async _pushViaBridge(filePath, content) {
    let sent = 0;
    try {
      const { bridgeManager } = await import('../tools/device-bridge.js');
      const server = bridgeManager._server;
      if (!server) return { sent: 0, method: 'bridge' };

      const fileContent = content || (existsSync(filePath) ? readFileSync(filePath, 'base64') : null);
      if (!fileContent) return { sent: 0 };

      server.notify('file_sync', { filePath, content: fileContent, encoding: 'base64' });
      sent = server._clients?.size || 0;
    } catch {}
    return { sent, method: 'bridge' };
  }

  async _pushViaSCP(filePath, host) {
    const target = `${host.user}@${host.ip}:${host.targetDir || '~/apex-sync/'}${path.basename(filePath)}`;
    const keyArg = host.privateKey ? `-i "${host.privateKey}"` : '';
    await execAsync(`scp ${keyArg} -o StrictHostKeyChecking=no "${filePath}" "${target}"`, { timeout: 30000 });
    return { host: host.ip, success: true, method: 'scp' };
  }

  async _isSyncthingRunning() {
    if (this._syncthingAvailable !== null) return this._syncthingAvailable;
    try {
      const { default: axios } = await import('axios');
      await axios.get('http://localhost:8384', { timeout: 2000 });
      this._syncthingAvailable = true;
    } catch {
      this._syncthingAvailable = false;
    }
    return this._syncthingAvailable;
  }

  _getRemoteHosts() {
    const hosts = process.env.APEX_SYNC_HOSTS || '';
    if (!hosts) return [];
    return hosts.split(',').map(h => {
      const [userAtIp, targetDir] = h.trim().split(':');
      const [user, ip] = userAtIp.split('@');
      return { user, ip, targetDir, name: ip };
    }).filter(h => h.user && h.ip);
  }

  _loadQueue() {
    if (existsSync(QUEUE_FILE)) {
      try { return JSON.parse(readFileSync(QUEUE_FILE, 'utf8')); } catch {}
    }
    return [];
  }

  _saveQueue() {
    writeFileSync(QUEUE_FILE, JSON.stringify(this._queue, null, 2));
  }
}

export default FileSyncAgent;
