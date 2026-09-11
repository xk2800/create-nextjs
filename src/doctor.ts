// Verifies required env vars are set and the configured DB driver can
// actually connect, before you run migrations against it.
import { Pool } from 'pg';
import { neon } from '@neondatabase/serverless';

const required = ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'BASE_URL', 'BETTER_AUTH_URL'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`❌ Missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('✅ Required env vars are set');

const driver = process.env.DB_DRIVER ?? 'pg';
try {
  if (driver === 'neon') {
    const sql = neon(process.env.DATABASE_URL!);
    await sql`select 1`;
  } else {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('select 1');
    await pool.end();
  }
  console.log(`✅ Database connection OK (${driver})`);
} catch (err) {
  console.error(`❌ Database connection failed (${driver}):`, err instanceof Error ? err.message : err);
  process.exit(1);
}

console.log('\nAll checks passed.');
