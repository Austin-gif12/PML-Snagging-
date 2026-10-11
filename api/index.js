// Vercel function for the PML Snagging API. Every /api/… address comes here (see vercel.json)
// and is handled by lib/app.js. Settings come from Vercel → Project → Settings → Environment Variables:
//   WORKOS_CLIENT_ID, WORKOS_API_KEY, DATABASE_URL   (required)
//   OWNER_EMAILS                                     (optional, default below)
import { handle } from '../lib/app.js';
import { pgStore } from '../lib/store-postgres.js';

const env = {
  ...process.env,
  OWNER_EMAILS: process.env.OWNER_EMAILS || 'austin@planningmanager.co.uk'
};
let store = null; // kept between requests while Vercel keeps this function warm

async function serve(request) {
  if (!store && env.DATABASE_URL) store = pgStore(env.DATABASE_URL);
  const url = new URL(request.url);
  // vercel.json turns /api/sync into /api?route=sync
  const route = url.searchParams.get('route') ?? url.pathname.replace(/^\/api\/?/, '');
  url.searchParams.delete('route');
  url.pathname = '/' + route;
  return handle({
    method: request.method,
    url: url.href,
    headers: request.headers,
    json: () => request.json()
  }, env, store);
}

export const GET = serve;
export const POST = serve;
export const OPTIONS = serve;
