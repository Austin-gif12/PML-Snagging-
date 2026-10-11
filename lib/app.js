// PML Snagging API: sign-in, permissions and sync. Uses only standard web APIs, so it runs on Vercel
// (api/index.js) and, for testing, in a browser. The database is passed in as `store`
// (store-postgres.js in production).
//
// Data is addressed by paths, the same shape the app has always used:
//   users/{email}                        settings/{id}
//   jobs/{jobId}                         jobs/{jobId}/drawings/{drawingId}
//   jobs/{jobId}/drawings/{drawingId}/chunks/{n}
//   jobs/{jobId}/snags/{snagId}          jobs/{jobId}/snags/{snagId}/photos/{photoId}
//
// Who can see and change what (this used to be firestore.rules):
//   Admin       everything, including users and deleting jobs. OWNER_EMAILS are always admin.
//   Site manager every job, snag, drawing and the settings; can add contractor users only.
//   Contractor  only jobs/snags where their email is listed; can move a snag between open,
//               in progress and awaiting sign-off, add a note, and add/remove their own fix photos.

import { runReminders, remind } from './reminders.js';

const WORKOS = 'https://api.workos.com';
const SESSION_DAYS = 30;

export async function handle(req, env, store) {
  // The app and the API share one website, so normally there's no cross-site access to allow.
  // ALLOWED_ORIGINS (optional) lets other websites use the API too.
  const origin = req.headers.get('Origin') || '';
  const okOrigin = !origin || origin === new URL(req.url).origin || list(env.ALLOWED_ORIGINS).includes(origin);
  const cors = okOrigin && origin ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  } : { 'Vary': 'Origin' };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  const path = new URL(req.url).pathname;

  // Open /api in a browser to check the setup.
  if (req.method === 'GET' && path === '/') {
    const missing = ['WORKOS_CLIENT_ID', 'WORKOS_API_KEY', 'DATABASE_URL'].filter(k => !env[k]);
    let database = 'not checked';
    if (store) { try { await store.ping(); database = 'ok'; } catch (e) { database = 'error: ' + e.message; } }
    const email = env.RESEND_API_KEY && env.REMINDER_FROM ? (env.CRON_SECRET ? 'ok' : 'CRON_SECRET not set, so scheduled reminders won\'t run') : 'not set up (RESEND_API_KEY, REMINDER_FROM)';
    return reply(200, { ok: !missing.length && database === 'ok', missing, database, email });
  }
  // The app reads the WorkOS Client ID from here, so it only needs setting in Vercel.
  if (req.method === 'GET' && path === '/config') return reply(200, { workosClientId: env.WORKOS_CLIENT_ID || '' });
  if (req.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
  if (!okOrigin) return reply(403, { error: 'This website is not allowed to use the PML Snagging API.', code: 'bad-origin' });

  try {
    if (!store) throw fail(500, 'no-database', 'DATABASE_URL is not set.');
    await store.init();
    if (req.method === 'POST' && path === '/session') return reply(200, await session(req, env));
    if (req.method === 'GET' && path === '/cron/reminders') return reply(200, await cron(req, env, store));
    const me = await whoAmI(req, env, store);
    if (req.method === 'POST' && path === '/sync') return reply(200, await sync(req, me, store));
    if (req.method === 'POST' && path === '/write') return reply(200, await write(req, me, store));
    if (req.method === 'GET' && path === '/list') return reply(200, await listDocs(req, me, store));
    if (req.method === 'POST' && path === '/invite') return reply(200, await invite(req, env, me, store));
    if (req.method === 'POST' && path === '/reminders/send') return reply(200, await sendReminderNow(req, env, me, store));
    return reply(404, { error: 'Not found' });
  } catch (e) {
    if (!e.status) console.error(e);
    return reply(e.status || 500, { error: e.status ? e.message : 'Server error: ' + e.message, code: e.code || 'error', index: e.index });
  }
}

/* ═════════════ sign-in ═════════════ */

