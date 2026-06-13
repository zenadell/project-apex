// core/admin-gate.js
// APEX Admin Security Gate — Hard password wall for restricted capabilities.
// Illegal/dangerous features require the admin code to unlock.
// Audit logs every restricted action regardless.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import bus from './event-bus.js';
import chalk from 'chalk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.apex-data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'audit.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    category TEXT NOT NULL,
    authorized INTEGER NOT NULL,
    admin_used INTEGER DEFAULT 0,
    agent TEXT,
    target TEXT,
    outcome TEXT,
    ip TEXT
  );

  CREATE TABLE IF NOT EXISTS admin_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ─── RESTRICTION CATEGORIES ───────────────────────────────────────────────────
const RESTRICTED = {
  // Requires admin password
  admin_required: [
    'kali_external_scan',      // Scanning external targets
    'kali_exploitation',       // Any exploitation tools
    'kali_brute_force',        // Password cracking
    'social_bulk_send',        // Bulk social messaging
    'osint_person',            // Personal OSINT (not business)
    'device_control_full',     // Full device control on remote machines
    'code_execute_host',       // Execute arbitrary code on host
    'file_delete_bulk',        // Bulk file deletion
    'deploy_production',       // Production deployments
    'stripe_charge',           // Any Stripe charges
  ],

  // Always blocked — no password unlocks these
  always_blocked: [
    'ddos_attack',
    'ransomware',
    'child_exploitation',
    'mass_surveillance',
    'credential_theft_others',
    'account_takeover_others',
  ],

  // Pauses for confirmation (not password, just y/n)
  confirm_required: [
    'payment_send',
    'file_delete',
    'deploy_any',
    'email_bulk_send',
    'social_message_send',
    'git_push_main',
  ],
};

// ─── ADMIN GATE CLASS ─────────────────────────────────────────────────────────
class AdminGate {
  constructor() {
    this._sessionUnlocked = false;
    this._sessionExpiry = null;
    this._sessionDuration = 30 * 60 * 1000; // 30 min session
    this._failedAttempts = 0;
    this._lockoutUntil = null;

    // Admin codes stored as SHA-256 hashes (case-insensitive: tim/Tim/TIM all work)
    this._setupDefaultCode();
  }

  _setupDefaultCode() {
    const existing = db.prepare(`SELECT value FROM admin_config WHERE key='admin_hash'`).get();
    if (!existing) {
      // Default code: "tim" (Temple's code)
      const hash = this._hash('tim');
      db.prepare(`INSERT INTO admin_config (key, value) VALUES ('admin_hash', ?)`).run(hash);
    }
  }

  _hash(code) {
    return createHash('sha256').update(code.toLowerCase().trim()).digest('hex');
  }

  // Check if a code is correct
  verifyCode(code) {
    if (this._lockoutUntil && Date.now() < this._lockoutUntil) {
      const waitSec = Math.ceil((this._lockoutUntil - Date.now()) / 1000);
      throw new Error(`Too many failed attempts. Wait ${waitSec}s.`);
    }

    const stored = db.prepare(`SELECT value FROM admin_config WHERE key='admin_hash'`).get();
    const isValid = stored && this._hash(code) === stored.value;

    if (!isValid) {
      this._failedAttempts++;
      if (this._failedAttempts >= 5) {
        this._lockoutUntil = Date.now() + 5 * 60 * 1000; // 5 min lockout
        this._failedAttempts = 0;
        bus.emit('admin:lockout', { until: this._lockoutUntil });
      }
      return false;
    }

    this._failedAttempts = 0;
    return true;
  }

  // Unlock admin session
  unlock(code) {
    if (!this.verifyCode(code)) return false;
    this._sessionUnlocked = true;
    this._sessionExpiry = Date.now() + this._sessionDuration;
    bus.emit('admin:unlocked', { expiresIn: this._sessionDuration / 60000 + 'min' });
    console.log(chalk.green('\n🔓 Admin session unlocked (30 minutes)\n'));
    return true;
  }

  // Check if session is currently unlocked
  isUnlocked() {
    if (!this._sessionUnlocked) return false;
    if (Date.now() > this._sessionExpiry) {
      this._sessionUnlocked = false;
      bus.emit('admin:session_expired');
      return false;
    }
    return true;
  }

