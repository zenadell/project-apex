// tools/wake-on-lan.js
// APEX WakeOnLAN — Wake your PC remotely from your phone/VPS.
// Send a magic packet to boot your machine, wait for it, then APEX continues.
// Also handles VPS always-on setup (PM2 as service).

import { exec } from 'child_process';
import { promisify } from 'util';
import { createSocket } from 'dgram';
import bus from '../core/event-bus.js';

const execAsync = promisify(exec);

export class WakeOnLAN {
  constructor() {
    this._knownMachines = this._loadMachines();
  }

  // ── SEND MAGIC PACKET ────────────────────────────────────────────────────
  async wake(target) {
    const machine = typeof target === 'string'
      ? this._knownMachines[target] || { mac: target }
      : target;

    if (!machine.mac) throw new Error(`Unknown machine: ${target}. Add to APEX_MACHINES in .env`);

    this.log(`🌙 Waking: ${machine.name || machine.mac}`);
    bus.emit('wol:sending', { mac: machine.mac, name: machine.name });

    await this._sendMagicPacket(machine.mac, machine.broadcast || '255.255.255.255');

    // Wait for machine to come online
    if (machine.ip) {
      const online = await this._waitForOnline(machine.ip, machine.waitTimeoutMs || 120000);
      bus.emit('wol:result', { mac: machine.mac, online });
      return { woken: online, machine: machine.name || machine.mac, ip: machine.ip };
    }

    return { woken: true, machine: machine.name || machine.mac, note: 'Magic packet sent. No IP to verify.' };
  }

  // ── SEND MAGIC PACKET (raw UDP) ───────────────────────────────────────────
  async _sendMagicPacket(mac, broadcast = '255.255.255.255') {
    // Clean MAC address
    const cleanMac = mac.replace(/[:\-]/g, '');
    if (cleanMac.length !== 12) throw new Error(`Invalid MAC address: ${mac}`);

    // Build magic packet: 6x 0xFF + 16x MAC
    const macBytes = Buffer.from(cleanMac, 'hex');
    const packet = Buffer.alloc(102);
    for (let i = 0; i < 6; i++) packet[i] = 0xFF;
    for (let i = 1; i <= 16; i++) macBytes.copy(packet, i * 6, 0, 6);

    return new Promise((resolve, reject) => {
      const socket = createSocket('udp4');
      socket.once('error', reject);
      socket.bind(() => {
        socket.setBroadcast(true);
        socket.send(packet, 0, packet.length, 9, broadcast, (err) => {
          socket.close();
          if (err) reject(err);
          else resolve(true);
        });
      });
    });
  }

  // ── PING UNTIL MACHINE RESPONDS ──────────────────────────────────────────
  async _waitForOnline(ip, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await execAsync(`ping -c 1 -W 2 ${ip} 2>/dev/null || ping -n 1 -w 2 ${ip} 2>/dev/null`, { timeout: 5000 });
        console.log(`✅ Machine ${ip} is online`);
        return true;
      } catch {
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    return false;
  }

  // ── CHECK IF MACHINE IS ONLINE ────────────────────────────────────────────
  async isOnline(ip) {
    try {
      await execAsync(`ping -c 1 -W 2 ${ip} 2>/dev/null`, { timeout: 5000 });
      return true;
    } catch { return false; }
  }

  // ── CONFIGURE A MACHINE ────────────────────────────────────────────────────
  configure(name, { mac, ip, broadcast, privateKey }) {
    this._knownMachines[name] = { name, mac, ip, broadcast, privateKey };
    this._saveMachines();
    return { configured: name, mac, ip };
  }

  _loadMachines() {
    // Load from env: APEX_MACHINES=name:mac:ip,name2:mac2:ip2
    const machines = {};
    const env = process.env.APEX_MACHINES || '';
    if (env) {
      for (const entry of env.split(',')) {
        const [name, mac, ip, broadcast] = entry.trim().split(':');
        if (name && mac) machines[name] = { name, mac, ip, broadcast };
      }
    }
    return machines;
  }

  _saveMachines() {
    // Persist to env pattern for now
    const entries = Object.values(this._knownMachines)
      .map(m => `${m.name}:${m.mac}:${m.ip || ''}`)
      .join(',');
    process.env.APEX_MACHINES = entries;
  }

  log(msg) { bus.emit('agent:log', { agent: 'WakeOnLAN', message: msg, level: 'info' }); }

  listMachines() { return Object.values(this._knownMachines); }
}

// ── VPS ALWAYS-ON SETUP ───────────────────────────────────────────────────────
// Run this once on your VPS to keep APEX alive 24/7

export async function setupAlwaysOn(apexDir = process.cwd()) {
  console.log('⚡ Setting up APEX as always-on service...\n');

  const steps = [];

  // 1. Check PM2
  try {
    await execAsync('which pm2', { timeout: 3000 });
    steps.push({ step: 'PM2', status: 'already installed' });
  } catch {
    await execAsync('npm install -g pm2', { timeout: 60000 });
    steps.push({ step: 'PM2', status: 'installed' });
  }

  // 2. Start APEX with PM2
  try {
    await execAsync(`pm2 stop apex 2>/dev/null; pm2 delete apex 2>/dev/null`, { timeout: 10000 });
  } catch {}

  await execAsync(
    `pm2 start "${apexDir}/apex.js" --name apex --interpreter node ` +
    `--log "${apexDir}/.apex-data/apex.log" ` +
    `--error "${apexDir}/.apex-data/apex-error.log" ` +
    `--restart-delay 5000 ` +
    `--max-restarts 10`,
    { timeout: 30000 }
  );
  steps.push({ step: 'PM2 start', status: 'APEX running' });

  // 3. PM2 startup (survive reboots)
  try {
    const { stdout } = await execAsync('pm2 startup', { timeout: 10000 });
    if (stdout.includes('sudo')) {
      // Need to run the suggested command
      steps.push({ step: 'PM2 startup', status: 'run the sudo command shown above', stdout: stdout.slice(0, 200) });
    }
  } catch {}

  await execAsync('pm2 save', { timeout: 10000 });
  steps.push({ step: 'PM2 save', status: 'configuration saved' });

  // 4. Show status
  const { stdout: status } = await execAsync('pm2 show apex', { timeout: 10000 });

  return {
    success: true,
    steps,
    status: status.slice(0, 500),
    message: 'APEX is now running 24/7. Control from WhatsApp or Telegram anywhere.',
    commands: {
      logs: 'pm2 logs apex',
      restart: 'pm2 restart apex',
      stop: 'pm2 stop apex',
      status: 'pm2 show apex',
    },
  };
}

export const wakeOnLAN = new WakeOnLAN();
export default wakeOnLAN;
