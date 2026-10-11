// One-off: loads firebase-export.json (from export-firestore.mjs) straight into the PlanetScale database,
// then reads the counts back so you can check nothing is missing. Run by migrate/import-to-db.ps1, which
// supplies a short-lived admin login in DATABASE_URL.
//   node migrate/import-to-db.mjs [firebase-export.json]
import { readFileSync } from 'node:fs';
import { pgStore } from '../lib/store-postgres.js';
import { parse } from '../lib/app.js';

const file = process.argv[2] || 'firebase-export.json';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const { docs } = JSON.parse(readFileSync(file, 'utf8'));
const kind = p => p.split('/').at(-2);
const order = ['users', 'settings', 'jobs', 'drawings', 'chunks', 'snags', 'photos'];
const list = docs.filter(d => parse(d.path) && order.includes(kind(d.path)))
  .sort((a, b) => order.indexOf(kind(a.path)) - order.indexOf(kind(b.path)));
const skipped = docs.length - list.length;

const store = pgStore(process.env.DATABASE_URL);
try {
  await store.init();
  let n = 0;
  for (let i = 0; i < list.length; i += 25) {
    await store.transaction(async tx => { for (const d of list.slice(i, i + 25)) await tx.put(d.path, d.data); });
    n = Math.min(i + 25, list.length);
    process.stdout.write(`\rSaved ${n} of ${list.length}…`);
  }
  console.log(`\rSaved ${n} of ${list.length} items.${skipped ? ` Skipped ${skipped} unknown item(s).` : ''}`);

  // Read everything back and compare with the export.
  const want = {};
  for (const d of list) want[kind(d.path)] = (want[kind(d.path)] || 0) + 1;
  const got = {};
  for (const d of list) if (await store.get(d.path)) got[kind(d.path)] = (got[kind(d.path)] || 0) + 1;
  let ok = true;
  for (const k of order) if (want[k]) {
    const good = got[k] === want[k];
    ok &&= good;
    console.log(`  ${good ? 'OK ' : 'MISSING'} ${k}: ${got[k] || 0} of ${want[k]}`);
  }
  for (const j of list.filter(d => kind(d.path) === 'jobs')) {
    const snags = list.filter(d => d.path.startsWith(j.path + '/snags/') && kind(d.path) === 'snags').length;
    console.log(`  ${j.data.name}: ${snags} snags`);
  }
  console.log(ok ? 'Everything is in the database.' : 'Some items are missing — see above.');
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('\nImport stopped: ' + e.message);
  process.exitCode = 1;
} finally {
  await store.end();
}
