#!/usr/bin/env sh
# =============================================================================
# Apply db/migrations/*.sql in filename order, once each.
#
# This repo has no migration runner. api/package.json declares
# `"migrate": "tsx src/db/migrate.ts"` but api/src/db/migrate.ts DOES NOT EXIST,
# so `npm -w api run migrate` fails. This script is what actually applies the
# schema — in docker-compose, in CI, and against DigitalOcean Managed Postgres.
#
# The migrations are NOT individually idempotent (CREATE DOMAIN, CREATE TYPE and
# CREATE POLICY all fail on a second run), so applied files are recorded in a
# schema_migrations ledger and skipped next time. The ledger prefers `public`,
# which exists before 001_core.sql has run, and falls back to `gw` when the
# bound user may not write to `public`.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/db ./infra/scripts/apply-migrations.sh
#   ./infra/scripts/apply-migrations.sh --dry-run
#
# Against DigitalOcean Managed Postgres, DATABASE_URL must end in
# `?sslmode=require`. Prefer the doadmin URI: as an ordinary user the
# extensions, the gw_app/gw_report roles and the RLS policy are skipped (the
# migrations degrade on purpose — see the preflight line in the output), and
# the schema is still complete.
# =============================================================================
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ -z "${DATABASE_URL:-}" ]; then
  echo "apply-migrations: DATABASE_URL is not set." >&2
  exit 2
fi
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "apply-migrations: no such directory: $MIGRATIONS_DIR" >&2
  exit 2
fi

# ON_ERROR_STOP=1 is the whole point: without it psql reports success after a
# failed statement and a half-applied schema looks like a clean deploy.
PSQL="psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --dbname=$DATABASE_URL"

echo "apply-migrations: waiting for the database to accept connections"
i=0
until $PSQL --command 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "apply-migrations: database did not become reachable within 120s" >&2
    $PSQL --command 'SELECT 1' >&2 || true
    exit 1
  fi
  sleep 2
done

# ---------------------------------------------------------------------------
# Preflight. The bound user differs wildly between substrates: doadmin on a
# DigitalOcean managed cluster owns everything, while the user handed to an App
# Platform *dev* database owns nothing and cannot write to `public`. Print what
# we actually have before anything fails, so a deploy log explains itself.
# ---------------------------------------------------------------------------
echo "apply-migrations: preflight"
$PSQL --tuples-only --no-align --command "
  SELECT '  user=' || current_user
      || ' db=' || current_database()
      || ' superuser=' || coalesce((SELECT usesuper     FROM pg_user  WHERE usename = current_user)::text, '?')
      || ' createrole=' || coalesce((SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user)::text, '?')
      || E'\n  create_on_database=' || has_database_privilege(current_user, current_database(), 'CREATE')
      || ' create_on_public=' || has_schema_privilege(current_user, 'public', 'CREATE')
      || ' public_owner=' || pg_get_userbyid((SELECT nspowner FROM pg_namespace WHERE nspname = 'public'))
      || ' server=' || current_setting('server_version')" || true

# Best effort: if we are allowed to own `public`, take it. Silent when refused.
$PSQL --command "ALTER SCHEMA public OWNER TO CURRENT_USER" >/dev/null 2>&1 || true
$PSQL --command "GRANT ALL ON SCHEMA public TO CURRENT_USER"  >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# The ledger. It wants to live in `public` so it is visible before schema `gw`
# exists, but a restricted user has no CREATE there. Fall back to `gw` — which
# this same user must be able to create anyway, or no migration can run at all.
# ---------------------------------------------------------------------------
LEDGER_DDL='(
    filename    text PRIMARY KEY,
    sha256      text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )'

LEDGER=public.schema_migrations
if ! $PSQL --command "SET client_min_messages = warning;
                      CREATE TABLE IF NOT EXISTS public.schema_migrations $LEDGER_DDL;" >/dev/null 2>&1; then
  echo "apply-migrations: no CREATE on schema public — putting the ledger in gw"
  if ! $PSQL --command "CREATE SCHEMA IF NOT EXISTS gw" >/dev/null 2>&1; then
    echo "apply-migrations: this user can create neither a table in public nor schema gw." >&2
    echo "  Nothing can be migrated with these privileges. Use the cluster's admin" >&2
    echo "  user (doadmin on DigitalOcean Managed Postgres) for DATABASE_URL." >&2
    $PSQL --command "CREATE SCHEMA IF NOT EXISTS gw" >&2 || true
    exit 1
  fi
  LEDGER=gw.schema_migrations
  $PSQL --command "SET client_min_messages = warning;
                   CREATE TABLE IF NOT EXISTS gw.schema_migrations $LEDGER_DDL;" >/dev/null
fi
echo "apply-migrations: ledger is $LEDGER"

applied=0
skipped=0

for path in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$path" ] || { echo "apply-migrations: no .sql files in $MIGRATIONS_DIR" >&2; exit 2; }
  name=$(basename "$path")
  sum=$(sha256sum "$path" | cut -d' ' -f1)

  recorded=$($PSQL --tuples-only --no-align \
    --command "SELECT sha256 FROM $LEDGER WHERE filename = '$name'")

  if [ -n "$recorded" ]; then
    if [ "$recorded" != "$sum" ]; then
      # Editing an applied migration in place means the database and the file no
      # longer agree. Refuse rather than guess which one is right.
      echo "apply-migrations: $name was applied with a different checksum." >&2
      echo "  database: $recorded" >&2
      echo "  file:     $sum" >&2
      echo "  Add a new migration file instead of editing an applied one." >&2
      exit 1
    fi
    echo "  = $name (already applied)"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  + $name (would apply)"
    applied=$((applied + 1))
    continue
  fi

  echo "  + $name"
  # Each file in ONE transaction: a failure leaves nothing behind, and the
  # ledger row is committed by the same transaction that applied the schema.
  $PSQL --single-transaction \
        --file "$path" \
        --command "INSERT INTO $LEDGER (filename, sha256) VALUES ('$name', '$sum');"
  applied=$((applied + 1))
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "apply-migrations: dry run — $applied to apply, $skipped already applied"
else
  echo "apply-migrations: $applied applied, $skipped skipped"
fi
