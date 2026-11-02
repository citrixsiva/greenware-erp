# Greenware ERP

One system for the enquiry-to-cash cycle of an IT system integrator: enquiry →
technical and procurement estimation → quotation → customer PO → project
delivery → sign-off → invoice → collection → realised margin, with the sales
and marketing functions that feed it.

Replaces three disconnected Excel workbooks whose only shared key was the
customer's name.

## Status

**Increments 0 and 1 of nine.** Running, tested, and usable for the pre-sales
cycle. Increments 2–8 (order & delivery, procure-to-pay, order-to-cash,
reporting, alerting, contracts, migration) are specified in the blueprint and
not yet built. See `docs/` and the tender pack for the full roadmap.

- 146 database tables, 5 views, 3 migrations
- ~7,500 lines of API across 8 route modules
- 468 tests, all passing
- React web client: pipeline board, enquiry 360, quotation builder with the
  margin gate, procurement comparison, estimation, approvals, price history, admin

## What makes this different from a generic CRM

**Field-level permissions are the product.** Two people open the same
quotation and legitimately see different numbers:

| Role | Sees on a quotation |
|---|---|
| Sales | selling price, margin, gross profit — **never supplier cost** |
| Procurement | **supplier cost only** — never selling price or margin |
| Technical | no access |
| Director / Accounts | everything |

A masked field is **absent from the API payload**, not returned and hidden by
the client. Scope is ANDed into the SQL `WHERE` clause before pagination, so
an out-of-scope record returns 404 rather than revealing that it exists.

**Commercial history is append-only.** Every supplier quote line writes an
immutable cost price point; every approved quotation version writes sell price
points. No application role holds `DELETE` on either, or on the audit log.
Correction is by superseding, never overwriting.

**Margin is measured three times** — quoted, booked at PO, realised at close —
so the gap between what was promised and what was earned is attributable to
discounting or to delivery overrun rather than being a single unexplained number.

## Run it locally

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and JWT_SECRET
docker compose up -d --build
open http://localhost:8081
```

Start order is enforced: postgres (healthy) → migrate (exits 0) → api
(healthy) → web.

### Without Docker

```bash
npm install
export DATABASE_URL='postgres://postgres:PASSWORD@127.0.0.1:5432/greenware'
export JWT_SECRET="$(openssl rand -base64 48)"
npm -w api run migrate        # ordered, checksummed, recorded in public.schema_migrations
npm -w api run seed -- --demo # 33 staff, the real SBU structure, demo customers
npm -w api run dev            # :8080
npm -w web run dev            # :5173
```

Seed users are the real org — `siva@`, `chockas@`, `naveen@`, `bineesh@`,
`thousif@`, `sangeetha@`, `kumar@` … all `@greenware.ae`. Default seed
password is `Greenware#2026`; override with `SEED_PASSWORD`. **Change it
before any deployment.**

Log in as `bineesh@` and then `naveen@` and open the same quotation — the
difference in what each can see is the point of the system.

## Tests

```bash
npm -w api run test
```

468 tests. They are **not** unit tests: they need postgres, the three
migrations, a `--demo` seed and a live API on `:8080`, in that order. CI does
exactly that sequence. The suite includes the RBAC matrix as executable
fixtures with a negative test for every denial, margin and TAT calculation
fixtures, and the workflow gate tests (a project cannot close without
sign-off; a submitted quotation version cannot be edited; an approver cannot
approve their own record).

## Deploy

DigitalOcean, two paths — `docs/DEPLOYMENT.md` has the trade-offs:

- `infra/terraform/` — droplet + managed Postgres. **Recommended.** Generated
  documents get a real disk.
- `infra/do-app-spec.yaml` — App Platform. Faster, but the container
  filesystem is ephemeral and generated quotation PDFs are lost on every
  deploy and restart.

Neither touches existing Greenware production: its own app, its own database
cluster, its own DigitalOcean project.

**Read `SECURITY.md` before exposing this to the internet.** It lists what was
fixed, and the one significant hardening task that is not done.

## Layout

```
api/     Fastify + TypeScript. core/ is the engine (rbac, audit, sla, db,
         numbering); modules/ is one Fastify plugin per domain.
web/     React + TypeScript + Vite.
db/      Three SQL migrations. 001 core, 002 marketing, 003 defect fixes.
infra/   Terraform, App Platform spec, nginx, migration script.
docs/    CONVENTIONS.md (read before writing code), DEPLOYMENT.md.
```

`docs/CONVENTIONS.md` states three non-negotiables — permission first, scope
in the query, mask on the way out. Every handler follows them. A review of all
~7,500 lines found no handler that does not.

## Decisions this encodes

Thirty-seven commercial and technical decisions were settled before the build.
The ones visible in the code: Greenware Technologies LLC is the only invoicing
entity; margin splits are 80/20 to Sales on product and 20/80 to Technical on
services, with renewals 50% to Sales and 50% retained by the company; the
hard margin floor is 3% with per-type warning thresholds above it; Dubai hours
and holidays govern every SLA clock; Abdul is one person in two SBUs; Patch
Management belongs to SBU 4.

Each is commented at the point it is implemented, with its OD number.
