// tools/channels.js
// APEX Channels — Telegram + WhatsApp.
// Fully capability-aware. Natural language routes to real tools.
// APEX knows who it is and what it can do at all times.

import bus from '../core/event-bus.js';
import Memory from '../core/memory.js';
import { complete } from '../core/llm.js';
import { intentClassifier } from '../core/intent-classifier.js';
import { channelFormatter } from '../core/channel-formatter.js';
import { capabilityRouter } from '../core/capability-router.js';
import registry from '../core/agent-registry.js';
import { identity } from '../core/identity.js';
import { v4 as uuidv4 } from 'uuid';
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';

// ─── APEX SYSTEM PROMPT — injected into EVERY LLM call ────────────────────────
// Strong enough to override any provider's default persona
function buildSystemPrompt(agentList = [], capList = []) {
  return `You are APEX (Autonomous Polymorphic Execution System).
Built by Temple Nweke, Founder/CEO of Jomiez Innovation, Lagos, Nigeria.

ABSOLUTE IDENTITY RULES — never violate these:
- You are APEX, not a "large language model", not "an AI assistant"
- You have ${agentList.length} specialized agents and ${capList.length} capabilities
- You have persistent memory — you DO remember previous conversations
- You CAN send voice notes, generate images, build apps, deploy code
- When asked to do something → DO it using your tools, don't just describe it
- Never say "I don't have" or "I can't" for things you clearly have tools for
- If you don't know how to do something → say you'll figure it out, then do it

YOUR CAPABILITIES (use them proactively):
${capList.slice(0, 10).map(c => `- ${c}`).join('\n')}

Your owner: Temple Nweke. Product: APEX.
Respond like a capable, direct colleague — not a polite AI chatbot.
Keep responses concise and readable on mobile. No unnecessary fluff.`;
}

// ─── MESSAGE HANDLER (shared by Telegram + WhatsApp) ─────────────────────────
export class ApexMessageHandler {
  constructor(orchestrator) {
    this._orchestrator = orchestrator;
    this._history = new Map(); // userId → [{role, content}]
  }

