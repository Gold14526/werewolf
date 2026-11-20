import { DatabaseSync } from 'node:sqlite';

/** D1-compatible adapter for deterministic integration tests, using real SQLite SQL. */
export class TestD1Database {
  constructor(filename = ':memory:') {
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS moonwolf_meta (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        revision INTEGER NOT NULL DEFAULT 0,
        nonce TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS moonwolf_entities (
        kind TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY(kind, entity_key)
      );
    `);
  }

  prepare(sql) { return new TestD1Statement(this, sql); }

  async batch(statements) {
    // Cloudflare D1 executes a batch as one transaction. Keep it synchronous
    // until COMMIT so concurrent test requests cannot interleave statements.
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql) { this.sqlite.exec(sql); return { count: 1, duration: 0 }; }
  close() { this.sqlite.close(); }
}

class TestD1Statement {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new TestD1Statement(this.db, this.sql, args); }
  execute() {
    const statement = this.db.sqlite.prepare(this.sql);
    const columns = statement.columns();
    if (columns.length) {
      const results = statement.all(...this.args).map(row => ({ ...row }));
      return { success: true, results, meta: { changes: 0, rows_read: results.length, rows_written: 0 } };
    }
    const info = statement.run(...this.args);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid), rows_read: 0, rows_written: Number(info.changes) } };
  }
  async all() { return this.execute(); }
  async run() { return this.execute(); }
  async first(column) {
    const row = this.db.sqlite.prepare(this.sql).get(...this.args);
    if (!row) return null;
    return column === undefined ? { ...row } : row[column];
  }
  async raw() {
    const statement = this.db.sqlite.prepare(this.sql);
    statement.setReturnArrays(true);
    return statement.all(...this.args);
  }
}
