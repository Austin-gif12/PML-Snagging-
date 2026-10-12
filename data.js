// The app's data layer. It offers the same functions the app used with Firebase (collection, doc,
// onSnapshot, setDoc, writeBatch…), but stores everything in the PML Snagging API (PlanetScale Postgres).
//
// Offline: everything this person can see is kept on the device (IndexedDB). Changes are saved on the
// device first and queued; the queue uploads in order whenever there's signal, and the device checks the
// API for other people's changes every few seconds. Photos and drawing images are fetched when opened
// (photos are then kept on the device too; drawings are kept by index.html's own drawing cache).
import { API_URL, OWNER_EMAILS } from './config.js';
export { OWNER_EMAILS };

const SYNCED = new Set(['users', 'settings', 'jobs', 'drawings', 'snags']);
const POLL_MS = 15000;

const segs = p => p.split('/');
const colOf = path => path.slice(0, path.lastIndexOf('/'));         // jobs/a/snags/b → jobs/a/snags
const kindOf = path => { const s = segs(path); return s[s.length - 2]; }; // jobs/a/snags/b → snags
const clone = v => v === undefined ? undefined : structuredClone(v);
const plain = v => JSON.parse(JSON.stringify(v)); // drops undefined values, like Firestore

/* ═════════════ on-device storage (IndexedDB) ═════════════ */
const IDB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('pml-snag-data', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('docs'); d.createObjectStore('outbox', { keyPath: 'id' }); d.createObjectStore('meta'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (stores, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(stores, 'readwrite');
      fn(...stores.map(s => t.objectStore(s)));
      t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  };
  return {
    async entries(store) {
      const d = await open();
      return new Promise((res, rej) => {
        const out = [], r = d.transaction(store).objectStore(store).openCursor();
        r.onsuccess = () => { const c = r.result; if (!c) return res(out); out.push([c.key, c.value]); c.continue(); };
        r.onerror = () => rej(r.error);
      });
    },
    saveDocs: entries => tx(['docs'], s => { for (const [k, v] of entries) v === undefined ? s.delete(k) : s.put(v, k); }),
    addBatch: b => tx(['outbox'], s => s.put(b)),
    removeBatch: id => tx(['outbox'], s => s.delete(id)),
    setMeta: v => tx(['meta'], s => s.put(v, 'state')),
    clear: () => tx(['docs', 'outbox', 'meta'], (a, b, c) => { a.clear(); b.clear(); c.clear(); })
  };
})();

/* ═════════════ state ═════════════ */
let session = null;                // {token, email, name, exp}
let expired = false;               // signed in, but the API wants a fresh sign-in
let meta = { email: null, cursor: 0, role: undefined };
let synced = false;                // caught up with the server at least once since opening the app
const base = new Map();            // path → data as the server last had it (plus photos fetched)
const children = new Map();        // collection path → Set of doc paths
let queue = [];                    // [{id, ops}] changes not uploaded yet, oldest first
let pending = new Map();           // path → [op…] from the queue
const waiting = new Map();         // batch id → {res, rej} for the promise setDoc() etc. returned
const fetchedCols = new Set();     // photo collections fetched from the server this session
const ver = new Map();             // path → change counter (lets listeners skip unchanged updates)
const dirty = new Map();           // docs waiting to be written to IndexedDB

function index(path) { const c = colOf(path); if (!children.has(c)) children.set(c, new Set()); children.get(c).add(path); }
function unindex(path) { if (!base.has(path) && !pending.has(path)) children.get(colOf(path))?.delete(path); }
function rebuildPending() {
  pending = new Map();
  for (const b of queue) for (const op of b.ops) { if (!pending.has(op.path)) pending.set(op.path, []); pending.get(op.path).push(op); index(op.path); }
}
function applyOp(d, op) {
  if (op.type === 'delete') return undefined;
  if (op.type === 'update') return d === undefined ? undefined : { ...d, ...op.data };
  return op.merge ? { ...(d || {}), ...op.data } : op.data;
}
// What the app sees: the server's copy with this device's unsent changes on top.
function view(path) {
  let d = base.get(path);
  for (const op of pending.get(path) || []) d = applyOp(d, op);
  return d;
}
function setBase(path, data) {
  if (data === undefined) base.delete(path); else { base.set(path, data); index(path); }
  unindex(path);
  if (kindOf(path) !== 'chunks') dirty.set(path, data);
  touch(path);
}
let saveTimer = null;
function touch(path) {
  ver.set(path, (ver.get(path) || 0) + 1);
  if (!saveTimer) saveTimer = setTimeout(() => {
    saveTimer = null;
    const entries = [...dirty]; dirty.clear();
    if (entries.length) IDB.saveDocs(entries).catch(e => console.warn('save', e));
  }, 300);
  scheduleNotify();
}

