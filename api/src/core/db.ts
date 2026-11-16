import pg from 'pg';
import { config } from './config.js';

// numeric/int8 as numbers, not strings — every money figure in this system is numeric()
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

/**
 * DigitalOcean hands the app a URL ending in `?sslmode=require` and a
 * certificate signed by a per-cluster CA that is in no public trust store.
 *
 * Passing an `ssl` object is not enough on its own: node-postgres now treats
 * `sslmode=require` in the connection string as `verify-full`, that parsing
 * wins over the object, and the connection dies with "self-signed certificate
 * in certificate chain" — verified against this cluster. So the mode is
 * removed from the URL and verification is configured explicitly, against the
 * cluster's own CA. The common workaround, rejectUnauthorized:false, encrypts
 * the connection while authenticating nothing, which is the half that matters.
 *
 * With no CA supplied — local Postgres, docker-compose — the URL is used as
 * given and SSL is left alone.
 */
function connection(): pg.PoolConfig {
  if (!config.databaseCaCert) return { connectionString: config.databaseUrl };
  const url = new URL(config.databaseUrl);
  url.searchParams.delete('sslmode');
  return {
    connectionString: url.toString(),
    ssl: { ca: config.databaseCaCert, rejectUnauthorized: true },
  };
}

export const pool = new pg.Pool({
  ...connection(),
  max: config.databasePoolMax,
  idleTimeoutMillis: 30_000,
});

export type Row = Record<string, any>;

export async function q<T = Row>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
export async function q1<T = Row>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs fn inside a transaction with the app.* settings the schema's RLS policies
 * and audit triggers read. Every mutating request goes through this.
 */
export async function tx<T>(
  ctx: { userId?: string | null; employeeId?: string | null; sbuId?: string | null; scope?: string },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['app.user_id', ctx.userId ?? '']);
    await client.query('SELECT set_config($1,$2,true)', ['app.employee_id', ctx.employeeId ?? '']);
    await client.query('SELECT set_config($1,$2,true)', ['app.sbu_id', ctx.sbuId ?? '']);
    await client.query('SELECT set_config($1,$2,true)', ['app.scope', ctx.scope ?? 'O']);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