// POST /session {accessToken: WorkOS AuthKit token} → {token, email, name}
async function session(req, env) {
  const { accessToken } = await req.json().catch(() => ({}));
  const claims = await verifyWorkosToken(accessToken, env);
  // Looking the person up with our own API key also proves the token belongs to our WorkOS account.
  const u = await workos(env, 'GET', `/user_management/users/${encodeURIComponent(claims.sub)}`);
  if (!u.email_verified) throw fail(403, 'not-verified', 'Your email address hasn\'t been confirmed yet. Sign in again and enter the code WorkOS emails you.');
  const email = low(u.email);
  if (!email) throw fail(403, 'no-email', 'Your login has no email address.');
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
  const exp = Date.now() + SESSION_DAYS * 864e5;
  return { token: await signSession(env, { email, workosId: u.id, exp }), email, name, exp };
}

// Session tokens are signed by this API (HMAC), so every request is checked without calling WorkOS.
export async function signSession(env, payload) {
  const body = b64urlText(JSON.stringify(payload));
  return body + '.' + bytesToB64url(await hmac(env, body));
}
async function readSession(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const expected = bytesToB64url(await hmac(env, body));
  if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) return null;
  try { const p = JSON.parse(new TextDecoder().decode(b64ToBytes(body))); return p.exp > Date.now() ? p : null; } catch { return null; }
}
async function hmac(env, text) {
  if (!env.WORKOS_API_KEY) throw new Error('WORKOS_API_KEY is not set');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode('pml-snagging-session:' + env.WORKOS_API_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
function timingSafeEqual(a, b) { let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }

async function whoAmI(req, env, store) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const s = await readSession(env, token);
  if (!s) throw fail(401, 'signed-out', 'Your sign-in has expired. Please sign in again.');
  const email = s.email;
  const profile = await store.get('users/' + email);
  const owner = list(env.OWNER_EMAILS).map(low).includes(email);
  const active = !!profile && profile.active === true;
  const role = owner ? 'admin' : (active ? profile.role : null);
  return {
    email, owner, role,
    admin: role === 'admin',
    staff: role === 'admin' || role === 'manager',
    contractor: role === 'contractor'
  };
}

/* ═════════════ reading ═════════════ */

// POST /sync {since, knownJobs} → everything this person can see that changed since `since`.
// Photos and drawing image chunks aren't included (they're big); the app fetches them with /list.
async function sync(req, me, store) {
  const { since = 0, knownJobs = [] } = await req.json().catch(() => ({}));
  const r = await store.changes({ since: Number(since) || 0, email: me.email, role: me.role, knownJobs: Array.isArray(knownJobs) ? knownJobs : [] });
  return { ...r, me: { email: me.email, role: me.role } };
}

// GET /list?path=jobs/x/snags/y/photos  or  jobs/x/drawings/y/chunks
async function listDocs(req, me, store) {
  const col = new URL(req.url).searchParams.get('path') || '';
  const p = parse(col + '/_');
  if (!p || !['photo', 'chunk'].includes(p.kind)) throw fail(400, 'bad-path', 'Only photos and drawing pieces can be listed.');
  if (!me.staff) {
    if (!me.contractor) throw denied();
    const parent = p.kind === 'photo' ? await store.get(`jobs/${p.job}/snags/${p.snag}`) : await store.get(`jobs/${p.job}`);
    if (!parent || !(parent.contractorEmails || []).includes(me.email)) throw denied();
  }
  return { docs: await store.list(col) };
}

/* ═════════════ writing ═════════════ */

// POST /write {ops:[{type:'set'|'update'|'delete', path, data, merge}]} — all or nothing.
async function write(req, me, store) {
  const { ops } = await req.json().catch(() => ({}));
  if (!Array.isArray(ops) || !ops.length) throw fail(400, 'bad-request', 'Nothing to save.');
  if (ops.length > 600) throw fail(400, 'bad-request', 'Too many changes in one go.');
  await store.transaction(async tx => {
    for (const [index, op] of ops.entries()) {
      try { await applyOp(tx, me, op); }
      catch (e) { e.index = index; throw e; }
    }
  });
  return { ok: true };
}

const CONTRACTOR_SNAG_KEYS = ['status', 'contractorNote', 'history', 'updatedAt', 'updatedBy'];

async function applyOp(tx, me, op) {
  const p = parse(op?.path);
  if (!p) throw fail(400, 'bad-path', 'Unknown place to save: ' + op?.path);
  if (!['set', 'update', 'delete'].includes(op.type)) throw fail(400, 'bad-request', 'Unknown change type.');
  if (op.type !== 'delete' && (typeof op.data !== 'object' || op.data === null || Array.isArray(op.data))) throw fail(400, 'bad-request', 'Missing data.');
  const before = await tx.get(op.path);
  if (op.type === 'update' && !before) throw fail(404, 'not-found', 'That item no longer exists.');
  if (op.type === 'delete' && !before) return; // already gone
  const after = op.type === 'delete' ? null
    : op.type === 'update' || op.merge ? { ...(before || {}), ...op.data }
    : op.data;
  const creating = !before;

  if (!me.role) throw denied();
  switch (p.kind) {
    case 'user':
      if (after && (low(after.email) !== p.email)) throw fail(400, 'bad-request', 'A user\'s email must match their record.');
      if (creating ? !(me.admin || (me.staff && after.role === 'contractor')) : !me.admin) throw denied();
      break;
    case 'settings':
      if (!me.staff) throw denied();
      break;
    case 'job':
      if (op.type === 'delete' ? !me.admin : !me.staff) throw denied();
      break;
    case 'drawing':
    case 'chunk':
      if (!me.staff) throw denied();
      break;
    case 'snag':
      if (me.staff) break;
      if (!me.contractor || creating || op.type === 'delete') throw denied();
      if (!(before.contractorEmails || []).includes(me.email)) throw denied();
      if (before.status === 'closed' || !['open', 'progress', 'ready'].includes(after.status)) throw denied();
      if (changedKeys(before, after).some(k => !CONTRACTOR_SNAG_KEYS.includes(k))) throw denied();
      break;
    case 'photo': {
      if (me.staff) break;
      if (!me.contractor) throw denied();
      if (op.type === 'delete') { if (before.byEmail !== me.email) throw denied(); break; }
      if (!creating) throw denied();
      const snag = await tx.get(`jobs/${p.job}/snags/${p.snag}`);
      if (!snag || !(snag.contractorEmails || []).includes(me.email) || after.kind !== 'fix' || after.byEmail !== me.email) throw denied();
      break;
    }
  }
  if (after) await tx.put(op.path, after); else await tx.remove(op.path);
}

function changedKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/* ═════════════ invitations ═════════════ */

// POST /invite {email} → {status: 'sent'|'resent'|'has-login'}. The person must already be in the Users list.
async function invite(req, env, me, store) {
  if (!me.staff) throw fail(403, 'not-allowed', 'Only PML staff can send invitations.');
  const { email: raw } = await req.json().catch(() => ({}));
  const email = low(raw);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'bad-email', 'That email address doesn\'t look right.');
  const them = await store.get('users/' + email);
  if (!them || !them.active) throw fail(400, 'no-access', 'Give this person access in the app first.');
  if (!me.admin && them.role !== 'contractor') throw fail(403, 'not-allowed', 'Site managers can only invite contractors.');

  const existing = await workos(env, 'GET', `/user_management/users?email=${encodeURIComponent(email)}`);
  if (existing.data?.length) return { status: 'has-login' };
  const pending = await workos(env, 'GET', `/user_management/invitations?email=${encodeURIComponent(email)}`);
  const open = (pending.data || []).find(i => i.state === 'pending');
  if (open) { await workos(env, 'POST', `/user_management/invitations/${open.id}/resend`); return { status: 'resent' }; }
  await workos(env, 'POST', '/user_management/invitations', { email });
  return { status: 'sent' };
}

