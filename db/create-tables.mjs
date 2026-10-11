// Creates the PML Snagging tables (db/schema.sql) using the connection string in DATABASE_URL.
// Run by db/create-tables.ps1 with a short-lived admin login; the API itself only needs read/write.
import { pgStore } from '../lib/store-postgres.js';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
const store = pgStore(process.env.DATABASE_URL);
try {
  await store.ping(); // creates any missing tables
  console.log('Tables are ready.');
} catch (e) {
  console.error('Could not create the tables: ' + e.message);
  process.exitCode = 1;
} finally {
  await store.end();
}