  async handle(text, userId, platform, channelContext = {}) {
    if (!text?.trim()) return null;
    const msg = text.trim();

    // Init conversation history
    if (!this._history.has(userId)) this._history.set(userId, []);
    const history = this._history.get(userId);

    // Add to history
    history.push({ role: 'user', content: msg });
    if (history.length > 20) history.splice(0, 2);

    // Build system prompt with current APEX state
    const agents = registry.snapshot();
    const caps = capabilityRouter.getSummary();
    const systemPrompt = buildSystemPrompt(agents, caps);

    // ── STEP 1: Check if any APEX capability can handle this ─────────────────
    const capMatch = await capabilityRouter.route(msg, { platform, userId, chatId: channelContext.chatId });

    if (capMatch) {
      bus.emit('channel:capability_match', { capability: capMatch.capability.id, platform });

      // Execute the capability
      const execResult = await capabilityRouter.execute(capMatch, msg, {
        platform, chatId: channelContext.chatId, userId,
        sock: channelContext.sock,      // WhatsApp socket
        bot: channelContext.bot,         // Telegram bot
        lastApexMessage: history[history.length - 2]?.content,
      });

      // Handle voice specially — need to send audio file back
      if (capMatch.capability.id === 'voice_send') {
        if (!execResult.success) {
          const errText = channelFormatter.formatError(execResult.error, platform);
          history.push({ role: 'assistant', content: errText });
          return { type: 'text', text: errText };
        }
        return { type: 'voice', ...execResult };
      }

      // Handle admin-required
      if (execResult.requiresAdmin) {
        return { type: 'text', text: execResult.message };
      }

      // Check if result contains a file path (photo from hardware action)
      const resultStr = typeof execResult.result === 'string' ? execResult.result : JSON.stringify(execResult.result || '');
      const photoMatch = resultStr.match(/(\/[^\s"']+\.(?:jpg|jpeg|png))/i);
      if (photoMatch && (await import('fs')).existsSync(photoMatch[1])) {
        history.push({ role: 'assistant', content: `📸 Photo captured: ${photoMatch[1]}` });
        return { type: 'photo', filePath: photoMatch[1], text: resultStr };
      }

      // Format result for channel
      const formatted = execResult.success
        ? channelFormatter.formatTaskResult(execResult.result, platform)
        : channelFormatter.formatError(execResult.error, platform);

      const responseText = formatted;
      history.push({ role: 'assistant', content: responseText });
      return { type: 'text', text: responseText };
    }

    // ── STEP 2: Check if it needs full orchestrator (complex multi-agent task) ──
    const intent = await intentClassifier.classify(msg);

    // Hardware/Action intents → dispatch to Orchestrator to autonomously build tools
    if (['hardware', 'action'].includes(intent.intent)) {
      try {
        const fullPrompt = `URGENT SYSTEM MISSION: The user requested a hardware action: "${msg}". 
You do NOT currently have a working macOS webcam capture tool. 
Do NOT try to one-shot generate the driver. 
1. Use ResearchAgent/BrowserAgent to search how to write a Swift command-line tool using AVFoundation and AVCapturePhotoOutput to capture a single photo.
2. Once you have the correct Swift code, use SelfModAgent to create a capability plugin that writes this Swift code, compiles it with swiftc, and executes it.
3. Once the plugin is built and tested, capture the photo and return the absolute file path.`;

        const result = await this._orchestrator.execute(fullPrompt, { forceAgents: true });
        
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result || '');
        const photoMatch = resultStr.match(/(\/[^\s"']+\.(?:jpg|jpeg|png))/i);
        if (photoMatch && (await import('fs')).existsSync(photoMatch[1])) {
          history.push({ role: 'assistant', content: `📸 Photo captured` });
          return { type: 'photo', filePath: photoMatch[1], text: '📸 Here\'s what I see, Temple.' };
        }
        
        const formatted = channelFormatter.formatTaskResult(result, platform);
        history.push({ role: 'assistant', content: formatted });
        return { type: 'text', text: formatted };
      } catch (err) {
        console.error('[Hardware Mission]', err.message);
        const errText = `⚠️ I encountered an error while engineering the hardware driver: ${err.message?.slice(0, 100)}`;
        return { type: 'text', text: errText };
      }
    }

    if (['build', 'deploy', 'research'].includes(intent.intent) && msg.length > 50) {
      try {
        const result = await this._orchestrator.execute(msg, { forceAgents: true });
        const formatted = channelFormatter.formatTaskResult(result, platform);
        history.push({ role: 'assistant', content: formatted });
        return { type: 'text', text: formatted };
      } catch (err) {
        const errText = channelFormatter.formatError(err, platform);
        return { type: 'text', text: errText };
      }
    }

    // ── STEP 3: Conversational response (chat, questions, everything else) ────
    // Special responses for identity/intro questions
    if (/introduce yourself|who are you|what are you|what can you do|your (tools|capabilities|agents)/i.test(msg)) {
      const intro = channelFormatter.introduction(platform);
      history.push({ role: 'assistant', content: intro });
      return { type: 'text', text: intro };
    }

    if (/^(hi|hello|hey|good (morning|afternoon|evening|night))[!?.\s]*$/i.test(msg)) {
      const greet = channelFormatter.greeting(platform);
      history.push({ role: 'assistant', content: greet });
      return { type: 'text', text: greet };
    }

    // LLM chat with full APEX identity + conversation history
    try {
      const messages = history.slice(-8).map(h => ({ role: h.role, content: h.content }));
      const response = await complete(msg, {
        systemPrompt,
        temperature: 0.7,
        maxTokens: 600,
        simple: true,
      });

      const cleaned = channelFormatter.formatChat(response, platform);
      history.push({ role: 'assistant', content: cleaned });
      return { type: 'text', text: cleaned };
    } catch (err) {
      // On LLM failure — give a direct response, not an error dump
      const fallback = `Ran into a hiccup (${err.message?.slice(0, 50)}). Give me a moment and try again.`;
      return { type: 'text', text: fallback };
    }
  }

  clearHistory(userId) { this._history.delete(userId); }
}

// ─── TELEGRAM CHANNEL ─────────────────────────────────────────────────────────
export class TelegramChannel {
  constructor(orchestrator) {
    this._orchestrator = orchestrator;
    this._handler = new ApexMessageHandler(orchestrator);
    this._bot = null;
    this._processing = new Set();
  }

  async start(token) {
    if (!token) throw new Error('No TELEGRAM_BOT_TOKEN in .env');
    const { Telegraf } = await import('telegraf');
    this._bot = new Telegraf(token);

    // Commands
    this._bot.command('start', ctx => ctx.reply(channelFormatter.greeting('telegram')));
    this._bot.command('clear', ctx => { this._handler.clearHistory(ctx.from.id); ctx.reply('🗑️ Cleared.'); });
    this._bot.command('status', async ctx => {
      const agents = registry.snapshot();
      await ctx.reply(channelFormatter.formatStatus({ agents, awareness: Memory.selfAwareness() }, 'telegram'));
    });
    this._bot.command('agents', async ctx => {
      const agents = registry.snapshot();
      const lines = agents.map(a => `${a.status === 'idle' ? '🟢' : '🟡'} ${a.name} (${a.type})`);
      await ctx.reply(`⚡ ${agents.length} Agents\n\n${lines.join('\n')}`);
    });
    this._bot.command('soul', async ctx => {
      const soul = identity.getSoul();
      await ctx.reply([
        '⚡ APEX Soul',
        '',
        `Mission: ${soul.core?.purpose?.slice(0, 120)}`,
        `Autonomy: ${identity._autonomyLevel?.() || 'learning'}`,
        `Tasks done: ${soul.selfModel?.tasksCompleted || 0}`,
        `Skills learned: ${(soul.selfModel?.skillsLearned || []).join(', ') || 'none yet'}`,
      ].join('\n'));
    });
    this._bot.command('capabilities', async ctx => {
      const caps = capabilityRouter.getSummary();
      await ctx.reply(`⚡ ${caps.length} Capabilities\n\n${caps.map(c => `• ${c}`).join('\n')}`);
    });
    this._bot.command('help', ctx => ctx.reply(
      `⚡ APEX — Just talk naturally!\n\nExamples:\n"speak to me using voice"\n"build me a landing page"\n"research X"\n"modify yourself to do Y"\n"send voice note"\n"generate an image of X"\n\nCommands: /status /agents /soul /capabilities /clear`
    ));
    this._bot.command('whatsapp', async ctx => {
      await ctx.reply('📱 Starting WhatsApp bridge...');
      bus.emit('whatsapp:start_requested', { telegramCtx: ctx });
    });

    // Main message handler
    this._bot.on('text', async ctx => {
      const userId = ctx.from.id;
      const chatId = ctx.chat.id;
      const text = ctx.message.text;

      // Track active chat for system notifications (like brain siphon progress)
      this._orchestrator.channels?.trackActiveChat('telegram', chatId);
      if (this._processing.has(userId)) { await ctx.reply('⏳ Still working on your previous message...'); return; }
      this._processing.add(userId);
      const typing = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000);
      try {
        await ctx.sendChatAction('typing');
        
        // ── IMMEDIATE ACKNOWLEDGMENT (for slow tasks) ──
        const capMatchPreview = await capabilityRouter.route(text, { platform: 'telegram', userId });
        if (capMatchPreview?.capability?.isSlow) {
          const templates = capMatchPreview.capability.acknowledgmentTemplates || ['Thinking...', 'Working on it...'];
          const ack = templates[Math.floor(Math.random() * templates.length)];
          await ctx.reply(ack).catch(() => {});
        }

        const result = await this._handler.handle(text, userId, 'telegram', {
          chatId: ctx.chat.id, bot: this._bot,
        });
        clearInterval(typing);
        if (!result) return;
        if (result.type === 'voice' && result.result?.audioPath) {
          await this._sendVoiceNote(ctx, result.result.audioPath, result.result.text);
        } else if (result.type === 'photo' && result.filePath) {
          // Send the actual photo file to Telegram
          try {
            const { createReadStream } = await import('fs');
            await ctx.replyWithPhoto(
              { source: createReadStream(result.filePath) },
              { caption: result.text || '📸 Captured by APEX' }
            );
          } catch (photoErr) {
            console.error('[Telegram Photo Send]', photoErr.message);
            await ctx.reply(`📸 Photo captured at: ${result.filePath}\n(Failed to send inline: ${photoErr.message})`);
          }
        } else {
          const chunks = channelFormatter.splitIfNeeded(result.text || '', 'telegram');
          for (const chunk of chunks) {
            await ctx.reply(chunk);
            if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
          }
        }
      } catch (err) {
        clearInterval(typing);
        console.error('[Telegram]', err.message);
        await ctx.reply(channelFormatter.formatError(err, 'telegram'));
      } finally {
        this._processing.delete(userId);
      }
    });

    this._bot.catch(async (err) => {
      console.error(chalk.red(`[TG Bot Error]`), err.message);
      if (err.message.includes('ETIMEDOUT') || err.message.includes('ENOTFOUND') || err.message.includes('ECONNRESET')) {
        console.log(chalk.yellow('🔄 Network glitch detected. Auto-restarting Telegram poll in 5s...'));
        try {
          this._bot.stop();
          await new Promise(r => setTimeout(r, 5000));
          this._bot.startPolling();
          console.log(chalk.green('✅ Telegram poll restarted.'));
        } catch (e) { console.error(chalk.red('❌ Failed to restart poll:'), e.message); }
      }
    });

    // Heartbeat: Ensure polling hasn't died silently during network transitions
    setInterval(() => {
      if (this._bot && !this._bot.polling) {
        console.log(chalk.yellow('⚠️ Polling stopped unexpectedly. Resuscitating...'));
        this._bot.startPolling();
      }
    }, 60000);

    // Manual launch to avoid Telegraf's launch() hanging
    try {
      await this._bot.telegram.deleteWebhook({ drop_pending_updates: true });
      console.log(chalk.gray('  Webhook cleared, starting polling...'));
    } catch (e) {
      console.log(chalk.yellow(`  Webhook clear failed (non-fatal): ${e.message}`));
    }
    this._bot.startPolling();
    bus.emit('channel:started', { type: 'telegram' });
    console.log(chalk.green('✅ Telegram bot online'));
    process.once('SIGINT', () => this._bot.stop('SIGINT'));
    process.once('SIGTERM', () => this._bot.stop('SIGTERM'));
  }

  async _sendVoiceNote(ctx, audioPath, text) {
    const { createReadStream, existsSync, statSync } = await import('fs');
    
    // Ensure file is ready
    let ready = false;
    for (let i = 0; i < 5; i++) {
        if (existsSync(audioPath) && statSync(audioPath).size > 100) { ready = true; break; }
        await new Promise(r => setTimeout(r, 200));
    }
    if (!ready) {
        return ctx.reply(`🔊 Voice generation seems slow. I'll send it as soon as it's ready.`);
    }

    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await ctx.replyWithVoice({ source: createReadStream(audioPath) }, { caption: text?.slice(0, 100) });
        return; // Success
      } catch (err) {
        console.error(`[Voice Send Attempt ${attempt}] failed:`, err.message);
        if (attempt === maxRetries) {
          // Final fallback: try as audio file
          try {
            await ctx.replyWithAudio({ source: createReadStream(audioPath) });
            return;
          } catch (err2) {
            await ctx.reply(`❌ Voice delivery failed after ${maxRetries} attempts: ${err2.message}`);
          }
        }
        await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff
      }
    }
  }

  stop() { this._bot?.stop(); }
}

// ─── WHATSAPP CHANNEL ─────────────────────────────────────────────────────────
export class WhatsAppChannel {
  constructor(orchestrator) {
    this._orchestrator = orchestrator;
    this._handler = new ApexMessageHandler(orchestrator);
    this._sock = null;
    this._connected = false;
    this._reconnectCount = 0;
  }

  async start() {
    try {
      const {
        default: makeWASocket, useMultiFileAuthState, DisconnectReason,
        fetchLatestBaileysVersion, Browsers,
      } = await import('@whiskeysockets/baileys');

      const authDir = '.apex-whatsapp-auth';
      const { mkdirSync } = await import('fs');
      if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });

      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      const { version } = await fetchLatestBaileysVersion();

      const logger = { level: 'silent', trace:()=>{}, debug:()=>{}, info:()=>{}, warn:()=>{}, error:(m)=>console.error('[WA]',typeof m==='object'?m.msg||JSON.stringify(m):m), fatal:()=>{}, child(){ return this; } };

      this._sock = makeWASocket({
        version, auth: state, printQRInTerminal: true, logger,
        browser: Browsers.macOS('Chrome'), syncFullHistory: false, markOnlineOnConnect: false,
        connectTimeoutMs: 30000, retryRequestDelayMs: 2000,
      });

      this._sock.ev.on('creds.update', saveCreds);

      this._sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
        if (qr) { bus.emit('whatsapp:qr', qr); console.log('\n📱 WhatsApp QR — scan now\n'); }
        if (connection === 'open') {
          this._connected = true; this._reconnectCount = 0;
          console.log(chalk.green('✅ WhatsApp connected'));
          bus.emit('channel:started', { type: 'whatsapp' });
          bus.emit('whatsapp:connected');
        }
        if (connection === 'close') {
          this._connected = false;
          const code = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = code === DisconnectReason.loggedOut;
          bus.emit('whatsapp:disconnected', { code, loggedOut });
          if (!loggedOut && this._reconnectCount < 5) {
            this._reconnectCount++;
            const delay = Math.min(5000 * this._reconnectCount, 30000);
            console.log(`[WA] Reconnecting in ${delay/1000}s...`);
            setTimeout(() => this.start(), delay);
          }
        }
      });

