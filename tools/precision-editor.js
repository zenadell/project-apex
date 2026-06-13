// tools/precision-editor.js
// APEX PrecisionEditor — Surgical, AST-aware code modifications.
// Finds exactly the right function/class/block to change. Never rewrites full files.
// Works like Copilot/Antigravity — precise diffs, not full rewrites.

import { complete, structured } from '../core/llm.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import bus from '../core/event-bus.js';

const execAsync = promisify(exec);

export class PrecisionEditor {

  // ── MAIN ENTRY POINT ──────────────────────────────────────────────────────
  // Applies a natural-language modification to a file with surgical precision
  async modify(filePath, instruction, opts = {}) {
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

    const original = readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath);

    // Parse into blocks (functions, classes, methods)
    const blocks = this._parseBlocks(original, ext);

    // Find which blocks need changing
    const targetBlocks = await this._identifyTargets(blocks, instruction, original);

    // Generate precise replacements
    const patches = await this._generatePatches(targetBlocks, instruction, original, filePath);

    // Apply patches
    const modified = this._applyPatches(original, patches);

    // Validate
    const valid = await this._validate(modified, filePath, ext);
    if (!valid.ok) {
      throw new Error(`Patched file has syntax errors: ${valid.error}`);
    }

    // Write
    writeFileSync(filePath, modified);

    // Generate diff summary
    const diff = this._summarizeDiff(original, modified, patches);

    bus.emit('precision-editor:modified', { file: filePath, blocks: patches.length });

