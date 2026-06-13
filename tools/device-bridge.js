// tools/device-bridge.js
// APEX Cross-Device Bridge — WebSocket server + client.
// Connect your phone, PC, laptop, server — all controlled by one APEX instance.
// Any device on your network can send tasks and receive results.

import { createServer } from 'http';
import { EventEmitter } from 'eventemitter3';
import bus from '../core/event-bus.js';
import Memory from '../core/memory.js';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

// ─── APEX BRIDGE SERVER ────────────────────────────────────────────────────────
// Runs on the main APEX machine. Other devices connect to this.

export class ApexBridgeServer extends EventEmitter {
  constructor(orchestrator, port = 7331) {
    super();
    this._orchestrator = orchestrator;
    this._port = port;
    this._wss = null;
    this._clients = new Map();  // clientId -> { ws, info, lastSeen }
    this._httpServer = null;
  }

  async start() {
    const { WebSocketServer } = await import('ws').catch(() => {
      throw new Error('ws not installed — run: npm install ws');
    });

    this._httpServer = createServer((req, res) => {
      // Simple status page
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: 'APEX Bridge',
          version: '1.0.0',
          clients: this._clients.size,
          uptime: process.uptime(),
          host: os.hostname(),
        }));
      } else {
        res.writeHead(404); res.end();
      }
    });

    this._wss = new WebSocketServer({ server: this._httpServer });

    this._wss.on('connection', (ws, req) => {
      const clientId = uuidv4().slice(0, 8);
      const clientIp = req.socket.remoteAddress;

      this._clients.set(clientId, {
        ws, ip: clientIp, id: clientId,
        info: {}, lastSeen: Date.now(), connected: Date.now(),
      });

      console.log(`\n🔗 Device connected: ${clientId} (${clientIp})`);
      bus.emit('bridge:device_connected', { clientId, ip: clientIp });

      // Send welcome
      this._send(ws, { type: 'welcome', clientId, host: os.hostname(), capabilities: this._getCapabilities() });

      ws.on('message', async (data) => {
        try {
          const msg = JSON.parse(data.toString());
          await this._handleMessage(clientId, ws, msg);
        } catch (err) {
          this._send(ws, { type: 'error', error: err.message });
        }
      });

      ws.on('close', () => {
        this._clients.delete(clientId);
        console.log(`🔌 Device disconnected: ${clientId}`);
        bus.emit('bridge:device_disconnected', { clientId });
      });

      ws.on('error', (err) => {
        console.log(`Bridge client error (${clientId}): ${err.message}`);
      });
    });

    await new Promise((resolve) => {
      this._httpServer.listen(this._port, '0.0.0.0', () => {
        const localIP = this._getLocalIP();
        console.log(`\n🌐 APEX Bridge Server running`);
        console.log(`   Local:   ws://localhost:${this._port}`);
        console.log(`   Network: ws://${localIP}:${this._port}`);
        console.log(`   QR: Connect any device on your network\n`);
        bus.emit('bridge:started', { port: this._port, ip: localIP });
        resolve();
      });
    });

    return this;
  }

  async _handleMessage(clientId, ws, msg) {
    const client = this._clients.get(clientId);
    if (client) client.lastSeen = Date.now();

    switch (msg.type) {
      case 'task': {
        // Route task to orchestrator
        const taskId = msg.taskId || uuidv4();
        this._send(ws, { type: 'task_ack', taskId, status: 'processing' });

        try {
          const result = await this._orchestrator.execute(msg.input, msg.opts || {});
          this._send(ws, { type: 'task_result', taskId, result: result.synthesis || result, status: 'done' });
        } catch (err) {
          this._send(ws, { type: 'task_error', taskId, error: err.message });
        }
        break;
      }

      case 'agent_dispatch': {
        // Dispatch directly to a specific agent
        const { default: registry } = await import('../core/agent-registry.js');
        const agent = registry.get(msg.agent);
        if (!agent) {
          this._send(ws, { type: 'error', error: `Agent ${msg.agent} not found` });
          break;
        }
        const result = await agent._handleTask({ id: uuidv4(), ...msg.task });
        this._send(ws, { type: 'agent_result', agent: msg.agent, result });
        break;
      }

      case 'device_control': {
        // Execute device control on THIS machine
        const { default: registry } = await import('../core/agent-registry.js');
        const deviceAgent = registry.get('DeviceAgent');
        if (!deviceAgent) {
          this._send(ws, { type: 'error', error: 'DeviceAgent not available' });
          break;
        }
        const result = await deviceAgent._handleTask({ id: uuidv4(), ...msg.action });
        this._send(ws, { type: 'device_result', result });
        break;
      }

      case 'status': {
        const { default: registry } = await import('../core/agent-registry.js');
        this._send(ws, {
          type: 'status',
          agents: registry.snapshot(),
          clients: this._clients.size,
          host: os.hostname(),
          platform: process.platform,
        });
        break;
      }

      case 'ping':
        this._send(ws, { type: 'pong', ts: Date.now() });
        break;

      case 'identify':
        if (client) client.info = msg.info || {};
        this._send(ws, { type: 'identified', clientId });
        break;

      case 'broadcast': {
        // Broadcast to all other clients
        this._broadcast(msg.payload, clientId);
        break;
      }

      case 'subscribe':
        // Subscribe to bus events
        if (msg.event) {
          bus.on(msg.event, (data) => {
            if (ws.readyState === 1) this._send(ws, { type: 'event', event: msg.event, data });
          });
          this._send(ws, { type: 'subscribed', event: msg.event });
        }
        break;

      default:
        this._send(ws, { type: 'unknown_message', received: msg.type });
    }
  }

  // Send to one client
  _send(ws, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  // Broadcast to all clients (optionally exclude one)
  _broadcast(data, excludeId = null) {
    for (const [id, client] of this._clients) {
      if (id !== excludeId) this._send(client.ws, data);
    }
  }

  // Push a task result or notification to all connected devices
  notify(message, data = {}) {
    this._broadcast({ type: 'notification', message, data, ts: Date.now() });
  }

  getClients() {
    return [...this._clients.values()].map(c => ({
      id: c.id, ip: c.ip, info: c.info,
      lastSeen: c.lastSeen, connected: c.connected,
    }));
  }

  _getLocalIP() {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const net of iface) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
    return 'localhost';
  }

  _getCapabilities() {
    return ['task', 'agent_dispatch', 'device_control', 'status', 'subscribe', 'broadcast'];
  }

  stop() {
    this._wss?.close();
    this._httpServer?.close();
  }
}

