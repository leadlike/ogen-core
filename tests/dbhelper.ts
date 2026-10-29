import pg from 'pg';
import { migrate } from '../src/store/migrate';
import { Store } from '../src/store/store';
import type { Mode } from '../src/core/types';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/ogen_test';

let pool: pg.Pool | null = null;

/** One shared pool; schema is rebuilt from the real migrations once per test file. */
export async function testPool(): Promise<pg.Pool> {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 8 });
  const c = await pool.connect();
  try {
    await c.query('drop schema public cascade; create schema public;');
  } finally {
    c.release();
  }
  await migrate(pool);
  return pool;
}

/** Append-only tables reject TRUNCATE via trigger; tests rebuild the schema instead. */
export async function resetDb(): Promise<pg.Pool> {
  const p = await testPool();
  const c = await p.connect();
  try {
    await c.query('drop schema public cascade; create schema public;');
  } finally {
    c.release();
  }
  await migrate(p);
  return p;
}

export async function freshStore(mode: Mode = 'PAPER'): Promise<{ pool: pg.Pool; store: Store }> {
  const p = await resetDb();
  return { pool: p, store: Store.open(mode, p) };
}

export async function closePool(): Promise<void> {
  if (pool) await pool.end();
  pool = null;
}
