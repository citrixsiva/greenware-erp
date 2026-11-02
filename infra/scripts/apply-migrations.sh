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
# CREATE POLICY all fail on a second run), so applied files are recorded in
# public.schema_migrations and skipped next time. The ledger lives in `public`
# because schema `gw` does not exist until 001_core.sql has run.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/db ./infra/scripts/apply-migrations.sh
#   ./infra/scripts/apply-migrations.sh --dry-run
#
# Against DigitalOcean Managed Postgres, DATABASE_URL must end in
# `?sslmode=require` and must be the doadmin URI: 001_core.sql issues
# CREATE EXTENSION and CREATE ROLE, which an ordinary database user cannot do.
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

$PSQL --command "
  SET client_min_messages = warning;
  CREATE TABLE IF NOT EXISTS public.schema_migrations (
    filename    text PRIMARY KEY,
    sha256      text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );" >/dev/null

applied=0
skipped=0

for path in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$path" ] || { echo "apply-migrations: no .sql files in $MIGRATIONS_DIR" >&2; exit 2; }
  name=$(basename "$path")
  sum=$(sha256sum "$path" | cut -d' ' -f1)

  recorded=$($PSQL --tuples-only --no-align \
    --command "SELECT sha256 FROM public.schema_migrations WHERE filename = '$name'")

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
        --command "INSERT INTO public.schema_migrations (filename, sha256) VALUES ('$name', '$sum');"
  applied=$((applied + 1))
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "apply-migrations: dry run — $applied to apply, $skipped already applied"
else
  echo "apply-migrations: $applied applied, $skipped skipped"
fi
