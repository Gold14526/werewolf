/** Persistent optimistic transactions over D1. A batch commits all changed rows or none. */
const KINDS = ['sessions', 'rooms', 'histories', 'standings', 'limits'];
const KEY_SEPARATOR = '\u0000';
const encoder = new TextEncoder();

function emptyState() { return Object.fromEntries(KINDS.map(kind => [kind, new Map()])); }

export async function loadState(db) {
  await db.prepare("INSERT OR IGNORE INTO moonwolf_meta (id, revision, nonce) VALUES (1, 0, '')").run();
  // This one SELECT is a consistent snapshot, including the revision used by the later CAS.
  const result = await db.prepare('SELECT m.revision, e.kind, e.entity_key, e.data FROM moonwolf_meta m LEFT JOIN moonwolf_entities e ON 1 = 1 WHERE m.id = 1').all();
  const state = emptyState();
  const original = new Map();
  let revision = 0;
  for (const row of result.results ?? []) {
    revision = row.revision;
    if (!KINDS.includes(row.kind)) continue;
    state[row.kind].set(row.entity_key, JSON.parse(row.data));
    original.set(row.kind + KEY_SEPARATOR + row.entity_key, row.data);
  }
  return { state, original, revision };
}

function changesFor(state, original) {
  const next = new Map();
  let totalBytes = 0;
  for (const kind of KINDS) {
    for (const [key, value] of state[kind]) {
      const data = JSON.stringify(value);
      totalBytes += encoder.encode(data).length;
      if (encoder.encode(data).length > 1024 * 1024) throw Object.assign(new Error('房间记录过大，请稍后重试'), { status: 503 });
      next.set(kind + KEY_SEPARATOR + key, data);
    }
  }
  if (totalBytes > 10 * 1024 * 1024) throw Object.assign(new Error('当前在线房间较多，请稍后重试'), { status: 503 });
  const writes = [];
  for (const [key, data] of next) if (original.get(key) !== data) writes.push({ key, data });
  for (const key of original.keys()) if (!next.has(key)) writes.push({ key, data: null });
  return writes;
}

/** callback is synchronous and may be retried; never perform external effects inside it. */
export async function withState(db, callback) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const { state, original, revision } = await loadState(db);
    let output;
    try { output = callback(state); }
    catch (error) { output = { __stateError: error }; }
    const writes = changesFor(state, original);
    if (!writes.length) {
      if (output?.__stateError) throw output.__stateError;
      return output;
    }
    const nonce = crypto.randomUUID();
    const statements = [db.prepare('UPDATE moonwolf_meta SET revision = revision + 1, nonce = ? WHERE id = 1 AND revision = ?').bind(nonce, revision)];
    for (const { key, data } of writes) {
      const [kind, entityKey] = key.split(KEY_SEPARATOR);
      if (data === null) statements.push(db.prepare('DELETE FROM moonwolf_entities WHERE kind = ? AND entity_key = ? AND EXISTS (SELECT 1 FROM moonwolf_meta WHERE id = 1 AND nonce = ?)').bind(kind, entityKey, nonce));
      else statements.push(db.prepare('INSERT INTO moonwolf_entities (kind, entity_key, data) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM moonwolf_meta WHERE id = 1 AND nonce = ?) ON CONFLICT (kind, entity_key) DO UPDATE SET data = excluded.data').bind(kind, entityKey, data, nonce));
    }
    // D1 batches run as transactions. The nonce prevents a lost CAS from writing anything.
    const result = await db.batch(statements);
    if (Number(result[0]?.meta?.changes) === 1) {
      if (output?.__stateError) throw output.__stateError;
      return output;
    }
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * Math.min(30, 2 + attempt * 3))));
  }
  throw Object.assign(new Error('同时操作的玩家较多，请重试'), { status: 409 });
}