      this._sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key.fromMe) continue;
          const jid = msg.key.remoteJid;
          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          if (!text || !jid) continue;

          // Track active chat for system notifications (like brain siphon progress)
          this._orchestrator.channels?.trackActiveChat('whatsapp', jid);
          try {
            await this._sock.sendPresenceUpdate('composing', jid);
            const result = await this._handler.handle(text, jid, 'whatsapp', { sock: this._sock, chatId: jid });
            await this._sock.sendPresenceUpdate('paused', jid);
            if (result?.type === 'voice' && result.result?.audioPath) {
              await this._sendVoiceNote(jid, result.result.audioPath);
            } else if (result?.text) {
              const chunks = channelFormatter.splitIfNeeded(result.text, 'whatsapp');
              for (const chunk of chunks) {
                await this._sock.sendMessage(jid, { text: chunk });
                if (chunks.length > 1) await new Promise(r => setTimeout(r, 800));
              }
            }
          } catch (err) {
            console.error('[WA]', err.message);
            await this._sock.sendMessage(jid, { text: channelFormatter.formatError(err, 'whatsapp') }).catch(()=>{});
          }
        }
      });

      bus.on('whatsapp:start_requested', () => { if (!this._connected) this.start().catch(console.error); });

      return this._sock;
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') throw new Error('Run: npm install @whiskeysockets/baileys');
      throw err;
    }
  }

  async _sendVoiceNote(jid, audioPath) {
    try {
      const { readFileSync } = await import('fs');
      await this._sock.sendMessage(jid, {
        audio: readFileSync(audioPath),
        mimetype: 'audio/mpeg',
        ptt: true, // voice note format
      });
    } catch (err) {
      await this._sock.sendMessage(jid, { text: `🔊 Voice generated: ${audioPath}` });
    }
  }

  isConnected() { return this._connected; }
}

