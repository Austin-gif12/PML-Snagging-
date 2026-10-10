// Cloudflare Worker entry point for the PML Snagging API. See app.js for what it does.
import { handle } from './app.js';
import { pgStore } from './store-postgres.js';

export default {
  async fetch(req, env, ctx) {
    const store = env.DATABASE_URL ? pgStore(env.DATABASE_URL) : null;
    try {
      if (store) await store.init();
      return await handle(req, env, store);
    } finally {
      if (store) ctx.waitUntil(store.end());
    }
  }
};