  // Lock immediately
  lock() {
    this._sessionUnlocked = false;
    this._sessionExpiry = null;
    bus.emit('admin:locked');
    console.log(chalk.yellow('🔒 Admin session locked'));
  }

  // Change admin code
  changeCode(currentCode, newCode) {
    if (!this.verifyCode(currentCode)) throw new Error('Current code incorrect');
    if (newCode.length < 3) throw new Error('Code too short — minimum 3 characters');
    const hash = this._hash(newCode);
    db.prepare(`UPDATE admin_config SET value=? WHERE key='admin_hash'`).run(hash);
    console.log(chalk.green('✅ Admin code updated'));
    return true;
  }

  // Gate check — call before any restricted action
  async gate(action, { agent = 'unknown', target = '', skipPrompt = false } = {}) {
    // Always blocked — no exceptions
    if (RESTRICTED.always_blocked.includes(action)) {
      this._audit(action, 'always_blocked', false, false, agent, target, 'BLOCKED');
      throw new Error(`Action "${action}" is permanently blocked in APEX.`);
    }

    // Check if admin required
    const needsAdmin = RESTRICTED.admin_required.includes(action);
    const needsConfirm = RESTRICTED.confirm_required.includes(action);

    if (needsAdmin) {
      if (!this.isUnlocked()) {
        this._audit(action, 'admin_required', false, false, agent, target, 'DENIED');
        bus.emit('admin:access_denied', { action, agent });

        // Prompt for code if not in skip mode
        if (!skipPrompt) {
          const code = await this._promptForCode(action);
          if (!code || !this.verifyCode(code)) {
            throw new Error(`Admin authentication required for: ${action}`);
          }
          this._sessionUnlocked = true;
          this._sessionExpiry = Date.now() + this._sessionDuration;
        } else {
          throw new Error(`Admin authentication required for: ${action}. Unlock with /unlock <code>`);
        }
      }
      this._audit(action, 'admin_required', true, true, agent, target, 'ALLOWED');
    }

    if (needsConfirm && !skipPrompt) {
      const confirmed = await this._promptConfirm(action, target);
      if (!confirmed) {
        this._audit(action, 'confirm_required', false, false, agent, target, 'USER_DECLINED');
        throw new Error(`Action cancelled by user: ${action}`);
      }
      this._audit(action, 'confirm_required', true, false, agent, target, 'CONFIRMED');
    }

    return true; // Authorized
  }

  // Quick check without prompting — returns boolean
  canDo(action) {
    if (RESTRICTED.always_blocked.includes(action)) return false;
    if (RESTRICTED.admin_required.includes(action)) return this.isUnlocked();
    return true;
  }

  // Get audit log
  getAuditLog(limit = 50) {
    return db.prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  // Get status
  status() {
    return {
      sessionUnlocked: this.isUnlocked(),
      sessionExpiresIn: this._sessionExpiry ? Math.round((this._sessionExpiry - Date.now()) / 1000) + 's' : null,
      failedAttempts: this._failedAttempts,
      lockedOut: this._lockoutUntil ? Date.now() < this._lockoutUntil : false,
      restrictedActions: RESTRICTED.admin_required.length,
      blockedActions: RESTRICTED.always_blocked.length,
    };
  }

  _audit(action, category, authorized, adminUsed, agent, target, outcome) {
    db.prepare(`
      INSERT INTO audit_log (ts, action, category, authorized, admin_used, agent, target, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Date.now(), action, category, authorized ? 1 : 0, adminUsed ? 1 : 0, agent, target, outcome);
  }

  async _promptForCode(action) {
    const { default: inquirer } = await import('inquirer');
    console.log(chalk.yellow(`\n🔐 Admin authentication required for: ${chalk.white(action)}`));
    const { code } = await inquirer.prompt([{
      type: 'password',
      name: 'code',
      message: 'Enter admin code:',
      mask: '*',
    }]);
    return code;
  }

  async _promptConfirm(action, target) {
    const { default: inquirer } = await import('inquirer');
    console.log(chalk.yellow(`\n⚠️  Confirmation required`));
    const { confirmed } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmed',
      message: `Proceed with: ${action}${target ? ` on "${target}"` : ''}?`,
      default: false,
    }]);
    return confirmed;
  }
}

export const adminGate = new AdminGate();
export { RESTRICTED };
export default adminGate;