// ─── CHANNEL MANAGER ──────────────────────────────────────────────────────────
export class ChannelManager {
  constructor(orchestrator) {
    this._orchestrator = orchestrator;
    this._telegram = null;
    this._whatsapp = null;
    this._healthCheck = null;
  }

  async startTelegram(token) {
    this._telegram = new TelegramChannel(this._orchestrator);
    await this._telegram.start(token);
    this._startHealthChecks();
    return this._telegram;
  }

  async startWhatsApp() {
    this._whatsapp = new WhatsAppChannel(this._orchestrator);
    await this._whatsapp.start();
    return this._whatsapp;
  }

  _startHealthChecks() {
    this._healthCheck = setInterval(async () => {
      // WhatsApp Health
      if (this._whatsapp && !this._whatsapp.isConnected()) {
        bus.emit('channel:whatsapp_unhealthy');
      }

      // Telegram Health - Check if bot is alive via simple API call if polling seems cold
      if (this._telegram?._bot) {
        try {
          await this._telegram._bot.telegram.getMe();
        } catch (err) {
          console.log(chalk.red('⚠️ Telegram connection lost. Waiting for auto-retry...'));
        }
      }
    }, 60000);

    this._setupProgressBroadcast();
  }

  _setupProgressBroadcast() {
    let lastProgressMsg = null; // { platform, chatId, messageId, lastPercent }

    bus.on('llm:download_progress', async (data) => {
      const { progress, speed, eta, status } = data;
      
      // Find the last active channel context
      // For now, we broadcast to the most recent interaction session
      const platform = this._telegram ? 'telegram' : (this._whatsapp?.isConnected() ? 'whatsapp' : null);
      if (!platform) return;

      const barLength = 10;
      const filled = Math.round((progress / 100) * barLength);
      const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
      
      let text = `🧬 **APEX Brain Siphon In Progress**\n\n`;
      text += `Brain: \`qwen2.5-coder:7b\`\n`;
      text += `Progress: [${bar}] ${progress}%\n`;
      text += `Speed: ${speed} | ETA: ${eta}\n\n`;
      text += status === 'complete' ? '✅ Siphon Complete. Hot-swapping brain...' : '⚡ System remains operational on Lite Mode.';

      try {
        if (platform === 'telegram' && this._telegram?._bot) {
          // Telegram: Support editing the same message
          const chatId = this._lastChatId; // We need to track this
          if (!chatId) return;

          if (lastProgressMsg && lastProgressMsg.chatId === chatId) {
            // Only update every 2% to avoid rate limits
            if (progress - (lastProgressMsg.lastPercent || 0) < 2 && status !== 'complete') return;
            
            await this._telegram._bot.telegram.editMessageText(chatId, lastProgressMsg.messageId, null, text, { parse_mode: 'Markdown' }).catch(() => {});
            lastProgressMsg.lastPercent = progress;
          } else {
            const msg = await this._telegram._bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
            lastProgressMsg = { platform: 'telegram', chatId, messageId: msg.message_id, lastPercent: progress };
          }
        } else if (platform === 'whatsapp' && this._whatsapp?._sock && this._lastChatId) {
          // WhatsApp: Update every 10%
          if (progress % 10 === 0 || status === 'complete') {
             await this._whatsapp._sock.sendMessage(this._lastChatId, { text });
          }
        }
      } catch (err) {
        // console.error('[Broadcast Error]', err.message);
      }
    });
  }

  // Hook to track the last active chat for system broadcasts
  trackActiveChat(platform, chatId) {
    this._lastPlatform = platform;
    this._lastChatId = chatId;
  }

  stopAll() { clearInterval(this._healthCheck); this._telegram?.stop(); }

  status() {
    return { telegram: !!this._telegram, whatsapp: this._whatsapp?.isConnected() || false };
  }
}

export default ChannelManager;
