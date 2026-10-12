// Stores the app's data in Postgres (PlanetScale). app.js only talks to the database through the
// functions returned by pgStore(): get, put, remove, list, changes, transaction and ping.
//
// Every row the app syncs has a `rev` from one shared counter. When anything changes it gets a new rev,
// so "everything after rev N" is what a phone needs to catch up. Deleted jobs, drawings, snags, users
// and settings stay as `deleted` rows for a while so phones learn they've gone.
// Photos and drawing image pieces are big, so they live in their own columns and aren't synced; the
// app fetches them when they're opened. The table definitions are also in db/schema.sql — keep them the same.
import postgres from 'postgres';
import { parse } from './app.js';

export const SCHEMA = `
create sequence if not exists rev_seq;
create table if not exists users (
  email text primary key,
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false);
create table if not exists settings (
  id text primary key,
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false);
create table if not exists jobs (
  id text primary key,
  contractor_emails text[] not null default '{}',
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false);
create table if not exists drawings (
  job_id text not null,
  id text not null,
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false,
  primary key (job_id, id));
create table if not exists drawing_chunks (
  job_id text not null,
  drawing_id text not null,
  id text not null,
  i integer not null default 0,
  d text not null default '',
  data jsonb not null default '{}',
  primary key (job_id, drawing_id, id));
create table if not exists snags (
  job_id text not null,
  id text not null,
  contractor_emails text[] not null default '{}',
  status text not null default '',
  data jsonb not null default '{}',
  rev bigint not null default nextval('rev_seq'),
  deleted boolean not null default false,
  primary key (job_id, id));
create table if not exists photos (
  job_id text not null,
  snag_id text not null,
  id text not null,
  by_email text not null default '',
  kind text not null default '',
  at bigint not null default 0,
  d text not null default '',
  data jsonb not null default '{}',
  primary key (job_id, snag_id, id));
create index if not exists users_rev on users (rev);
create index if not exists settings_rev on settings (rev);
create index if not exists jobs_rev on jobs (rev);
create index if not exists jobs_contractors on jobs using gin (contractor_emails);
create index if not exists drawings_rev on drawings (rev);
create index if not exists snags_rev on snags (rev);
create index if not exists snags_contractors on snags using gin (contractor_emails);
`;

// How each kind of path maps to a table.
const T = {
  user:     { table: 'users',          keys: p => ({ email: p.email }), synced: true },
  settings: { table: 'settings',       keys: p => ({ id: p.id }), synced: true },
  job:      { table: 'jobs',           keys: p => ({ id: p.job }), synced: true,
              cols: d => ({ contractor_emails: emails(d.contractorEmails) }) },
  drawing:  { table: 'drawings',       keys: p => ({ job_id: p.job, id: p.drawing }), synced: true },
  snag:     { table: 'snags',          keys: p => ({ job_id: p.job, id: p.snag }), synced: true,
              cols: d => ({ contractor_emails: emails(d.contractorEmails), status: str(d.status) }) },
  chunk:    { table: 'drawing_chunks', keys: p => ({ job_id: p.job, drawing_id: p.drawing, id: p.chunk }), blob: true,
              cols: d => ({ i: Number.isInteger(d.i) ? d.i : 0 }) },
  photo:    { table: 'photos',         keys: p => ({ job_id: p.job, snag_id: p.snag, id: p.photo }), blob: true,
              cols: d => ({ by_email: str(d.byEmail), kind: str(d.kind), at: Number.isFinite(d.at) ? Math.round(d.at) : 0 }) }
};
const emails = v => ({ array: (Array.isArray(v) ? v : []).map(x => String(x).toLowerCase()) });
const str = v => (typeof v === 'string' ? v : '');

// Rows that changed in the last OVERLAP revs are sent again, in case two saves finished out of order.
const OVERLAP = 200;

let schemaReady = null;

