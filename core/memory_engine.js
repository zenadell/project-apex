import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export class MemoryEngine {
  constructor() {
    this.dbPath = path.join(process.cwd(), 'memory.db');
    this.db = new Database(this.dbPath);
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lessons_learned (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT,
        error_message TEXT,
        lesson TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  saveLesson(filePath, errorMessage, lesson) {
    const stmt = this.db.prepare('INSERT INTO lessons_learned (file_path, error_message, lesson) VALUES (?, ?, ?)');
    stmt.run(filePath, errorMessage, lesson);
  }

  getLessons(filePath) {
    const stmt = this.db.prepare('SELECT lesson FROM lessons_learned WHERE file_path = ? ORDER BY timestamp DESC LIMIT 5');
    const rows = stmt.all(filePath);
    return rows.map(r => r.lesson);
  }

  getAllLessons() {
    const stmt = this.db.prepare('SELECT lesson FROM lessons_learned ORDER BY timestamp DESC LIMIT 10');
    const rows = stmt.all();
    return rows.map(r => r.lesson);
  }
}

export default new MemoryEngine();
