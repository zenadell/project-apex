// core/agent-loop.js
// APEX Agentic Execution Loop — the layer APEX was missing.
//
// The model emits ONE structured tool call per turn. The harness executes it
// against the real filesystem / shell, then feeds the REAL result back as an
// observation. The model iterates until it calls `finish`.
//
// Why this exists: the rest of APEX historically did `complete(prompt) -> writeFileSync(reply)`,
// i.e. it saved the model's PROSE as if it were code, with no execution and no ground truth.
// That is what produced corrupted files. This loop replaces that pattern everywhere it is used:
//   - file edits are exact diffs (search/replace), never blind full-file overwrites
//   - generated code is syntax-checked on write and can be run + tested before it is trusted
//   - every action returns a real observation the model must react to
//   - it can navigate real, existing codebases: search (grep) + paged file reads
//   - context compaction keeps long/complex tasks inside the model's window
//   - flash→pro escalation: cruise on the cheap model, escalate to the pro reasoner when stuck
//   - NATIVE function-calling (provider tools API) for robust tool dispatch, with a JSON fallback
//   - plan/todo tracking + sub-agent delegation (each child gets its own fresh context)
//   - INDEPENDENT verification: a separate read-only agent must run the code and confirm success
//     before `finish` is accepted — the agent cannot grade its own homework
//
// All file tools are confined to a `workspace` root — the loop cannot escape it and touch
// APEX's own source. That containment is what makes self-generation safe.

import { chat, chatTools } from './llm.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import bus from './event-bus.js';
import { mcpManager } from './mcp-client.js';

const execAsync = promisify(exec);
const SNAPSHOT_SKIP = new Set(['node_modules', '.git', '.apex-backup', 'sandbox']);

const MAX_OBS_CHARS = 12000;   // cap observation size fed back to the model
const DEFAULT_MAX_STEPS = 30;
const COMPACT_THRESHOLD = 30000; // when message history exceeds ~this many chars, compact older turns
const KEEP_RECENT = 6;           // recent messages kept verbatim when compacting