    return {
      file: filePath,
      instruction,
      patchesApplied: patches.length,
      blocksModified: patches.map(p => p.blockName),
      diff,
      linesChanged: Math.abs(modified.split('\n').length - original.split('\n').length),
    };
  }

  // ── PARSE FILE INTO SEMANTIC BLOCKS ──────────────────────────────────────
  _parseBlocks(source, ext) {
    const blocks = [];
    const lines = source.split('\n');

    // JS/TS patterns
    if (['.js', '.mjs', '.ts', '.jsx', '.tsx'].includes(ext)) {
      // Functions
      const fnPatterns = [
        /^(export\s+)?(async\s+)?function\s+(\w+)/,
        /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(/,
        /^(export\s+)?(const|let|var)\s+(\w+)\s*=\s*(async\s+)?function/,
        /^\s+(async\s+)?(\w+)\s*\([^)]*\)\s*\{/,  // class methods
      ];

      // Classes
      const classPattern = /^(export\s+)?(default\s+)?class\s+(\w+)/;

      let blockStart = null;
      let blockName = null;
      let braceDepth = 0;
      let inBlock = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Detect block starts
        if (!inBlock) {
          const classMatch = line.match(classPattern);
          if (classMatch) {
            blockStart = i;
            blockName = `class:${classMatch[3]}`;
            inBlock = true;
            braceDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
            continue;
          }

          for (const pattern of fnPatterns) {
            const match = line.match(pattern);
            if (match) {
              const name = match[3] || match[2];
              blockStart = i;
              blockName = `fn:${name}`;
              inBlock = true;
              braceDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
              break;
            }
          }
        } else {
          // Track brace depth
          braceDepth += (line.match(/\{/g) || []).length;
          braceDepth -= (line.match(/\}/g) || []).length;

          if (braceDepth <= 0) {
            blocks.push({
              name: blockName,
              startLine: blockStart,
              endLine: i,
              content: lines.slice(blockStart, i + 1).join('\n'),
              type: blockName.startsWith('class:') ? 'class' : 'function',
            });
            inBlock = false;
            blockStart = null;
            blockName = null;
          }
        }
      }
    }

    // Python patterns
    if (ext === '.py') {
      const defPattern = /^(def|async def|class)\s+(\w+)/;
      let currentBlock = null;
      let currentIndent = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(defPattern);

        if (match) {
          if (currentBlock) {
            blocks.push({ ...currentBlock, endLine: i - 1, content: lines.slice(currentBlock.startLine, i).join('\n') });
          }
          currentBlock = { name: `${match[1]}:${match[2]}`, startLine: i, type: match[1] === 'class' ? 'class' : 'function' };
          currentIndent = line.length - line.trimStart().length;
        }
      }
      if (currentBlock) {
        blocks.push({ ...currentBlock, endLine: lines.length - 1, content: lines.slice(currentBlock.startLine).join('\n') });
      }
    }

    // If no blocks parsed, treat whole file as one block
    if (!blocks.length) {
      blocks.push({ name: 'file:root', startLine: 0, endLine: lines.length - 1, content: source, type: 'file' });
    }

    return blocks;
  }

  // ── IDENTIFY WHICH BLOCKS NEED TO CHANGE ─────────────────────────────────
  async _identifyTargets(blocks, instruction, fullSource) {
    if (blocks.length === 1) return blocks; // Only one block — must be it

    const blockList = blocks.map((b, i) => `[${i}] ${b.name} (lines ${b.startLine}-${b.endLine}): ${b.content.slice(0, 100)}...`).join('\n');

    const result = await structured(
      `Identify which code blocks need to be modified for this instruction:\n\nInstruction: "${instruction}"\n\nBlocks:\n${blockList}\n\nReturn the indices of blocks that need to change.`,
      { targetIndices: [0], reasoning: 'why these blocks' },
      { temperature: 0.1 }
    );

    const indices = result.targetIndices || [0];
    return indices.filter(i => i >= 0 && i < blocks.length).map(i => blocks[i]);
  }

  // ── GENERATE SURGICAL PATCHES ─────────────────────────────────────────────
  async _generatePatches(targetBlocks, instruction, fullSource, filePath) {
    const patches = [];

    for (const block of targetBlocks) {
      const patch = await complete(
        `You are doing a SURGICAL code edit. Modify ONLY what the instruction says — nothing else.\n\nInstruction: "${instruction}"\nFile: ${path.basename(filePath)}\n\nThe EXACT block to modify (lines ${block.startLine}-${block.endLine}):\n\`\`\`\n${block.content}\n\`\`\`\n\nContext (surrounding code):\n\`\`\`\n${fullSource.slice(Math.max(0, (block.startLine - 10) * 30), block.startLine * 30)}\n...\n${fullSource.slice(block.endLine * 30, (block.endLine + 10) * 30)}\n\`\`\`\n\nReturn ONLY the modified version of that exact block. Same indentation, same structure. Change ONLY what the instruction requires. No comments explaining what you changed. No markdown.`,
        { temperature: 0.1, maxTokens: 2000 }
      );

      // Clean the response (remove any accidental markdown)
      const cleaned = patch.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim();

      patches.push({
        blockName: block.name,
        startLine: block.startLine,
        endLine: block.endLine,
        original: block.content,
        replacement: cleaned,
      });
    }

    return patches;
  }

  // ── APPLY PATCHES ─────────────────────────────────────────────────────────
  _applyPatches(source, patches) {
    // Sort patches in reverse order so line numbers stay valid
    const sorted = [...patches].sort((a, b) => b.startLine - a.startLine);
    const lines = source.split('\n');

    for (const patch of sorted) {
      const replacementLines = patch.replacement.split('\n');
      lines.splice(patch.startLine, patch.endLine - patch.startLine + 1, ...replacementLines);
    }

    return lines.join('\n');
  }

  // ── VALIDATE PATCHED FILE ─────────────────────────────────────────────────
  async _validate(source, filePath, ext) {
    const tmpPath = `/tmp/apex-validate-${Date.now()}${ext}`;
    writeFileSync(tmpPath, source);

    try {
      if (['.js', '.mjs'].includes(ext)) {
        await execAsync(`node --check ${tmpPath}`, { timeout: 5000 });
      } else if (['.ts', '.tsx'].includes(ext)) {
        await execAsync(`npx tsc --noEmit --skipLibCheck ${tmpPath} 2>&1`, { timeout: 10000 });
      } else if (ext === '.py') {
        await execAsync(`python3 -m py_compile ${tmpPath}`, { timeout: 5000 });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.stderr || err.message };
    }
  }

  // ── DIFF SUMMARY ──────────────────────────────────────────────────────────
  _summarizeDiff(original, modified, patches) {
    const origLines = original.split('\n');
    const modLines = modified.split('\n');

    return {
      linesAdded: modLines.length - origLines.length > 0 ? modLines.length - origLines.length : 0,
      linesRemoved: origLines.length - modLines.length > 0 ? origLines.length - modLines.length : 0,
      blocksModified: patches.map(p => ({
        block: p.blockName,
        originalLines: p.original.split('\n').length,
        replacementLines: p.replacement.split('\n').length,
      })),
    };
  }

  // ── ADD NEW FUNCTION/CLASS ────────────────────────────────────────────────
  async addCode(filePath, description, position = 'end') {
    const original = readFileSync(filePath, 'utf8');
    const ext = path.extname(filePath);

    const newCode = await complete(
      `Add new code to this file.\n\nFile: ${path.basename(filePath)}\nExisting code:\n${original.slice(0, 3000)}\n\nWhat to add: ${description}\nPosition: ${position} of file\n\nWrite ONLY the new code to add. Match the existing code style exactly.`,
      { temperature: 0.1, maxTokens: 2000 }
    );

    const cleaned = newCode.replace(/^```[\w]*\n?/m, '').replace(/\n?```$/m, '').trim();
    const modified = position === 'end' ? `${original}\n\n${cleaned}\n` : `${cleaned}\n\n${original}`;

    const valid = await this._validate(modified, filePath, ext);
    if (!valid.ok) throw new Error(`Added code has errors: ${valid.error}`);

    writeFileSync(filePath, modified);
    bus.emit('precision-editor:added', { file: filePath, description });
    return { added: true, file: filePath, description };
  }

  // ── FIND AND REPLACE (with AI context) ────────────────────────────────────
  async findAndReplace(filePath, findDescription, replaceWith) {
    const source = readFileSync(filePath, 'utf8');

    const target = await complete(
      `In this code, find the exact string/pattern described below.\n\nCode:\n${source.slice(0, 5000)}\n\nFind: "${findDescription}"\n\nReturn ONLY the exact text to find (copy it exactly as it appears in the code). No explanation.`,
      { temperature: 0.0, maxTokens: 200 }
    );

    const cleaned = target.trim();
    if (!source.includes(cleaned)) throw new Error(`Could not find: "${cleaned}" in ${filePath}`);

    const modified = source.replace(cleaned, replaceWith);
    writeFileSync(filePath, modified);
    return { replaced: true, found: cleaned, replacedWith: replaceWith };
  }
}

export const precisionEditor = new PrecisionEditor();
export default precisionEditor;