/* ═════════════ references (same shapes as Firebase) ═════════════ */
const mk = (type, path, where = []) => ({ type, path, id: path.split('/').pop(), where });
const join = (...p) => p.filter(Boolean).join('/');
const newId = () => { const a = crypto.getRandomValues(new Uint8Array(20)); return [...a].map(x => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[x % 62]).join(''); };
export const db = { type: 'db', path: '' };
export const collection = (b, ...s) => mk('col', join(b.path, ...s));
export function doc(b, ...s) { return b.type === 'col' && !s.length ? mk('doc', b.path + '/' + newId()) : mk('doc', join(b.path, ...s)); }
export const where = (field, op, value) => ({ field, op, value });
export const query = (col, ...w) => mk('query', col.path, w);

/* ═════════════ reading ═════════════ */
const fromCache = path => kindOf(path) === 'photos' ? !fetchedCols.has(colOf(path)) : !synced;
function docSnap(path) {
  const d = view(path);
  return { id: path.split('/').pop(), ref: mk('doc', path), exists: () => d !== undefined, data: () => clone(d),
    metadata: { fromCache: fromCache(path), hasPendingWrites: pending.has(path) } };
}
function matches(d, w) {
  return w.every(({ field, op, value }) => op === 'array-contains' ? Array.isArray(d[field]) && d[field].includes(value) : op === '==' ? d[field] === value : true);
}
function colPaths(ref) {
  return [...(children.get(ref.path) || [])].filter(p => { const d = view(p); return d !== undefined && matches(d, ref.where); }).sort();
}
function querySnap(ref, paths = colPaths(ref)) {
  const docs = paths.map(docSnap);
  return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f),
    metadata: { fromCache: fromCache(ref.path + '/_'), hasPendingWrites: docs.some(d => d.metadata.hasPendingWrites) } };
}
const snapOf = ref => ref.type === 'doc' ? docSnap(ref.path) : querySnap(ref);
const signature = ref => {
  const paths = ref.type === 'doc' ? [ref.path] : colPaths(ref);
  return (ref.type === 'doc' ? '' : paths.length + '|') + fromCache(ref.type === 'doc' ? ref.path : ref.path + '/_') + '|' +
    paths.map(p => p + ':' + (ver.get(p) || 0) + (pending.has(p) ? '*' : '')).join(',');
};

const listeners = new Set();
let notifyQueued = false;
function scheduleNotify() {
  if (notifyQueued) return; notifyQueued = true;
  setTimeout(() => { notifyQueued = false; for (const l of [...listeners]) l.run(); }, 0);
}
export function onSnapshot(ref, a, b, c) {
  const [cb, onErr] = typeof a === 'function' ? [a, b] : [b, c];
  const l = {
    last: null,
    run(force) {
      if (!listeners.has(l)) return;
      const sig = signature(ref);
      if (!force && sig === l.last) return;
      l.last = sig;
      try { cb(snapOf(ref)); } catch (e) { console.error(e); }
    }
  };
  listeners.add(l);
  ready.then(() => {
    l.run(true);
    if (ref.type !== 'doc' && kindOf(ref.path + '/_') === 'photos') fetchPhotos(ref.path).catch(e => { if (e.status === 403) onErr?.(e); });
  });
  return () => listeners.delete(l);
}
export async function getDoc(ref) { await ready; return docSnap(ref.path); }
export async function getDocs(ref) {
  await ready;
  const kind = kindOf(ref.path + '/_');
  if (kind === 'chunks') {
    // Drawing image pieces always come from the server (index.html keeps the finished drawing on the device).
    const r = await api('GET', '/list?path=' + encodeURIComponent(ref.path));
    const metadata = { fromCache: false, hasPendingWrites: false };
    const docs = r.docs.map(x => ({ id: x.path.split('/').pop(), ref: mk('doc', x.path), exists: () => true, data: () => x.data, metadata }));
    return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f), metadata };
  }
  if (kind === 'photos' && navigator.onLine) await fetchPhotos(ref.path).catch(() => {});
  return querySnap(ref);
}
async function fetchPhotos(col) {
  if (!session || !navigator.onLine) return;
  const r = await api('GET', '/list?path=' + encodeURIComponent(col));
  const got = new Set(r.docs.map(x => x.path));
  for (const p of [...(children.get(col) || [])]) if (base.has(p) && !got.has(p)) setBase(p, undefined);
  for (const x of r.docs) setBase(x.path, x.data);
  fetchedCols.add(col);
  scheduleNotify();
}