// ─── Tools: native function-calling schemas (OpenAI format) ─────────────────────
// The model picks tools through the provider's native function-calling API (robust, structured),
// not by emitting hand-parsed JSON. `allowedTools` lets a constrained agent (e.g. the read-only
// verifier) be offered only a subset.
const ALL_TOOL_DEFS = {
  list_dir:   { description: 'List files and directories at a workspace-relative path.', params: { path: { type: 'string', description: 'directory, default "."' } }, required: [] },
  read_file:  { description: 'Read a file. For a big file, page it with start/end (1-indexed line numbers).', params: { path: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, required: ['path'] },
  search:     { description: 'Search matching lines across the workspace. query is plain text (case-insensitive) or a /regex/i. Returns file:line: text.', params: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] },
  write_file: { description: 'Create or overwrite a whole file with COMPLETE content (no placeholders).', params: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  edit_file:  { description: 'Exact search/replace in an existing file. "old" must appear verbatim exactly once.', params: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] },
  run:        { description: 'Run a shell command in the workspace; returns stdout, stderr, and exit code.', params: { command: { type: 'string' } }, required: ['command'] },
  plan:       { description: 'Declare or replace your checklist for a multi-part task.', params: { todos: { type: 'array', items: { type: 'string' } } }, required: ['todos'] },
  todo:       { description: 'Update one checklist item status.', params: { index: { type: 'integer' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['index', 'status'] },
  delegate:   { description: 'Hand off sub-task(s) to fresh sub-agent(s) — each gets its own clean context in the same workspace. Use "task" for one, or "tasks" (array) to run several IN PARALLEL (only when they touch DIFFERENT files). Returns summaries.', params: { task: { type: 'string' }, tasks: { type: 'array', items: { type: 'string' } }, context: { type: 'string' } }, required: [] },
  call_agent: { description: 'Invoke one of APEX\'s specialist agents for a capability the file/run tools cannot do — e.g. web research, browsing, email/calendar, voice, image/video, deployment, security scanning, hardware. See the roster in the task context. Returns the agent\'s result.', params: { agent: { type: 'string', description: 'agent name from the roster' }, task: { type: 'string', description: 'what you need it to do' } }, required: ['agent', 'task'] },
  call_mcp:   { description: 'Use an external MCP server\'s tools (configured in .apex-data/mcp.json). Omit "tool" to LIST a server\'s tools; provide tool + args to CALL one. Returns the result.', params: { server: { type: 'string', description: 'configured MCP server name' }, tool: { type: 'string', description: 'tool to call (omit to list tools)' }, args: { type: 'object', description: 'arguments for the tool' } }, required: ['server'] },
  finish:     { description: 'Finish the task — only after you have actually run the code/tests and confirmed success.', params: { summary: { type: 'string' }, success: { type: 'boolean' } }, required: ['summary'] },
};

export function buildToolSchemas(allowed) {
  const names = allowed && allowed.length ? allowed : Object.keys(ALL_TOOL_DEFS);
  return names.filter(n => ALL_TOOL_DEFS[n]).map(name => ({
    type: 'function',
    function: { name, description: ALL_TOOL_DEFS[name].description, parameters: { type: 'object', properties: ALL_TOOL_DEFS[name].params, required: ALL_TOOL_DEFS[name].required } },
  }));
}

export function safeParseArgs(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch {}
  try { return JSON.parse(String(s).replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')); } catch { return {}; }
}

const STRATEGY = `Work strategy:
- SIMPLEST PATH FIRST (most important). Before doing anything, ask: what is the CHEAPEST, easiest way to achieve this goal? Briefly weigh 2-3 approaches and start with the lightest one. Strongly PREFER (a) researching / web-searching / opening the page (call_agent a research or browser agent) and (b) existing tools/agents — OVER downloading, transcribing, or installing big dependencies. Reach for a heavy approach ONLY after the simple ones genuinely fail. Do NOT tunnel into the hardest method.
- RESEARCH the unfamiliar BEFORE diving in. If the task involves something you don't already know how to do, your FIRST move is to find out the easy way (search the web / read the page / check what's installed) — not to start building.
- For a multi-part or long task: call plan with a short checklist, then work the items, marking each todo in_progress when you start and done when verified.
- Delegate large, self-contained sub-tasks (e.g. "build module X", "write the test suite") with delegate — the sub-agent has its own fresh context, which keeps yours clean. Integrate and verify its result. For simple 1-2 step tasks, just do them.
- Explore before you edit: use list_dir / search / read_file to understand existing code first.
- Prefer edit_file (exact diff) over rewriting whole files.
- For capabilities the file/run tools lack (web research, browsing, email, voice, deploy, security scan, hardware), use call_agent with a specialist from the roster — do NOT try to fake them with run.
- VERIFY by running it (use run). Do NOT call finish until the code/tests actually pass — an independent verifier will re-check your claim.
- Write COMPLETE file contents — never "// ..." placeholders.
- Keep the workspace tidy: delete any throwaway scratch/probe files you created (e.g. tmp_*.mjs) before you finish — leave only the real deliverables.
- NEVER hide errors: do NOT suppress stderr (no "2>/dev/null", no swallowing output). You can only fix what you can SEE.
- Before using an unfamiliar tool/API, check it's available (which/--version) or research it. If something is missing, INSTALL it (pip/npm) — don't work around a missing dependency.
- SELF-HEAL: when an action fails, do NOT repeat it. Read the real error, diagnose the ROOT CAUSE, then act on it (install the missing thing, research the error, or switch method). You are autonomous — never stall waiting for a human.
- BE TARGETED AND EFFICIENT — minimize steps. Once a tool, install, or whole approach has failed about twice, treat it as UNAVAILABLE: do NOT keep re-attempting it. Switch to a simpler alternative, or stop and deliver the best partial result you already have. Spinning is failure.
- NEVER FABRICATE. Do not invent output, file contents, transcripts, metrics, or "plausible" answers you didn't actually obtain from a tool. If you couldn't produce something, say so plainly and report the blocker — a truthful PARTIAL answer ("here's what I confirmed; X was blocked because Y") always beats a confident fabrication.
- The deliverable is a WORKING ARTIFACT or a REAL answer backed by actual tool output — never just a description or a plan. Finish the job, then report what real execution returned.`;

function systemPrompt(extra = '') {
  return `You are APEX's autonomous engineering core. You complete software tasks by taking real actions through the provided tools and reacting to real results. Call a tool every step. Be precise; verify by executing.
${extra ? '\n' + extra + '\n' : ''}
${STRATEGY}`;
}

// Injected when the loop detects it's stuck — forces genuine self-healing instead of repetition.
const STUCK_INTERVENTION = `⚠️ YOU ARE STUCK — recent actions failed or repeated with no progress. A real autonomous agent diagnoses and adapts; it never repeats a failing action or waits to be rescued.
RIGHT NOW:
1. STOP. Do NOT re-run anything that already failed (the same command with a different option is still repeating).
2. STEP BACK to a SIMPLER approach you may have skipped. Is the heavy path (download/transcribe/install) even necessary? Could you just web-search it, open the page and read it, or ask a specialist agent (call_agent)? Pick the cheapest route to a good-enough answer.
3. SEE the real error — if you suppressed stderr (2>/dev/null) or piped it away, re-run WITHOUT suppression and read the actual failure.
4. Diagnose the ROOT CAUSE, then FIX it: install the missing dependency, research the error/approach, or switch method entirely.
5. If the goal is genuinely blocked, deliver the BEST PARTIAL answer you have — do not loop.`;

// Probe the runtime so the agent KNOWS what's available and stops attempting impossible installs
// (e.g. apt-get on macOS, multi-GB torch). Injected into the top-level context.
async function probeEnvironment() {
  const tools = ['node', 'python3', 'pip3', 'ffmpeg', 'ffprobe', 'yt-dlp', 'git', 'brew', 'apt-get', 'docker', 'tesseract', 'convert'];
  const have = [];
  for (const t of tools) { try { await execAsync(`command -v ${t}`, { timeout: 3000 }); have.push(t); } catch {} }
  const missing = tools.filter(t => !have.includes(t));
  const mac = os.platform() === 'darwin';
  const note = mac ? ' This is macOS — apt-get/yum do NOT exist (use brew or pip/npm). Avoid multi-GB installs (e.g. torch) unless essential; prefer a lighter tool or an available specialist agent (call_agent).' : '';
  return `\nRUNTIME: ${mac ? 'macOS (darwin)' : os.platform()}. Available CLIs: ${have.join(', ') || '(none)'}. NOT installed: ${missing.join(', ') || '(none)'}.${note}`;
}

// When the agent has flailed too long, STOP and deliver the best partial answer from what it has —
// genuine graceful degradation so APEX always ships something useful instead of looping to a dead end.
export async function synthesizePartial(goal, transcript) {
  const log = transcript.map(t => `${t.tool}${t.args?.command ? ` $${t.args.command}` : t.args?.path ? ` ${t.args.path}` : ''} → ${t.result?.ok ? 'ok' : 'FAIL'}: ${String(t.result?.observation || '').replace(/\s+/g, ' ').slice(0, 180)}`).join('\n').slice(0, 6000);
  // Deterministic fallback so the answer is NEVER empty (e.g. if the model returns empty content).
  const ok = transcript.filter(t => t.result?.ok && t.tool !== 'plan' && t.tool !== 'todo');
  const fallback = `Could not fully complete "${goal}". What I achieved: ${ok.slice(-6).map(t => t.tool + (t.args?.path ? ` ${t.args.path}` : t.args?.command ? ` (${String(t.args.command).slice(0, 40)})` : '')).join('; ') || 'minimal progress'}. The final step stayed blocked; any partial artifacts are in the workspace.`;
  try {
    // NOT the reasoning model here, and a generous budget — otherwise reasoning eats the tokens and content comes back empty.
    const out = await chat([{ role: 'user', content: `You attempted this task but could not fully complete it after repeated tries. Using ONLY what you actually achieved/learned below, give the user the BEST PARTIAL ANSWER you can for their request, and state in one line what remained blocked and why. Be useful and concrete, not apologetic.\n\nREQUEST: ${goal}\n\nWHAT HAPPENED:\n${log}` }], { temperature: 0.3, maxTokens: 2000 });
    return (out && out.trim()) ? out : fallback;
  } catch { return fallback; }
}

// ─── Robust extraction of a single JSON object from model output ───────────────
export function extractToolCall(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  // strip code fences if the model wrapped the JSON
  s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
  const start = s.indexOf('{');
  if (start === -1) return null;
  // balanced-brace scan, string-aware
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    else if (!inStr && c === '{') depth++;
    else if (!inStr && c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch { return null; }
      }
    }
  }
  return null;
}

// ─── Workspace-confined path resolution ────────────────────────────────────────
export function safeResolve(workspace, p) {
  const root = path.resolve(workspace);
  const full = path.resolve(root, p || '.');
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`path "${p}" escapes the workspace`);
  }
  return full;
}

