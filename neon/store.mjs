/**
 * Postgres owns every authoritative value. An isolate can disappear at any time:
 * a fresh request loads state under the same database lock before changing it.
 * No player operation is acknowledged until COMMIT succeeds.
 */
const KINDS = ['sessions', 'rooms', 'histories', 'standings', 'limits'];
const MAX_STATE_BYTES = 10 * 1024 * 1024;
const MAX_ENTITY_BYTES = 1024 * 1024;
const MAX_ENTITY_ROWS = 6000;
const HEARTBEAT_MS = 10000;
const RECOVERY_GAP_MS = 60000;
const RECONNECT_GRACE_MS = 120000;
const MIN_RECOVERY_PHASE_MS = 30000;
const encoder = new TextEncoder();

// Also supplied as neon/schema.sql for database consoles and backup operators.
// Inline SQL is intentional: a deployed function bundle has no source filesystem.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS moonwolf_pg_meta (
    id smallint PRIMARY KEY CHECK (id = 1),
    schema_version smallint NOT NULL CHECK (schema_version = 1),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    last_seen_ms bigint NOT NULL DEFAULT 0 CHECK (last_seen_ms >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS moonwolf_pg_entities (
    kind text NOT NULL CHECK (kind IN ('sessions', 'rooms', 'histories', 'standings', 'limits')),
    entity_key text NOT NULL,
    data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    PRIMARY KEY (kind, entity_key)
  )`,
  `INSERT INTO moonwolf_pg_meta (id, schema_version, revision, last_seen_ms)
    VALUES (1, 1, 0, 0) ON CONFLICT (id) DO NOTHING`,
];

const unavailable = () => Object.assign(new Error('联机数据库暂时不可用，请稍后重试'), { status: 503 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

function validateEntity(kind, key, value) {
  if (!KINDS.includes(kind) || typeof key !== 'string' || !key || key.length > 256 || !object(value)) throw unavailable();
  if (kind === 'sessions') {
    if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !timestamp(value.lastSeen)
      || !(value.roomCode === null || /^\d{6}$/.test(value.roomCode))) throw unavailable();
  } else if (kind === 'rooms' || kind === 'histories') {
    if (!/^\d{6}$/.test(key) || value.code !== key || !Array.isArray(value.players) || !Array.isArray(value.messages)
      || !object(value.config) || !object(value.config.roles) || !timestamp(value.lastActive)) throw unavailable();
    if (value.players.some(player => !object(player) || typeof player.id !== 'string' || !player.id
      || typeof player.name !== 'string' || !Number.isInteger(player.seat) || player.seat < 1)) throw unavailable();
    if (value.game !== null && (!object(value.game) || !Array.isArray(value.game.players) || typeof value.game.phase !== 'string'
      || (value.game.phase !== 'finished' && !timestamp(value.game.deadline)))) throw unavailable();
  } else if (kind === 'standings') {
    if (typeof value.id !== 'string' || typeof value.name !== 'string' || !Number.isInteger(value.games)
      || !Number.isInteger(value.wins) || !Number.isFinite(value.winRate)) throw unavailable();
  } else if (!Number.isFinite(value.count) || !timestamp(value.until)) throw unavailable();
}

function emptyState() { return Object.fromEntries(KINDS.map(kind => [kind, new Map()])); }

function encodeState(state) {
  const encoded = new Map();
  let totalBytes = 0;
  for (const kind of KINDS) {
    if (!(state[kind] instanceof Map)) throw unavailable();
    const entities = new Map();
    encoded.set(kind, entities);
    for (const [key, value] of state[kind]) {
      validateEntity(kind, key, value);
      const data = JSON.stringify(value);
      const size = encoder.encode(data).length;
      totalBytes += size;
      if (size > MAX_ENTITY_BYTES || totalBytes > MAX_STATE_BYTES) {
        throw Object.assign(new Error('当前对局数据较多，请稍后重试'), { status: 503 });
      }
      entities.set(key, data);
    }
  }
  return encoded;
}

function readState(rows) {
  if (rows.length > MAX_ENTITY_ROWS) throw unavailable();
  const state = emptyState();
  for (const row of rows) {
    // pg parses JSONB into objects. Accept text too for other compatible clients.
    const value = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
    validateEntity(row.kind, row.entity_key, value);
    if (state[row.kind].has(row.entity_key)) throw unavailable();
    state[row.kind].set(row.entity_key, value);
  }
  return state;
}

function validateMeta(meta) {
  const lastSeen = Number(meta?.last_seen_ms);
  if (Number(meta?.schema_version) !== 1 || !timestamp(lastSeen)) throw unavailable();
  return lastSeen;
}

/**
 * With no requests for a minute, there is no reliable process-liveness signal in
 * a serverless runtime. Treat the whole gap as a paused game, whether caused by
 * eviction, a deployment, an outage or all browsers closing. Health checks do
 * not keep game clocks alive. The locked metadata makes recovery happen once.
 */
function recoverIdleState(state, lastSeen, now) {
  if (!lastSeen || now - lastSeen <= RECOVERY_GAP_MS) return false;
  const paused = now - lastSeen;
  for (const session of state.sessions.values()) {
    session.lastSeen += paused;
    session.recoveryUntil = now + RECONNECT_GRACE_MS;
  }
  for (const room of state.rooms.values()) {
    room.lastActive += paused;
    room.recoveryUntil = now + RECONNECT_GRACE_MS;
    if (room.game && room.game.phase !== 'finished') {
      room.game.deadline = now + Math.max(MIN_RECOVERY_PHASE_MS, room.game.deadline - lastSeen);
    }
  }
  return true;
}

export function createPostgresStore(pool, { clock = Date.now } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A Postgres connection pool is required');
  let initialization;

  function initialize() {
    if (!initialization) initialization = (async () => {
      const client = await pool.connect();
      let begun = false;
      try {
        await client.query('BEGIN'); begun = true;
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        // CREATE IF NOT EXISTS alone can race when two fresh isolates start.
        await client.query('SELECT pg_advisory_xact_lock(1465011265)');
        for (const statement of SCHEMA_STATEMENTS.slice(0, 2)) await client.query(statement);
        // Missing metadata alongside existing entities is corruption, not an
        // empty installation. Do not silently reset the recovery clock/version.
        const existing = await client.query('SELECT id FROM moonwolf_pg_meta WHERE id = 1');
        if (!existing.rows.length) {
          const entities = await client.query('SELECT 1 FROM moonwolf_pg_entities LIMIT 1');
          if (entities.rows.length) throw unavailable();
          await client.query(SCHEMA_STATEMENTS[2]);
        }
        const result = await client.query('SELECT schema_version, last_seen_ms FROM moonwolf_pg_meta WHERE id = 1');
        validateMeta(result.rows[0]);
        await client.query('COMMIT'); begun = false;
      } catch (error) {
        if (begun) { try { await client.query('ROLLBACK'); } catch {} }
        throw error;
      } finally { client.release(); }
    })().catch(error => { initialization = undefined; throw error; });
    return initialization;
  }

  return {
    storage: 'postgres',
    async health() {
      await initialize();
      const client = await pool.connect();
      try {
        const result = await client.query('SELECT schema_version, last_seen_ms FROM moonwolf_pg_meta WHERE id = 1');
        validateMeta(result.rows[0]);
        return true;
      } finally { client.release(); }
    },
    async withState(callback, { now = clock() } = {}) {
      if (typeof callback !== 'function' || !timestamp(now)) throw new TypeError('A synchronous callback and valid timestamp are required');
      await initialize();
      const client = await pool.connect();
      let begun = false;
      try {
        await client.query('BEGIN'); begun = true;
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '15s'");
        await client.query('SET LOCAL synchronous_commit = on');
        const metadata = await client.query('SELECT schema_version, revision, last_seen_ms FROM moonwolf_pg_meta WHERE id = 1 FOR UPDATE');
        const lastSeen = validateMeta(metadata.rows[0]);
        const rows = await client.query('SELECT kind, entity_key, data FROM moonwolf_pg_entities LIMIT 6001');
        const state = readState(rows.rows);
        const original = encodeState(state);
        const recovered = recoverIdleState(state, lastSeen, now);
        // Recovery and the activity clock are independent of whether a player
        // operation succeeds. In particular, a full server must not roll back
        // recovery on every rejected login and restart its reconnect grace on
        // the next request. Encoded strings form an immutable pre-operation
        // baseline, so a failing callback cannot persist any of its mutations.
        const baseline = recovered ? encodeState(state) : original;
        let output, next, callbackError;
        let callbackFailed = false;
        try {
          output = callback(state);
          if (output && typeof output.then === 'function') throw new TypeError('State callbacks must be synchronous');
          next = encodeState(state);
        } catch (error) {
          callbackFailed = true;
          callbackError = error;
          next = baseline;
        }
        let changed = false;
        for (const kind of KINDS) {
          for (const [key, data] of next.get(kind)) {
            if (original.get(kind).get(key) === data) continue;
            await client.query(`INSERT INTO moonwolf_pg_entities (kind, entity_key, data) VALUES ($1, $2, $3::jsonb)
              ON CONFLICT (kind, entity_key) DO UPDATE SET data = EXCLUDED.data`, [kind, key, data]);
            changed = true;
          }
          for (const key of original.get(kind).keys()) {
            if (next.get(kind).has(key)) continue;
            await client.query('DELETE FROM moonwolf_pg_entities WHERE kind = $1 AND entity_key = $2', [kind, key]);
            changed = true;
          }
        }
        if (changed || recovered || now - lastSeen >= HEARTBEAT_MS || !lastSeen) {
          await client.query('UPDATE moonwolf_pg_meta SET revision = revision + 1, last_seen_ms = $1 WHERE id = 1', [Math.max(now, lastSeen)]);
        }
        await client.query('COMMIT'); begun = false;
        if (callbackFailed) throw callbackError;
        return output;
      } catch (error) {
        if (begun) { try { await client.query('ROLLBACK'); } catch {} }
        throw error;
      } finally { client.release(); }
    },
  };
}
