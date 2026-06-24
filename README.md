# APEX — Autonomous Polymorphic Execution System

APEX is a self-hosted, multi-agent AI system built by Temple Nweke (Jomiez Innovation).
It coordinates a fleet of specialized agents (code, research, security, browser, voice,
vision, deploy, and more) behind a multi-provider LLM router, with persistent memory,
a self-healing loop, and a sandboxed agentic execution core.

## Architecture

```
apex.js                 → entrypoint / orchestrator boot
core/
  llm-router.js         → multi-provider router (DeepSeek → Groq → Gemini → Claude → Ollama)
  llm.js                → thin re-export of the router (chat / complete / structured)
  agent-loop.js         → REAL agentic tool-calling loop (read/write/edit/run + ground-truth feedback)
  agent-registry.js     → live registry of running agents
  self-healing.js       → health checks, agent recovery, LLM watchdog
  memory.js             → persistent SQLite-backed memory
  sandbox.js            → isolated code execution (Docker, with host fallback)
  event-bus.js          → in-process pub/sub used across agents
agents/                 → specialized agents, all extend agents/base-agent.js
plugins/                → self-generated / hot-loaded tools (gated by the Warden)
dashboard/              → local web dashboard (server.js + public/)
```

## Requirements

- Node.js >= 20
- A `.env` file (gitignored) with at least one LLM key. See keys used in `core/llm-router.js`:
  `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_URL`.
- Optional: Docker (for fully isolated sandboxed execution).

## Quick start

```bash
npm install
# create .env with at least one LLM key, then:
npm start                 # boots APEX (apex.js)
```

## The agentic core (`core/agent-loop.js`)

This is the layer that lets APEX actually *do* tasks instead of describing them. The model
emits one structured tool call per turn; the harness executes it (reading real files, running
real commands), and feeds the real result back. Edits are applied as exact diffs — never
blind full-file overwrites — and generated code is run and tested before it is trusted.

Run a single task directly:

```bash
node agent-run.js "create calculator.js with add/multiply, write a test, run it, make it pass" --workspace /tmp/demo
```

The loop can also reach **APEX's specialist agents** (`call_agent`) and **external MCP servers**
(`call_mcp`) for capabilities the file/run tools don't cover.

## Connectors

APEX both **exposes** itself as an MCP server (`tools/mcp-server.js`, for Cursor/Claude Desktop/etc.)
and **consumes** external MCP servers as a client (`core/mcp-client.js`, stdio or http):

```bash
# register an external MCP server, then APEX can use its tools via call_mcp
apex mcp-add filesystem --command npx --args "-y,@modelcontextprotocol/server-filesystem,/tmp"
apex mcp-list
```

It can also clone + integrate a git repo as a reusable skill (`agents/skills.js`).

## Tests

```bash
node test/smoke.js          # structural + module smoke tests
node test/agent-loop.test.js  # agentic-core regression suite
```

## Notes

- Autonomous source-rewriting of APEX's own core is intentionally **disabled** — it previously
  corrupted the system. Self-modification happens by generating *new* tools/agents into
  `plugins/`, in a workspace, validated by execution and tests, and gated by the Warden.
