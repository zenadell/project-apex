// core/channel-formatter.js
// APEX Channel Formatter — Turns any APEX output into clean, readable messages.
// No raw asterisks. No code dumps. No markdown spam. Platform-aware formatting.

import { identity } from './identity.js';

// Max message lengths per platform
const LIMITS = {
  telegram: 4096,
  whatsapp: 4000,
  discord: 2000,
  slack: 4000,
  sms: 1600,
  dashboard: 50000,
  default: 4000,
};

export class ChannelFormatter {

  // Main format entry point
  format(content, platform = 'telegram', opts = {}) {
    let text = this._extractText(content);
    text = this._clean(text, platform);
    text = this._truncate(text, LIMITS[platform] || LIMITS.default);
    if (opts.split) return this._splitIntoChunks(text, LIMITS[platform] || 4000);
    return text;
  }

  // Format APEX chat response (for conversation mode)
  formatChat(text, platform = 'telegram') {
    // Remove markdown formatting that looks bad in messengers
    let out = text
      .replace(/\*\*(.*?)\*\*/g, '$1')       // **bold** → plain
      .replace(/\*(.*?)\*/g, '$1')            // *italic* → plain
      .replace(/`{3}[\s\S]*?`{3}/g, '')       // Remove code blocks entirely for chat
      .replace(/`([^`]+)`/g, '"$1"')          // `code` → "code"
      .replace(/#{1,6}\s+/g, '')              // Remove headings
      .replace(/^\s*[=\-]{3,}\s*$/gm, '')     // Remove ====== dividers
      .replace(/^\s*[*\-]\s+/gm, '• ')        // * item → • item
      .replace(/\n{3,}/g, '\n\n')             // Max 2 newlines
      .trim();

    return this._truncate(out, LIMITS[platform] || 4000);
  }

  // Format task result — shows what was accomplished, not the raw output
  formatTaskResult(result, platform = 'telegram') {
    const synthesis = result?.synthesis || result?.result || result;
    const agentsUsed = result?.plan?.agents || [];

    let text = '';

    // Header
    if (result?.input) {
      text += `✅ Done: "${result.input.slice(0, 60)}"\n\n`;
    }

    // Main content (clean)
    let mainContent = '';
    
    if (result?.type === 'voice_modification' || result?.action === 'activated_existing' || result?.integrated) {
      mainContent = `✅ System Evolution Complete: I have successfully integrated the "${result.name || result.capability}" capability. I am now more capable than I was a moment ago. How would you like to test this new skill?`;
    } else if (result?.modifiedFor) {
      mainContent = `✅ Internal Modification Success: I have updated my logic to handle "${result.modifiedFor}". This change is now live across all my agents.`;
    } else {
      mainContent = typeof synthesis === 'string'
        ? synthesis
        : JSON.stringify(synthesis, null, 2);
    }

    text += this.formatChat(mainContent, platform);

    // Footer with agents used (if interesting)
    if (agentsUsed.length > 1) {
      text += `\n\n—\n🤖 Used: ${agentsUsed.join(', ')}`;
    }

    // If there are output files/URLs, show them
    if (result?.result?.outputPath) {
      text += `\n📁 Output: ${result.result.outputPath}`;
    }
    if (result?.result?.url) {
      text += `\n🔗 ${result.result.url}`;
    }

    return this._truncate(text, LIMITS[platform] || 4000);
  }

  // Format error message — clean and helpful
  formatError(error, platform = 'telegram') {
    const msg = error?.message || error?.toString() || 'Unknown error';

    // Make error messages human-readable
    const readable = msg
      .replace(/Error: /g, '')
      .replace(/at .+ \(.+\)/g, '')  // Remove stack traces
      .trim();

    return `❌ ${readable.slice(0, 200)}\n\nTry rephrasing your request or type /status to check system health.`;
  }

  // Format status update for channels
  formatStatus(status, platform = 'telegram') {
    const agents = status.agents || [];
    const awareness = status.awareness || {};
    const working = agents.filter(a => a.status === 'working');
    const idle = agents.filter(a => a.status === 'idle');

    const totalCaps = (awareness.capabilities || []).reduce((acc, c) => acc + c.count, 0);

    return [
      `⚡ APEX Status`,
      ``,
      `🟢 ${idle.length} agents idle`,
      working.length ? `🟡 ${working.length} working: ${working.map(a => a.name).join(', ')}` : null,
      `✦ ${totalCaps} capabilities`,
      `📋 ${awareness.tasks?.total || 0} tasks completed`,
    ].filter(Boolean).join('\n');
  }

  // Split long messages into chunks (for Telegram's 4096 limit)
  splitIfNeeded(text, platform = 'telegram') {
    const limit = LIMITS[platform] || 4000;
    if (text.length <= limit) return [text];
    return this._splitIntoChunks(text, limit);
  }

  // Generate APEX introduction — accurate, never generates code
  introduction(platform = 'telegram') {
    const soul = identity.getSoul();
    const level = identity._autonomyLevel?.() || 'learning';
    const tasks = soul.selfModel?.tasksCompleted || 0;
    const skills = (soul.selfModel?.skillsLearned || []).length;

    return [
      `⚡ I'm APEX — Autonomous Polymorphic Execution System`,
      `Built by Temple Nweke at Jomiez Innovation.`,
      ``,
      `I'm not a chatbot. I'm a fully autonomous system with:`,
      `• 28 specialized agents working together`,
      `• Persistent memory across all our conversations`,
      `• Self-modification — I improve my own code`,
      `• Self-healing — I fix my own failures automatically`,
      ``,
      `What I can actually do right now:`,
      `• 💻 Build complete apps, websites, APIs from scratch`,
      `• 🎨 Design Framer-quality animated UIs`,
      `• 🔍 Deep research on any topic`,
      `• 🔊 Send voice notes (just say "speak to me")`,
      `• 🖼️ Generate images/video/3D (free, no key needed)`,
      `• 🚀 Deploy to Vercel, Fly.io, Railway, Docker`,
      `• 📱 Message people on your behalf (WA, TG, LinkedIn)`,
      `• 🤖 Find and pitch international clients for Jomiez`,
      `• 💰 Create Stripe invoices and payment links`,
      `• 🛡️ Security scan your systems (Kali tools)`,
      `• 🔧 Modify my own capabilities when you ask`,
      `• 📽️ Download + replicate any YouTube project`,
      `• 🌐 Clone any website design (strip Framer lock)`,
      ``,
      `Autonomy: ${level} | Tasks done: ${tasks} | Skills learned: ${skills}`,
      ``,
      `No commands needed. Just talk naturally.`,
      `"speak to me" → voice note`,
      `"build X" → full project`,
      `"use a different voice" → I find and integrate it`,
    ].join('\n');
  }

  // Generate greeting response
  greeting(platform = 'telegram') {
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return `${timeGreeting}, Temple. ⚡ APEX online and ready. What do you need?`;
  }

  // ── PRIVATE HELPERS ──────────────────────────────────────────────────────

  _extractText(content) {
    if (typeof content === 'string') return content;
    if (content?.synthesis) return content.synthesis;
    if (content?.result?.synthesis) return content.result.synthesis;
    if (content?.message) return content.message;
    if (content?.text) return content.text;
    if (content?.analysis) return content.analysis;
    // Last resort: JSON but trim aggressively
    return JSON.stringify(content, null, 2).slice(0, 1000) + '\n\n[Full result in dashboard]';
  }

  _clean(text, platform) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  _truncate(text, limit) {
    if (text.length <= limit) return text;
    const cutoff = limit - 50;
    return text.slice(0, cutoff) + '\n\n... [continued in dashboard: localhost:7332]';
  }

  _splitIntoChunks(text, limit) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }
      // Find a good split point (paragraph break)
      let splitAt = remaining.lastIndexOf('\n\n', limit);
      if (splitAt === -1 || splitAt < limit * 0.5) {
        splitAt = remaining.lastIndexOf('\n', limit);
      }
      if (splitAt === -1 || splitAt < limit * 0.3) {
        splitAt = limit;
      }
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).trim();
    }
    return chunks.filter(Boolean);
  }
}

export const channelFormatter = new ChannelFormatter();
export default channelFormatter;
