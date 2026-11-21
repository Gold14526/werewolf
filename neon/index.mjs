import { Pool } from 'pg';
import { attachDatabasePool } from '@neon/functions';
import { handleApi } from '../worker/api.js';
import { createPostgresStore } from './store.mjs';

// Neon injects the branch's pooled DATABASE_URL. Keep the pool between requests;
// authoritative game state is loaded and committed by a database transaction.
let store;
function stateStore() {
  if (store) return store;
  if (!process.env.DATABASE_URL) return undefined;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 10000,
    application_name: 'moonwolf',
  });
  attachDatabasePool(pool);
  store = createPostgresStore(pool);
  return store;
}

const handler = {
  async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: '接口不存在' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    // Initialization failures are deliberately not returned with driver details.
    let activeStore;
    try { activeStore = stateStore(); } catch {}
    return handleApi(request, {
      STATE_STORE: activeStore,
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? 'https://gold14526.github.io',
    });
  },
};

export default handler;
