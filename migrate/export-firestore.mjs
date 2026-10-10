// One-off: copies everything out of the old Firebase (Firestore) snagging database into a JSON file,
// which the app then imports (Users & permissions → Move data across from Firebase).
//
//   node migrate/export-firestore.mjs <service-account.json> [output.json] [database-id]
//
// The service account file comes from Firebase console → Project settings → Service accounts →
// Generate new private key. It can read everything, so delete it once the export is done.
// Needs Node 18 or newer. No packages to install.
import { readFileSync, writeFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const [keyFile, outFile = 'firebase-export.json', databaseId = '(default)'] = process.argv.slice(2);
if (!keyFile) { console.error('Usage: node migrate/export-firestore.mjs <service-account.json> [output.json] [database-id]'); process.exit(1); }
const sa = JSON.parse(readFileSync(keyFile, 'utf8'));
const ROOT = `https://firestore.googleapis.com/v1/projects/${sa.project_id}/databases/${encodeURIComponent(databaseId)}/documents`;

async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  });
  const jwt = unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google sign-in failed: ' + JSON.stringify(j));
  return j.access_token;
}
const token = await accessToken();
async function call(url, body) {
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${url}: ${j.error?.message || JSON.stringify(j)}`);
  return j;
}

// Firestore stores values with their type ({stringValue: 'x'}); turn them back into plain JSON.
function plain(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('mapValue' in v) return fields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('referenceValue' in v) return v.referenceValue.split('/documents/')[1];
  if ('geoPointValue' in v) return v.geoPointValue;
  if ('bytesValue' in v) return v.bytesValue;
  return null;
}
const fields = f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, plain(v)]));

const docs = [];
async function collectionIds(parent) {
  const ids = [];
  let pageToken;
  do {
    const j = await call(`${parent}:listCollectionIds`, { pageSize: 300, pageToken });
    ids.push(...(j.collectionIds || []));
    pageToken = j.nextPageToken;
  } while (pageToken);
  return ids;
}
async function walk(parent, id) {
  let pageToken;
  do {
    const j = await call(`${parent}/${id}?pageSize=300${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
    for (const d of j.documents || []) {
      const path = d.name.split('/documents/')[1];
      docs.push({ path, data: fields(d.fields || {}) });
      if (docs.length % 100 === 0) process.stdout.write(`\r${docs.length} items…`);
      for (const sub of await collectionIds(d.name.replace(/^projects/, 'https://firestore.googleapis.com/v1/projects'))) await walk(`${ROOT}/${path}`, sub);
    }
    pageToken = j.nextPageToken;
  } while (pageToken);
}

console.log(`Reading Firebase project ${sa.project_id}, database ${databaseId}…`);
for (const id of await collectionIds(ROOT)) await walk(ROOT, id);
writeFileSync(outFile, JSON.stringify({ exportedAt: new Date().toISOString(), project: sa.project_id, docs }));
const count = k => docs.filter(d => d.path.split('/').at(-2) === k).length;
console.log(`\rSaved ${docs.length} items to ${outFile}: ${count('jobs')} jobs, ${count('drawings')} drawings, ` +
  `${count('snags')} snags, ${count('photos')} photos, ${count('users')} users.`);
console.log('Now delete the service account file, then import the export in the app.');
