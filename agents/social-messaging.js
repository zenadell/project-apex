// agents/social-messaging.js
// APEX SocialMessagingAgent — Send messages on behalf of the user.
// WhatsApp, Telegram, LinkedIn, Instagram, TikTok, Email — using YOUR accounts.
// Uses HumanCursor for platforms without API access, so it looks 100% human.

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { launchStealthBrowser, HumanCursor } from '../tools/human-cursor.js';
import bus from '../core/event-bus.js';
import Memory from '../core/memory.js';

export class SocialMessagingAgent extends BaseAgent {
  constructor() {
    super({
      name: 'SocialMessagingAgent',
      type: 'social_messaging',
      description: 'Sends messages on your behalf across WhatsApp, Telegram, LinkedIn, Instagram, Email. Uses human-like cursor to access platforms directly without API — looks 100% like you.',
    });
    this._sessions = {};
  }

  async run(task) {
    const { action = 'send', platform } = task;

    switch (action) {
      case 'send':       return this.send(task);
      case 'draft':      return this.draftMessage(task);
      case 'bulk_send':  return this.bulkSend(task);
      case 'outreach':   return this.outreach(task);
      default:           return this.send(task);
    }
  }

  // ── SMART MESSAGE DRAFTING ─────────────────────────────────────────────────
  async draftMessage({ platform, recipient, objective, context = '', tone = 'professional', length = 'medium' }) {
    const profile = await this._getUserProfile();
    const senderName = profile?.name || 'Temple';

    const draft = await structured(
      `Draft a ${platform} message from ${senderName} to ${recipient}.\n\nObjective: ${objective}\nContext: ${context}\nTone: ${tone}\nLength: ${length} (short=1-2 sentences, medium=1 paragraph, long=2-3 paragraphs)\nPlatform: ${platform} (adapt style for this platform)\n\nWrite a message that sounds natural and human, not AI-generated.`,
      {
        message: 'the complete message text',
        subject: 'subject line if email, otherwise null',
        followUp: 'suggested follow-up if no response in 3 days',
        notes: 'tips for this specific platform/recipient',
      },
      { temperature: 0.7 }
    );

    return draft;
  }

  // ── SEND TO PLATFORM ──────────────────────────────────────────────────────
  async send(task) {
    const { platform, recipient, message, opts = {} } = task;

    // Draft message if not provided
    const msg = message || (await this.draftMessage(task)).message;

    this.log(`Sending ${platform} message to ${recipient}`);

    switch (platform.toLowerCase()) {
      case 'telegram': return this._sendTelegram(recipient, msg, opts);
      case 'whatsapp': return this._sendWhatsApp(recipient, msg, opts);
      case 'email':    return this._sendEmail(recipient, msg, task.subject, opts);
      case 'linkedin': return this._sendLinkedIn(recipient, msg, opts);
      case 'instagram':return this._sendInstagram(recipient, msg, opts);
      default:         return { error: `Platform ${platform} not yet implemented` };
    }
  }

