# =============================================================================
# Greenware ERP — database migration / ops image  (the repo's default image)
#
#     docker build -t greenware-erp-migrate:local .
#
# This is NOT the API (see api/Dockerfile) and NOT the web client
# (see web/Dockerfile). It exists because the repo has no migration runner:
# api/package.json declares `"migrate": "tsx src/db/migrate.ts"` but
# api/src/db/migrate.ts does not exist. This image carries psql 16 and the three
# migrations, and applies them in order exactly once — the same image is used by
# the `migrate` service in docker-compose.yml, on the droplet, and against
# DigitalOcean Managed Postgres.
#
# Apply to a managed cluster from anywhere:
#     docker run --rm \
#       -e DATABASE_URL="postgres://doadmin:...@...ondigitalocean.com:25060/greenware?sslmode=require" \
#       greenware-erp-migrate:local
#
# Show what would run, change nothing:
#     docker run --rm -e DATABASE_URL=... greenware-erp-migrate:local --dry-run
# =============================================================================

FROM postgres:16-alpine AS runtime

ENV NODE_ENV=production \
    MIGRATIONS_DIR=/migrations \
    PGCONNECT_TIMEOUT=10

# Carried read-only. Changing a migration after it has been applied is refused
# by the checksum guard in apply-migrations.sh.
COPY --chown=root:root db/migrations/ /migrations/
COPY --chown=root:root infra/scripts/apply-migrations.sh /usr/local/bin/apply-migrations
RUN chmod 0755 /usr/local/bin/apply-migrations && chmod -R a-w /migrations

# The postgres base image already provides an unprivileged `postgres` user
# (uid 70). Nothing here needs root, and no server runs in this container.
USER postgres

# Overrides the base image's docker-entrypoint.sh — this container never starts
# a Postgres server, it only connects to one.
ENTRYPOINT ["/usr/local/bin/apply-migrations"]
