import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

/** One durable, versioned game-state snapshot. Only one server may own it. */
export function openPersistence(databasePath) {
  if (databasePath !== ':memory:') mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(databasePath);
  try {
    if (databasePath !== ':memory:') chmodSync(databasePath, 0o600);
    db.exec('PRAGMA busy_timeout = 5000;');
    const journal = db.prepare('PRAGMA journal_mode = WAL').get();
    if (databasePath !== ':memory:' && journal.journal_mode !== 'wal') {
      throw new Error('Durable game storage requires SQLite WAL support');
    }
    db.exec(`
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        saved_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    const row = db.prepare('SELECT revision, saved_at, payload FROM app_state WHERE id = 1').get();
    let revision = row?.revision ?? 0;
    const loaded = row ? { savedAt: row.saved_at, snapshot: JSON.parse(row.payload) } : null;
    const update = db.prepare('UPDATE app_state SET revision = revision + 1, saved_at = ?, payload = ? WHERE id = 1 AND revision = ?');
    const insert = db.prepare('INSERT INTO app_state (id, revision, saved_at, payload) VALUES (1, 1, ?, ?)');
    let closed = false;
    return {
      loaded,
      save(snapshot, now) {
        if (closed) throw new Error('Persistence is closed');
        const payload = JSON.stringify(snapshot);
        db.exec('BEGIN IMMEDIATE');
        try {
          if (revision === 0) insert.run(now, payload);
          else if (update.run(now, payload, revision).changes !== 1) {
            throw new Error('Database revision changed: another server has taken ownership');
          }
          db.exec('COMMIT');
          revision++;
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
      },
      assertCurrent() {
        if (closed || db.prepare('SELECT revision FROM app_state WHERE id = 1').get()?.revision !== revision) {
          throw new Error('Database revision changed: another server has taken ownership');
        }
      },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