/* ═════════════ email reminders (lib/reminders.js) ═════════════ */

// GET /cron/reminders: Vercel's morning run. Vercel sends "Authorization: Bearer <CRON_SECRET>".
async function cron(req, env, store) {
  const got = req.headers.get('Authorization') || '', want = 'Bearer ' + (env.CRON_SECRET || '');
  if (!env.CRON_SECRET || got.length !== want.length || !timingSafeEqual(got, want)) throw fail(401, 'not-allowed', 'Not allowed.');
  return runReminders(env, store);
}

// POST /reminders/send {job, contractor}: staff send one contractor their reminder straight away.
async function sendReminderNow(req, env, me, store) {
  if (!me.staff) throw fail(403, 'not-allowed', 'Only PML staff can send reminders.');
  const { job: jobId, contractor } = await req.json().catch(() => ({}));
  const job = typeof jobId === 'string' && ID.test(jobId) ? await store.get('jobs/' + jobId) : null;
  const c = (job?.contractors || []).find(x => x.id === contractor);
  if (!c) throw fail(404, 'not-found', 'That contractor isn\'t saved on this job yet. Try again in a moment.');
  return remind(env, store, { id: jobId, ...job }, c);
}

/* ═════════════ WorkOS ═════════════ */

async function verifyWorkosToken(token, env) {
  if (typeof token !== 'string' || token.split('.').length !== 3) throw fail(401, 'signed-out', 'No WorkOS sign-in was found. Please sign in again.');
  const [h, p, s] = token.split('.');
  let header, payload;
  try { header = jsonPart(h); payload = jsonPart(p); } catch { throw fail(401, 'signed-out', 'Sign-in token is not readable.'); }
  if (header.alg !== 'RS256') throw fail(401, 'signed-out', 'Unexpected sign-in token.');
  const jwks = await (await fetch(`${WORKOS}/sso/jwks/${encodeURIComponent(env.WORKOS_CLIENT_ID)}`, { cf: { cacheTtl: 3600 } })).json();
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw fail(401, 'signed-out', 'Sign-in token was not issued for this app.');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(h + '.' + p)))
    throw fail(401, 'signed-out', 'Sign-in token could not be checked.');
  if (!payload.exp || payload.exp < Date.now() / 1000 - 60) throw fail(401, 'signed-out', 'Your sign-in has expired. Please sign in again.');
  if (!payload.sub) throw fail(401, 'signed-out', 'Sign-in token has no user.');
  return payload;
}

