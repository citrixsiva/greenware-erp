# Greenware ERP — deployment

From a clean DigitalOcean account to a running system, in order. Nothing in this
document touches existing Greenware production: every command creates new,
separately-named resources inside a new DigitalOcean project called
`greenware-erp`.

Read [Before you start](#0-before-you-start-read-this-part) first. There is one
decision in it that no amount of configuration can work around.

---

## Contents

0. [Before you start — read this part](#0-before-you-start-read-this-part)
1. [What gets deployed](#1-what-gets-deployed)
2. [Region choice](#2-region-choice)
3. [Path A — run it locally with Docker Compose](#path-a--run-it-locally-with-docker-compose)
4. [Path B — Droplet + Managed Postgres (recommended)](#path-b--droplet--managed-postgres-recommended)
5. [Path C — App Platform](#path-c--app-platform)
6. [Secrets](#5-secrets)
7. [Migrations against Managed Postgres](#6-migrations-against-managed-postgres)
8. [Backup and restore — and the honest RTO/RPO position](#7-backup-and-restore--and-the-honest-rtorpo-position)
9. [What is NOT production-ready yet](#8-what-is-not-production-ready-yet)

---

## 0. Before you start — read this part

### DigitalOcean cannot satisfy the UAE data-residency decision

The project's own decision log records, from 13 September 2026:

> UAE data must stay in the UAE — hosting region is a hard constraint.

**DigitalOcean has no UAE region and no Middle East region of any kind.** Its
regions are in the United States, Canada, the Netherlands, Germany, the United
Kingdom, Singapore, India and Australia. There is no slug, no setting and no
configuration in this repository that makes a DigitalOcean deployment keep data
in the UAE. Choosing `fra1` means UAE commercial data, customer names, pricing
and contracts sit in Germany.

That is a decision for the business, not a detail for the deployment. The three
real options:

| Option | What it means |
|---|---|
| **Accept EU residency** | Deploy to `fra1`. Record that the 13 Sep decision was changed and why. Everything in this repository then works as written. |
| **Keep the UAE constraint** | DigitalOcean is out. The providers with a UAE region are Microsoft Azure (UAE North, Dubai; UAE Central, Abu Dhabi), AWS (me-central-1, UAE) and the local Core42/G42 clouds. The Dockerfiles and `docker-compose.yml` here port to any of them; `infra/terraform/` and `infra/do-app-spec.yaml` do not. |
| **Split** | Application on DigitalOcean, database in the UAE. Adds cross-region latency to every query and a second vendor. Rarely worth it. |

Everything below assumes the first option has been chosen deliberately. If it
has not, stop here and settle that first.

### Nothing here touches existing production

- `infra/terraform/` contains no `import` block and no data source that reads an
  existing droplet, database or VPC. Its only data sources look up SSH keys by
  name, which reads account metadata and changes nothing.
- Every resource is created inside a new DigitalOcean project (`project_name`,
  default `greenware-erp`) and a new VPC.
- The managed Postgres cluster carries `prevent_destroy = true`.
- Before applying anything, read the plan. `terraform plan` on a clean account
  should show **only creates and zero destroys**. If it shows a destroy, stop.

---

## 1. What gets deployed

```
                    Internet
                       │
                 443 / 80  (the only ports open in the cloud firewall)
                       │
            ┌──────────▼───────────┐
            │  Caddy on the host   │  TLS, Let's Encrypt, auto-renew
            └──────────┬───────────┘
                       │ 127.0.0.1:8081
            ┌──────────▼───────────┐
            │  web container       │  nginx (unprivileged, uid 101)
            │  - serves web/dist   │
            │  - proxies /api ─────┼────┐
            └──────────────────────┘    │ api:8080
                                        │
            ┌───────────────────────────▼──┐
            │  api container  (Fastify 5)  │  non-root, NODE_ENV=production
            │  volume: /app/storage        │  generated documents
            └───────────────┬──────────────┘
                            │ private VPC address, sslmode=require
            ┌───────────────▼──────────────┐
            │  DO Managed PostgreSQL 16    │  trusted sources: the droplet only
            └──────────────────────────────┘
```

**Why the SPA and the API must share one origin.** `web/src/lib/api.ts` calls
`/api/v1/...` with a relative path and has no base-URL setting. Serving
`web/dist` from a bucket or a different hostname does not work without changing
the client. Both the nginx config (`infra/nginx/web.conf.template`) and the App
Platform ingress rules exist to put them on one hostname.

### Files

| File | What it is |
|---|---|
| `docker-compose.yml` | Full local stack: postgres, migrations, api, web, optional seed |
| `infra/compose.managed-db.yml` | Overlay for a host using managed Postgres instead of the container |
| `Dockerfile` | Migration/ops image (psql 16 + `db/migrations` + the apply script) |
| `api/Dockerfile` | API production image; `tooling` target for seed/scripts |
| `web/Dockerfile` | SPA build; `dist` target for assets only, `runtime` for nginx |
| `infra/scripts/apply-migrations.sh` | The migration runner this repo otherwise does not have |
| `infra/nginx/web.conf.template` | The single-origin edge config |
| `infra/do-app-spec.yaml` | App Platform spec (Path C) |
| `infra/terraform/` | Droplet + managed Postgres + firewall + reserved IP (Path B) |
| `.github/workflows/ci.yml` | Typecheck, migrate, seed, test, build, image checks |

---

## 2. Region choice

**Recommended: `fra1` (Frankfurt)** — subject to section 0.

DigitalOcean publishes no latency figures, and the region list could not be
fetched while this was written, so treat the following as a stated assumption to
be measured, not a quoted fact:

| Region | Approx. distance from Dubai | Expected RTT from Dubai | Note |
|---|---|---|---|
| `fra1` Frankfurt | ~4,800 km | ~95–120 ms | Full feature parity, EU jurisdiction |
| `ams3` Amsterdam | ~5,200 km | ~105–130 ms | Equivalent to `fra1` |
| `lon1` London | ~5,500 km | ~115–140 ms | No Spaces |
| `blr1` Bangalore | ~2,700 km | ~45–70 ms | **Lowest latency**, Indian jurisdiction |
| `sgp1` Singapore | ~5,800 km | ~110–135 ms | No advantage over `fra1` |

`blr1` is the latency winner, not `fra1`, and it would also sit next to the
Trichy team. It is not the recommendation because it moves UAE customer
commercial data under Indian jurisdiction, which is a worse answer to the
residency question than the EU, and because the gap — roughly 50 ms of round
trip — does not matter much for a form-driven internal ERP. If someone measures
and disagrees, the region is one variable:

```bash
# Measure before committing. Run from a machine on the Dubai office network.
for r in fra1 ams3 lon1 blr1 sgp1; do
  printf '%-6s ' "$r"
  curl -s -o /dev/null -w '%{time_connect}s connect, %{time_total}s total\n' \
    "https://speedtest-${r}.digitalocean.com/"
done
```

Change `region` in `infra/terraform/terraform.tfvars` (and the Spaces endpoint
in `infra/terraform/versions.tf`, and `region:` in `infra/do-app-spec.yaml`,
where App Platform uses `fra` without the digit).

---

## Path A — run it locally with Docker Compose

For a laptop, a demo, or an on-premises box. No DigitalOcean account needed.

```bash
git clone <repo-url> greenware-erp && cd greenware-erp

cp .env.example .env
# Set at minimum:
#   POSTGRES_PASSWORD   openssl rand -base64 24
#   JWT_SECRET          openssl rand -hex 32
${EDITOR:-vi} .env

docker compose up -d --build
docker compose logs -f migrate     # must end "3 applied, 0 skipped"
```

Then open <http://localhost:8081> and sign in as `siva@greenware.ae` with the
`SEED_PASSWORD` from `.env`.

What that one command did, in order: started `postgres:16` on a named volume;
waited for it to accept **TCP** connections (not just the unix socket, which
would have let the next step run during `initdb`); applied
`001_core.sql`, `002_marketing.sql`, `003_fixes.sql` in that order, each in its
own transaction, recording each in `public.schema_migrations`; seeded reference
data and demo customers; started the API and waited for `/health`; started
nginx.

Useful afterwards:

```bash
docker compose ps                                   # health of each service
docker compose run --rm migrate --dry-run           # what would a new migration apply
docker compose down                                 # stop, keep data
docker compose down -v                              # stop and DELETE the database volume
```

The test suite runs against this stack with no extra configuration — the host
ports (`5433` for Postgres, `8080` for the API) are chosen to match the defaults
in `api/src/__tests__/env.ts` and `helpers.ts`:

```bash
npx tsx --test api/src/__tests__/*.test.ts
```

**Before this stack holds anything real:** remove `demo` from
`COMPOSE_PROFILES` in `.env`. The seed inserts the whole Greenware staff list
with one shared password.

---

## Path B — Droplet + Managed Postgres (recommended)

Recommended over App Platform for one concrete reason: **this application
writes files to local disk.** `api/src/modules/documents.ts` stores generated
quotation and RFQ documents under `DOCUMENT_STORE_DIR`. A droplet gives that a
real disk that survives restarts and is covered by daily droplet backups. App
Platform does not (see Path C).

### B.1 Prerequisites on your own machine

```bash
# DigitalOcean CLI
brew install doctl            # or: snap install doctl
doctl auth init               # paste a read+write personal access token

# Terraform >= 1.6
brew install terraform

# Confirm you are pointed at the right account, and look at what already exists
# so you can prove afterwards that none of it changed.
doctl account get
doctl compute droplet list
doctl databases list
doctl projects list
```

Add an SSH key to the account if there is not one already — Terraform looks keys
up by name and will not create one:

```bash
doctl compute ssh-key create "greenware-erp-ops" --public-key-file ~/.ssh/id_ed25519.pub
doctl compute ssh-key list
```

### B.2 Configure

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars
${EDITOR:-vi} terraform.tfvars
```

Set at least:

```hcl
region            = "fra1"
ssh_key_names     = ["greenware-erp-ops"]
ssh_allowed_cidrs = ["203.0.113.10/32"]   # the Dubai office egress IP
app_domain        = "erp.greenware.ae"
acme_email        = "it@greenware.ae"
alert_emails      = ["it@greenware.ae"]
```

`terraform.tfvars` is git-ignored. The API token is **not** put in it:

```bash
export DIGITALOCEAN_TOKEN="dop_v1_..."
```

### B.3 Plan and apply

```bash
terraform init
terraform plan -out tf.plan
```

**Read the plan.** On a clean account it must say `Plan: N to add, 0 to change,
0 to destroy`. Any destroy means Terraform has found state it did not create —
stop and work out why.

```bash
terraform apply tf.plan
```

This creates: a project, a VPC, a droplet (Ubuntu 24.04, Docker and Caddy
installed by cloud-init), a reserved IP, a cloud firewall allowing only 80, 443
and 22, a Managed PostgreSQL 16 cluster on the private network, a database, a
trusted-source rule admitting only the droplet, and a PgBouncer pool.

### B.4 Point DNS and verify the perimeter

```bash
terraform output reserved_ip
# Create an A record:  erp.greenware.ae -> that address
```

Then prove the database is closed:

```bash
doctl databases firewalls list "$(terraform output -raw project_id >/dev/null; \
  doctl databases list --format ID,Name --no-header | grep greenware-erp | cut -f1)"
```

It must list exactly one rule, of type `droplet`. If it lists anything else, or
nothing, the cluster is reachable from the internet with credentials alone.

### B.5 Deploy the application

```bash
ssh deploy@$(terraform output -raw reserved_ip)

sudo chown -R deploy:deploy /opt/greenware-erp
cd /opt/greenware-erp
git clone <repo-url> .

cp .env.example .env
```

Edit `.env` on the droplet. The bundled Postgres is not used here, so
`POSTGRES_*` is irrelevant; what matters is two URLs and the JWT secret:

```dotenv
# From your laptop:  terraform output -raw database_url_pooled
DATABASE_URL=postgres://doadmin:...@private-...:25061/api-pool?sslmode=require

# From your laptop:  terraform output -raw database_url_direct
DATABASE_URL_DIRECT=postgres://doadmin:...@private-...:25060/greenware?sslmode=require

JWT_SECRET=<openssl rand -hex 32>
COMPOSE_PROFILES=
```

Two URLs on purpose: migrations run DDL (`CREATE EXTENSION`, `CREATE ROLE`) and
must go to the cluster directly, not through PgBouncer.

```bash
cd /opt/greenware-erp
COMPOSE="docker compose -f docker-compose.yml -f infra/compose.managed-db.yml"

$COMPOSE run --rm migrate          # must end "3 applied, 0 skipped"
$COMPOSE up -d --build api web
$COMPOSE ps
curl -fsS http://127.0.0.1:8081/healthz-api
```

Then from anywhere: <https://erp.greenware.ae>.

### B.6 First user

The seed is demo data and must not be run against this cluster. Create the first
real account by hand — one user row, one Argon2 password hash in `gw.settings`
and one `SUPER_ADMIN` role, exactly as `api/src/db/seed.ts` does it:

```bash
# On the droplet. The tooling image carries tsx and the TypeScript sources.
$COMPOSE run --rm --entrypoint sh seed -c '
  node -e "
    const a=require(\"argon2\");
    a.hash(process.argv[1],{type:a.argon2id}).then(h=>console.log(h));
  " "<the password you chose>"'
```

Then insert the user, the `auth.local.<user-id>` setting holding that hash, the
`SUPER_ADMIN` role and an `employees` row with the Dubai calendar. Keep the
password out of your shell history.

### B.7 Updating later

```bash
cd /opt/greenware-erp && git pull
$COMPOSE run --rm migrate          # no-op when there is nothing new
$COMPOSE up -d --build api web
```

---

## Path C — App Platform

Faster to stand up, with a real limitation you must accept first.

**The container filesystem is ephemeral.** Every generated quotation and RFQ
document written to `DOCUMENT_STORE_DIR` is destroyed on every deploy and every
restart, and is not shared between instances — which is also why
`instance_count` must stay at 1 in `infra/do-app-spec.yaml`. The project's own
decision log says documents belong in object storage; until the application
writes to DigitalOcean Spaces instead of local disk, App Platform loses them.

If that is acceptable for a pilot:

```bash
# 1. Create the managed cluster first — the app spec references it by name and
#    does not create a dedicated cluster itself.
doctl databases create greenware-erp-pg \
  --engine pg --version 16 --region fra --size db-s-1vcpu-2gb --num-nodes 1

doctl databases db create <cluster-id> greenware

# 2. Point the spec at your repository.
${EDITOR:-vi} infra/do-app-spec.yaml      # replace every REPLACE_ME

# 3. Validate, then create.
doctl apps spec validate --spec infra/do-app-spec.yaml
doctl apps create --spec infra/do-app-spec.yaml

# 4. Set the real JWT secret out of band, so it is never in a committed file.
doctl apps update <app-id> --spec infra/do-app-spec.yaml
#    …then in the control panel: Settings > App-Level Environment Variables,
#    set JWT_SECRET and tick "Encrypt".
```

Notes that will cost you an afternoon if missed:

- `preserve_path_prefix: true` on the API ingress rule is required. App Platform
  strips the matched prefix by default, which turns `GET /api/v1/enquiries` into
  `GET /v1/enquiries` and produces a 404 from Fastify on every request.
- Migrations run as a `PRE_DEPLOY` job, before the new API version takes
  traffic. They are not idempotent, so running them from application start-up
  would race between instances.
- Binding the database to the app adds the app to the cluster's trusted sources
  automatically, so the cluster stays closed.
- If your account's builder rejects `dockerfile_path` on a static site, swap
  that component to the buildpack form:
  ```yaml
  build_command: cd web && npm ci && npm run build
  output_dir: web/dist
  ```

---

## 5. Secrets

Nothing secret is committed. `.env`, `infra/terraform/terraform.tfvars` and
`*.tfstate` are git-ignored, and CI asserts none of them are tracked.

| Secret | Generate with | Where it goes |
|---|---|---|
| `POSTGRES_PASSWORD` (Path A only) | `openssl rand -base64 24` | `.env` |
| `JWT_SECRET` | `openssl rand -hex 32` | `.env`, or App Platform encrypted env var |
| `DIGITALOCEAN_TOKEN` | DO control panel, read+write | shell environment only |
| Managed PG password | created by DigitalOcean | `terraform output -raw database_url_direct` |

Two traps:

1. **`api/src/core/config.ts` falls back to `'dev-only-secret-change-me'` when
   `JWT_SECRET` is unset.** The application starts happily with a publicly known
   signing key. `docker-compose.yml` refuses to start without one, and the App
   Platform spec sets one, but nothing in the application itself does.
2. **Terraform state holds the `doadmin` password in cleartext.** Keep it off
   laptops. `infra/terraform/versions.tf` has a commented S3 backend for a
   DigitalOcean Spaces bucket; create the bucket by hand, uncomment, then
   `terraform init -migrate-state`.

Rotating `JWT_SECRET` invalidates every issued token, so everyone is signed out.
It does not touch stored passwords.

---

## 6. Migrations against Managed Postgres

`api/package.json` declares `"migrate": "tsx src/db/migrate.ts"`, but
**`api/src/db/migrate.ts` does not exist** — that script fails. Use
`infra/scripts/apply-migrations.sh`, which is what the `Dockerfile` image,
`docker-compose.yml` and CI all run.

It applies `db/migrations/*.sql` in filename order, each file in a single
transaction with `ON_ERROR_STOP=1`, and records filename plus SHA-256 in
`public.schema_migrations`. Re-running is a no-op. Editing a migration that has
already been applied is refused rather than guessed at.

Why the ledger lives in `public` and not `gw`: schema `gw` does not exist until
`001_core.sql` has run.

```bash
# From anywhere, no checkout needed beyond the image:
docker build -t greenware-erp-migrate:local .

docker run --rm -e DATABASE_URL="$DIRECT_URL" greenware-erp-migrate:local --dry-run
docker run --rm -e DATABASE_URL="$DIRECT_URL" greenware-erp-migrate:local
```

Three things the URL must be:

1. **The `doadmin` URI.** `001_core.sql` runs `CREATE EXTENSION pgcrypto`,
   `pg_trgm`, `btree_gin` and `CREATE ROLE gw_app`. An ordinary database user
   cannot do either.
2. **`?sslmode=require`.** Managed clusters reject plaintext connections.
3. **Not the PgBouncer pool.** Port 25060 (the cluster), not 25061 (the pool).

Connectivity: the cluster's trusted sources admit only the droplet, so run the
migration from the droplet, not from a laptop. If you must run it from
elsewhere, tunnel rather than widening the firewall:

```bash
ssh -L 25060:<private-db-host>:25060 deploy@<reserved-ip>
# then use postgres://doadmin:...@127.0.0.1:25060/greenware?sslmode=require
```

Verify afterwards:

```sql
SELECT filename, applied_at FROM public.schema_migrations ORDER BY filename;
SELECT count(*) FROM pg_tables WHERE schemaname = 'gw';   -- expect 146
```

---

## 7. Backup and restore — and the honest RTO/RPO position

### What DigitalOcean Managed Postgres actually gives you

Backups are **always on** and cannot be configured from Terraform — their
absence from `infra/terraform/main.tf` is not an oversight and does not mean
they are off. The service takes a daily full backup and ships write-ahead logs
continuously, and offers point-in-time recovery within the retention window
(7 days on standard plans).

One thing to understand before you need it: **a restore creates a NEW cluster.**
DigitalOcean forks a cluster from the backup at the chosen timestamp. You cannot
roll a cluster back in place. Recovery therefore always includes a cutover —
new connection string, redeploy, verify.

### Against a 4-hour RTO and a 5-minute RPO

| Failure | RPO | RTO | Honest assessment |
|---|---|---|---|
| Postgres node failure, `db_node_count = 1` | up to ~24 h in the worst case (last backup) + WAL | **hours** | DigitalOcean replaces the node, but there is no standby to fail over to. Do not run production on 1 node. |
| Postgres node failure, `db_node_count >= 2` | near zero, **not** zero | minutes, automatic | Standby replication is **asynchronous**, so a failover can lose writes that had not yet reached the standby. Usually sub-second. Not a guarantee. |
| Accidental `DELETE`, bad migration, logical corruption | bounded by PITR granularity | **1–4 h if rehearsed** | Fork a new cluster to a timestamp, repoint `DATABASE_URL`, redeploy. Standby nodes do not help — the corruption replicates. |
| Whole-region loss | last daily backup | **days** | Backups live in the same region. There is no cross-region copy unless you build one. |
| Droplet loss | up to 24 h for the document store | 1–2 h | Rebuild from the daily droplet backup, or rebuild from Terraform and redeploy; generated documents since the last backup are gone. |

**The 5-minute RPO cannot be promised on DigitalOcean Managed Postgres.**
DigitalOcean does not publish an RPO, a WAL-shipping interval or a recovery-point
SLA for managed databases. In practice point-in-time recovery lands within the
last archived WAL segment — commonly well under five minutes of writes — but
"commonly" is not a commitment, and nothing in this repository can make it one.
If a 5-minute RPO has to be defensible in writing, there are two routes:

- Run Postgres yourself with your own WAL archiving (`archive_timeout = 60s`) to
  a Spaces bucket, which gives you a number you set and can test; you take on
  patching, failover and backup verification in exchange.
- Use a provider that publishes an RPO for its managed service.

**The 4-hour RTO is achievable but is not achieved by configuration.** It
depends on a rehearsed runbook. A restore nobody has practised takes longer than
four hours every time. Schedule a drill per section 7.3 and record the actual
elapsed time.

**The weakest link is not Postgres.** The generated-document store is on local
disk. On a droplet its RPO is up to 24 hours (the daily droplet backup); on App
Platform it has no backup at all. No database setting improves that — only
moving documents to object storage does.

### 7.1 Restore the database to a point in time

```bash
doctl databases list                      # note the source cluster id
doctl databases backups list <cluster-id>

# Fork to a moment just before the damage. Times are UTC.
doctl databases create greenware-erp-pg-restore \
  --engine pg --version 16 --region fra1 --size db-s-1vcpu-2gb --num-nodes 1 \
  --restore-from-cluster-name greenware-erp-prod-pg \
  --restore-from-timestamp 2026-11-02T09:15:00Z

# Readmit the droplet — a new cluster has no trusted sources.
doctl databases firewalls append <new-cluster-id> --rule droplet:<droplet-id>
```

Verify the fork **before** cutting over:

```bash
psql "$NEW_DIRECT_URL" -c "SELECT filename, applied_at FROM public.schema_migrations ORDER BY filename;"
psql "$NEW_DIRECT_URL" -c "SELECT max(occurred_at) FROM gw.audit_log;"   # how far forward it really goes
psql "$NEW_DIRECT_URL" -c "SELECT count(*) FROM gw.enquiries;"
```

Then cut over on the droplet:

```bash
cd /opt/greenware-erp
${EDITOR:-vi} .env                 # DATABASE_URL and DATABASE_URL_DIRECT -> the new cluster
$COMPOSE up -d api
curl -fsS http://127.0.0.1:8081/healthz-api
```

Keep the damaged cluster until the restore is confirmed good. Then move the
`cluster_name`/`prevent_destroy` state across in Terraform deliberately rather
than letting a later `apply` try to reconcile it.

### 7.2 Restore the generated-document store

```bash
doctl compute droplet backups list <droplet-id>
# Restore the whole droplet from a backup image, or create a droplet from it,
# attach, and copy /var/lib/docker/volumes/greenware-erp-docstore back.
```

### 7.3 Prove it, quarterly

A backup you have not restored is a hope. Once a quarter: fork the cluster to a
timestamp, point a scratch API at it, log in, open an enquiry, record the
elapsed wall-clock time, destroy the fork. If that number is over four hours,
the 4-hour RTO is not real yet and the gap needs fixing, not restating.

---

## 8. What is NOT production-ready yet

Ordered by how likely each is to hurt.

### Blocking — the build is red today

1. **The web client does not compile.** `web/src/App.tsx` imports
   `./pages/QuotationBuilder`, `./pages/PriceHistory`, `./pages/Approvals` and
   `./pages/Admin`. None of those files exist, so `npm -w web run build` fails
   with four `TS2307` errors, `web/Dockerfile` fails at the build stage, and CI
   fails at "Typecheck (web)". Nothing in this deployment setup can work around
   it. (The API typechecks clean, and all 468 API tests pass.)

2. **`npm ci` at the repository root fails.** The committed root
   `package-lock.json` covers only the `api` workspace; `web` carries its own
   `web/package-lock.json`. With both declared as workspaces, `npm ci` aborts
   with `Missing: @esbuild/win32-x64@0.21.5 from lock file`. CI, `api/Dockerfile`
   and `web/Dockerfile` each work around this and say so in a comment.
   **The fix is one command:** `npm install` at the root, then commit
   `package-lock.json` — after which three workarounds can be deleted.

3. **`api/src/db/migrate.ts` does not exist** although `api/package.json`
   declares a `migrate` script pointing at it.
   `infra/scripts/apply-migrations.sh` fills the gap, but the broken script
   should either be removed or made to call it.

### Security

4. **Row-level security is enabled but not in force.** `001_core.sql` runs
   `ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY` and then creates only a
   `FOR SELECT` policy for `gw_app`. With RLS on and no INSERT or UPDATE policy,
   `gw_app` **cannot write to `gw.enquiries` at all**. The application therefore
   has to connect as the schema owner (`doadmin` / `postgres`), and a table
   owner bypasses RLS entirely. The "defence in depth" the comment describes is
   not actually protecting anything in a deployed system. Either add INSERT and
   UPDATE policies and move the application to `gw_app`, or drop the claim.

5. **`JWT_SECRET` has a working default.** `api/src/core/config.ts` falls back to
   `'dev-only-secret-change-me'`. The server should refuse to start in
   production without a real one; today it starts and signs tokens.

6. **CORS reflects any origin with credentials.** `api/src/server.ts` registers
   `cors` with `{ origin: true, credentials: true }`. Behind the single-origin
   setup here that is not immediately exploitable, but it should be an allow-list.

7. **A JWT is committed at the repository root.** The file `tok` contains a
   signed token. Delete it and add it to `.gitignore`; rotate `JWT_SECRET` if
   that token was ever issued against a real environment.

8. **No rate limiting and no brute-force protection on `/api/v1/auth/login`.**
   `@fastify/rate-limit` is not a dependency.

9. **The seed inserts real staff emails with one shared password.** It is behind
   the `demo` compose profile and the `--demo` flag, but there is nothing
   stopping someone running it against production.

### Operations

10. **Generated documents are on local disk.** `DOCUMENT_STORE_DIR` in
    `api/src/modules/documents.ts`. This is why the API cannot be scaled past
    one instance, why App Platform loses them, and why the document store's RPO
    is 24 hours instead of minutes. The decision log already says object storage;
    the code does not do it yet.

11. **Audit partition maintenance is never scheduled.** `003_fixes.sql` provides
    `gw.ensure_audit_partitions()` and the migration runs it once for 24 months
    ahead. Nothing calls it again. From late 2028, audit rows fall into the
    DEFAULT partition — which `003` thankfully created, so writes do not fail,
    but the partitioning stops doing its job. Needs a monthly job.

12. **No log aggregation, metrics or error tracking.** The API logs JSON to
    stdout and Docker rotates it on the droplet. There is no alert on a 500
    rate, no APM, no uptime check from outside. The only alerts configured are
    droplet CPU/disk/memory, and only if `alert_emails` is set.

13. **The restore path has never been executed.** Section 7.3 exists; nobody has
    run it. Until someone has, the 4-hour RTO is an aspiration.

14. **No staging environment.** `infra/terraform` takes an `environment`
    variable but only one has been applied. Migrations reaching production
    without having first run anywhere else is a risk on a schema this size.

15. **`terraform fmt` and `terraform validate` have never been run against
    `infra/terraform/`.** No Terraform binary was available where these files
    were written — `releases.hashicorp.com` and `registry.terraform.io` were
    both blocked — so the HCL has been checked for syntax only, not against the
    DigitalOcean provider schema. Resource arguments, attribute names and
    instance-size slugs are from documentation knowledge and may have drifted.
    **Run `terraform init && terraform validate` before trusting the plan**, and
    expect the first `terraform fmt -check` in CI to want cosmetic changes.

16. **The Docker images have never been built.** No Docker daemon was available.
    `docker compose config` parses and every stage has been reasoned through
    (including confirming that `argon2` ships a musl prebuild, so no build
    toolchain is needed), but the first `docker compose up --build` is the first
    real test. CI builds all three images on every push, which is where that gap
    closes.

### Not started

17. **Entra ID / Microsoft 365 SSO.** `ENTRA_ENABLED` is wired through config
    but the app registration does not exist. Local password login is the only
    working path.
18. **Email and Teams alerting**, which the requirements call for.
19. **Migration of 3 years of GW_Sales history**, and retirement of that system.
20. **TLS is only configured when `app_domain` is set.** With it empty, Caddy
    serves plain HTTP on port 80 and nothing warns you at runtime.