function truncate(str, n = MAX_OBS_CHARS) {
  if (str == null) return '';
  str = String(str);
  return str.length > n ? str.slice(0, n) + `\n...[truncated ${str.length - n} chars]` : str;
}

// ─── Tool implementations ──────────────────────────────────────────────────────
async function execTool(tool, args, workspace, guard) {
  args = args || {};
  switch (tool) {
    case 'list_dir': {
      const dir = safeResolve(workspace, args.path || '.');
      if (!fs.existsSync(dir)) return { ok: false, observation: `No such directory: ${args.path}` };
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .map(e => (e.isDirectory() ? e.name + '/' : e.name));
      return { ok: true, observation: entries.length ? entries.join('\n') : '(empty)' };
    }
    case 'read_file': {
      const fp = safeResolve(workspace, args.path);
      if (!fs.existsSync(fp)) return { ok: false, observation: `No such file: ${args.path}` };
      const raw = fs.readFileSync(fp, 'utf8');
      const lines = raw.split('\n');
      if (args.start != null || args.end != null) {
        const start = Math.max(1, parseInt(args.start ?? 1, 10) || 1);
        const end = Math.min(lines.length, parseInt(args.end ?? lines.length, 10) || lines.length);
        const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join('\n');
        return { ok: true, observation: truncate(slice) };
      }
      if (raw.length > MAX_OBS_CHARS) {
        return { ok: true, observation: truncate(raw) + `\n[file has ${lines.length} lines; use read_file with {start,end} to page through it]` };
      }
      return { ok: true, observation: raw };
    }
    case 'search': {
      const q = args.query;
      if (!q) return { ok: false, observation: `search needs a "query" (plain text or /regex/i).` };
      let re;
      try {
        const m = /^\/(.*)\/([a-z]*)$/.exec(q);
        re = m ? new RegExp(m[1], m[2].includes('i') ? 'i' : '')
               : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } catch { return { ok: false, observation: `invalid regex: ${q}` }; }
      const base = safeResolve(workspace, args.path || '.');
      const matches = [];
      const MAX = 60;
      const walk = (dir) => {
        if (matches.length >= MAX) return;
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (matches.length >= MAX) break;
          if (SNAPSHOT_SKIP.has(e.name)) continue;
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) { walk(fp); continue; }
          let st; try { st = fs.statSync(fp); } catch { continue; }
          if (st.size > 1_000_000) continue;
          let text; try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
          if (text.indexOf(String.fromCharCode(0)) !== -1) continue; // skip binary
          const ls = text.split('\n');
          for (let i = 0; i < ls.length; i++) {
            if (re.test(ls[i])) {
              matches.push(`${path.relative(path.resolve(workspace), fp)}:${i + 1}: ${ls[i].trim().slice(0, 200)}`);
              if (matches.length >= MAX) break;
            }
          }
        }
      };
      if (fs.existsSync(base)) walk(base);
      return { ok: true, observation: matches.length ? matches.join('\n') + (matches.length >= MAX ? `\n[capped at ${MAX} matches]` : '') : `No matches for ${q}` };
    }
    case 'write_file': {
      const fp = safeResolve(workspace, args.path);
      let content = args.content ?? '';
      // strip accidental markdown fences the model may include
      content = content.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
      if (guard) {
        const verdict = await guard({ path: args.path, fullPath: fp, content });
        if (verdict && verdict.ok === false) return { ok: false, observation: verdict.observation || 'Write rejected by guard.' };
      }
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf8');
      const note = await syntaxNote(fp);
      return { ok: true, observation: `Wrote ${args.path} (${content.length} bytes).${note}` };
    }
    case 'edit_file': {
      const fp = safeResolve(workspace, args.path);
      if (!fs.existsSync(fp)) return { ok: false, observation: `No such file: ${args.path}` };
      const original = fs.readFileSync(fp, 'utf8');
      if (args.old == null || args.old === '') return { ok: false, observation: `edit_file needs a non-empty "old" snippet to find.` };
      const count = original.split(args.old).length - 1;
      if (count === 0) return { ok: false, observation: `"old" snippet not found in ${args.path}. Read the file and copy an exact snippet.` };
      if (count > 1) return { ok: false, observation: `"old" snippet appears ${count} times in ${args.path}; make it unique (include surrounding lines).` };
      const updated = original.replace(args.old, args.new ?? '');
      if (guard) {
        const verdict = await guard({ path: args.path, fullPath: fp, content: updated });
        if (verdict && verdict.ok === false) return { ok: false, observation: verdict.observation || 'Edit rejected by guard.' };
      }
      fs.writeFileSync(fp, updated, 'utf8');
      const note = await syntaxNote(fp);
      return { ok: true, observation: `Edited ${args.path}.${note}` };
    }
    case 'run': {
      if (!args.command) return { ok: false, observation: `run needs a "command".` };
      // Installs/downloads (pip, npm, brew, model fetches) legitimately take minutes — a 120s cap
      // silently kills them and makes a capability look "impossible". Give those a real window.
      const heavy = /\b(pip3?|npm|yarn|pnpm|brew|apt-get|apt|cargo|go)\s+(install|add|get)\b|download|whisper|--dump|yt-dlp|ffmpeg/i.test(args.command);
      const timeout = heavy ? 600000 : 120000;
      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: path.resolve(workspace), timeout, maxBuffer: 8 * 1024 * 1024,
        });
        return { ok: true, observation: `exit 0\n--- stdout ---\n${truncate(stdout)}\n--- stderr ---\n${truncate(stderr)}` };
      } catch (err) {
        return { ok: false, observation: `exit ${err.code ?? 1}\n--- stdout ---\n${truncate(err.stdout)}\n--- stderr ---\n${truncate(err.stderr || err.message)}` };
      }
    }
    case 'finish':
      return { ok: true, finish: true, summary: args.summary || '(no summary)', success: args.success !== false };
    default:
      return { ok: false, observation: `Unknown tool "${tool}". Valid: list_dir, read_file, search, write_file, edit_file, run, plan, todo, delegate, call_agent, call_mcp, finish.` };
  }
}

