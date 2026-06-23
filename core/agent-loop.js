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
//
// All file tools are confined to a `workspace` root — the loop cannot escape it and touch
// APEX's own source. That containment is what makes self-generation safe.

import { chat } from './llm.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import bus from './event-bus.js';

const execAsync = promisify(exec);
const SNAPSHOT_SKIP = new Set(['node_modules', '.git', '.apex-backup', 'sandbox']);

const MAX_OBS_CHARS = 12000;   // cap observation size fed back to the model
const DEFAULT_MAX_STEPS = 30;

// ─── Tool protocol (described to the model) ────────────────────────────────────
const TOOL_SPEC = `
You have these tools. Each turn, respond with EXACTLY ONE JSON object and NOTHING else:

{ "thought": "<one short sentence on what you are doing and why>",
  "tool": "<tool name>",
  "args": { ... } }

Tools:
- list_dir   { "path": "." }                      → list files/dirs (relative to workspace)
- read_file  { "path": "src/x.js" }               → return file contents
- write_file { "path": "src/x.js", "content": "..." } → create/overwrite a whole file
- edit_file  { "path": "src/x.js", "old": "<exact existing snippet>", "new": "<replacement>" }
             → exact search/replace. "old" MUST appear verbatim exactly once. Use this for
               changes to existing files instead of rewriting the whole file.
- run        { "command": "node test.js" }        → run a shell command in the workspace, get stdout/stderr/exit code
- finish     { "summary": "<what you accomplished>", "success": true }

Rules:
- Output ONLY the JSON object. No markdown fences, no prose around it.
- Take ONE action per turn, then wait for the OBSERVATION before the next.
- Verify your work by running it (use run). Don't call finish until it actually works.
- When you write code, write the COMPLETE file content in write_file (no "// ..." placeholders).
`.trim();

function systemPrompt(extra = '') {
  return `You are APEX's autonomous engineering core. You complete software tasks by taking
real actions through tools and reacting to real results. You are precise, you verify your
work by executing it, and you fix failures iteratively.
${extra ? '\n' + extra + '\n' : ''}
${TOOL_SPEC}`;
}

// ─── Robust extraction of a single JSON object from model output ───────────────
function extractToolCall(raw) {
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
function safeResolve(workspace, p) {
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
      return { ok: true, observation: truncate(fs.readFileSync(fp, 'utf8')) };
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
      try {
        const { stdout, stderr } = await execAsync(args.command, {
          cwd: path.resolve(workspace), timeout: 120000, maxBuffer: 4 * 1024 * 1024,
        });
        return { ok: true, observation: `exit 0\n--- stdout ---\n${truncate(stdout)}\n--- stderr ---\n${truncate(stderr)}` };
      } catch (err) {
        return { ok: false, observation: `exit ${err.code ?? 1}\n--- stdout ---\n${truncate(err.stdout)}\n--- stderr ---\n${truncate(err.stderr || err.message)}` };
      }
    }
    case 'finish':
      return { ok: true, finish: true, summary: args.summary || '(no summary)', success: args.success !== false };
    default:
      return { ok: false, observation: `Unknown tool "${tool}". Valid: list_dir, read_file, write_file, edit_file, run, finish.` };
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
 * @returns {Promise<{success, summary, steps, transcript, rolledBack?}>}
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

  const sys = systemPrompt(context);
  const messages = [{ role: 'user', content: `TASK:\n${goal}\n\nThe workspace is "${path.resolve(workspace)}". Begin. Remember: respond with one JSON tool call.` }];
  const transcript = [];
  let consecutiveParseFails = 0;

  emit(onEvent, { type: 'start', goal, workspace: path.resolve(workspace) });

  for (let step = 1; step <= maxSteps; step++) {
    let raw;
    try {
      raw = await chat(messages, { coding: true, temperature: 0.2, maxTokens: 8000, systemPrompt: sys, ...llmOpts });
    } catch (err) {
      emit(onEvent, { type: 'llm_error', step, error: err.message });
      return finalize({ success: false, summary: `LLM call failed: ${err.message}`, steps: step - 1, transcript });
    }

    const call = extractToolCall(raw);
    if (!call || !call.tool) {
      consecutiveParseFails++;
      emit(onEvent, { type: 'parse_fail', step, raw: truncate(raw, 400) });
      if (consecutiveParseFails >= 3) {
        return finalize({ success: false, summary: 'Model failed to produce a valid tool call 3 times.', steps: step, transcript });
      }
      messages.push({ role: 'assistant', content: raw || '' });
      messages.push({ role: 'user', content: 'That was not a valid tool call. Respond with EXACTLY one JSON object: {"thought":"...","tool":"...","args":{...}} and nothing else.' });
      continue;
    }
    consecutiveParseFails = 0;

    emit(onEvent, { type: 'action', step, thought: call.thought, tool: call.tool, args: call.args });
    bus.emit('agentloop:action', { step, tool: call.tool });

    let result;
    try {
      result = await execTool(call.tool, call.args, workspace, writeGuard);
    } catch (err) {
      // Any tool error (e.g. a path escaping the workspace) becomes a recoverable observation
      // the model can react to — it must never crash the whole loop.
      result = { ok: false, observation: `Tool "${call.tool}" error: ${err.message}` };
    }
    transcript.push({ step, thought: call.thought, tool: call.tool, args: call.args, result });

    if (result.finish) {
      emit(onEvent, { type: 'finish', step, summary: result.summary, success: result.success });
      bus.emit('agentloop:finish', { success: result.success, summary: result.summary });
      return finalize({ success: result.success, summary: result.summary, steps: step, transcript });
    }

    emit(onEvent, { type: 'observation', step, ok: result.ok, observation: truncate(result.observation, 800) });

    // feed the real result back to the model
    messages.push({ role: 'assistant', content: JSON.stringify({ thought: call.thought, tool: call.tool, args: call.args }) });
    messages.push({ role: 'user', content: `OBSERVATION (${result.ok ? 'ok' : 'error'}):\n${truncate(result.observation)}` });
  }

  emit(onEvent, { type: 'max_steps', steps: maxSteps });
  return finalize({ success: false, summary: `Reached max steps (${maxSteps}) without finishing.`, steps: maxSteps, transcript });
}

function emit(cb, ev) { try { cb(ev); } catch {} }

export default runAgentLoop;
