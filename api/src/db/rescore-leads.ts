/**
 * Re-score every workable lead.
 *
 * Fit rules are evaluated when a lead is created or edited. Leads that already
 * existed before the evaluator did — or before a rule was added, re-weighted
 * or retired — keep whatever score they were last given, which for anything
 * created earlier is zero. This brings them into line.
 *
 *   DATABASE_URL=postgres://... npm -w api run rescore
 *   DATABASE_URL=... npm -w api run rescore -- --dry-run
 *
 * Safe to run repeatedly: rescoreLead only writes when a rule's position has
 * actually changed, so a second run over settled data writes nothing. Closed
 * leads are left alone — a qualified lead's score is the number it was handed
 * to sales with, and rewriting history under a changed rule set would make the
 * conversion figures disagree with what anyone remembers.
 */
import { pool, q } from '../core/db.js';
import { rescoreLead } from '../core/lead-scoring.js';

const WORKABLE = ['New', 'Working', 'Nurturing', 'Recycled'];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const leads = await q<{ id: string; lead_no: string; score: number | null }>(
    `SELECT id, lead_no, score FROM gw.leads WHERE status::text = ANY($1) ORDER BY lead_no`,
    [WORKABLE]);

  if (!leads.length) {
    console.log('rescore: no workable leads.');
    return;
  }

  const client = await pool.connect();
  let changed = 0;
  try {
    for (const lead of leads) {
      // One transaction per lead: a rule that trips over one lead's data should
      // not roll back the hundreds already corrected.
      await client.query('BEGIN');
      try {
        const before = Number(lead.score ?? 0);
        const after = await rescoreLead(client, null, lead.id);
        if (after !== before) {
          changed += 1;
          console.log(`  ${lead.lead_no}  ${before} -> ${after}`);
        }
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        console.error(`  ${lead.lead_no}  failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    client.release();
  }

  console.log(`rescore: ${changed} of ${leads.length} lead(s) changed${dryRun ? ' (dry run — nothing written)' : ''}.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());