// Quick syntax check for JS files written to disk; surfaced to the model immediately.
async function syntaxNote(fp) {
  if (!fp.endsWith('.js') && !fp.endsWith('.mjs')) return '';
  try {
    await execAsync(`node --check "${fp}"`, { timeout: 5000 });
    return ' Syntax OK.';
  } catch (err) {
    return ` ⚠️ Syntax error: ${truncate(err.stderr || err.message, 600)}`;
  }
}

// ─── Workspace snapshot / rollback (file-based, NEVER touches git) ──────────────
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    if (SNAPSHOT_SKIP.has(entry)) continue;
    const s = path.join(src, entry), d = path.join(dst, entry);
    const st = fs.statSync(s);
    if (st.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

export function snapshotWorkspace(workspace) {
  const backup = path.join(os.tmpdir(), `apex-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  copyTree(workspace, backup);
  return backup;
}

export function restoreWorkspace(backup, workspace) {
  // Remove everything the run may have created/changed (except skipped dirs), then copy the snapshot back.
  for (const entry of fs.readdirSync(workspace)) {
    if (SNAPSHOT_SKIP.has(entry)) continue;
    fs.rmSync(path.join(workspace, entry), { recursive: true, force: true });
  }
  copyTree(backup, workspace);
}

// ─── Context compaction ─────────────────────────────────────────────────────────
// Long/complex tasks would otherwise grow the message history until it overflows the model's
// context window and quality collapses. When history gets large, summarize the older turns into
// a compact "progress so far" note and keep only the most recent turns verbatim. This is what
// lets the loop sustain very long, multi-step tasks — the single biggest enabler of complexity.
export async function maybeCompact(messages, onEvent = () => {}, step = 0) {
  const size = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
  if (size < COMPACT_THRESHOLD || messages.length <= KEEP_RECENT + 2) return messages;

  const head = messages[0];                                  // the original TASK
  // Keep the most recent turns verbatim — but never start the kept window on a dangling tool
  // result, or the API rejects it (a 'tool' message must follow its assistant's tool_calls).
  let cut = Math.max(1, messages.length - KEEP_RECENT);
  while (cut > 1 && messages[cut].role === 'tool') cut--;
  const recent = messages.slice(cut);
  const middle = messages.slice(1, cut);
  const historyText = middle.map(m =>
    (m.role === 'assistant' && m.tool_calls?.length)
      ? `ASSISTANT called: ${m.tool_calls.map(t => t.function?.name).join(', ')}`
      : `${m.role.toUpperCase()}: ${m.content || ''}`
  ).join('\n').slice(0, 24000);

  let summary;
  try {
    summary = await chat(
      [{ role: 'user', content: `Summarize the agent's progress so it can continue WITHOUT the full history. Be concrete: files created/modified, key decisions, what is verified working, what still remains, and errors to avoid repeating.\n\nHISTORY:\n${historyText}` }],
      { temperature: 0.1, maxTokens: 700 }
    );
  } catch {
    return messages; // compaction is best-effort; never break the run over it
  }
  emit(onEvent, { type: 'compact', step, fromMessages: messages.length });
  return [head, { role: 'user', content: `PROGRESS SUMMARY (earlier steps compacted):\n${summary}` }, ...recent];
}

// ─── Plan / todo tracker ────────────────────────────────────────────────────────
function renderTodos(todos) {
  if (!todos.length) return '(no todos)';
  return todos.map((t, i) => `${i}. [${t.status === 'done' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.task}`).join('\n');
}

function updatePlan(tool, args, todos, onEvent, depth) {
  if (tool === 'plan') {
    const list = Array.isArray(args.todos) ? args.todos : [];
    if (!list.length) return { ok: false, observation: 'plan needs a non-empty "todos" array.' };
    todos.length = 0;
    for (const t of list) {
      todos.push(typeof t === 'string'
        ? { task: t, status: 'pending' }
        : { task: String(t.task || ''), status: t.status || 'pending' });
    }
    emit(onEvent, { type: 'plan', depth, todos: todos.map(t => ({ ...t })) });
    return { ok: true, observation: `Plan set:\n${renderTodos(todos)}` };
  }
  // tool === 'todo'
  const idx = parseInt(args.index, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= todos.length) {
    return { ok: false, observation: `todo: index ${args.index} out of range (0..${todos.length - 1}).` };
  }
  todos[idx].status = ['pending', 'in_progress', 'done'].includes(args.status) ? args.status : 'done';
  emit(onEvent, { type: 'plan', depth, todos: todos.map(t => ({ ...t })) });
  return { ok: true, observation: `Updated todo ${idx} → ${todos[idx].status}.\n${renderTodos(todos)}` };
}

