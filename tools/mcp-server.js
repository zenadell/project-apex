// tools/mcp-server.js
// APEX MCP Server — Exposes all APEX agents as MCP tools.
// Connect from Cursor, Claude Desktop, Google Antigravity, VS Code — any MCP client.
// Your IDE gets APEX superpowers: build, deploy, research, browse, all from inside the IDE.

import { createServer } from 'http';
import { EventEmitter } from 'events';
import registry from '../core/agent-registry.js';
import Memory from '../core/memory.js';
import bus from '../core/event-bus.js';
import chalk from 'chalk';

// MCP Protocol implementation (JSON-RPC 2.0 over stdio or HTTP+SSE)
export class ApexMCPServer extends EventEmitter {
  constructor(orchestrator, port = 7333) {
    super();
    this._orchestrator = orchestrator;
    this._port = port;
    this._tools = this._buildToolCatalog();
  }

  // ── BUILD TOOL CATALOG FROM ALL AGENTS ───────────────────────────────────
  _buildToolCatalog() {
    return [
      // ── TASK EXECUTION ──
      {
        name: 'apex_run',
        description: 'Execute any task with APEX autonomous agents. APEX will plan, research, build, test, and deliver.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Natural language task description' },
            outputDir: { type: 'string', description: 'Optional output directory for files' },
          },
          required: ['task'],
        },
      },

      // ── CODE ──
      {
        name: 'apex_build',
        description: 'Build a complete project: plan architecture → write code → install deps → test → fix bugs. Returns all files.',
        inputSchema: {
          type: 'object',
          properties: {
            objective: { type: 'string', description: 'What to build' },
            language: { type: 'string', description: 'Preferred language/framework (auto-detected if not specified)' },
            outputDir: { type: 'string', description: 'Where to save the project' },
          },
          required: ['objective'],
        },
      },

      // ── RESEARCH ──
      {
        name: 'apex_research',
        description: 'Deep web research on any topic. Searches GitHub, npm, web, and synthesizes findings.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Research query' },
            depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'Research depth' },
          },
          required: ['query'],
        },
      },

      // ── BROWSER ──
      {
        name: 'apex_browse',
        description: 'Browse a URL, extract information, fill forms, click elements. Uses stealth browser.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to browse' },
            objective: { type: 'string', description: 'What to do on the page' },
            extract: { type: 'string', description: 'What data to extract' },
          },
          required: ['url'],
        },
      },

      // ── UI DESIGN ──
      {
        name: 'apex_design_ui',
        description: 'Design and build a complete UI/frontend. Framer-quality animations, responsive, production-ready.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'UI description' },
            framework: { type: 'string', description: 'react/vanilla/vue (auto-detected)' },
            outputDir: { type: 'string', description: 'Output directory' },
          },
          required: ['description'],
        },
      },

      // ── DEPLOY ──
      {
        name: 'apex_deploy',
        description: 'Deploy a project to Fly.io, Railway, Vercel, Docker, or PM2. Auto-detects best platform.',
        inputSchema: {
          type: 'object',
          properties: {
            projectDir: { type: 'string', description: 'Project directory to deploy' },
            platform: { type: 'string', enum: ['auto', 'fly', 'railway', 'vercel', 'docker', 'pm2'], description: 'Target platform' },
          },
          required: ['projectDir'],
        },
      },

      // ── GIT ──
      {
        name: 'apex_git',
        description: 'Clone a repo, analyze it, modify it, push changes, and deploy.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['clone', 'analyze', 'modify', 'push', 'full_pipeline'] },
            url: { type: 'string', description: 'GitHub repo URL' },
            modification: { type: 'string', description: 'What to modify (for modify/full_pipeline actions)' },
            targetDir: { type: 'string', description: 'Where to clone' },
          },
          required: ['action'],
        },
      },

      // ── SECURITY ──
      {
        name: 'apex_security_scan',
        description: 'Security scan of a target (your own systems only). OSINT, vulnerability assessment.',
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Target to scan (must be your own system)' },
            authorized: { type: 'boolean', description: 'Confirm you own/have permission to test this target' },
          },
          required: ['target', 'authorized'],
        },
      },

      // ── SCREENSHOT / VISION ──
      {
        name: 'apex_screenshot',
        description: 'Take a screenshot and analyze it with AI vision.',
        inputSchema: {
          type: 'object',
          properties: {
            analyze: { type: 'boolean', description: 'Analyze screenshot with AI' },
            prompt: { type: 'string', description: 'What to look for in the screenshot' },
          },
        },
      },

      // ── DATA ANALYSIS ──
      {
        name: 'apex_analyze_data',
        description: 'Analyze a data file (CSV, JSON) or URL with AI. Natural language queries, statistics, charts.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', description: 'File path, URL, or inline data' },
            query: { type: 'string', description: 'Natural language question about the data' },
            chart: { type: 'boolean', description: 'Generate a chart' },
          },
          required: ['source'],
        },
      },

      // ── IMAGE/VIDEO GENERATION ──
      {
        name: 'apex_generate',
        description: 'Generate images, video, or 3D models. Uses free providers (Pollinations, etc.)',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['image', 'video', '3d', 'audio'] },
            prompt: { type: 'string', description: 'Generation prompt' },
            width: { type: 'number', description: 'Width in pixels (images)' },
            height: { type: 'number', description: 'Height in pixels (images)' },
          },
          required: ['type', 'prompt'],
        },
      },

      // ── SYSTEM STATUS ──
      {
        name: 'apex_status',
        description: 'Get APEX system status: active agents, capabilities, memory, uptime.',
        inputSchema: { type: 'object', properties: {} },
      },

      // ── PRECISION EDIT ──
      {
        name: 'apex_edit_file',
        description: 'Surgically modify a specific file with natural language instructions. AST-aware, precise diff.',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'File to modify' },
            instruction: { type: 'string', description: 'What to change (natural language)' },
          },
          required: ['filePath', 'instruction'],
        },
      },

      // ── EMAIL ──
      {
        name: 'apex_email',
        description: 'Read inbox, send emails, draft professional messages.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['read', 'send', 'draft', 'summarize'] },
            to: { type: 'string', description: 'Recipient (for send/draft)' },
            objective: { type: 'string', description: 'Email purpose (for draft)' },
          },
          required: ['action'],
        },
      },

      // ── REVENUE ──
      {
        name: 'apex_revenue',
        description: 'Create Stripe invoices, payment links, find revenue opportunities.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['invoice', 'payment_link', 'opportunities', 'status'] },
            clientEmail: { type: 'string' },
            amount: { type: 'number' },
            description: { type: 'string' },
          },
          required: ['action'],
        },
      },
    ];
  }

  // ── HANDLE TOOL CALL ──────────────────────────────────────────────────────
  async _callTool(name, args) {
    this.emit('tool_call', { name, args });

    switch (name) {
      case 'apex_run':
        return this._orchestrator.execute(args.task, { outputDir: args.outputDir });

      case 'apex_build': {
        const agent = registry.get('CodeAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, objective: args.objective, language: args.language, outputDir: args.outputDir, type: 'project' });
      }

      case 'apex_research': {
        const agent = registry.get('ResearchAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, query: args.query, depth: args.depth });
      }

      case 'apex_browse': {
        const agent = registry.get('BrowserAgentPro');
        return agent._handleTask({ id: `mcp-${Date.now()}`, objective: args.objective, url: args.url, extract: args.extract });
      }

      case 'apex_design_ui': {
        const agent = registry.get('UIAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, objective: args.description, framework: args.framework, outputDir: args.outputDir });
      }

      case 'apex_deploy': {
        const agent = registry.get('DeployAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, action: args.platform || 'auto', projectDir: args.projectDir });
      }

      case 'apex_git': {
        const { gitTool } = await import('./git-tool.js');
        if (args.action === 'clone') return gitTool.clone(args.url, args.targetDir);
        if (args.action === 'analyze') {
          const files = await gitTool.readFiles(args.targetDir);
          const agent = registry.get('CodeAgent');
          return agent.analyzeCodebase(args.targetDir);
        }
        if (args.action === 'full_pipeline') {
          const { dir } = await gitTool.clone(args.url);
          const codeAgent = registry.get('CodeAgent');
          const deployAgent = registry.get('DeployAgent');
          if (args.modification) {
            const { precisionEditor } = await import('./precision-editor.js');
            const files = await gitTool.readFiles(dir, ['.js', '.ts', '.py']);
            for (const file of files.slice(0, 5)) {
              try { await precisionEditor.modify(dir + file.path, args.modification); } catch {}
            }
          }
          await gitTool.commit('APEX modifications', dir);
          return deployAgent._handleTask({ id: `mcp-${Date.now()}`, action: 'auto', projectDir: dir });
        }
        return { error: `Unknown git action: ${args.action}` };
      }

      case 'apex_security_scan': {
        if (!args.authorized) return { error: 'Set authorized: true to confirm you own this target' };
        const agent = registry.get('SecurityAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, objective: `Scan ${args.target}`, target: args.target, authorization: true });
      }

      case 'apex_screenshot': {
        const agent = registry.get('VisionAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, action: 'screenshot_and_analyze', prompt: args.prompt || 'Describe everything on screen', screenshot: true });
      }

      case 'apex_analyze_data': {
        const agent = registry.get('DataAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, action: args.chart ? 'visualize' : 'analyze', filePath: args.source, query: args.query });
      }

      case 'apex_generate': {
        const agent = registry.get('GenerationAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, action: args.type, prompt: args.prompt, opts: { width: args.width, height: args.height } });
      }

      case 'apex_status':
        return {
          agents: registry.snapshot(),
          capabilities: Memory.listCapabilities(),
          awareness: Memory.selfAwareness(),
        };

      case 'apex_edit_file': {
        const { precisionEditor } = await import('./precision-editor.js');
        return precisionEditor.modify(args.filePath, args.instruction);
      }

      case 'apex_email': {
        const agent = registry.get('EmailCalendarAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, action: args.action, to: args.to, objective: args.objective });
      }

      case 'apex_revenue': {
        const agent = registry.get('RevenueAgent');
        return agent._handleTask({ id: `mcp-${Date.now()}`, action: args.action, clientEmail: args.clientEmail, amount: args.amount, items: args.amount ? [{ description: args.description, amount: args.amount }] : [] });
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // ── START HTTP+SSE MCP SERVER ─────────────────────────────────────────────
  async start() {
    const server = createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const url = new URL(req.url, `http://localhost:${this._port}`);

      // ── MCP PROTOCOL ENDPOINTS ──
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: 'APEX MCP Server',
          version: '2.0.0',
          description: 'APEX autonomous agent tools for any MCP-compatible IDE',
          tools: this._tools.length,
        }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/tools') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tools: this._tools }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/call') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
          try {
            const { name, arguments: args } = JSON.parse(body);
            const result = await this._callTool(name, args || {});
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // JSON-RPC endpoint (for MCP over HTTP)
      if (req.method === 'POST' && url.pathname === '/mcp') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', async () => {
          const rpc = JSON.parse(body);
          let response;

          if (rpc.method === 'initialize') {
            response = {
              jsonrpc: '2.0', id: rpc.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'apex-mcp', version: '2.0.0' },
              }
            };
          } else if (rpc.method === 'tools/list') {
            response = { jsonrpc: '2.0', id: rpc.id, result: { tools: this._tools } };
          } else if (rpc.method === 'tools/call') {
            try {
              const result = await this._callTool(rpc.params.name, rpc.params.arguments || {});
              response = {
                jsonrpc: '2.0', id: rpc.id,
                result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
              };
            } catch (err) {
              response = { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: err.message } };
            }
          } else {
            response = { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } };
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        });
        return;
      }

      res.writeHead(404); res.end('Not found');
    });

    await new Promise(resolve => server.listen(this._port, () => resolve()));

    console.log(chalk.magenta(`\n🔌 APEX MCP Server: http://localhost:${this._port}`));
    console.log(chalk.gray(`   ${this._tools.length} tools available`));
    console.log(chalk.gray(`   Add to Cursor/.cursor/mcp.json:`));
    console.log(chalk.gray(`   { "apex": { "url": "http://localhost:${this._port}/mcp" } }\n`));

    bus.emit('mcp:started', { port: this._port, tools: this._tools.length });
    return server;
  }

  // ── STDIO MODE (for Claude Desktop / direct MCP) ───────────────────────
  startStdio() {
    process.stdin.setEncoding('utf8');
    let buffer = '';

    process.stdin.on('data', async chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const rpc = JSON.parse(line);
          let response;

          if (rpc.method === 'initialize') {
            response = { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'apex-mcp', version: '2.0.0' } } };
          } else if (rpc.method === 'tools/list') {
            response = { jsonrpc: '2.0', id: rpc.id, result: { tools: this._tools } };
          } else if (rpc.method === 'tools/call') {
            const result = await this._callTool(rpc.params.name, rpc.params.arguments || {});
            response = { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } };
          }

          if (response) process.stdout.write(JSON.stringify(response) + '\n');
        } catch {}
      }
    });

    console.error('APEX MCP Server (stdio mode) ready');
  }
}

export default ApexMCPServer;
