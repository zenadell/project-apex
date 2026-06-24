// core/mcp-client.js
// APEX MCP Client — lets APEX CONSUME external MCP servers (the counterpart to tools/mcp-server.js,
// which exposes APEX as a server). APEX can now connect to any MCP server, discover its tools, and
// call them — so external MCP capabilities become first-class alongside the loop's own tools and
// APEX's specialist agents (call_agent).
//
// Transports:
//   - stdio: spawn a command (e.g. `npx -y @modelcontextprotocol/server-filesystem /path`) and speak
//            newline-delimited JSON-RPC 2.0 over stdin/stdout (how most MCP servers run).
//   - http:  POST JSON-RPC 2.0 to a URL (e.g. http://localhost:7333/mcp).
//
// Servers are configured in .apex-data/mcp.json:
//   { "servers": { "filesystem": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/tmp"] },
//                  "myhttp":     { "url": "http://localhost:9000/mcp" } } }

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bus from './event-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '..', '.apex-data', 'mcp.json');
const PROTOCOL_VERSION = '2024-11-05';

// ─── stdio transport: newline-delimited JSON-RPC over a child process ───────────
class StdioTransport {
  constructor({ command, args = [], env = {} }) {
    this.command = command; this.args = args; this.env = env;
    this.proc = null; this._buf = ''; this._pending = new Map();
  }
  async start() {
    this.proc = spawn(this.command, this.args, { env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.on('error', (err) => this._failAll(err));
    this.proc.on('exit', (code) => this._failAll(new Error(`MCP server exited (code ${code})`)));
  }
  _onData(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || JSON.stringify(msg.error))) : resolve(msg.result);
      }
    }
  }
  _failAll(err) { for (const { reject } of this._pending.values()) reject(err); this._pending.clear(); }
  request(id, method, params) {
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      const t = setTimeout(() => { if (this._pending.delete(id)) reject(new Error(`MCP request timed out: ${method}`)); }, 30000);
      const done = (fn) => (v) => { clearTimeout(t); fn(v); };
      this._pending.set(id, { resolve: done(resolve), reject: done(reject) });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (err) { clearTimeout(t); this._pending.delete(id); reject(err); }
    });
  }
  notify(method, params) { try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch {} }
  close() { try { this.proc?.kill(); } catch {} }
}

// ─── http transport: POST JSON-RPC to a URL ─────────────────────────────────────
class HttpTransport {
  constructor({ url }) { this.url = url; }
  async start() {}
  async request(id, method, params) {
    const resp = await fetch(this.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.result;
  }
  notify() {}
  close() {}
}

// ─── one connection to one MCP server ───────────────────────────────────────────
export class MCPClient {
  constructor(config) {
    this.config = config;
    this.transport = config.url ? new HttpTransport(config) : new StdioTransport(config);
    this._id = 0; this.tools = null; this.serverInfo = null;
  }
  _rpc(method, params = {}) { return this.transport.request(++this._id, method, params); }
  async connect() {
    await this.transport.start();
    const init = await this._rpc('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'apex', version: '1.0' } });
    this.serverInfo = init?.serverInfo || null;
    this.transport.notify('notifications/initialized', {});
    return this;
  }
  async listTools() { const r = await this._rpc('tools/list', {}); this.tools = r?.tools || []; return this.tools; }
  async callTool(name, args = {}) {
    const r = await this._rpc('tools/call', { name, arguments: args });
    // Normalize MCP content array → plain text for the loop's observation feed.
    if (r?.content && Array.isArray(r.content)) return r.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
    return typeof r === 'string' ? r : JSON.stringify(r);
  }
  close() { this.transport.close(); }
}

// ─── manager: config-driven, lazily-connected pool of MCP servers ───────────────
class MCPManager {
  constructor() { this._clients = new Map(); }
  loadConfig() {
    try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return { servers: {} }; }
  }
  saveConfig(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  }
  listConfigured() { return Object.entries(this.loadConfig().servers || {}).map(([name, cfg]) => ({ name, ...cfg })); }
  async addServer(name, cfg) {
    const conf = this.loadConfig(); conf.servers = conf.servers || {}; conf.servers[name] = cfg; this.saveConfig(conf);
    bus.emit('mcp:server_added', { name });
    return { name, ...cfg };
  }
  async client(name) {
    if (this._clients.has(name)) return this._clients.get(name);
    const cfg = this.loadConfig().servers?.[name];
    if (!cfg) throw new Error(`No MCP server "${name}" configured in .apex-data/mcp.json`);
    const c = new MCPClient(cfg);
    await c.connect();
    this._clients.set(name, c);
    bus.emit('mcp:connected', { name, serverInfo: c.serverInfo });
    return c;
  }
  async tools(name) { return (await this.client(name)).listTools(); }
  async call(name, tool, args) {
    const c = await this.client(name);
    bus.emit('mcp:call', { server: name, tool });
    return c.callTool(tool, args);
  }
  closeAll() { for (const c of this._clients.values()) c.close(); this._clients.clear(); }
}

export const mcpManager = new MCPManager();
export default mcpManager;
