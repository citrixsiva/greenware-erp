# Security posture

Reviewed 2 November 2026 before first publication. What follows is the honest
state, including what is **not** yet fixed.

## Fixed before first commit

| # | Finding | Fix |
|---|---|---|
| 1 | **JWT secret fell back to a hardcoded literal** (`dev-only-secret-change-me`) present in the source. Anyone with a copy of the repo could mint a token for any user id — including SUPER_ADMIN — and read every supplier cost, selling price and margin. The entire RBAC and masking layer sat behind a published password. | `config.ts` now fails closed: production refuses to boot without `JWT_SECRET` (min 32 chars). Development generates a random secret per process, so there is no shared default worth knowing. `DATABASE_URL` is handled the same way. |
| 2 | **No root `.gitignore`.** `git add -A` staged `tok` (a bearer JWT) and would have staged any `.env` containing the real database password and JWT secret. `.dockerignore` listed them, but that only trims the Docker build context — it has no effect on git. | Root `.gitignore` added covering `.env*`, `tok`, keys, terraform state and runtime dirs. Verified: `git add -A -n` no longer stages either. |
| 3 | **Login timing enumerated valid accounts.** argon2 ran only when a matching user existed: ~213 ms for a real email against ~5 ms for an unknown one, a 40× gap that defeated the deliberately generic error message. | The unknown-email path now verifies against a decoy argon2 hash so both paths pay the same cost. Measured after the fix: 228 ms vs 219 ms. |
| 4 | **CORS reflected any origin** with `credentials: true`. | Pinned to a `CORS_ORIGINS` allowlist. |

## Known and NOT fixed — read before going live

**The application connects to PostgreSQL as a superuser, so row-level security
is bypassed entirely.** Access control is therefore app-layer only: every
protection depends on each handler remembering to AND `scopeSql` into its
query and to call `mask()` on the way out. A review found no handler that
forgets — but there is no second line of defence if one ever does.

The schema already creates `gw_app` and `gw_report` roles with the right
grants and revokes `DELETE` on the append-only tables. Closing this means:

1. Point `DATABASE_URL` at `gw_app` rather than `postgres`.
2. Set the `app.*` settings on read connections too, not only inside `tx()`
   (read paths currently never call `set_config`, so any RLS policy would
   deny every row).
3. Extend RLS policies beyond `enquiries` to `quotation_versions`,
   `supplier_quotes`, `cost_price_points`, `sell_price_points`, `customers`
   and `customer_pos`, with `FORCE ROW LEVEL SECURITY`.

This is defence in depth, not an active leak. It is the single most valuable
remaining hardening task and belongs in increment 2.

**One deliberate deviation from the field matrix:** the assigned approver of a
quotation sees its margin even when their role holds margin as own-only. The
reasoning is that being asked to approve a margin entitles you to see it.
It is intentional and commented in `quotation.ts`, but it deviates from the
matrix in `rbac.ts` and should get an explicit product sign-off.

## Data residency

OD-22 decided that UAE data stays in the UAE. **DigitalOcean has no UAE
region** — the nearest is Frankfurt. Hosting here was chosen deliberately to
get the system running; it parks that decision rather than closing it.
Before real customer pricing lands in production, either move to a provider
with a UAE region (Azure UAE North, AWS me-central-1) or formally revise
OD-22. It is a migration, not a rebuild — the schema and application are
portable.

## Reporting

Security issues: siva@greenware.ae. Do not open a public issue.