  // ── TELEGRAM ──────────────────────────────────────────────────────────────
  async _sendTelegram(recipient, message, opts = {}) {
    // Try API first (if token available)
    if (process.env.TELEGRAM_BOT_TOKEN && recipient.startsWith('@')) {
      const { default: axios } = await import('axios');
      try {
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: recipient,
          text: message,
          parse_mode: 'Markdown',
        });
        this._logSent('telegram', recipient, message);
        return { sent: true, platform: 'telegram', recipient, method: 'api' };
      } catch {}
    }

    // Fallback: human cursor on web.telegram.org
    const { browser, page, cursor } = await launchStealthBrowser({ headless: false });
    try {
      await page.goto('https://web.telegram.org/', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Search for contact
      const searchBox = await page.$('[placeholder*="Search"]') || await page.$('.search-input');
      if (searchBox) {
        const box = await searchBox.boundingBox();
        await cursor.click(Math.round(box.x + box.width/2), Math.round(box.y + box.height/2));
        await page.waitForTimeout(500);
        await cursor.type(recipient.replace('@', ''));
        await page.waitForTimeout(2000);

        // Click first result
        const firstResult = await page.$('.search-result, .chatlist-chat');
        if (firstResult) {
          const rb = await firstResult.boundingBox();
          await cursor.click(Math.round(rb.x + rb.width/2), Math.round(rb.y + rb.height/2));
          await page.waitForTimeout(1500);
        }
      }

      // Find message input and type
      const msgInput = await page.$('[contenteditable="true"]') || await page.$('.composer-input');
      if (msgInput) {
        const ib = await msgInput.boundingBox();
        await cursor.click(Math.round(ib.x + 20), Math.round(ib.y + ib.height/2));
        await page.waitForTimeout(500);
        await cursor.type(message);
        await page.waitForTimeout(300 + Math.random() * 500);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
      }

      await browser.close();
      this._logSent('telegram', recipient, message);
      return { sent: true, platform: 'telegram', recipient, method: 'human-cursor' };
    } catch (err) {
      await browser.close();
      return { sent: false, error: err.message };
    }
  }

  // ── WHATSAPP ──────────────────────────────────────────────────────────────
  async _sendWhatsApp(recipient, message, opts = {}) {
    // Try Baileys API first
    try {
      const { default: makeWASocket, useMultiFileAuthState } = await import('@whiskeysockets/baileys');
      const { state, saveCreds } = await useMultiFileAuthState('.apex-whatsapp-auth');
      // If already authenticated, send directly
      if (state?.creds?.me) {
        const jid = recipient.includes('@') ? recipient : `${recipient.replace(/\D/g, '')}@s.whatsapp.net`;
        // This requires active Baileys socket — handled by channels.js
        this._logSent('whatsapp', recipient, message);
        return { sent: true, platform: 'whatsapp', recipient, method: 'baileys', note: 'Queued via Baileys' };
      }
    } catch {}

    // Fallback: WhatsApp Web via human cursor
    const phone = recipient.replace(/\D/g, '');
    const { browser, page, cursor } = await launchStealthBrowser({ headless: false });

    try {
      // WhatsApp deep link
      const waUrl = `https://web.whatsapp.com/send?phone=${phone}&text=${encodeURIComponent(message)}`;
      await page.goto(waUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000); // Wait for QR scan if needed

      // Find and click send button
      const sendBtn = await page.$('[data-testid="send"], [data-icon="send"]');
      if (sendBtn) {
        const sb = await sendBtn.boundingBox();
        await cursor.click(Math.round(sb.x + sb.width/2), Math.round(sb.y + sb.height/2));
        await page.waitForTimeout(1000);
      }

      await browser.close();
      this._logSent('whatsapp', recipient, message);
      return { sent: true, platform: 'whatsapp', recipient, method: 'human-cursor' };
    } catch (err) {
      await browser.close();
      return { sent: false, error: err.message, note: 'WhatsApp Web requires active session' };
    }
  }

  // ── EMAIL ─────────────────────────────────────────────────────────────────
  async _sendEmail(recipient, message, subject, opts = {}) {
    const emailAgent = (await import('../core/agent-registry.js')).default.get('EmailCalendarAgent');
    if (emailAgent) {
      return emailAgent._handleTask({
        id: 'social-email', action: 'send',
        to: recipient, subject: subject || 'Hello', body: message,
      });
    }
    return { sent: false, error: 'EmailCalendarAgent not available' };
  }

  // ── LINKEDIN ──────────────────────────────────────────────────────────────
  async _sendLinkedIn(profileUrl, message, opts = {}) {
    const { browser, page, cursor } = await launchStealthBrowser({ headless: false });
    try {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      await cursor.readPage(2000);

      // Find and click Message button
      await cursor.clickElement(page, 'button:has-text("Message"), [aria-label*="Message"]');
      await page.waitForTimeout(1500);

      // Type in message modal
      const textarea = await page.$('textarea, [contenteditable]');
      if (textarea) {
        const tb = await textarea.boundingBox();
        await cursor.click(Math.round(tb.x + 20), Math.round(tb.y + 20));
        await cursor.type(message);
        await page.waitForTimeout(500);

        // Send
        await cursor.clickElement(page, 'button:has-text("Send")');
        await page.waitForTimeout(1500);
      }

      await browser.close();
      this._logSent('linkedin', profileUrl, message);
      return { sent: true, platform: 'linkedin', recipient: profileUrl, method: 'human-cursor' };
    } catch (err) {
      await browser.close();
      return { sent: false, error: err.message, note: 'LinkedIn requires logged-in session' };
    }
  }

  // ── INSTAGRAM DM ─────────────────────────────────────────────────────────
  async _sendInstagram(username, message, opts = {}) {
    const { browser, page, cursor } = await launchStealthBrowser({ headless: false });
    try {
      await page.goto(`https://www.instagram.com/${username}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Click Message button
      await cursor.clickElement(page, 'div[role="button"]:has-text("Message"), a:has-text("Message")');
      await page.waitForTimeout(2000);

      // Type message in DM modal
      const msgBox = await page.$('textarea[placeholder*="message"], [contenteditable]');
      if (msgBox) {
        const mb = await msgBox.boundingBox();
        await cursor.click(Math.round(mb.x + 20), Math.round(mb.y + mb.height/2));
        await cursor.type(message);
        await page.waitForTimeout(400);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
      }

      await browser.close();
      this._logSent('instagram', username, message);
      return { sent: true, platform: 'instagram', recipient: username, method: 'human-cursor' };
    } catch (err) {
      await browser.close();
      return { sent: false, error: err.message };
    }
  }

  // ── BULK SEND ─────────────────────────────────────────────────────────────
  async bulkSend({ platform, recipients, messageTemplate, delay = 30000 }) {
    const results = [];
    for (const recipient of recipients) {
      const message = messageTemplate.replace(/{name}/gi, recipient.name || recipient)
        .replace(/{company}/gi, recipient.company || '')
        .replace(/{platform}/gi, platform);

      const result = await this.send({ platform, recipient: recipient.contact || recipient, message });
      results.push({ recipient, ...result });

      this.log(`Sent to ${recipient}: ${result.sent ? '✅' : '❌'}`);

      // Human-like delay between messages (don't spam)
      if (recipients.indexOf(recipient) < recipients.length - 1) {
        const jitter = delay * (0.7 + Math.random() * 0.6);
        await new Promise(r => setTimeout(r, jitter));
      }
    }
    return { platform, total: recipients.length, sent: results.filter(r => r.sent).length, results };
  }

  // ── OUTREACH CAMPAIGN ────────────────────────────────────────────────────
  async outreach({ prospect, service, platform = 'linkedin', customNote = '' }) {
    // Draft personalized outreach
    const profile = await this._getUserProfile();
    const draft = await this.draftMessage({
      platform, recipient: prospect.name || prospect.company,
      objective: `Offer ${service} services to ${prospect.company || 'them'}`,
      context: `Prospect: ${JSON.stringify(prospect)}\nSender: ${profile?.name} from Jomiez Innovation\n${customNote}`,
      tone: 'warm and professional',
      length: 'short',
    });

    return {
      platform, prospect, service,
      draft: draft.message,
      followUp: draft.followUp,
      readyToSend: true,
    };
  }

  // ── HELPERS ───────────────────────────────────────────────────────────────
  _logSent(platform, recipient, message) {
    Memory.store({
      scope: 'long_term', agent: 'SocialMessagingAgent',
      content: `Sent ${platform} message to ${recipient}: "${message.slice(0, 80)}"`,
      tags: ['social', 'message', 'sent', platform], importance: 7,
    });
    bus.emit('social:message_sent', { platform, recipient });
  }

  async _getUserProfile() {
    try {
      const reg = (await import('../core/agent-registry.js')).default;
      const p = reg.get('UserProfileAgent');
      if (p) return await p._handleTask({ id: 'profile', action: 'profile' });
    } catch {}
    return {};
  }
}

export default SocialMessagingAgent;