/* ═════════════ writing ═════════════ */
// Every change is saved on the device straight away and uploaded in order when there's signal.
// The returned promise finishes when the server has accepted it (offline: when signal returns).
let seq = 0;
function commit(ops) {
  return ready.then(() => {
    if (!session) throw Object.assign(new Error('Not signed in'), { code: 'unauthenticated' });
    for (const op of ops) if (op.type === 'update' && view(op.path) === undefined) throw Object.assign(new Error('That item no longer exists'), { code: 'not-found' });
    const b = { id: Date.now() * 1000 + (seq++ % 1000), ops };
    queue.push(b); rebuildPending();
    ops.forEach(op => touch(op.path));
    const done = new Promise((res, rej) => waiting.set(b.id, { res, rej }));
    IDB.addBatch(b).catch(e => console.warn('queue', e)).finally(() => setTimeout(flush, 200));
    return done;
  });
}
export const setDoc = (ref, data, opts) => commit([{ type: 'set', path: ref.path, data: plain(data), merge: !!opts?.merge }]);
export const updateDoc = (ref, data) => commit([{ type: 'update', path: ref.path, data: plain(data) }]);
export const deleteDoc = ref => commit([{ type: 'delete', path: ref.path }]);
export function writeBatch() {
  const ops = [];
  return {
    set(r, d, o) { ops.push({ type: 'set', path: r.path, data: plain(d), merge: !!o?.merge }); return this; },
    update(r, d) { ops.push({ type: 'update', path: r.path, data: plain(d) }); return this; },
    delete(r) { ops.push({ type: 'delete', path: r.path }); return this; },
    commit: () => ops.length ? commit(ops) : Promise.resolve()
  };
}
export const pendingWrites = () => queue.length;

let flushing = false;
async function flush() {
  if (flushing || !session || expired || !navigator.onLine) return;
  flushing = true;
  try {
    while (queue.length && session) {
      const b = queue[0];
      let ok = true, err = null;
      try { await api('POST', '/write', { ops: b.ops }); }
      catch (e) {
        // Signal / server trouble: stop and try again later. Refused (no permission etc.): drop it.
        if (!e.status || e.status >= 500 || e.status === 401) break;
        ok = false; err = e;
      }
      queue.shift(); rebuildPending();
      IDB.removeBatch(b.id).catch(() => {});
      for (const op of b.ops) {
        if (ok && kindOf(op.path) !== 'chunks') setBase(op.path, applyOp(base.get(op.path), op));
        else { unindex(op.path); touch(op.path); }
      }
      const w = waiting.get(b.id); waiting.delete(b.id);
      if (ok) w?.res(); else { console.warn('Change refused', err); w ? w.rej(err) : onRefused?.(err); }
    }
  } finally { flushing = false; }
}
let onRefused = null;
// Called when a change saved earlier (e.g. before the app was reopened) is refused by the server.
export function setRefusedHandler(fn) { onRefused = fn; }

/* ═════════════ syncing ═════════════ */
let syncing = null;
export function sync() {
  if (!session || expired || !navigator.onLine) return Promise.resolve();
  return syncing || (syncing = (async () => {
    await flush();
    const knownJobs = meta.role === 'contractor' || meta.role === 'client' ?[...base.keys()].filter(p => /^jobs\/[^/]+$/.test(p)).map(p => p.slice(5)) : [];
    const r = await api('POST', '/sync', { since: meta.cursor, knownJobs });
    if (meta.role !== undefined && r.me.role !== meta.role) {
      // Role changed (e.g. contractor → site manager): start again from scratch.
      for (const p of [...base.keys()]) setBase(p, undefined);
      fetchedCols.clear();
      meta = { ...meta, cursor: 0, role: r.me.role };
      syncing = null;
      return sync();
    }
    for (const d of r.docs) setBase(d.path, d.deleted ? undefined : d.data);
    if (r.visible) {
      // Contractors and clients: forget jobs and snags they no longer have access to.
      const jobs = new Set(r.visible.jobs), snags = new Set(r.visible.snags);
      for (const p of [...base.keys()]) {
        const s = segs(p);
        if (s[0] === 'jobs' && !jobs.has('jobs/' + s[1])) setBase(p, undefined);
        else if (s[0] === 'jobs' && s[2] === 'snags' && !snags.has(s.slice(0, 4).join('/'))) setBase(p, undefined);
      }
    }
    meta = { ...meta, cursor: Math.max(meta.cursor, r.rev), role: r.me.role };
    IDB.setMeta(meta).catch(() => {});
    synced = true;
    scheduleNotify();
  })().catch(e => { if (e.status !== 401) console.warn('sync', e.message); }).finally(() => { syncing = null; }));
}
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') sync(); }, POLL_MS);
}
addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });

