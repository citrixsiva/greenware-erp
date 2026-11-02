/**
 * =============================================================================
 * Greenware ERP — migration runner.
 *
 * Applies db/migrations/*.sql in filename order, exactly once each. This is the
 * Node implementation of infra/scripts/apply-migrations.sh and shares its
 * ledger, so the two are interchangeable against the same database:
 *
 *   npm -w api run migrate            # tsx src/db/migrate.ts
 *   npm -w api run migrate -- --dry-run
 *
 * The migrations are NOT individually idempotent (CREATE DOMAIN, CREATE TYPE
 * and CREATE POLICY all fail on a second run), so each applied file is recorded
 * in public.schema_migrations and skipped next time. The ledger lives in
 * `public` and not `gw` because schema `gw` does not exist until 001_core.sql
 * has run — see docs/CONVENTIONS.md on schema-qualifying everything.
 *
 * Guarantees:
 *   * filename order, one transaction per file — a failure leaves that file's
 *     changes rolled back, and the ledger row is committed by the same
 *     transaction that applied the schema, so the two can never disagree;
 *   * a file whose checksum no longer matches what was recorded is a hard
 *     failure, never a silent re-apply;
 *   * re-running applies nothing and exits 0.
 *
 * Exit codes:  0 ok · 1 migration failed / checksum drift · 2 bad invocation.
 *
 * Against DigitalOcean Managed Postgres, DATABASE_URL must end in
 * `?sslmode=require` and must be the doadmin URI: 001_core.sql issues
 * CREATE EXTENSION and CREATE ROLE, which an ordinary database user cannot do.
 * =============================================================================
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// -----------------------------------------------------------------------------
// This runner opens its OWN pg.Pool instead of reusing `pool` from
// ../core/db.js, deliberately:
//
//   1. core/db.ts takes its URL from core/config.ts, which SILENTLY falls back
//      to postgres://postgres@127.0.0.1:5432/greenware when DATABASE_URL is
//      unset. For the application that default is a convenience; for a DDL job
//      it means migrating whatever database happens to be on localhost. Like
//      apply-migrations.sh, this refuses to run without DATABASE_URL (exit 2).
//   2. Every migration starts with `SET search_path = gw, public`. A plain SET
//      that commits sticks to the connection, so DDL must run on a connection
//      this script owns end to end — not on one borrowed from, and handed back
//      to, the application's 20-connection pool. max: 1 also means the advisory
//      lock below is held by the only connection in play.
//   3. Migrations run before the app schema exists; importing core/db.js would
//      pull in config + the global numeric type parsers for no benefit here.
// -----------------------------------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
// api/src/db -> repo root (and api/dist/db -> repo root, same depth after build)
const DEFAULT_MIGRATIONS_DIR = path.resolve(HERE, '../../../db/migrations');
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? DEFAULT_MIGRATIONS_DIR;

// Seconds to wait for the database to accept connections. docker-compose gates
// this service on a TCP healthcheck already, but CI service containers and
// managed clusters can still refuse the first connection.
const WAIT_SECONDS = Number(process.env.MIGRATE_WAIT_SECONDS ?? 120);

// Stable key so two concurrent runners (or this script and the shell script)
// serialise instead of racing on the same ledger.
const LOCK_KEY = 4132026;

const DRY_RUN = process.argv.includes('--dry-run');

function die(message: string, code: 1 | 2 = 1): never {
  console.error(`migrate: ${message}`);
  process.exit(code);
}

/** Byte-for-byte sha256, so it matches `sha256sum` and apply-migrations.sh. */
function checksum(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

/** Turns a postgres error `position` (1-based character offset) into line:col. */
function locate(sql: string, position?: string): string {
  const offset = Number(position);
  if (!Number.isFinite(offset) || offset < 1) return '';
  const upto = sql.slice(0, offset - 1).split('\n');
  return ` (line ${upto.length}, column ${(upto[upto.length - 1] ?? '').length + 1})`;
}

async function listMigrations(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    die(`no such directory: ${dir}`, 2);
  }
  // Plain sort = filename order: 001_core.sql, 002_marketing.sql, 003_fixes.sql.
  const files = entries.filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) die(`no .sql files in ${dir}`, 2);
  return files;
}

async function waitForDatabase(pool: pg.Pool): Promise<pg.PoolClient> {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let announced = false;
  for (;;) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      return client;
    } catch (err) {
      if (Date.now() >= deadline) {
        die(
          `database did not become reachable within ${WAIT_SECONDS}s: ${(err as Error).message}`,
        );
      }
      if (!announced) {
        console.log('migrate: waiting for the database to accept connections');
        announced = true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main(): Promise<void> {
  if (!DATABASE_URL) die('DATABASE_URL is not set.', 2);

  const dirStat = await stat(MIGRATIONS_DIR).catch(() => null);
  if (!dirStat?.isDirectory()) die(`no such directory: ${MIGRATIONS_DIR}`, 2);

  const files = await listMigrations(MIGRATIONS_DIR);

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const client = await waitForDatabase(pool);

  let applied = 0;
  let skipped = 0;

  try {
    // Serialise concurrent runners. Session-scoped: released with the client.
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    await client.query(`
      SET client_min_messages = warning;
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename    text PRIMARY KEY,
        sha256      text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      );`);

    for (const filename of files) {
      const fullPath = path.join(MIGRATIONS_DIR, filename);
      const contents = await readFile(fullPath);
      const sum = checksum(contents);

      const recorded: string | undefined = (
        await client.query<{ sha256: string }>(
          'SELECT sha256 FROM public.schema_migrations WHERE filename = $1',
          [filename],
        )
      ).rows[0]?.sha256;

      if (recorded) {
        if (recorded !== sum) {
          // Editing an applied migration in place means the database and the
          // file no longer agree. Refuse rather than guess which one is right.
          console.error(`migrate: ${filename} was applied with a different checksum.`);
          console.error(`  database: ${recorded}`);
          console.error(`  file:     ${sum}`);
          console.error('  Add a new migration file instead of editing an applied one.');
          process.exit(1);
        }
        console.log(`  = ${filename} (already applied)`);
        skipped++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`  + ${filename} (would apply)`);
        applied++;
        continue;
      }

      const sql = contents.toString('utf8');
      const started = Date.now();
      try {
        await client.query('BEGIN');
        // Each migration sets its own `search_path = gw, public`, and a plain
        // SET that commits sticks to the connection. Start every file from the
        // same state so file N never depends on file N-1's leftovers.
        await client.query('RESET search_path');
        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (filename, sha256) VALUES ($1, $2)',
          [filename, sum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        const e = err as Error & {
          code?: string;
          detail?: string;
          hint?: string;
          position?: string;
          where?: string;
        };
        console.error(`migrate: ${filename} FAILED — rolled back, nothing from it was kept.`);
        console.error(`  file:  ${fullPath}`);
        console.error(`  error: ${e.code ? `[${e.code}] ` : ''}${e.message}${locate(sql, e.position)}`);
        if (e.detail) console.error(`  detail: ${e.detail}`);
        if (e.hint) console.error(`  hint:   ${e.hint}`);
        if (e.where) console.error(`  where:  ${e.where}`);
        process.exit(1);
      }
      console.log(`  + ${filename} (applied in ${Date.now() - started} ms)`);
      applied++;
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(
    DRY_RUN
      ? `migrate: dry run — ${applied} to apply, ${skipped} already applied`
      : `migrate: ${applied} applied, ${skipped} skipped`,
  );
}

main().catch((e) => {
  console.error('migrate: unexpected failure');
  console.error(e);
  process.exit(1);
});