// ─── APEX BRIDGE CLIENT ───────────────────────────────────────────────────────
// Runs on remote devices (phone, another PC, server).
// Connect to the main APEX instance and send tasks.

export class ApexBridgeClient extends EventEmitter {
  constructor(serverUrl) {
    super();
    this._url = serverUrl; // e.g. ws://192.168.1.5:7331
    this._ws = null;
    this._pending = new Map(); // taskId -> { resolve, reject }
    this._reconnectDelay = 3000;
    this._connected = false;
  }

  async connect() {
    const { WebSocket } = await import('ws');

    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this._url);

      this._ws.on('open', () => {
        this._connected = true;
        console.log(`✅ Connected to APEX at ${this._url}`);
        this.emit('connected');
        resolve(this);
      });

      this._ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch {}
      });

      this._ws.on('close', () => {
        this._connected = false;
        this.emit('disconnected');
        console.log('🔌 Disconnected from APEX — reconnecting...');
        setTimeout(() => this.connect().catch(() => {}), this._reconnectDelay);
      });

      this._ws.on('error', (err) => {
        reject(err);
        this.emit('error', err);
      });
    });
  }

  _handleMessage(msg) {
    this.emit('message', msg);
    this.emit(msg.type, msg);

    // Resolve pending task promises
    if (msg.taskId && this._pending.has(msg.taskId)) {
      const { resolve, reject } = this._pending.get(msg.taskId);
      if (msg.type === 'task_result') { resolve(msg.result); this._pending.delete(msg.taskId); }
      if (msg.type === 'task_error') { reject(new Error(msg.error)); this._pending.delete(msg.taskId); }
    }
  }

  // Send a task and wait for result
  async task(input, opts = {}) {
    const taskId = uuidv4();
    return new Promise((resolve, reject) => {
      this._pending.set(taskId, { resolve, reject });
      this._send({ type: 'task', taskId, input, opts });
      // Timeout after 5 minutes
      setTimeout(() => {
        if (this._pending.has(taskId)) {
          this._pending.delete(taskId);
          reject(new Error('Task timed out'));
        }
      }, 300000);
    });
  }

  // Control device on the remote machine
  async deviceControl(action) {
    this._send({ type: 'device_control', action });
    return new Promise((resolve) => {
      this.once('device_result', (msg) => resolve(msg.result));
    });
  }

  // Dispatch to specific agent on remote machine
  async dispatchAgent(agent, task) {
    this._send({ type: 'agent_dispatch', agent, task });
    return new Promise((resolve) => {
      this.once('agent_result', (msg) => resolve(msg.result));
    });
  }

  // Get status of remote APEX
  async status() {
    this._send({ type: 'status' });
    return new Promise((resolve) => {
      this.once('status', resolve);
    });
  }

  // Subscribe to remote APEX events
  subscribe(event, callback) {
    this._send({ type: 'subscribe', event });
    this.on('event', (msg) => {
      if (msg.event === event) callback(msg.data);
    });
  }

  // Fire and forget
  send(input) {
    this._send({ type: 'task', taskId: uuidv4(), input });
  }

  _send(data) {
    if (this._ws?.readyState === 1) {
      this._ws.send(JSON.stringify(data));
    }
  }

  disconnect() {
    this._ws?.close();
  }
}

// ─── BRIDGE MANAGER ───────────────────────────────────────────────────────────

export class BridgeManager {
  constructor() {
    this._server = null;
    this._clients = new Map();
  }

  async startServer(orchestrator, port = 7331) {
    this._server = new ApexBridgeServer(orchestrator, port);
    await this._server.start();
    return this._server;
  }

  async connectTo(url, name = 'remote') {
    const client = new ApexBridgeClient(url);
    await client.connect();
    this._clients.set(name, client);
    return client;
  }

  getClient(name) {
    return this._clients.get(name);
  }

  stopServer() {
    this._server?.stop();
  }
}

export const bridgeManager = new BridgeManager();
export default bridgeManager;