// ─── Sub-agent delegation ───────────────────────────────────────────────────────
// Hand a self-contained sub-task to a CHILD loop with its OWN fresh context. The parent only
// ever sees the child's summary — not its full transcript — so a big project costs the parent
// almost no context. This is the mechanism that lets APEX scale to arbitrarily complex work.
async function runDelegate(args, cfg) {
  const { workspace, writeGuard, llmOpts, depth, maxDepth, maxSteps, onEvent } = cfg;
  if (depth >= maxDepth) {
    return { ok: false, observation: `Delegation depth limit (${maxDepth}) reached — do this sub-task yourself with the file/run tools.` };
  }

  const spawn = (task, branch) => {
    const childOnEvent = (ev) => emit(onEvent, { ...ev, depth: (ev.depth ?? depth) + 1, viaDelegate: true, ...(branch != null ? { branch } : {}) });
    return runAgentLoop(String(task), {
      workspace, writeGuard, llmOpts,
      maxSteps: Math.min(maxSteps, 25),
      depth: depth + 1, maxDepth,
      context: args.context ? `Handoff from the parent agent:\n${args.context}` : '',
      onEvent: childOnEvent,
    }).catch(err => ({ success: false, summary: `error: ${err.message}`, steps: 0 }));
  };

  // PARALLEL: run several independent sub-tasks concurrently (the model is told to use this only
  // when they touch DIFFERENT files). Big speedup on large projects — the front-tier agent move.
  const tasks = Array.isArray(args.tasks) ? args.tasks.filter(t => t && String(t).trim()) : null;
  if (tasks && tasks.length) {
    emit(onEvent, { type: 'delegate_start', depth, task: `${tasks.length} parallel sub-tasks`, parallel: true });
    const children = await Promise.all(tasks.map((t, i) => spawn(t, i)));
    const okCount = children.filter(c => c.success).length;
    const lines = children.map((c, i) => `  [${i}] ${c.success ? 'OK' : 'FAIL'} (${c.steps} steps): ${c.summary}`);
    emit(onEvent, { type: 'delegate_end', depth, success: okCount === children.length, summary: `${okCount}/${children.length} parallel sub-agents succeeded` });
    return { ok: okCount === children.length, observation: `Parallel sub-agents (${okCount}/${children.length} ok):\n${lines.join('\n')}` };
  }

  // SINGLE
  const task = args.task || args.goal;
  if (!task) return { ok: false, observation: 'delegate needs "task" (one sub-task) or "tasks" (an array, run in parallel).' };
  emit(onEvent, { type: 'delegate_start', depth, task });
  const child = await spawn(task, null);
  emit(onEvent, { type: 'delegate_end', depth, success: child.success, summary: child.summary, steps: child.steps });
  const head = child.success ? 'Sub-agent COMPLETED' : 'Sub-agent did NOT finish';
  return { ok: child.success, observation: `${head} (${child.steps} steps): ${child.summary}` };
}

// ─── Specialist agents as tools (call_agent) ────────────────────────────────────
// The loop is a software-engineering brain (file/run/search). For everything else — web research,
// browsing, email/calendar, voice, image/video, deploy, security scans, hardware — it invokes one
// of APEX's specialist agents. This is what makes the loop a UNIVERSAL executor, not just a coder.
async function listAvailableAgents() {
  try {
    const registry = (await import('./agent-registry.js')).default;
    const all = (typeof registry.all === 'function') ? registry.all() : [];
    const EXCLUDE = new Set(['CodeAgent', 'WardenAgent', 'SelfModAgent']); // the loop already embodies these
    return all.filter(a => a && a.name && !EXCLUDE.has(a.name))
      .map(a => ({ name: a.name, description: (a.description || '').slice(0, 100) }));
  } catch { return []; }
}

async function runCallAgent(args, cfg) {
  const { onEvent, depth, workspace } = cfg;
  const name = args.agent, task = args.task;
  if (!name || !task) return { ok: false, observation: 'call_agent needs "agent" and "task".' };
  let registry;
  try { registry = (await import('./agent-registry.js')).default; } catch { return { ok: false, observation: 'agent registry unavailable.' }; }
  const agent = registry.get ? registry.get(name) : null;
  if (!agent) {
    const avail = (await listAvailableAgents()).map(a => a.name).join(', ') || '(none registered)';
    return { ok: false, observation: `No agent named "${name}". Available: ${avail}.` };
  }
  emit(onEvent, { type: 'call_agent', depth, agent: name, task });
  try {
    // Extract file/image paths + URLs from the task and pass them through — without this, vision/
    // file-consuming agents (e.g. VisionAgent needs task.imagePath) get only prose and fail.
    const urlMatch = task.match(/https?:\/\/[^\s)"'<>]+/);
    const tokens = task.match(/(?:\.{0,2}\/)?[\w./~-]+\.(?:png|jpe?g|webp|gif|bmp|pdf|txt|json|csv|md|mp4|mov|wav|mp3|html?)/gi) || [];
    const resolved = [];
    for (const p of tokens) {
      try { const abs = path.isAbsolute(p) ? p : path.resolve(workspace || process.cwd(), p); if (fs.existsSync(abs) && !resolved.includes(abs)) resolved.push(abs); } catch {}
    }
    const images = resolved.filter(p => /\.(png|jpe?g|webp|gif|bmp)$/i.test(p));
    // Agents read varied field names; pass a superset so most work without per-agent mapping.
    const payload = {
      id: `loop-${Date.now()}`, objective: task, prompt: task, query: task, instruction: task, task, workspace,
      imagePath: images[0], images, paths: resolved, filePath: resolved[0],
      imageUrl: (urlMatch && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(urlMatch[0])) ? urlMatch[0] : undefined,
      url: urlMatch ? urlMatch[0] : undefined,
    };
    const result = (typeof agent._handleTask === 'function') ? await agent._handleTask(payload) : await agent.run(payload);
    let obs;
    if (result == null) obs = `${name} completed (no return value).`;
    else if (typeof result === 'string') obs = result;
    else obs = result.synthesis || result.summary || result.message || JSON.stringify(result);
    return { ok: true, observation: `${name} →\n${truncate(String(obs))}` };
  } catch (err) {
    return { ok: false, observation: `${name} failed: ${err.message}` };
  }
}

// ─── External MCP servers as tools (call_mcp) ───────────────────────────────────
async function runCallMcp(args, cfg) {
  const { onEvent, depth } = cfg;
  const server = args.server;
  if (!server) return { ok: false, observation: 'call_mcp needs "server" (a configured MCP server name).' };
  try {
    if (!args.tool) {
      const tools = await mcpManager.tools(server);
      emit(onEvent, { type: 'call_mcp', depth, server, tool: '(list)' });
      return { ok: true, observation: `MCP "${server}" tools:\n${tools.map(t => `- ${t.name}: ${(t.description || '').slice(0, 80)}`).join('\n') || '(none)'}` };
    }
    emit(onEvent, { type: 'call_mcp', depth, server, tool: args.tool });
    const result = await mcpManager.call(server, args.tool, args.args || {});
    return { ok: true, observation: `${server}.${args.tool} →\n${truncate(String(result))}` };
  } catch (err) {
    return { ok: false, observation: `MCP "${server}" error: ${err.message}` };
  }
}

// ─── Learning: distill successful runs into lessons, recall them on similar tasks ──
// This is the self-improving half: after the loop verifiably succeeds, it stores a compact
// "playbook" of what worked; on a future similar task it recalls relevant playbooks and injects
// them as hints. Memory.search is a LIKE on content, so recall is keyword-driven.
const STOPWORDS = new Set('the a an and or to of for with in on at is are be do does build create make write file files code test tests run using use that this it your you them then into from as new app project function class return print value string'.split(' '));
function keywordsOf(text, n = 7) {
  const words = (String(text).toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) || []).filter(w => !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, n);
}
async function recallLessons(goal, onEvent) {
  try {
    const Memory = (await import('./memory.js')).default;
    const seen = new Map();
    for (const kw of keywordsOf(goal)) for (const m of Memory.search(kw, { agent: 'loop-memory', limit: 3 })) seen.set(m.id, m);
    const lessons = [...seen.values()].sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, 3);
    if (!lessons.length) return '';
    emit(onEvent, { type: 'recall', count: lessons.length });
    return `\nRELEVANT PAST EXPERIENCE (lessons from similar tasks you solved before — reuse what helps):\n${lessons.map((l, i) => `${i + 1}. ${l.content}`).join('\n')}`;
  } catch { return ''; }
}
async function distillLesson(goal, transcript, summary, onEvent) {
  try {
    const Memory = (await import('./memory.js')).default;
    const steps = transcript.map(t => `${t.tool}${t.args?.path ? ` ${t.args.path}` : ''}${t.args?.command ? ` $${t.args.command}` : ''}`).join(' → ').slice(0, 1500);
    let playbook;
    try {
      playbook = await chat([{ role: 'user', content: `Distill a SHORT reusable playbook (max 6 lines) from this successfully-completed task so a future agent on a SIMILAR task can reuse the approach. Include the task type, the winning sequence, key files/commands, and any gotcha to avoid. Terse and concrete.\n\nTASK: ${goal}\nSTEPS: ${steps}\nOUTCOME: ${summary}` }], { temperature: 0.2, maxTokens: 320 });
    } catch { playbook = `Approach: ${steps}`; }
    Memory.store({ scope: 'long_term', agent: 'loop-memory', key: String(goal).slice(0, 100), content: `[${String(goal).slice(0, 90)}]\n${playbook}`, tags: ['playbook', 'lesson'], importance: 7 });
    emit(onEvent, { type: 'learned' });
  } catch { /* learning is best-effort */ }
}

