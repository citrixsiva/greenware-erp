-- =====================================================================
-- DEAL DESK — marketing permissions and the MARKETING role
--
-- 002_marketing.sql created 18 tables and 2 views for the HubSpot-modelled
-- marketing side, but no permissions: `leads`, `campaigns` and `activities`
-- were absent from the RBAC matrix, so the lead and campaign routes borrowed
-- `enquiries.*`. That had two consequences worth naming:
--   1. Marketing data was governed by sales permissions, so lead and contact
--      records were not scoped by a marketer's own ownership.
--   2. Nobody could work a lead without also holding the sales pipeline.
--
-- This migration closes both. The permission rows themselves are generated
-- from api/src/db/rbac-matrix.ts by the seed — that file stays the single
-- source of truth and the test suite asserts every allow and deny against it.
-- What is done HERE is only what the seed cannot do idempotently on an
-- already-populated database: create the role, and put Rock in it.
--
-- Safe to re-run.
-- =====================================================================

SET search_path = gw, public;

-- ---------------------------------------------------------------------
-- The role. `roles` is a master table, so a code that already exists is
-- left exactly as it is rather than overwritten.
-- ---------------------------------------------------------------------
INSERT INTO gw.roles (code, name, description)
VALUES ('MARKETING', 'Marketing',
        'Works the Deal Desk: campaigns, leads, scoring and the activity timeline. '
        'Reads customers and the enquiries its leads became, and no commercial figures.')
ON CONFLICT (code) DO NOTHING;

-- Who holds the role is NOT decided here. seed.ts assigns every other role
-- from PEOPLE/EXTRA_ROLES and is re-runnable, so putting Rock in MARKETING
-- there keeps one source of truth and works on a fresh database too — where
-- this migration runs before any user exists.

-- ---------------------------------------------------------------------
-- Scoring rules the Deal Desk ships with, so a new lead has a score for a
-- reason on day one rather than sitting at zero until someone configures it.
-- These are starting values, editable in the UI.
-- ---------------------------------------------------------------------
-- 002_marketing.sql already seeded nine rules (FIT_*, BEH_*). These are only
-- the gaps — data-completeness signals it had none of. Deliberately NOT added:
-- an "existing customer", "technology matched", "replied" or "attended an
-- event" rule, because FIT_EXISTING, FIT_TECH, BEH_REPLY and BEH_WEBINAR
-- already score exactly those. Two rules for one signal double-count it, and
-- a score that silently counts the same fact twice is worse than no score.
INSERT INTO gw.scoring_rules (code, name, dimension, condition, weight, is_active)
VALUES
  ('FIT_EMAIL',       'Contact email captured',       'Fit',
   '{"field":"email","op":"present"}'::jsonb,                                   5,  true),
  ('FIT_PHONE',       'Contact phone captured',       'Fit',
   '{"field":"phone","op":"present"}'::jsonb,                                   5,  true),
  ('FIT_SENIORITY',   'Contact is a decision maker',  'Fit',
   '{"field":"designation","op":"matches","value":"(?i)(ceo|cto|cio|cfo|director|head|manager|owner)"}'::jsonb, 15, true),
  ('FIT_VALUE',       'Estimated value over AED 100,000', 'Fit',
   '{"field":"estimated_value","op":"gte","value":100000}'::jsonb,              20, true),
  ('BEH_CONSENT',     'Opted in to marketing contact', 'Behaviour',
   '{"field":"consent_marketing","op":"eq","value":true}'::jsonb,               10, true)
ON CONFLICT (code) DO NOTHING;
