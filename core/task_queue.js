import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

class TaskQueue {
  constructor() {
    this.dbPath = path.join(process.cwd(), 'task_queue.db');
    this.db = new Database(this.dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        input TEXT,
        state_json TEXT,
        status TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  saveTaskState(taskId, input, state) {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, input, state_json, status, last_updated)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        state_json=excluded.state_json,
        status=excluded.status,
        last_updated=CURRENT_TIMESTAMP
    `);
    stmt.run(taskId, input, JSON.stringify(state), state.status || 'PLANNING');
  }

  getUnfinishedTasks() {
    // Only return tasks from the last hour — old stuck tasks are expired automatically
    const stmt = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE status NOT IN ('FINALIZING', 'COMPLETED', 'FAILED')
        AND last_updated > datetime('now', '-1 hour')
      ORDER BY last_updated DESC
      LIMIT 1
    `);
    const rows = stmt.all();
    return rows.map(r => ({
      id: r.id,
      input: r.input,
      state: JSON.parse(r.state_json),
      status: r.status
    }));
  }

  markTaskCompleted(taskId) {
    const stmt = this.db.prepare("UPDATE tasks SET status = 'COMPLETED', last_updated = CURRENT_TIMESTAMP WHERE id = ?");
    stmt.run(taskId);
  }

  markTaskFailed(taskId) {
    const stmt = this.db.prepare("UPDATE tasks SET status = 'FAILED', last_updated = CURRENT_TIMESTAMP WHERE id = ?");
    stmt.run(taskId);
  }
}

export default new TaskQueue();