// ─── Independent verification ───────────────────────────────────────────────────
// Do NOT let the agent grade its own homework. When it claims `finish`, a SEPARATE read-only
// agent (its own fresh context, can only read/search/RUN — never modify) must independently
// confirm the task is actually done by executing the relevant code/tests. If it can't confirm,
// the worker's finish is rejected and it keeps working with the verifier's precise feedback.
async function runVerifier(goal, workspace, claim, cfg) {
  const { llmOpts, onEvent } = cfg;
  emit(onEvent, { type: 'verify_start' });
  const vGoal = `INDEPENDENT VERIFICATION — do NOT trust the worker's claim.

ORIGINAL TASK:
${goal}

THE WORKER CLAIMS IT IS DONE:
${claim}

Confirm whether the task is ACTUALLY complete: inspect the workspace and RUN the relevant code/tests yourself. You can only read, search, and run — you cannot modify anything.
Call finish with success=true ONLY if you executed the relevant code/tests and saw them pass and genuinely satisfy the task. Otherwise finish with success=false and a precise one-paragraph reason stating exactly what is missing, wrong, or unverified.`;

  const res = await runAgentLoop(vGoal, {
    workspace,
    llmOpts,
    maxSteps: 12,
    allowedTools: ['list_dir', 'read_file', 'search', 'run', 'finish'],
    verify: false,        // never verify the verifier (no recursion)
    depth: 0,
    maxDepth: 0,
    onEvent: (ev) => emit(onEvent, { ...ev, verifier: true }),
  });
  emit(onEvent, { type: 'verify_end', verified: res.success, reason: res.summary });
  return { verified: res.success, reason: res.summary || 'no reason given' };
}

// ─── The loop ──────────────────────────────────────────────────────────────────
/**
 * Run an autonomous tool-calling loop until the model finishes or steps run out.
 * @param {string} goal              The task in natural language.
 * @param {object} opts
 * @param {string} opts.workspace    Directory the agent may read/write/run in (required).
 * @param {number} [opts.maxSteps]   Max tool calls (default 30).
 * @param {string} [opts.context]    Extra context injected into the system prompt.
 * @param {function} [opts.onEvent]  Callback({type, ...}) for streaming progress.
 * @param {object} [opts.llmOpts]    Extra options passed to the LLM router.
 * @param {function} [opts.writeGuard] async ({path, fullPath, content}) => {ok, observation};
 *                                    vets every write_file/edit_file before it touches disk
 *                                    (e.g. Warden). Return {ok:false, observation} to reject.
 * @param {boolean} [opts.rollbackOnFailure] snapshot the workspace (file copy, NOT git) before
 *                                    the run and restore it if the loop fails. Only snapshots
 *                                    when the workspace already has content worth protecting.
 * @param {number} [opts.depth]      current delegation depth (internal; 0 at the top).
 * @param {number} [opts.maxDepth]   how deep sub-agents may delegate (default 2).
 * @param {string[]} [opts.allowedTools] restrict the offered tools to this subset (e.g. the
 *                                    read-only verifier gets list_dir/read_file/search/run/finish).
 * @param {boolean} [opts.verify]    on finish (top level only), run an INDEPENDENT read-only
 *                                    verifier that must confirm the work by running it; if it
 *                                    can't, the finish is rejected and the agent keeps working.
 * @returns {Promise<{success, summary, steps, transcript, rolledBack?, verified?}>}
 */
