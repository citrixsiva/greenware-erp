import type pg from 'pg';

/**
 * Human-readable business keys: ENQ-2026-00142, QT-2026-0087, PRJ-2026-0051.
 * Allocated inside the caller's transaction with a row lock, so two concurrent
 * creates cannot take the same number.
 */
export async function nextNumber(
  client: pg.PoolClient, entity: string, companyId: string | null, prefix: string, padding = 5,
): Promise<string> {
  const year = new Date().getUTCFullYear();
  const sel = companyId
    ? await client.query(
        `SELECT id, next_value FROM gw.number_sequences
          WHERE entity=$1 AND company_id=$2 AND year=$3 FOR UPDATE`, [entity, companyId, year])
    : await client.query(
        `SELECT id, next_value FROM gw.number_sequences
          WHERE entity=$1 AND company_id IS NULL AND year=$2 FOR UPDATE`, [entity, year]);

  let n = 1, id: string | null = null;
  if (sel.rows.length) { id = sel.rows[0].id; n = Number(sel.rows[0].next_value); }
  else {
    const ins = await client.query(
      `INSERT INTO gw.number_sequences (entity, company_id, year, prefix, padding, next_value)
       VALUES ($1,$2,$3,$4,$5,1) RETURNING id`, [entity, companyId, year, prefix, padding]);
    id = ins.rows[0].id;
  }
  await client.query(`UPDATE gw.number_sequences SET next_value = $2 WHERE id = $1`, [id, n + 1]);
  return `${prefix}-${year}-${String(n).padStart(padding, '0')}`;
}