export function pgStore(databaseUrl) {
  // PlanetScale's connection strings end with ?sslmode=verify-full&sslrootcert=system. postgres.js would send
  // those to the server as settings (which it rejects), so they're turned into its own TLS option instead.
  const url = new URL(databaseUrl);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  url.searchParams.delete('sslrootcert');
  const sql = postgres(url.href, {
    max: 1, prepare: false, fetch_types: false, connect_timeout: 10, idle_timeout: 20,
    ssl: local || sslmode === 'disable' ? false : sslmode === 'require' ? 'require' : 'verify-full'
  });

  // Creates the tables the first time. Once they exist nothing is changed, so the API can then use a
  // read/write-only login (see db/schema.sql).
  const init = () => schemaReady || (schemaReady = (async () => {
    const [{ ok }] = await sql`select to_regclass('public.photos') is not null as ok`;
    if (ok) {
      // Repairs rows saved by the first release, which stored `data` as JSON text inside a JSON string.
      for (const t of ['users', 'settings', 'jobs', 'drawings', 'snags', 'drawing_chunks', 'photos'])
        await sql.unsafe(`update ${t} set data = (data #>> '{}')::jsonb where jsonb_typeof(data) = 'string'`);
      return;
    }
    try { await sql.unsafe(SCHEMA).simple(); }
    catch (e) {
      throw new Error(`The database tables don't exist yet and this login can't create them (${e.message}). ` +
        'Run db/schema.sql once in PlanetScale, or use an admin login the first time.');
    }
  })().catch(e => { schemaReady = null; throw e; }));

  function where(keys, start = 1) {
    const names = Object.keys(keys);
    return { clause: names.map((k, i) => `${k} = $${start + i}`).join(' and '), params: names.map(k => keys[k]) };
  }
  const value = (v, n) => v && v.array ? [`array(select jsonb_array_elements_text($${n}::jsonb))`, v.array] : [`$${n}`, v];

  const toDoc = (kind, row) => {
    const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
    return T[kind].blob ? { ...data, d: row.d } : data;
  };

  function ops(q) {
    return {
      async get(path) {
        const p = parse(path); if (!p) return null;
        const t = T[p.kind], w = where(t.keys(p));
        const rows = await q.unsafe(`select data${t.blob ? ', d' : ''} from ${t.table} where ${w.clause}${t.synced ? ' and not deleted' : ''}`, w.params);
        return rows.length ? toDoc(p.kind, rows[0]) : null;
      },
      async put(path, doc) {
        const p = parse(path); if (!p) throw new Error('bad path ' + path);
        const t = T[p.kind];
        const { d, ...rest } = doc;
        const cols = { ...t.keys(p), ...(t.cols ? t.cols(doc) : {}) };
        const names = Object.keys(cols), params = [], exprs = [];
        for (const k of names) { const [e, v] = value(cols[k], params.length + 1); exprs.push(e); params.push(v); }
        names.push('data'); exprs.push(`$${params.length + 1}::jsonb`); params.push(t.blob ? rest : doc);
        if (t.blob) { names.push('d'); exprs.push(`$${params.length + 1}`); params.push(typeof d === 'string' ? d : ''); }
        const keyNames = Object.keys(t.keys(p));
        const updates = names.filter(k => !keyNames.includes(k)).map(k => `${k} = excluded.${k}`);
        if (t.synced) updates.push(`rev = nextval('rev_seq')`, 'deleted = false');
        await q.unsafe(`insert into ${t.table} (${names.join(', ')}) values (${exprs.join(', ')})
          on conflict (${keyNames.join(', ')}) do update set ${updates.join(', ')}`, params);
      },
      async remove(path) {
        const p = parse(path); if (!p) return;
        const t = T[p.kind], w = where(t.keys(p));
        if (t.synced) await q.unsafe(`update ${t.table} set deleted = true, data = '{}'::jsonb, rev = nextval('rev_seq') where ${w.clause} and not deleted`, w.params);
        else await q.unsafe(`delete from ${t.table} where ${w.clause}`, w.params);
      }
    };
  }

  return {
    init,
    async ping() { await init(); await sql`select 1`; },
    ...ops(sql),
    async transaction(fn) { await sql.begin(t => fn(ops(t))); },

    // Photos or drawing pieces under one snag / drawing.
    async list(colPath) {
      const p = parse(colPath + '/_');
      const t = T[p.kind];
      const keys = t.keys(p); delete keys.id;
      const w = where(keys);
      const order = p.kind === 'chunk' ? 'i' : 'at';
      const rows = await sql.unsafe(`select id, data, d from ${t.table} where ${w.clause} order by ${order}`, w.params);
      return rows.map(r => ({ path: colPath + '/' + r.id, data: toDoc(p.kind, r) }));
    },

    // Everything a person can see that changed after `since`.
    async changes({ since, email, role, knownJobs }) {
      const s = Math.max(0, since - OVERLAP);
      const out = [];
      let max = since;
      const add = (rows, kind, pathOf) => {
        for (const r of rows) {
          out.push({ path: pathOf(r), data: r.deleted ? null : toDoc(kind, r), deleted: !!r.deleted });
          max = Math.max(max, Number(r.rev));
        }
      };
      const userPath = r => 'users/' + r.email, jobPath = r => 'jobs/' + r.id;
      const drawingPath = r => `jobs/${r.job_id}/drawings/${r.id}`, snagPath = r => `jobs/${r.job_id}/snags/${r.id}`;

      if (role === 'admin' || role === 'manager') {
        add(await sql.unsafe('select email, data, rev, deleted from users where rev > $1', [s]), 'user', userPath);
        add(await sql.unsafe('select id, data, rev, deleted from settings where rev > $1', [s]), 'settings', r => 'settings/' + r.id);
        add(await sql.unsafe('select id, data, rev, deleted from jobs where rev > $1', [s]), 'job', jobPath);
        add(await sql.unsafe('select job_id, id, data, rev, deleted from drawings where rev > $1', [s]), 'drawing', drawingPath);
        add(await sql.unsafe('select job_id, id, data, rev, deleted from snags where rev > $1', [s]), 'snag', snagPath);
        return { rev: max, docs: out, visible: null };
      }

      add(await sql.unsafe('select email, data, rev, deleted from users where email = $1 and rev > $2', [email, s]), 'user', userPath);
      if (role !== 'contractor' && role !== 'client') return { rev: max, docs: out, visible: { jobs: [], snags: [] } };

      // Contractors: only jobs and snags where their email is listed. Clients: jobs where they're one of
      // the job's clients, and every snag on them. Jobs they've just been added to (not in knownJobs)
      // are sent in full, however old their drawings and snags are.
      const client = role === 'client';
      const arr = n => `array(select jsonb_array_elements_text($${n}::jsonb))`; // a JSON list parameter as text[]
      const visibleJobs = (await sql.unsafe(client
        ? `select id from jobs where not deleted and coalesce(data->'clientEmails', '[]'::jsonb) @> jsonb_build_array($1::text)`
        : 'select id from jobs where not deleted and $1 = any(contractor_emails)', [email])).map(r => r.id);
      const mine = client ? `$4 <> ''` : `$4 = any(contractor_emails)`;
      // $1 visible job ids, $2 since, $3 jobs the phone already has, $4 email
      const params = [visibleJobs, s, knownJobs.map(String), email];
      const fresh = `(rev > $2 or (not deleted and not (job_id = any(${arr(3)}))))`;
      add(await sql.unsafe(`select id, data, rev, deleted from jobs
        where id = any(${arr(1)}) and (rev > $2 or not (id = any(${arr(3)}))) and $4 <> ''`, params), 'job', jobPath);
      add(await sql.unsafe(`select job_id, id, data, rev, deleted from drawings
        where job_id = any(${arr(1)}) and ${fresh} and $4 <> ''`, params), 'drawing', drawingPath);
      add(await sql.unsafe(`select job_id, id, data, rev, deleted from snags
        where job_id = any(${arr(1)}) and ${mine} and ${fresh}`, params), 'snag', snagPath);
      const visibleSnags = (await sql.unsafe(`select job_id, id from snags
        where not deleted and ${client ? `$1 <> ''` : '$1 = any(contractor_emails)'} and job_id = any(${arr(2)})`, [email, params[0]])).map(snagPath);
      return { rev: max, docs: out, visible: { jobs: visibleJobs.map(id => 'jobs/' + id), snags: visibleSnags } };
    },

    // For the reminder emails (lib/reminders.js).
    async allJobs() {
      return (await sql.unsafe('select id, data from jobs where not deleted')).map(r => ({ ...toDoc('job', r), id: r.id }));
    },
    async jobRows(table, jobId) {
      if (!['drawings', 'snags'].includes(table)) throw new Error('bad table ' + table);
      return (await sql.unsafe(`select id, data from ${table} where job_id = $1 and not deleted`, [jobId])).map(r => ({ ...toDoc(table === 'snags' ? 'snag' : 'drawing', r), id: r.id }));
    },

    end: () => sql.end({ timeout: 5 })
  };
}