async function workos(env, method, path, body) {
  const r = await fetch(WORKOS + path, {
    method,
    headers: { Authorization: 'Bearer ' + env.WORKOS_API_KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404) throw fail(401, 'signed-out', 'That WorkOS login was not found. Please sign in again.');
  if (!r.ok) throw fail(502, 'workos', 'WorkOS: ' + (j.message || j.error_description || j.code || r.status));
  return j;
}

/* ═════════════ paths ═════════════ */

const ID = /^[A-Za-z0-9_\-.@+]{1,128}$/;
// Works out what a path points at, or null if it isn't one the app uses.
export function parse(path) {
  const s = String(path || '').split('/');
  if (!s.every(x => ID.test(x))) return null;
  if (s.length === 2 && s[0] === 'users') return { kind: 'user', email: s[1] };
  if (s.length === 2 && s[0] === 'settings') return { kind: 'settings', id: s[1] };
  if (s[0] !== 'jobs') return null;
  if (s.length === 2) return { kind: 'job', job: s[1] };
  if (s.length === 4 && s[2] === 'drawings') return { kind: 'drawing', job: s[1], drawing: s[3] };
  if (s.length === 6 && s[2] === 'drawings' && s[4] === 'chunks') return { kind: 'chunk', job: s[1], drawing: s[3], chunk: s[5] };
  if (s.length === 4 && s[2] === 'snags') return { kind: 'snag', job: s[1], snag: s[3] };
  if (s.length === 6 && s[2] === 'snags' && s[4] === 'photos') return { kind: 'photo', job: s[1], snag: s[3], photo: s[5] };
  return null;
}

/* ═════════════ helpers ═════════════ */
const low = s => String(s || '').trim().toLowerCase();
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
function fail(status, code, message) { return Object.assign(new Error(message), { status, code }); }
const denied = () => fail(403, 'permission-denied', 'You don\'t have permission to change that.');
const b64url = s => b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/'));
const jsonPart = s => JSON.parse(new TextDecoder().decode(b64url(s)));
function b64ToBytes(b64) {
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlText = t => bytesToB64url(new TextEncoder().encode(t));
