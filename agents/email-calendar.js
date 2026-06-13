// agents/email-calendar.js
// APEX EmailCalendarAgent — Read/send emails, manage calendar events.
// Uses nodemailer (SMTP) for sending, IMAP for reading, node-ical for calendar.
// No OAuth required — works with app passwords (Gmail, Outlook, etc.)

import { BaseAgent } from './base-agent.js';
import { complete, structured } from '../core/llm.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Memory from '../core/memory.js';
import bus from '../core/event-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.apex-data', 'email');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export class EmailCalendarAgent extends BaseAgent {
  constructor() {
    super({
      name: 'EmailCalendarAgent',
      type: 'email_calendar',
      description: 'Read and send emails. Manage calendar events. Draft professional emails. Schedule meetings. Summarize inbox. Smart email actions using AI.',
    });
    this._config = this._loadConfig();
  }

  async run(task) {
    const { action } = task;

    switch (action) {
      case 'send':           return this.sendEmail(task);
      case 'draft':          return this.draftEmail(task);
      case 'read_inbox':     return this.readInbox(task);
      case 'summarize_inbox':return this.summarizeInbox();
      case 'reply':          return this.replyToEmail(task);
      case 'schedule':       return this.scheduleEvent(task);
      case 'list_events':    return this.listEvents(task);
      case 'setup':          return this.setup(task);
      case 'status':         return this.status();
      default:               return this.smartEmailAction(task);
    }
  }

  // ─── SEND EMAIL ───────────────────────────────────────────────────────────

  async sendEmail({ to, subject, body, html, attachments = [], cc, bcc }) {
    this.log(`Sending email to: ${to}`);
    const transporter = await this._getTransporter();

    const mail = {
      from: `${this._config.name || 'APEX'} <${this._config.email}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject,
      text: body,
      ...(html ? { html } : {}),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
      ...(attachments.length ? { attachments } : {}),
    };

    const info = await transporter.sendMail(mail);
    this.remember(`Sent email to ${to}: ${subject}`, { tags: ['email', 'sent'], importance: 6 });
    bus.emit('email:sent', { to, subject });
    return { sent: true, messageId: info.messageId, to, subject };
  }

  // ─── AI DRAFT EMAIL ───────────────────────────────────────────────────────

  async draftEmail({ objective, to, context = '', tone = 'professional' }) {
    const profile = await this._getUserProfile();

    const draft = await structured(
      `Draft an email based on this objective.\n\nObjective: "${objective}"\nTo: ${to}\nTone: ${tone}\nContext: ${context}\nSender: ${profile.name || 'the user'}\n\nWrite a complete, ${tone} email.`,
      {
        subject: 'email subject line',
        body: 'complete email body (plain text)',
        html: 'HTML version of the email body',
        notes: 'any notes about this draft',
      },
      { temperature: 0.5 }
    );

    return { draft, ready: true };
  }

  // ─── READ INBOX ───────────────────────────────────────────────────────────

  async readInbox({ limit = 10, folder = 'INBOX', filter = 'UNSEEN' } = {}) {
    this.log(`Reading inbox: ${folder} (${filter}, limit ${limit})`);
    try {
      const imap = await this._getIMAPClient();
      const messages = await this._fetchMessages(imap, folder, filter, limit);
      await imap.end();

      // Cache locally
      const cachePath = path.join(DATA_DIR, 'inbox-cache.json');
      writeFileSync(cachePath, JSON.stringify({ messages, cached: Date.now() }, null, 2));

      return { folder, filter, count: messages.length, messages };
    } catch (err) {
      this.log(`IMAP failed: ${err.message} — checking cache`, 'warn');
      return this._readCachedInbox();
    }
  }

  // ─── SUMMARIZE INBOX ─────────────────────────────────────────────────────

  async summarizeInbox() {
    const { messages } = await this.readInbox({ limit: 20 });
    if (!messages.length) return { summary: 'Inbox is empty', messages: [] };

    const emailList = messages.map(m => `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\nPreview: ${m.preview}`).join('\n\n---\n\n');

    const summary = await complete(
      `Summarize this inbox and identify:\n1. Urgent emails needing immediate response\n2. Important emails to action\n3. Newsletters/low priority to ignore\n4. Any patterns or trends\n\nEmails:\n${emailList}`,
      { temperature: 0.3, maxTokens: 1000 }
    );

    return { summary, count: messages.length, urgent: messages.filter(m => this._isUrgent(m)) };
  }

  // ─── REPLY TO EMAIL ───────────────────────────────────────────────────────

  async replyToEmail({ emailId, instruction, tone = 'professional' }) {
    const emails = this._readCachedInbox().messages || [];
    const email = emails.find(e => e.id === emailId);
    if (!email) return { error: `Email ${emailId} not found in cache` };

    const reply = await this.draftEmail({
      objective: instruction,
      to: email.from,
      context: `Replying to:\nSubject: ${email.subject}\nFrom: ${email.from}\nContent: ${email.body?.slice(0, 500)}`,
      tone,
    });

    return {
      ...reply,
      replyTo: email.from,
      subject: `Re: ${email.subject}`,
    };
  }

  // ─── CALENDAR ─────────────────────────────────────────────────────────────

  async scheduleEvent({ title, date, time, duration = 60, attendees = [], description = '', location = '' }) {
    // Generate ICS file
    const icsContent = this._generateICS({ title, date, time, duration, attendees, description, location });
    const icsPath = path.join(DATA_DIR, `event-${Date.now()}.ics`);
    writeFileSync(icsPath, icsContent);

    this.remember(`Scheduled: ${title} on ${date} at ${time}`, { tags: ['calendar', 'event'], importance: 7 });
    bus.emit('calendar:event_created', { title, date, time });

    // If attendees, send invite emails
    const invites = [];
    for (const attendee of attendees) {
      try {
        const invite = await this.sendEmail({
          to: attendee,
          subject: `Invitation: ${title}`,
          body: `You're invited to: ${title}\nDate: ${date} at ${time}\nDuration: ${duration} minutes\n${location ? `Location: ${location}` : ''}\n\n${description}`,
          attachments: [{ filename: 'invite.ics', path: icsPath, contentType: 'text/calendar' }],
        });
        invites.push({ attendee, sent: invite.sent });
      } catch (err) {
        invites.push({ attendee, error: err.message });
      }
    }

    return { scheduled: true, title, date, time, icsPath, invites };
  }

  async listEvents({ startDate = new Date().toISOString(), days = 7 } = {}) {
    // Read from local ICS files
    const icsFiles = existsSync(DATA_DIR)
      ? require('fs').readdirSync(DATA_DIR).filter(f => f.endsWith('.ics'))
      : [];

    const events = [];
    for (const file of icsFiles) {
      try {
        const content = readFileSync(path.join(DATA_DIR, file), 'utf8');
        const parsed = this._parseICS(content);
        if (parsed) events.push(parsed);
      } catch {}
    }

    return { events: events.sort((a, b) => new Date(a.date) - new Date(b.date)), count: events.length };
  }

  // ─── SMART EMAIL ACTION ───────────────────────────────────────────────────

  async smartEmailAction({ objective }) {
    const plan = await structured(
      `Plan the best email/calendar action for: "${objective}"`,
      {
        action: 'send|draft|read_inbox|summarize_inbox|reply|schedule|list_events',
        params: {},
        reasoning: 'why this action',
      },
      { temperature: 0.2 }
    );

    return this.run({ action: plan.action, ...plan.params });
  }

  // ─── SETUP ────────────────────────────────────────────────────────────────

  async setup({ email, password, name = '', imapHost = null, smtpHost = null, service = 'gmail' }) {
    const config = {
      email, password, name,
      service,
      imap: imapHost || this._getDefaultIMAP(service),
      smtp: smtpHost || this._getDefaultSMTP(service),
      configured: true,
    };

    writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
    this._config = config;

    return { configured: true, email, service };
  }

  status() {
    return {
      configured: !!this._config?.configured,
      email: this._config?.email || 'not set',
      service: this._config?.service || 'not set',
      hasCachedInbox: existsSync(path.join(DATA_DIR, 'inbox-cache.json')),
    };
  }

  // ─── INTERNAL ─────────────────────────────────────────────────────────────

  async _getTransporter() {
    const nodemailer = await import('nodemailer').catch(() => {
      throw new Error('nodemailer not installed — run: npm install nodemailer');
    });

    if (!this._config?.email) throw new Error('Email not configured. Run: apex email setup');

    return nodemailer.createTransport({
      service: this._config.service,
      host: this._config.smtp,
      port: 587,
      secure: false,
      auth: { user: this._config.email, pass: this._config.password },
    });
  }

  async _getIMAPClient() {
    const Imap = await import('imap').catch(() => {
      throw new Error('imap not installed — run: npm install imap');
    });

    if (!this._config?.email) throw new Error('Email not configured');

    return new Promise((resolve, reject) => {
      const imap = new Imap.default({
        user: this._config.email,
        password: this._config.password,
        host: this._config.imap,
        port: 993,
        tls: true,
      });
      imap.once('ready', () => resolve(imap));
      imap.once('error', reject);
      imap.connect();
    });
  }

  async _fetchMessages(imap, folder, filter, limit) {
    return new Promise((resolve, reject) => {
      imap.openBox(folder, true, (err) => {
        if (err) return reject(err);
        imap.search([filter], (err, results) => {
          if (err || !results.length) return resolve([]);
          const toFetch = results.slice(-limit);
          const messages = [];
          const fetch = imap.fetch(toFetch, { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'], struct: true });
          fetch.on('message', (msg) => {
            const message = {};
            msg.on('body', (stream, info) => {
              let body = '';
              stream.on('data', (chunk) => { body += chunk.toString('utf8'); });
              stream.on('end', () => {
                if (info.which.startsWith('HEADER')) {
                  const headers = body.split('\n');
                  headers.forEach(h => {
                    if (h.startsWith('From:')) message.from = h.replace('From:', '').trim();
                    if (h.startsWith('Subject:')) message.subject = h.replace('Subject:', '').trim();
                    if (h.startsWith('Date:')) message.date = h.replace('Date:', '').trim();
                  });
                } else {
                  message.body = body.slice(0, 500);
                  message.preview = body.slice(0, 150).replace(/\s+/g, ' ');
                }
              });
            });
            msg.on('attributes', (attrs) => { message.id = attrs.uid; });
            msg.once('end', () => messages.push(message));
          });
          fetch.once('end', () => resolve(messages));
          fetch.once('error', reject);
        });
      });
    });
  }

  _readCachedInbox() {
    const cachePath = path.join(DATA_DIR, 'inbox-cache.json');
    if (!existsSync(cachePath)) return { messages: [], cached: null };
    try { return JSON.parse(readFileSync(cachePath, 'utf8')); } catch { return { messages: [] }; }
  }

  _isUrgent(email) {
    const urgentWords = ['urgent', 'asap', 'immediately', 'action required', 'deadline', 'critical'];
    const text = `${email.subject} ${email.preview}`.toLowerCase();
    return urgentWords.some(w => text.includes(w));
  }

  _generateICS({ title, date, time, duration, attendees, description, location }) {
    const start = new Date(`${date}T${time}:00`);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace('.000', '');

    return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//APEX AI//EN
BEGIN:VEVENT
DTSTART:${fmt(start)}
DTEND:${fmt(end)}
SUMMARY:${title}
DESCRIPTION:${description}
LOCATION:${location}
${attendees.map(a => `ATTENDEE:mailto:${a}`).join('\n')}
END:VEVENT
END:VCALENDAR`;
  }

  _parseICS(content) {
    const summary = content.match(/SUMMARY:(.*)/)?.[1];
    const dtstart = content.match(/DTSTART:(.*)/)?.[1];
    if (!summary || !dtstart) return null;
    return { title: summary, date: dtstart, raw: content.slice(0, 200) };
  }

  _loadConfig() {
    const configPath = path.join(DATA_DIR, 'config.json');
    if (existsSync(configPath)) {
      try { return JSON.parse(readFileSync(configPath, 'utf8')); } catch {}
    }
    return {};
  }

  async _getUserProfile() {
    try {
      const profileAgent = (await import('../core/agent-registry.js')).default.get('UserProfileAgent');
      if (profileAgent) return await profileAgent._handleTask({ id: 'profile', action: 'profile' });
    } catch {}
    return {};
  }

  _getDefaultIMAP(service) {
    const hosts = { gmail: 'imap.gmail.com', outlook: 'outlook.office365.com', yahoo: 'imap.mail.yahoo.com' };
    return hosts[service] || `imap.${service}.com`;
  }

  _getDefaultSMTP(service) {
    const hosts = { gmail: 'smtp.gmail.com', outlook: 'smtp.office365.com', yahoo: 'smtp.mail.yahoo.com' };
    return hosts[service] || `smtp.${service}.com`;
  }
}

export default EmailCalendarAgent;
