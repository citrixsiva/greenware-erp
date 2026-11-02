import pg from 'pg';
import { config } from './config.js';

// numeric/int8 as numbers, not strings — every money figure in this system is numeric()
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
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
