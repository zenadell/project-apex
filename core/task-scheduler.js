// core/task-scheduler.js
// APEX TaskScheduler — Schedule tasks to run automatically.
// Cron-based + event-triggered + goal-driven autonomous execution.

import { EventEmitter } from 'eventemitter3';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import bus from './event-bus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.apex-data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'tasks.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    task_input TEXT NOT NULL,
    schedule TEXT NOT NULL,        -- cron expression OR 'interval:ms' OR 'event:eventName'
    enabled INTEGER DEFAULT 1,
    last_run INTEGER,
    next_run INTEGER,
    run_count INTEGER DEFAULT 0,
    last_result TEXT,
    created_at INTEGER NOT NULL
  );
`);

export class TaskScheduler extends EventEmitter {
  constructor() {
    super();
    this._running = false;
    this._interval = null;
    this._orchestrator = null;
    this._eventListeners = {};
  }

  init(orchestrator) {
    this._orchestrator = orchestrator;
    this._loadAndSchedule();
    this._start();
    bus.emit('scheduler:ready');
    return this;
  }

  // ─── SCHEDULE A TASK ───────────────────────────────────────────────────────

  schedule({ name, description = '', task, schedule, enabled = true }) {
    const id = uuidv4();
    const nextRun = this._calculateNextRun(schedule);

    db.prepare(`
      INSERT INTO scheduled_tasks (id, name, description, task_input, schedule, enabled, next_run, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, description, JSON.stringify(task), schedule, enabled ? 1 : 0, nextRun, Date.now());

    if (schedule.startsWith('event:')) {
      this._setupEventTrigger(id, schedule.replace('event:', ''), task);
    }

    bus.emit('scheduler:scheduled', { id, name, schedule });
    return id;
  }

  // ─── CANCEL ────────────────────────────────────────────────────────────────

  cancel(id) {
    db.prepare(`UPDATE scheduled_tasks SET enabled=0 WHERE id=?`).run(id);
    bus.emit('scheduler:cancelled', { id });
  }

  delete(id) {
    db.prepare(`DELETE FROM scheduled_tasks WHERE id=?`).run(id);
  }

  // ─── LIST ──────────────────────────────────────────────────────────────────

  list() {
    return db.prepare(`SELECT * FROM scheduled_tasks ORDER BY next_run ASC`).all().map(t => ({
      ...t,
      task_input: JSON.parse(t.task_input),
      nextRunIn: t.next_run ? `${Math.round((t.next_run - Date.now()) / 60000)}min` : 'unknown',
    }));
  }

  // ─── RUN NOW ───────────────────────────────────────────────────────────────

  async runNow(id) {
    const task = db.prepare(`SELECT * FROM scheduled_tasks WHERE id=?`).get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    return this._executeTask(task);
  }

  // ─── BUILT-IN SCHEDULES ────────────────────────────────────────────────────

  scheduleBuiltins() {
    const existing = db.prepare(`SELECT name FROM scheduled_tasks`).all().map(t => t.name);

    const builtins = [
      {
        name: 'Daily Self-Audit',
        description: 'Run APEX self-audit every morning',
        task: { type: 'self_audit' },
        schedule: 'daily:09:00',
        agent: 'SelfModAgent',
      },
      {
        name: 'Gap Detection',
        description: 'Check for capability gaps every 6 hours',
        task: { type: 'detect_gaps' },
        schedule: 'interval:21600000',
        agent: 'SelfModAgent',
      },
      {
        name: 'Memory Cleanup',
        description: 'Clean old session memories weekly',
        task: { type: 'memory_cleanup' },
        schedule: 'weekly:monday:02:00',
      },
    ];

    for (const b of builtins) {
      if (!existing.includes(b.name)) {
        this.schedule(b);
      }
    }
  }

  // ─── QUICK SCHEDULE HELPERS ────────────────────────────────────────────────

  // Run a task in X minutes
  inMinutes(minutes, task, name = 'Delayed Task') {
    return this.schedule({ name, task, schedule: `interval:${minutes * 60 * 1000}`, enabled: true });
  }

  // Run every day at a time
  daily(timeStr, task, name = 'Daily Task') {
    return this.schedule({ name, task, schedule: `daily:${timeStr}` });
  }

  // Run when an event fires
  onEvent(eventName, task, name = null) {
    return this.schedule({ name: name || `On ${eventName}`, task, schedule: `event:${eventName}` });
  }

  // ─── INTERNAL ──────────────────────────────────────────────────────────────

  _start() {
    this._running = true;
    // Check every minute
    this._interval = setInterval(() => this._tick(), 60 * 1000);
  }

  stop() {
    this._running = false;
    clearInterval(this._interval);
  }

  async _tick() {
    const now = Date.now();
    const due = db.prepare(`
      SELECT * FROM scheduled_tasks WHERE enabled=1 AND next_run <= ? AND schedule NOT LIKE 'event:%'
    `).all(now);

    for (const task of due) {
      this._executeTask(task).catch(err => {
        bus.emit('scheduler:task_error', { id: task.id, error: err.message });
      });
    }
  }

  async _executeTask(task) {
    if (!this._orchestrator) return;
    const taskInput = JSON.parse(task.task_input);

    bus.emit('scheduler:executing', { id: task.id, name: task.name });

    let result;
    try {
      // If it's a raw prompt, use orchestrator
      if (taskInput.prompt || typeof taskInput === 'string') {
        result = await this._orchestrator.execute(taskInput.prompt || taskInput);
      } else {
        // Else dispatch to specific agent
        const registry = (await import('./agent-registry.js')).default;
        const agentName = taskInput.agent || 'SelfModAgent';
        const agent = registry.get(agentName);
        if (agent) {
          result = await agent._handleTask({ id: uuidv4(), ...taskInput });
        }
      }

      const nextRun = this._calculateNextRun(task.schedule);
      db.prepare(`
        UPDATE scheduled_tasks SET last_run=?, next_run=?, run_count=run_count+1, last_result=? WHERE id=?
      `).run(Date.now(), nextRun, JSON.stringify(result).slice(0, 500), task.id);

      bus.emit('scheduler:task_done', { id: task.id, name: task.name });
      return result;
    } catch (err) {
      db.prepare(`UPDATE scheduled_tasks SET last_run=?, last_result=? WHERE id=?`).run(Date.now(), `ERROR: ${err.message}`, task.id);
      throw err;
    }
  }

  _setupEventTrigger(id, eventName, task) {
    const listener = () => {
      const dbTask = db.prepare(`SELECT * FROM scheduled_tasks WHERE id=? AND enabled=1`).get(id);
      if (dbTask) this._executeTask(dbTask).catch(() => {});
    };
    bus.on(eventName, listener);
    this._eventListeners[id] = { event: eventName, listener };
  }

  _loadAndSchedule() {
    // Re-wire event triggers from DB on startup
    const eventTasks = db.prepare(`SELECT * FROM scheduled_tasks WHERE enabled=1 AND schedule LIKE 'event:%'`).all();
    for (const task of eventTasks) {
      const eventName = task.schedule.replace('event:', '');
      this._setupEventTrigger(task.id, eventName, JSON.parse(task.task_input));
    }
  }

  _calculateNextRun(schedule) {
    const now = Date.now();

    if (schedule.startsWith('interval:')) {
      const ms = parseInt(schedule.split(':')[1]);
      return now + ms;
    }

    if (schedule.startsWith('daily:')) {
      const [, timeStr] = schedule.split(':');
      const [hours, minutes] = timeStr.split(':').map(Number);
      const next = new Date();
      next.setHours(hours, minutes, 0, 0);
      if (next.getTime() <= now) next.setDate(next.getDate() + 1);
      return next.getTime();
    }

    if (schedule.startsWith('weekly:')) {
      const parts = schedule.split(':');
      const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      const targetDay = dayNames.indexOf(parts[1].toLowerCase());
      const next = new Date();
      const daysUntil = (targetDay - next.getDay() + 7) % 7 || 7;
      next.setDate(next.getDate() + daysUntil);
      next.setHours(parseInt(parts[2]), parseInt(parts[3] || 0), 0, 0);
      return next.getTime();
    }

    if (schedule.startsWith('event:')) {
      return null; // Event-triggered, no next_run
    }

    // Default: 24 hours
    return now + 24 * 60 * 60 * 1000;
  }
}

export const taskScheduler = new TaskScheduler();
export default taskScheduler;
