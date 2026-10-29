import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

/** Applies pending migrations in filename order, each in its own transaction. Idempotent. */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // serialize concurrent migrators (worker + web starting together)
    await client.query('select pg_advisory_lock(727274)');
    await client.query(`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(version) values ($1)', [f]);
        await client.query('commit');
        applied.push(f);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: url });
  migrate(pool)
    .then((a) => console.log(a.length ? `applied: ${a.join(', ')}` : 'schema up to date'))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