export async function runAgentLoop(goal, opts = {}) {
  const {
    workspace,
    maxSteps = DEFAULT_MAX_STEPS,
    context = '',
    onEvent = () => {},
    llmOpts = {},
    writeGuard = null,   // optional async ({path, fullPath, content}) => {ok, observation} — vets every write/edit
    rollbackOnFailure = false,
    depth = 0,
    maxDepth = 2,
    allowedTools = null,
    verify = false,
    learn = false,
  } = opts;

  if (!workspace) throw new Error('runAgentLoop requires a workspace directory');
  const wsRoot = path.resolve(workspace);
  fs.mkdirSync(wsRoot, { recursive: true });

  // Opt-in safety: snapshot existing workspace content so a failed run can be rolled back.
  // Pure file copy — it never runs git, so it cannot disturb any surrounding repository.
  let backup = null;
  if (rollbackOnFailure) {
    try {
      const hasContent = fs.readdirSync(wsRoot).some(e => !SNAPSHOT_SKIP.has(e));
      if (hasContent) { backup = snapshotWorkspace(wsRoot); emit(onEvent, { type: 'snapshot', backup }); }
    } catch { /* snapshot best-effort */ }
  }

  // Single exit point: restore on failure, drop the snapshot on success.
  const finalize = (result) => {
    if (backup) {
      if (!result.success) {
        try { restoreWorkspace(backup, wsRoot); result.rolledBack = true; emit(onEvent, { type: 'rolledback' }); } catch {}
      }
      try { fs.rmSync(backup, { recursive: true, force: true }); } catch {}
    }
    return result;
  };

  // Specialist agents (call_agent) and external MCP servers (call_mcp) the loop may invoke — only
  // when not running a restricted toolset (e.g. the verifier). Tools are dropped when none exist.
  const restricted = !!(allowedTools && allowedTools.length);
  const agentRoster = restricted ? [] : await listAvailableAgents();
  let mcpServers = []; try { mcpServers = restricted ? [] : mcpManager.listConfigured(); } catch {}
  const rosterNote =
    (agentRoster.length ? `\nSpecialist agents available via call_agent (for things file/run cannot do):\n${agentRoster.map(a => `- ${a.name}: ${a.description}`).join('\n')}` : '') +
    (mcpServers.length ? `\nExternal MCP servers available via call_mcp (call_mcp {server} to list a server's tools, then {server,tool,args} to call):\n${mcpServers.map(s => `- ${s.name}`).join('\n')}` : '');
  const defaultNames = Object.keys(ALL_TOOL_DEFS).filter(n => {
    if (n === 'call_agent') return agentRoster.length > 0;
    if (n === 'call_mcp') return mcpServers.length > 0;
    return true;
  });
  const effectiveTools = restricted ? allowedTools : defaultNames;

  // Self-improvement + environment awareness: recall lessons from similar past tasks, and tell the
  // agent what's actually installed so it stops attempting impossible installs.
  const learnedNote = (learn && depth === 0) ? await recallLessons(goal, onEvent) : '';
  const envNote = (depth === 0) ? await probeEnvironment() : '';
  const sys = systemPrompt(context + rosterNote + learnedNote + envNote);
  const toolNames = new Set(effectiveTools);
  const toolSchemas = buildToolSchemas(effectiveTools);
  let messages = [{ role: 'user', content: `TASK:\n${goal}\n\nThe workspace is "${wsRoot}". Begin — use the provided tools.` }];
  const transcript = [];
  const todos = [];      // the agent's live checklist (plan/todo tools maintain it)
  let consecutiveParseFails = 0;
  let errorStreak = 0;   // consecutive failed steps — when high, escalate flash → pro to think harder
  let stuckSteps = 0;    // steps taken while stuck — after a cap, force graceful degradation (ship partial)
  let stepsSinceWrite = 0; // steps with no file write — caps pure info-gathering ("good enough, ship it")
  let softNudged = false;

  emit(onEvent, { type: 'start', goal, workspace: wsRoot });

  for (let step = 1; step <= maxSteps; step++) {
    messages = await maybeCompact(messages, onEvent, step);

    // Smart routing + SELF-HEALING: cruise on flash; when stuck (repeated failures), escalate to
    // the pro reasoner AND inject a forced diagnose-and-adapt intervention so the agent fixes the
    // root cause and changes strategy instead of repeating a dead action or waiting for rescue.
    const stuck = errorStreak >= 2;
    if (stuck) {
      stuckSteps++;
      emit(onEvent, { type: 'stuck', step, errorStreak });
      // SURVIVAL: after repeated failed self-heal attempts, stop flailing and ship the best partial
      // answer from what already works — never loop to a dead end "couldn't finish".
      if (stuckSteps >= 3) {
        emit(onEvent, { type: 'degrade', step });
        const partial = await synthesizePartial(goal, transcript);
        bus.emit('agentloop:finish', { success: false, summary: partial });
        return finalize({ success: false, degraded: true, summary: partial, steps: step, transcript });
      }
      messages.push({ role: 'user', content: STUCK_INTERVENTION });
    }

    // GATHERING BUDGET ("good enough — ship it"): when a top-level run has gone many steps WITHOUT
    // producing any file (pure info-gathering, e.g. "tell me about X"), stop over-collecting and
    // deliver the best answer from what's gathered. Builds write files, reset this, and are unaffected.
    if (depth === 0 && stepsSinceWrite >= 10) {
      emit(onEvent, { type: 'budget', step, stepsSinceWrite });
      const partial = await synthesizePartial(goal, transcript);
      bus.emit('agentloop:finish', { success: true, summary: partial });
      return finalize({ success: true, degraded: true, summary: partial, steps: step, transcript });
    }
    if (depth === 0 && stepsSinceWrite === 6 && !softNudged) {
      softNudged = true;
      messages.push({ role: 'user', content: 'You have gathered a lot already and produced no file yet. If you have enough to give a useful answer, STOP gathering and deliver your best answer NOW (with honest caveats about anything you could not confirm). Only continue if you are genuinely one step from a clearly better result.' });
    }

    // Use the pro reasoner when stuck AND on the very first step — choosing the right (simplest)
    // approach up front is the single highest-leverage decision in the whole run.
    const usePro = stuck || (depth === 0 && step === 1);
    let resp;
    try {
      resp = await chatTools(messages, toolSchemas, { complex: usePro, temperature: 0.2, maxTokens: 8000, systemPrompt: sys, ...llmOpts });
    } catch (err) {
      emit(onEvent, { type: 'llm_error', step, error: err.message });
      return finalize({ success: false, summary: `LLM call failed: ${err.message}`, steps: step - 1, transcript });
    }

    // Prefer native tool_calls; fall back to a JSON object parsed from text content.
    const native = (resp.toolCalls || []).filter(tc => tc.function?.name);
    let calls = native.length
      ? native.map(tc => ({ id: tc.id, name: tc.function.name, args: safeParseArgs(tc.function.arguments) }))
      : (() => { const p = extractToolCall(resp.content); return (p && p.tool) ? [{ id: null, name: p.tool, args: p.args || {} }] : []; })();

    if (!calls.length) {
      consecutiveParseFails++; errorStreak++;
      emit(onEvent, { type: 'parse_fail', step, raw: truncate(resp.content, 400) });
      if (consecutiveParseFails >= 3) {
        return finalize({ success: false, summary: 'Model produced no valid tool call 3 times.', steps: step, transcript });
      }
      messages.push({ role: 'assistant', content: resp.content || '' });
      messages.push({ role: 'user', content: 'That was not a tool call. Use one of the provided tools.' });
      continue;
    }
    consecutiveParseFails = 0;

    // Finishing supersedes anything else in the same batch — run only the finish call so the
    // assistant message and its tool responses stay consistent.
    const finishCall = calls.find(c => c.name === 'finish');
    const callsToRun = finishCall ? [finishCall] : calls;
    const idsToRun = new Set(callsToRun.map(c => c.id));

    if (native.length) messages.push({ role: 'assistant', content: resp.content || '', tool_calls: resp.toolCalls.filter(tc => idsToRun.has(tc.id)) });
    else messages.push({ role: 'assistant', content: resp.content || JSON.stringify({ tool: callsToRun[0].name, args: callsToRun[0].args }) });

    let anyError = false;
    let wroteThisStep = false;
    let returned = null;

    for (const c of callsToRun) {
      emit(onEvent, { type: 'action', step, tool: c.name, args: c.args, model: usePro ? 'pro' : 'flash' });
      bus.emit('agentloop:action', { step, tool: c.name });

      // ── finish: gate on INDEPENDENT verification (top level only) ──
      if (c.name === 'finish') {
        const success = c.args?.success !== false;
        const summary = c.args?.summary || '(no summary)';
        let verdict = { verified: true, reason: '' };
        if (verify && depth === 0 && success) verdict = await runVerifier(goal, wsRoot, summary, { llmOpts, onEvent });

        if (verdict.verified) {
          if (learn && depth === 0 && success) await distillLesson(goal, transcript, summary, onEvent);
          emit(onEvent, { type: 'finish', step, summary, success, verified: (verify && depth === 0) || undefined });
          bus.emit('agentloop:finish', { success, summary });
          returned = finalize({ success, summary, steps: step, transcript, verified: (verify && depth === 0) || undefined });
          break;
        }
        // rejected — feed the verifier's reason back and keep working
        errorStreak++;
        emit(onEvent, { type: 'verify_rejected', step, reason: verdict.reason });
        const msg = `Independent verification FAILED — you are NOT done. ${verdict.reason}\nFix the issues, then finish only when it genuinely passes.`;
        if (native.length) messages.push({ role: 'tool', tool_call_id: c.id, content: msg });
        else messages.push({ role: 'user', content: msg });
        break;
      }

      // ── normal tools ──
      let result;
      try {
        if (!toolNames.has(c.name)) result = { ok: false, observation: `Tool "${c.name}" is not available here. Available: ${[...toolNames].join(', ')}.` };
        else if (c.name === 'plan' || c.name === 'todo') result = updatePlan(c.name, c.args || {}, todos, onEvent, depth);
        else if (c.name === 'delegate') result = await runDelegate(c.args || {}, { workspace, writeGuard, llmOpts, depth, maxDepth, maxSteps, onEvent });
        else if (c.name === 'call_agent') result = await runCallAgent(c.args || {}, { onEvent, depth, workspace });
        else if (c.name === 'call_mcp') result = await runCallMcp(c.args || {}, { onEvent, depth });
        else result = await execTool(c.name, c.args, workspace, writeGuard);
      } catch (err) {
        result = { ok: false, observation: `Tool "${c.name}" error: ${err.message}` };
      }
      transcript.push({ step, tool: c.name, args: c.args, result });
      if (!result.ok) anyError = true;
      if ((c.name === 'write_file' || c.name === 'edit_file') && result.ok) wroteThisStep = true;
      emit(onEvent, { type: 'observation', step, ok: result.ok, observation: truncate(result.observation, 800) });
      if (native.length) messages.push({ role: 'tool', tool_call_id: c.id, content: truncate(result.observation) });
      else messages.push({ role: 'user', content: `OBSERVATION (${result.ok ? 'ok' : 'error'}):\n${truncate(result.observation)}` });
    }

    if (returned) return returned;
    if (!finishCall) errorStreak = anyError ? errorStreak + 1 : 0;
    stepsSinceWrite = wroteThisStep ? 0 : stepsSinceWrite + 1;
  }

  // Out of steps — still ship the best partial answer rather than a useless "couldn't finish".
  emit(onEvent, { type: 'max_steps', steps: maxSteps });
  const partial = (depth === 0)
    ? await synthesizePartial(goal, transcript)
    : `Reached max steps (${maxSteps}) without finishing.`;
  if (depth === 0) emit(onEvent, { type: 'degrade', step: maxSteps });
  return finalize({ success: false, degraded: depth === 0 || undefined, summary: partial, steps: maxSteps, transcript });
}

// Fan every loop event out to (a) the caller's onEvent and (b) the global bus, so any in-process
// subscriber (e.g. the dashboard) gets the full live stream without the caller wiring anything.
function emit(cb, ev) {
  try { cb(ev); } catch {}
  try { bus.emit('agentloop:event', ev); } catch {}
}

export default runAgentLoop;