/* ═════════════ the API ═════════════ */
async function api(method, path, body) {
  if (!session) throw Object.assign(new Error('Not signed in'), { status: 401, code: 'unauthenticated' });
  let r;
  try {
    r = await fetch(API_URL.replace(/\/+$/, '') + path, {
      method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.token },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch { throw Object.assign(new Error('No signal, or the PML Snagging server can\'t be reached'), { code: 'unavailable' }); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { sessionExpired(); }
  if (!r.ok) throw Object.assign(new Error(j.error || 'Server error ' + r.status), { status: r.status, code: j.code });
  return j;
}

/* ═════════════ signing in ═════════════ */
const SESSION_KEY = 'pml-snag-session';
const authCbs = new Set();
const emitAuth = () => { const u = auth.currentUser; authCbs.forEach(cb => cb(u)); };
export const auth = {
  get currentUser() { return session && !expired ? { uid: session.email, email: session.email, displayName: session.name || '' } : null; }
};
export function onAuthStateChanged(_auth, cb) { authCbs.add(cb); ready.then(() => cb(auth.currentUser)); return () => authCbs.delete(cb); }

let refresher = null;
// index.html passes a function that gets a fresh session from WorkOS without showing the sign-in page.
export function setSessionRefresher(fn) { refresher = fn; }
let refreshing = null;
function sessionExpired() {
  if (refreshing || expired) return;
  refreshing = (async () => {
    try { const s = refresher && await refresher(); if (s) { await signInWithSession(s); return; } } catch {}
    // Keep everything on the device (including unsent changes) until they sign in again.
    expired = true; emitAuth();
  })().finally(() => { refreshing = null; });
}

// Called by workos-auth.js with the API's answer to /session.
export async function signInWithSession(s) {
  await ready;
  if (meta.email && meta.email !== s.email) await wipe();
  const was = auth.currentUser?.uid;
  session = s; expired = false;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
  if (meta.email !== s.email) { meta = { email: s.email, cursor: 0, role: undefined }; IDB.setMeta(meta).catch(() => {}); }
  startPolling();
  if (was !== s.email) emitAuth();
  sync();
}
export async function signOut() {
  session = null; expired = false;
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  clearInterval(pollTimer); pollTimer = null;
  await wipe();
  emitAuth();
}
async function wipe() {
  for (const p of [...base.keys()]) base.delete(p);
  children.clear(); queue = []; pending = new Map(); fetchedCols.clear(); dirty.clear();
  meta = { email: null, cursor: 0, role: undefined }; synced = false;
  await IDB.clear().catch(() => {});
  scheduleNotify();
}

/* ═════════════ invitations & importing ═════════════ */
// Emails a WorkOS invitation. Returns 'sent', 'resent' or 'has-login'.
export async function sendInvite(email) { return (await api('POST', '/invite', { email })).status; }
// Emails one contractor on a job their outstanding snags now. → {status: 'sent'|'nothing-outstanding'|'no-email-address', to, count}
export const sendReminder = (job, contractor) => api('POST', '/reminders/send', { job, contractor });

// One-off: copies a Firebase export (made by migrate/export-firestore.mjs) into the database.
// Goes straight to the server in batches (needs signal), then syncs.
export async function importDocs(docs, onProgress = () => {}) {
  const order = ['users', 'settings', 'jobs', 'drawings', 'chunks', 'snags', 'photos'];
  const list = docs.filter(d => order.includes(kindOf(d.path))).sort((a, b) => order.indexOf(kindOf(a.path)) - order.indexOf(kindOf(b.path)));
  let batch = [], size = 0, done = 0;
  const send = async () => {
    if (!batch.length) return;
    await api('POST', '/write', { ops: batch });
    done += batch.length; onProgress(done, list.length);
    batch = []; size = 0;
  };
  for (const d of list) {
    const op = { type: 'set', path: d.path, data: d.data };
    const n = JSON.stringify(op).length;
    if (batch.length && (size + n > 4e6 || batch.length >= 200)) await send();
    batch.push(op); size += n;
  }
  await send();
  meta = { ...meta, cursor: 0 }; await sync();
  return list.length;
}

/* ═════════════ start-up ═════════════ */
const ready = (async () => {
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
  if (session && !(session.exp > Date.now())) expired = true;
  try {
    const metaRows = await IDB.entries('meta');
    meta = metaRows.find(([k]) => k === 'state')?.[1] || meta;
    if (session && meta.email && meta.email !== session.email) await wipe();
    else if (session) {
      for (const [k, v] of await IDB.entries('docs')) { base.set(k, v); index(k); }
      queue = (await IDB.entries('outbox')).map(([, v]) => v).sort((a, b) => a.id - b.id);
      rebuildPending();
    }
  } catch (e) { console.warn('Could not open the on-device copy', e); }
})();
ready.then(() => { if (session) { startPolling(); if (expired) sessionExpired(); else sync(); } });
