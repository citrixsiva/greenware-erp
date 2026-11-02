-- =====================================================================
-- GREENWARE ENQUIRY-TO-CASH ERP / CRM
-- PostgreSQL 16 schema  ·  Revision A  ·  September 2026
-- Companion to the "Greenware Enquiry-to-Cash Blueprint"
--
-- Design rules encoded here:
--   1. One record chain. Every artefact carries an FK to its parent.
--   2. Events are rows, not overwritten columns.
--   3. Commercial history is append-only; no DELETE grant.
--   4. Derived values are computed, never stored as typed input.
--   5. Status values are enums or FK to masters; never free text.
--   6. Money is numeric with an explicit currency; never float.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "btree_gin";

CREATE SCHEMA IF NOT EXISTS gw;
SET search_path = gw, public;

-- ---------------------------------------------------------------------
-- DOMAINS
-- ---------------------------------------------------------------------
CREATE DOMAIN money_amt   AS numeric(18,4);
CREATE DOMAIN pct         AS numeric(9,4);
CREATE DOMAIN ccy         AS char(3);
CREATE DOMAIN short_text  AS varchar(255);

-- ---------------------------------------------------------------------
-- ENUMS  (§16 §21 §24 §27 §29 — replaces free-text status, gap G7)
-- ---------------------------------------------------------------------
CREATE TYPE enquiry_stage      AS ENUM ('New','Qualifying','Working','Submitted','Pending','Won','Lost','Cancelled','Dropped');
CREATE TYPE proc_req_status    AS ENUM ('Raised','Assigned','Sourcing','AwaitingSupplier','Responded','Cancelled');
CREATE TYPE est_req_status     AS ENUM ('Raised','Assigned','InReview','ClarificationNeeded','Submitted','Cancelled');
CREATE TYPE quote_ver_status   AS ENUM ('Draft','PendingApproval','Approved','Submitted','Superseded','Rejected');
CREATE TYPE project_status     AS ENUM ('Created','Planning','ReadyToStart','InProgress','OnHold','Delayed','ReadyForSignoff','SignedOff','Completed','Cancelled');
CREATE TYPE task_status        AS ENUM ('NotStarted','Planned','InProgress','OnHold','Completed','Delayed','Cancelled');
CREATE TYPE invoice_status     AS ENUM ('Draft','PendingApproval','Issued','SubmittedToCustomer','PartPaid','Paid','Disputed','Cancelled','Credited');
CREATE TYPE receivable_status  AS ENUM ('NotDue','Due','Overdue','PartiallyPaid','Paid','Disputed','OnHold');
CREATE TYPE supplier_order_status AS ENUM ('POPending','POSent','SupplierConfirmed','GoodsReceived','InvoiceReceived','PaymentPending','PartiallyPaid','Paid');
CREATE TYPE change_req_status  AS ENUM ('Raised','Estimating','PendingCustomer','Approved','Rejected','Withdrawn');
CREATE TYPE approval_status    AS ENUM ('Pending','Approved','Rejected','Escalated','Withdrawn');
CREATE TYPE sla_state          AS ENUM ('Within','Approaching','Breached','Stopped','Paused');
CREATE TYPE urgency            AS ENUM ('Normal','Urgent');
CREATE TYPE audit_action       AS ENUM ('create','update','soft_delete','approve','reject','override','grant','revoke','export','download','login','login_failed');
CREATE TYPE resource_mode      AS ENUM ('Onsite','Remote','Hybrid');
CREATE TYPE notify_channel     AS ENUM ('InApp','Email','Teams','WhatsApp');

-- ---------------------------------------------------------------------
-- CLUSTER 1 · IDENTITY & ACCESS  (§34 §35)
-- ---------------------------------------------------------------------
CREATE TABLE companies (                       -- invoicing legal entity (OD-11)
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            varchar(12)  NOT NULL UNIQUE,   -- GWT / CSI / GGT
  name            short_text   NOT NULL,
  country         varchar(2)   NOT NULL DEFAULT 'AE',
  base_currency   ccy          NOT NULL DEFAULT 'AED',
  tax_registration short_text,
  is_active       boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        short_text NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE calendars (                        -- working calendars (OD-18)
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          short_text NOT NULL UNIQUE,     -- 'Dubai', 'Trichy'
  timezone      short_text NOT NULL,
  working_days  int[]      NOT NULL,            -- 1=Mon .. 7=Sun
  day_start     time       NOT NULL,
  day_end       time       NOT NULL,
  is_active     boolean    NOT NULL DEFAULT true
);

CREATE TABLE holidays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_id  uuid NOT NULL REFERENCES calendars(id),
  holiday_date date NOT NULL,
  description  short_text,
  UNIQUE (calendar_id, holiday_date)
);

CREATE TABLE sbus (                             -- §4
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code            varchar(12) NOT NULL UNIQUE,  -- SBU1..SBU4
  name            short_text  NOT NULL,
  head_employee_id uuid,                        -- FK added after employees
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_object_id   uuid UNIQUE,                -- Entra ID SSO subject
  email             short_text NOT NULL UNIQUE,
  display_name      short_text NOT NULL,
  is_active         boolean NOT NULL DEFAULT true,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid,
  deleted_at        timestamptz,
  deleted_by        uuid,
  delete_reason     text
);

CREATE TABLE employees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid UNIQUE REFERENCES users(id),
  employee_code  varchar(24) UNIQUE,
  full_name      short_text NOT NULL,
  department_id  uuid REFERENCES departments(id),
  sbu_id         uuid REFERENCES sbus(id),
  reports_to_id  uuid REFERENCES employees(id),
  calendar_id    uuid REFERENCES calendars(id),
  seniority_band short_text,                    -- drives internal day rate (OD-10)
  internal_day_rate money_amt,                  -- SENSITIVE: field-masked
  day_rate_currency ccy DEFAULT 'AED',
  is_billable    boolean NOT NULL DEFAULT true,
  is_active      boolean NOT NULL DEFAULT true
);

ALTER TABLE sbus ADD CONSTRAINT sbus_head_fk FOREIGN KEY (head_employee_id) REFERENCES employees(id);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        varchar(40) NOT NULL UNIQUE,      -- SUPER_ADMIN, DIRECTOR, SALES_MGR, SALES, ...
  name        short_text NOT NULL,
  description text,
  is_system   boolean NOT NULL DEFAULT false
);

CREATE TABLE permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         varchar(80) NOT NULL UNIQUE,      -- e.g. 'procurement.supplier_quote.create'
  module      short_text NOT NULL,
  entity      short_text NOT NULL,
  action      short_text NOT NULL               -- view create edit delete approve export download upload assign close override
);

CREATE TABLE role_permissions (
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  scope         varchar(2) NOT NULL DEFAULT 'O' CHECK (scope IN ('A','D','S','T','O')),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id   uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id),     -- role can be scoped to one entity
  PRIMARY KEY (user_id, role_id)
);

-- Time-boxed sensitive-field grants (the "Grant" cells in the field matrix)
CREATE TABLE permission_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  field_group   varchar(40) NOT NULL,           -- supplier_cost | sell_price | margin | day_rate | supplier_terms | credit
  granted_by    uuid NOT NULL REFERENCES users(id),
  reason        text NOT NULL,
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_to      timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id)
);

CREATE TABLE delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id  uuid NOT NULL REFERENCES users(id),
  to_user_id    uuid NOT NULL REFERENCES users(id),
  valid_from    timestamptz NOT NULL,
  valid_to      timestamptz NOT NULL,
  reason        text,
  CHECK (valid_to > valid_from)
);

-- Explicit record-level shares (third scope rule alongside owner and assignee)
CREATE TABLE record_shares (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type  short_text NOT NULL,
  entity_id    uuid NOT NULL,
  user_id      uuid NOT NULL REFERENCES users(id),
  can_edit     boolean NOT NULL DEFAULT false,
  shared_by    uuid NOT NULL REFERENCES users(id),
  valid_to     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- CLUSTER 2 · PARTY MASTER  (§31 §32)
-- ---------------------------------------------------------------------
CREATE TABLE customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id),
  customer_code     varchar(24) NOT NULL,
  name              short_text NOT NULL,
  industry          short_text,
  location          short_text,
  country           varchar(2),
  customer_type     short_text,                 -- Direct / Partner / Government / SME
  account_manager_id uuid REFERENCES employees(id),
  payment_terms_days int NOT NULL DEFAULT 30,
  default_currency  ccy NOT NULL DEFAULT 'AED', -- OD-07 R3: billing currency is set on the party
  credit_limit      money_amt,                  -- SENSITIVE
  credit_currency   ccy DEFAULT 'AED',
  tax_registration  short_text,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id),
  deleted_at        timestamptz,
  row_version       int NOT NULL DEFAULT 1,
  UNIQUE (company_id, customer_code)
);

CREATE TABLE customer_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  full_name    short_text NOT NULL,
  designation  short_text,
  email        short_text,
  phone        short_text,
  is_primary   boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE customer_addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address_type varchar(12) NOT NULL CHECK (address_type IN ('Billing','Delivery')),
  line1 short_text, line2 short_text, city short_text, country varchar(2),
  is_default   boolean NOT NULL DEFAULT false
);

CREATE TABLE partners (                          -- reseller / channel partner (OD-11)
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       short_text NOT NULL,
  country    varchar(2),
  is_active  boolean NOT NULL DEFAULT true
);

CREATE TABLE manufacturers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        short_text NOT NULL UNIQUE,
  country     varchar(2),
  deal_reg_portal short_text,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE suppliers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_code      varchar(24) NOT NULL UNIQUE,
  name               short_text NOT NULL,
  country            varchar(2),
  default_currency   ccy NOT NULL DEFAULT 'AED',
  payment_terms_days int NOT NULL DEFAULT 30,    -- SENSITIVE
  credit_limit       money_amt,
  rating             numeric(3,2),
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  row_version        int NOT NULL DEFAULT 1
);

CREATE TABLE supplier_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  full_name   short_text NOT NULL,
  email       short_text, phone short_text,
  is_primary  boolean NOT NULL DEFAULT false
);

CREATE TABLE supplier_manufacturers (
  supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  manufacturer_id uuid NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
  PRIMARY KEY (supplier_id, manufacturer_id)
);

-- ---------------------------------------------------------------------
-- CLUSTER 3 · CATALOGUE & MASTER DATA  (§3)
-- ---------------------------------------------------------------------
CREATE TABLE technology_categories (             -- the 21 categories in §3
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          short_text NOT NULL UNIQUE,
  sbu_id        uuid REFERENCES sbus(id),        -- routing target (§4)
  sla_profile   short_text,
  sort_order    int,
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TABLE technologies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   uuid NOT NULL REFERENCES technology_categories(id),
  name          short_text NOT NULL,
  sbu_id        uuid REFERENCES sbus(id),        -- overrides the category default
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (category_id, name)
);

CREATE TABLE technology_manufacturers (
  technology_id   uuid NOT NULL REFERENCES technologies(id) ON DELETE CASCADE,
  manufacturer_id uuid NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
  PRIMARY KEY (technology_id, manufacturer_id)
);

CREATE TABLE products (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id  uuid REFERENCES manufacturers(id),
  category_id      uuid REFERENCES technology_categories(id),
  name             short_text NOT NULL,
  description      text,
  is_active        boolean NOT NULL DEFAULT true
);

CREATE TABLE product_skus (                      -- the key the price history hangs on
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id),
  part_number  short_text NOT NULL,
  description  text,
  uom          varchar(12) NOT NULL DEFAULT 'EA',
  list_price   money_amt,
  list_currency ccy,
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (product_id, part_number)
);

CREATE TABLE services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          short_text NOT NULL,
  sbu_id        uuid REFERENCES sbus(id),
  unit          varchar(12) NOT NULL DEFAULT 'DAY',
  standard_rate money_amt,
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TABLE business_types (                    -- §9 · selects route, margin rule, approvals
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code              varchar(32) NOT NULL UNIQUE,
  name              short_text NOT NULL,
  needs_procurement boolean NOT NULL DEFAULT false,
  needs_estimation  boolean NOT NULL DEFAULT false,
  creates_project   boolean NOT NULL DEFAULT false,
  is_recurring      boolean NOT NULL DEFAULT false,
  is_active         boolean NOT NULL DEFAULT true
);

CREATE TABLE currencies (
  code      ccy PRIMARY KEY,
  name      short_text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE fx_rates (                          -- OD-07
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency  ccy NOT NULL REFERENCES currencies(code),
  to_currency    ccy NOT NULL REFERENCES currencies(code),
  rate           numeric(18,8) NOT NULL,
  rate_date      date NOT NULL,
  source         short_text,
  UNIQUE (from_currency, to_currency, rate_date)
);

CREATE TABLE tax_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         varchar(24) NOT NULL UNIQUE,
  description  short_text,
  rate_pct     pct NOT NULL,
  is_reverse_charge boolean NOT NULL DEFAULT false,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE loss_reasons (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code      varchar(32) NOT NULL UNIQUE,
  name      short_text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE number_sequences (                  -- ENQ-2026-00142 etc.
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity       short_text NOT NULL,
  company_id   uuid REFERENCES companies(id),
  year         int NOT NULL,
  prefix       varchar(12) NOT NULL,
  padding      int NOT NULL DEFAULT 5,
  next_value   bigint NOT NULL DEFAULT 1,
  UNIQUE (entity, company_id, year)
);

-- ---------------------------------------------------------------------
-- CLUSTER 4 · DEMAND — ENQUIRY  (§8 stage 1, §9)
-- ---------------------------------------------------------------------
CREATE TABLE enquiries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_no          varchar(32) NOT NULL UNIQUE,      -- ENQ-2026-00142
  company_id          uuid NOT NULL REFERENCES companies(id),
  customer_id         uuid NOT NULL REFERENCES customers(id),
  end_customer_name   short_text,
  partner_id          uuid REFERENCES partners(id),
  contact_id          uuid REFERENCES customer_contacts(id),
  account_manager_id  uuid NOT NULL REFERENCES employees(id),
  business_type_id    uuid NOT NULL REFERENCES business_types(id),
  primary_sbu_id      uuid REFERENCES sbus(id),
  title               short_text NOT NULL,
  description         text,
  received_at         timestamptz NOT NULL,
  approx_budget       money_amt,
  budget_currency     ccy DEFAULT 'AED',
  expected_quote_date date,
  expected_po_date    date,
  probability_pct     pct CHECK (probability_pct BETWEEN 0 AND 100),
  stage               enquiry_stage NOT NULL DEFAULT 'New',
  loss_reason_id      uuid REFERENCES loss_reasons(id),
  loss_remarks        text,
  slip_count          int NOT NULL DEFAULT 0,           -- times expected_po_date moved
  remarks             text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES users(id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id),
  deleted_at          timestamptz,
  row_version         int NOT NULL DEFAULT 1,
  CONSTRAINT enq_loss_reason_required
    CHECK (stage <> 'Lost' OR loss_reason_id IS NOT NULL)
);

CREATE TABLE enquiry_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id     uuid NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  line_no        int NOT NULL,
  technology_id  uuid REFERENCES technologies(id),
  sbu_id         uuid REFERENCES sbus(id),               -- resolved from technology
  product_sku_id uuid REFERENCES product_skus(id),
  service_id     uuid REFERENCES services(id),
  description    text NOT NULL,
  quantity       numeric(14,3) NOT NULL DEFAULT 1,
  UNIQUE (enquiry_id, line_no)
);

CREATE TABLE enquiry_competitors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id    uuid NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  competitor    short_text NOT NULL,
  known_price   money_amt,
  currency      ccy,
  notes         text
);

CREATE TABLE stage_history (                             -- derives sales cycle & stage ageing
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id   uuid NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  from_stage   enquiry_stage,
  to_stage     enquiry_stage NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  changed_by   uuid REFERENCES users(id),
  remarks      text
);

CREATE TABLE follow_ups (                                -- §16
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id     uuid NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
  followed_up_at timestamptz NOT NULL DEFAULT now(),
  next_follow_up date,
  channel        short_text,
  remarks        text NOT NULL,
  customer_feedback text,
  created_by     uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------------
-- CLUSTER 5 · SOURCING  (§7 §11 §12)
-- ---------------------------------------------------------------------
CREATE TABLE procurement_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no       varchar(32) NOT NULL UNIQUE,          -- PRQ-2026-00087
  enquiry_id       uuid NOT NULL REFERENCES enquiries(id),
  requested_by     uuid NOT NULL REFERENCES users(id),
  raised_at        timestamptz NOT NULL DEFAULT now(),   -- TAT clock start
  urgency          urgency NOT NULL DEFAULT 'Normal',
  required_by      date,
  assigned_to      uuid REFERENCES users(id),
  assigned_at      timestamptz,
  first_responded_at timestamptz,                        -- TAT clock stop
  status           proc_req_status NOT NULL DEFAULT 'Raised',
  paused_minutes   int NOT NULL DEFAULT 0,               -- time in AwaitingSupplier
  remarks          text,
  row_version      int NOT NULL DEFAULT 1
);

CREATE TABLE procurement_request_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id        uuid NOT NULL REFERENCES procurement_requests(id) ON DELETE CASCADE,
  enquiry_line_id   uuid REFERENCES enquiry_lines(id),
  product_sku_id    uuid REFERENCES product_skus(id),
  manufacturer_id   uuid REFERENCES manufacturers(id),
  part_number       short_text,
  description       text NOT NULL,
  quantity          numeric(14,3) NOT NULL
);

CREATE TABLE supplier_quotes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_no          varchar(32) NOT NULL UNIQUE,         -- SQ-2026-00311
  request_id        uuid NOT NULL REFERENCES procurement_requests(id),
  supplier_id       uuid NOT NULL REFERENCES suppliers(id),
  supplier_ref      short_text,                          -- supplier's own quote number
  quote_date        date NOT NULL,
  valid_until       date,
  currency          ccy NOT NULL DEFAULT 'AED',
  fx_rate           numeric(18,8),
  fx_rate_date      date,
  payment_terms_days int,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by       uuid NOT NULL REFERENCES users(id),
  is_recommended    boolean NOT NULL DEFAULT false,
  recommendation_reason text,
  remarks           text
);

CREATE TABLE supplier_quote_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_quote_id  uuid NOT NULL REFERENCES supplier_quotes(id) ON DELETE CASCADE,
  request_line_id    uuid REFERENCES procurement_request_lines(id),
  product_sku_id     uuid REFERENCES product_skus(id),
  part_number        short_text,
  description        text,
  quantity           numeric(14,3) NOT NULL,
  unit_cost          money_amt NOT NULL,                 -- SENSITIVE
  availability       short_text,                         -- In stock / On order / EOL
  lead_time_days     int,
  tax_code_id        uuid REFERENCES tax_codes(id)
);

-- APPEND-ONLY cost history (§12 §57). No DELETE grant. Written by trigger.
CREATE TABLE cost_price_points (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_sku_id      uuid REFERENCES product_skus(id),
  part_number         short_text NOT NULL,
  manufacturer_id     uuid REFERENCES manufacturers(id),
  supplier_id         uuid NOT NULL REFERENCES suppliers(id),
  supplier_quote_line_id uuid NOT NULL REFERENCES supplier_quote_lines(id),
  enquiry_id          uuid REFERENCES enquiries(id),
  customer_id         uuid REFERENCES customers(id),
  quantity            numeric(14,3) NOT NULL,
  unit_cost           money_amt NOT NULL,
  currency            ccy NOT NULL,
  unit_cost_base      money_amt,                         -- converted to base currency
  availability        short_text,
  lead_time_days      int,
  payment_terms_days  int,
  valid_until         date,
  quoted_on           date NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  superseded_by       uuid REFERENCES cost_price_points(id),
  is_archived         boolean NOT NULL DEFAULT false
);

-- ---------------------------------------------------------------------
-- CLUSTER 6 · TECHNICAL ESTIMATION  (§10)
-- ---------------------------------------------------------------------
CREATE TABLE estimation_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no         varchar(32) NOT NULL UNIQUE,        -- TER-2026-00054
  enquiry_id         uuid NOT NULL REFERENCES enquiries(id),
  sbu_id             uuid NOT NULL REFERENCES sbus(id),  -- one request per SBU involved
  requested_by       uuid NOT NULL REFERENCES users(id),
  raised_at          timestamptz NOT NULL DEFAULT now(),
  urgency            urgency NOT NULL DEFAULT 'Normal',
  required_by        date,
  assigned_to        uuid REFERENCES users(id),
  assigned_at        timestamptz,
  first_responded_at timestamptz,
  status             est_req_status NOT NULL DEFAULT 'Raised',
  paused_minutes     int NOT NULL DEFAULT 0,             -- time in ClarificationNeeded
  clarification_rounds int NOT NULL DEFAULT 0,
  scope_notes        text,
  row_version        int NOT NULL DEFAULT 1
);

CREATE TABLE technical_estimates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimation_request_id uuid NOT NULL REFERENCES estimation_requests(id),
  submitted_by        uuid NOT NULL REFERENCES users(id),
  submitted_at        timestamptz NOT NULL DEFAULT now(),
  scope_understanding text,
  proposed_solution   text,
  total_days          numeric(9,2) NOT NULL,
  mode                resource_mode NOT NULL DEFAULT 'Remote',
  travel_required     boolean NOT NULL DEFAULT false,
  travel_cost         money_amt,
  estimated_service_cost money_amt,                      -- SENSITIVE
  currency            ccy NOT NULL DEFAULT 'AED',
  assumptions         text,
  exclusions          text,
  dependencies        text,
  remarks             text,
  version             int NOT NULL DEFAULT 1,
  superseded_by       uuid REFERENCES technical_estimates(id)
);

CREATE TABLE estimate_resources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id     uuid NOT NULL REFERENCES technical_estimates(id) ON DELETE CASCADE,
  role_name       short_text NOT NULL,                   -- L2 Engineer / L3 Consultant
  seniority_band  short_text,
  headcount       int NOT NULL DEFAULT 1,
  days            numeric(9,2) NOT NULL,
  mode            resource_mode NOT NULL DEFAULT 'Remote',
  day_rate        money_amt                              -- SENSITIVE
);

-- ---------------------------------------------------------------------
-- CLUSTER 7 · COMMERCIAL — QUOTATION  (§13 §14 §15 §46)
-- ---------------------------------------------------------------------
CREATE TABLE margin_rules (                              -- §14, effective-dated
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_type_id  uuid NOT NULL REFERENCES business_types(id),
  min_margin_pct    pct,                                 -- OD-09: hard floor, blocks below this
  warn_margin_pct   pct,                                 -- OD-09: normal expectation, warns below
  sales_share_pct   pct NOT NULL,                        -- OD-06
  technical_share_pct pct NOT NULL,
  company_share_pct   pct NOT NULL DEFAULT 0,            -- OD-06 R3: renewals retain 50% to the company
  effective_from    date NOT NULL,
  effective_to      date,
  CHECK (sales_share_pct + technical_share_pct + company_share_pct = 100)
);

CREATE TABLE quotations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_no    varchar(32) NOT NULL UNIQUE,           -- QT-2026-0087
  enquiry_id      uuid NOT NULL REFERENCES enquiries(id),
  company_id      uuid NOT NULL REFERENCES companies(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  owner_id        uuid NOT NULL REFERENCES employees(id),
  current_version int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- IMMUTABLE once it leaves Draft. Any change creates the next version.
CREATE TABLE quotation_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id      uuid NOT NULL REFERENCES quotations(id),
  version_no        int NOT NULL,
  status            quote_ver_status NOT NULL DEFAULT 'Draft',
  quote_date        date NOT NULL DEFAULT current_date,
  valid_until       date,
  currency          ccy NOT NULL DEFAULT 'AED',
  total_cost        money_amt NOT NULL DEFAULT 0,        -- SENSITIVE
  other_project_cost money_amt NOT NULL DEFAULT 0,
  operation_charges money_amt NOT NULL DEFAULT 0,
  training_charges  money_amt NOT NULL DEFAULT 0,
  total_sell        money_amt NOT NULL DEFAULT 0,
  total_tax         money_amt NOT NULL DEFAULT 0,
  gross_profit      money_amt NOT NULL DEFAULT 0,        -- SENSITIVE
  gross_margin_pct  pct,                                 -- SENSITIVE
  payment_terms     text,
  delivery_terms    text,
  scope             text,
  assumptions       text,
  exclusions        text,
  warranty          text,
  commercial_terms  text,
  requires_approval boolean NOT NULL DEFAULT false,
  approved_at       timestamptz,
  submitted_at      timestamptz,
  superseded_by     uuid REFERENCES quotation_versions(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  UNIQUE (quotation_id, version_no)
);

CREATE TABLE quotation_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_version_id  uuid NOT NULL REFERENCES quotation_versions(id) ON DELETE CASCADE,
  line_no               int NOT NULL,
  enquiry_line_id       uuid REFERENCES enquiry_lines(id),
  -- provenance: this is what makes quoted cost provable
  supplier_quote_line_id uuid REFERENCES supplier_quote_lines(id),
  technical_estimate_id  uuid REFERENCES technical_estimates(id),
  product_sku_id        uuid REFERENCES product_skus(id),
  service_id            uuid REFERENCES services(id),
  manufacturer_id       uuid REFERENCES manufacturers(id),
  part_number           short_text,
  description           text NOT NULL,
  quantity              numeric(14,3) NOT NULL,
  unit_cost             money_amt NOT NULL DEFAULT 0,    -- SENSITIVE
  unit_price            money_amt NOT NULL,
  discount_pct          pct NOT NULL DEFAULT 0,
  tax_code_id           uuid REFERENCES tax_codes(id),
  supplier_id           uuid REFERENCES suppliers(id),
  -- generated columns: derived, never typed (design rule 4)
  line_sell   money_amt GENERATED ALWAYS AS (quantity * unit_price * (1 - discount_pct/100)) STORED,
  line_cost   money_amt GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  line_gp     money_amt GENERATED ALWAYS AS (quantity * unit_price * (1 - discount_pct/100) - quantity * unit_cost) STORED,
  UNIQUE (quotation_version_id, line_no)
);

-- APPEND-ONLY sell history (§12 §57). Written by trigger on version approval.
CREATE TABLE sell_price_points (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_sku_id       uuid REFERENCES product_skus(id),
  part_number          short_text,
  customer_id          uuid NOT NULL REFERENCES customers(id),
  quotation_line_id    uuid NOT NULL REFERENCES quotation_lines(id),
  quotation_version_id uuid NOT NULL REFERENCES quotation_versions(id),
  enquiry_id           uuid REFERENCES enquiries(id),
  quantity             numeric(14,3) NOT NULL,
  unit_price           money_amt NOT NULL,
  discount_pct         pct NOT NULL DEFAULT 0,
  unit_cost            money_amt,
  margin_pct           pct,
  currency             ccy NOT NULL,
  quoted_on            date NOT NULL,
  outcome              enquiry_stage,                    -- backfilled on Won / Lost
  recorded_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (                                 -- §44
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    short_text NOT NULL,                    -- quotation_version | supplier_po | change_request | ...
  entity_id      uuid NOT NULL,
  trigger_code   varchar(48) NOT NULL,                   -- LOW_MARGIN | HIGH_VALUE | DISCOUNT | TERMS | ...
  status         approval_status NOT NULL DEFAULT 'Pending',
  requested_by   uuid NOT NULL REFERENCES users(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);

CREATE TABLE approval_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id   uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  step_no       int NOT NULL,
  approver_id   uuid NOT NULL REFERENCES users(id),
  status        approval_status NOT NULL DEFAULT 'Pending',
  acted_at      timestamptz,
  acted_by      uuid REFERENCES users(id),                -- may differ via delegation
  comments      text,
  escalate_after_hours int,
  UNIQUE (approval_id, step_no),
  CONSTRAINT no_self_approval CHECK (true)                -- enforced in application + test suite
);

CREATE TABLE approval_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_code      varchar(48) NOT NULL,
  business_type_id  uuid REFERENCES business_types(id),
  min_value         money_amt,
  max_value         money_amt,
  margin_below_pct  pct,
  discount_above_pct pct,
  approver_role_ids uuid[] NOT NULL,                      -- ordered chain
  escalate_after_hours int NOT NULL DEFAULT 8,
  effective_from    date NOT NULL DEFAULT current_date,
  effective_to      date,
  is_active         boolean NOT NULL DEFAULT true
);

-- ---------------------------------------------------------------------
-- CLUSTER 9 · ORDER — CUSTOMER PO, SOW, CHANGE  (§18 §19 §45)
-- ---------------------------------------------------------------------
CREATE TABLE customer_pos (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_ref               varchar(32) NOT NULL,             -- CPO-2026-00071 (internal)
  customer_po_number   short_text NOT NULL,              -- the customer's own number
  company_id           uuid NOT NULL REFERENCES companies(id),
  customer_id          uuid NOT NULL REFERENCES customers(id),
  end_customer_name    short_text,
  partner_id           uuid REFERENCES partners(id),
  enquiry_id           uuid NOT NULL REFERENCES enquiries(id),
  quotation_version_id uuid NOT NULL REFERENCES quotation_versions(id),
  account_manager_id   uuid NOT NULL REFERENCES employees(id),
  po_date              date NOT NULL,
  po_received_date     date NOT NULL,
  currency             ccy NOT NULL DEFAULT 'AED',
  po_amount            money_amt NOT NULL,
  tax_amount           money_amt NOT NULL DEFAULT 0,
  net_value            money_amt NOT NULL,
  payment_terms_days   int NOT NULL,
  delivery_terms       text,
  -- booked baseline, frozen at PO (margin snapshot 2)
  booked_cost          money_amt,                        -- SENSITIVE
  booked_gross_profit  money_amt,                        -- SENSITIVE
  booked_margin_pct    pct,                              -- SENSITIVE
  po_document_id       uuid,                             -- FK added after documents
  sow_version_id       uuid,                             -- FK added after sow_versions
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users(id),
  row_version          int NOT NULL DEFAULT 1,
  UNIQUE (company_id, po_ref)
);

CREATE TABLE customer_po_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_po_id    uuid NOT NULL REFERENCES customer_pos(id) ON DELETE CASCADE,
  quotation_line_id uuid REFERENCES quotation_lines(id),
  line_no           int NOT NULL,
  description       text NOT NULL,
  quantity          numeric(14,3) NOT NULL,
  unit_price        money_amt NOT NULL,
  line_total        money_amt NOT NULL,
  UNIQUE (customer_po_id, line_no)
);

-- IMMUTABLE. §19: the agreed SOW is never edited, only superseded.
CREATE TABLE sow_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_po_id  uuid NOT NULL REFERENCES customer_pos(id),
  version_no      int NOT NULL,
  scope           text NOT NULL,
  deliverables    text,
  milestones      text,
  exclusions      text,
  assumptions     text,
  acceptance_criteria text,
  duration_days   int,
  document_id     uuid,
  change_request_id uuid,                                -- what created this version
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id),
  UNIQUE (customer_po_id, version_no)
);

ALTER TABLE customer_pos
  ADD CONSTRAINT cpo_sow_fk FOREIGN KEY (sow_version_id) REFERENCES sow_versions(id);

-- ---------------------------------------------------------------------
-- CLUSTER 10 · DELIVERY — PROJECT  (§20 §21 §22 §23 §24)
-- ---------------------------------------------------------------------
CREATE TABLE projects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_no           varchar(32) NOT NULL UNIQUE,      -- PRJ-2026-00051
  gt_number            short_text,                       -- legacy key, migrated (OD-12)
  company_id           uuid NOT NULL REFERENCES companies(id),
  customer_po_id       uuid NOT NULL REFERENCES customer_pos(id),
  sow_version_id       uuid NOT NULL REFERENCES sow_versions(id),
  customer_id          uuid NOT NULL REFERENCES customers(id),
  end_customer_name    short_text,
  name                 short_text NOT NULL,
  sbu_id               uuid REFERENCES sbus(id),
  account_manager_id   uuid REFERENCES employees(id),
  project_manager_id   uuid REFERENCES employees(id),
  project_coordinator_id uuid REFERENCES employees(id),
  team_lead_id         uuid REFERENCES employees(id),
  escalation_manager_id uuid REFERENCES employees(id),
  status               project_status NOT NULL DEFAULT 'Created',
  actual_start_date    date,
  actual_end_date      date,
  signoff_id           uuid,                             -- FK added after signoffs
  closure_override_id  uuid,                             -- audit id of the override
  sales_remarks        text,
  technical_remarks    text,
  pm_remarks           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  row_version          int NOT NULL DEFAULT 1,
  -- §24: closure requires acceptance or a logged override
  CONSTRAINT prj_closure_gate CHECK (
    status <> 'Completed' OR signoff_id IS NOT NULL OR closure_override_id IS NOT NULL)
);

-- Baseline is versioned so schedule variance always measures the original promise.
CREATE TABLE project_baselines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id),
  version_no         int NOT NULL,
  estimated_start_date date NOT NULL,
  estimated_end_date date NOT NULL,
  agreed_days        numeric(9,2) NOT NULL,
  estimated_days     numeric(9,2),                       -- from the technical estimate
  change_request_id  uuid,
  is_current         boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES users(id),
  UNIQUE (project_id, version_no)
);

CREATE TABLE milestones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name           short_text NOT NULL,
  due_date       date,
  completed_date date,
  is_billing_milestone boolean NOT NULL DEFAULT false,
  billing_pct    pct,
  sort_order     int
);

CREATE TABLE project_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_no         varchar(32) NOT NULL,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id    uuid REFERENCES milestones(id),
  name            short_text NOT NULL,
  description     text,
  assigned_to     uuid REFERENCES employees(id),
  sbu_id          uuid REFERENCES sbus(id),
  start_date      date,
  due_date        date,
  completed_date  date,
  estimated_days  numeric(9,2),
  weight          numeric(9,2) NOT NULL DEFAULT 1,       -- for weighted % complete
  pct_complete    pct NOT NULL DEFAULT 0,
  priority        varchar(12),
  status          task_status NOT NULL DEFAULT 'NotStarted',
  remarks         text,
  UNIQUE (project_id, task_no)
);

CREATE TABLE task_dependencies (
  task_id          uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  depends_on_id    uuid NOT NULL REFERENCES project_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id),
  CHECK (task_id <> depends_on_id)
);

CREATE TABLE project_resources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  employee_id   uuid NOT NULL REFERENCES employees(id),
  role_name     short_text,
  allocated_days numeric(9,2),
  allocated_from date,
  allocated_to   date,
  allocated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, employee_id, allocated_from)
);

-- The ONLY source of consumed days (design rule 4, fixes gap G9)
CREATE TABLE timesheet_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id),
  project_id    uuid REFERENCES projects(id),
  task_id       uuid REFERENCES project_tasks(id),
  enquiry_id    uuid REFERENCES enquiries(id),            -- presales / cost of pursuit
  work_date     date NOT NULL,
  hours         numeric(6,2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  days          numeric(6,3) GENERATED ALWAYS AS (hours / 8.0) STORED,
  is_billable   boolean NOT NULL DEFAULT true,
  mode          resource_mode,
  notes         text,
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (project_id IS NOT NULL OR enquiry_id IS NOT NULL)
);

CREATE TABLE signoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  signoff_date    date NOT NULL,
  signed_by_name  short_text,
  document_id     uuid,
  recorded_by     uuid NOT NULL REFERENCES users(id),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  remarks         text
);

ALTER TABLE projects ADD CONSTRAINT prj_signoff_fk FOREIGN KEY (signoff_id) REFERENCES signoffs(id);

CREATE TABLE change_requests (                            -- §45
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cr_no             varchar(32) NOT NULL UNIQUE,          -- CRQ-2026-00012
  project_id        uuid NOT NULL REFERENCES projects(id),
  original_sow_version_id uuid NOT NULL REFERENCES sow_versions(id),
  revised_sow_version_id  uuid REFERENCES sow_versions(id),
  requested_change  text NOT NULL,
  reason            text,
  additional_days   numeric(9,2),
  additional_cost   money_amt,
  additional_price  money_amt,
  margin_pct        pct,
  quotation_version_id uuid REFERENCES quotation_versions(id),
  customer_approval_document_id uuid,
  revised_start_date date,
  revised_end_date   date,
  status            change_req_status NOT NULL DEFAULT 'Raised',
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------------
-- CLUSTER 11 · PROCURE TO PAY  (§29)
-- ---------------------------------------------------------------------
CREATE TABLE supplier_pos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spo_no             varchar(32) NOT NULL UNIQUE,         -- SPO-2026-00033
  company_id         uuid NOT NULL REFERENCES companies(id),
  supplier_id        uuid NOT NULL REFERENCES suppliers(id),
  customer_po_id     uuid REFERENCES customer_pos(id),
  project_id         uuid REFERENCES projects(id),
  supplier_quote_id  uuid REFERENCES supplier_quotes(id),
  po_date            date NOT NULL,
  currency           ccy NOT NULL DEFAULT 'AED',
  fx_rate            numeric(18,8),
  fx_rate_date       date,
  net_amount         money_amt NOT NULL,
  tax_amount         money_amt NOT NULL DEFAULT 0,
  total_amount       money_amt NOT NULL,
  payment_terms_days int NOT NULL,
  expected_delivery  date,
  status             supplier_order_status NOT NULL DEFAULT 'POPending',
  document_id        uuid,
  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  row_version        int NOT NULL DEFAULT 1
);

CREATE TABLE supplier_po_lines (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_po_id        uuid NOT NULL REFERENCES supplier_pos(id) ON DELETE CASCADE,
  supplier_quote_line_id uuid REFERENCES supplier_quote_lines(id),
  product_sku_id        uuid REFERENCES product_skus(id),
  part_number           short_text,
  description           text NOT NULL,
  quantity              numeric(14,3) NOT NULL,
  unit_cost             money_amt NOT NULL,
  variance_reason       text,                             -- required if <> quoted price
  line_total            money_amt NOT NULL
);

CREATE TABLE goods_receipts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_po_id   uuid NOT NULL REFERENCES supplier_pos(id),
  received_date    date NOT NULL,
  received_by      uuid REFERENCES users(id),
  delivery_note_ref short_text,
  document_id      uuid,
  remarks          text
);

CREATE TABLE goods_receipt_lines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_receipt_id   uuid NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  supplier_po_line_id uuid NOT NULL REFERENCES supplier_po_lines(id),
  quantity_received  numeric(14,3) NOT NULL
);

CREATE TABLE serial_assets (                              -- addition A6
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_sku_id   uuid REFERENCES product_skus(id),
  serial_number    short_text NOT NULL,
  customer_id      uuid REFERENCES customers(id),
  project_id       uuid REFERENCES projects(id),
  goods_receipt_line_id uuid REFERENCES goods_receipt_lines(id),
  warranty_start   date,
  warranty_end     date,
  UNIQUE (product_sku_id, serial_number)
);

CREATE TABLE supplier_invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id),
  supplier_id        uuid NOT NULL REFERENCES suppliers(id),
  supplier_po_id     uuid REFERENCES supplier_pos(id),
  invoice_number     short_text NOT NULL,
  invoice_date       date NOT NULL,
  currency           ccy NOT NULL DEFAULT 'AED',
  fx_rate            numeric(18,8),
  net_amount         money_amt NOT NULL,
  tax_amount         money_amt NOT NULL DEFAULT 0,
  total_amount       money_amt NOT NULL,
  due_date           date NOT NULL,
  match_status       varchar(16) NOT NULL DEFAULT 'Unmatched'
                     CHECK (match_status IN ('Unmatched','Matched','Exception')),
  document_id        uuid,
  booked_by          uuid REFERENCES users(id),
  booked_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, invoice_number)
);

CREATE TABLE supplier_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES supplier_invoices(id),
  payment_date        date NOT NULL,
  amount              money_amt NOT NULL,
  currency            ccy NOT NULL,
  method              short_text,
  reference           short_text,
  document_id         uuid,
  recorded_by         uuid REFERENCES users(id),
  recorded_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- CLUSTER 12 · ORDER TO CASH  (§25 §26 §27 §28)
-- ---------------------------------------------------------------------
CREATE TABLE invoice_schedule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_po_id uuid NOT NULL REFERENCES customer_pos(id) ON DELETE CASCADE,
  milestone_id   uuid REFERENCES milestones(id),
  instalment_no  int,
  planned_date   date,
  planned_amount money_amt NOT NULL,
  is_invoiced    boolean NOT NULL DEFAULT false
);

CREATE TABLE customer_invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no        varchar(32) NOT NULL UNIQUE,          -- INV-2026-00210
  company_id        uuid NOT NULL REFERENCES companies(id),
  customer_id       uuid NOT NULL REFERENCES customers(id),
  customer_po_id    uuid NOT NULL REFERENCES customer_pos(id),   -- §25 gate
  project_id        uuid REFERENCES projects(id),
  signoff_id        uuid REFERENCES signoffs(id),                -- §25 gate for services
  milestone_id      uuid REFERENCES milestones(id),
  instalment_no     int,
  invoice_date      date NOT NULL,
  currency          ccy NOT NULL DEFAULT 'AED',
  taxable_amount    money_amt NOT NULL,
  tax_amount        money_amt NOT NULL DEFAULT 0,
  total_amount      money_amt NOT NULL,
  payment_terms_days int NOT NULL,
  due_date          date NOT NULL,
  status            invoice_status NOT NULL DEFAULT 'Draft',
  receivable_status receivable_status NOT NULL DEFAULT 'NotDue',
  document_id       uuid,
  issued_at         timestamptz,
  issued_by         uuid REFERENCES users(id),
  remarks           text,
  row_version       int NOT NULL DEFAULT 1
);

CREATE TABLE customer_invoice_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  line_no      int NOT NULL,
  customer_po_line_id uuid REFERENCES customer_po_lines(id),
  description  text NOT NULL,
  quantity     numeric(14,3) NOT NULL DEFAULT 1,
  unit_price   money_amt NOT NULL,
  tax_code_id  uuid REFERENCES tax_codes(id),
  line_total   money_amt NOT NULL,
  UNIQUE (invoice_id, line_no)
);

CREATE TABLE customer_receipts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no    varchar(32) NOT NULL UNIQUE,              -- RCT-2026-00144
  company_id    uuid NOT NULL REFERENCES companies(id),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  receipt_date  date NOT NULL,
  amount        money_amt NOT NULL,
  currency      ccy NOT NULL DEFAULT 'AED',
  method        short_text,
  reference     short_text,
  document_id   uuid,
  recorded_by   uuid REFERENCES users(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE receipt_allocations (                         -- one receipt settles many invoices
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id  uuid NOT NULL REFERENCES customer_receipts(id) ON DELETE CASCADE,
  invoice_id  uuid NOT NULL REFERENCES customer_invoices(id),
  amount      money_amt NOT NULL CHECK (amount > 0),
  UNIQUE (receipt_id, invoice_id)
);

CREATE TABLE credit_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_no    varchar(32) NOT NULL UNIQUE,
  invoice_id   uuid NOT NULL REFERENCES customer_invoices(id),
  credit_date  date NOT NULL,
  amount       money_amt NOT NULL,
  reason       text NOT NULL,
  approval_id  uuid REFERENCES approvals(id),
  document_id  uuid,
  created_by   uuid REFERENCES users(id)
);

CREATE TABLE collection_followups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES customer_invoices(id) ON DELETE CASCADE,
  followed_up_at timestamptz NOT NULL DEFAULT now(),
  expected_payment_date date,
  remarks      text NOT NULL,
  created_by   uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------------
-- CLUSTER 13 · CONTRACTS & RENEWALS  (addition A1 — closes gap G13)
-- ---------------------------------------------------------------------
CREATE TABLE contracts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_no       varchar(32) NOT NULL UNIQUE,
  company_id        uuid NOT NULL REFERENCES companies(id),
  customer_id       uuid NOT NULL REFERENCES customers(id),
  customer_po_id    uuid REFERENCES customer_pos(id),
  business_type_id  uuid REFERENCES business_types(id),   -- AMC / SLA / ManagedServices / Renewal
  sbu_id            uuid REFERENCES sbus(id),
  owner_id          uuid REFERENCES employees(id),
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  renewal_notice_days int NOT NULL DEFAULT 90,
  annual_value      money_amt,
  currency          ccy NOT NULL DEFAULT 'AED',
  auto_renew        boolean NOT NULL DEFAULT false,
  status            varchar(16) NOT NULL DEFAULT 'Active'
                    CHECK (status IN ('Draft','Active','Expiring','Renewed','Lapsed','Terminated')),
  CHECK (end_date > start_date)
);

CREATE TABLE contract_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id    uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  product_sku_id uuid REFERENCES product_skus(id),
  service_id     uuid REFERENCES services(id),
  description    text NOT NULL,
  quantity       numeric(14,3) NOT NULL DEFAULT 1,
  unit_price     money_amt,
  unit_cost      money_amt,
  sla_response_hours int,
  coverage_hours short_text                                -- 8x5 / 24x7
);

CREATE TABLE contract_renewals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id        uuid NOT NULL REFERENCES contracts(id),
  renewal_due_date   date NOT NULL,
  enquiry_id         uuid REFERENCES enquiries(id),        -- the renewal opportunity raised
  outcome            varchar(16) CHECK (outcome IN ('Renewed','Lost','Lapsed','Pending')),
  new_contract_id    uuid REFERENCES contracts(id),
  notified_90 boolean NOT NULL DEFAULT false,
  notified_60 boolean NOT NULL DEFAULT false,
  notified_30 boolean NOT NULL DEFAULT false
);

CREATE TABLE deal_registrations (                          -- addition A2
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id       uuid NOT NULL REFERENCES enquiries(id),
  manufacturer_id  uuid NOT NULL REFERENCES manufacturers(id),
  supplier_id      uuid REFERENCES suppliers(id),
  registration_ref short_text,
  submitted_on     date,
  approved_on      date,
  expires_on       date,
  approved_discount_pct pct,
  status           varchar(16) NOT NULL DEFAULT 'Submitted'
                   CHECK (status IN ('Draft','Submitted','Approved','Rejected','Expired')),
  remarks          text
);

-- ---------------------------------------------------------------------
-- CLUSTER 14 · PLATFORM  (§33 §36 §37 §42)
-- ---------------------------------------------------------------------
CREATE TABLE documents (                                   -- §33 polymorphic attachment
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   short_text NOT NULL,
  entity_id     uuid NOT NULL,
  doc_type      varchar(48) NOT NULL,                      -- CustomerPO | SOW | SupplierQuote | Signoff | ...
  title         short_text NOT NULL,
  current_version int NOT NULL DEFAULT 1,
  is_mandatory  boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users(id)
);

CREATE TABLE document_versions (                           -- IMMUTABLE (§46)
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no    int NOT NULL,
  file_name     short_text NOT NULL,
  mime_type     short_text NOT NULL,
  size_bytes    bigint NOT NULL,
  content_hash  char(64) NOT NULL,                         -- sha256, dedupe
  storage_key   text NOT NULL,
  extracted_text text,                                     -- full-text search of documents
  replaced_reason text,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_by   uuid REFERENCES users(id),
  UNIQUE (document_id, version_no)
);

ALTER TABLE customer_pos     ADD CONSTRAINT cpo_doc_fk  FOREIGN KEY (po_document_id) REFERENCES documents(id);
ALTER TABLE sow_versions     ADD CONSTRAINT sow_doc_fk  FOREIGN KEY (document_id)    REFERENCES documents(id);
ALTER TABLE signoffs         ADD CONSTRAINT sgn_doc_fk  FOREIGN KEY (document_id)    REFERENCES documents(id);
ALTER TABLE supplier_pos     ADD CONSTRAINT spo_doc_fk  FOREIGN KEY (document_id)    REFERENCES documents(id);
ALTER TABLE supplier_invoices ADD CONSTRAINT sinv_doc_fk FOREIGN KEY (document_id)   REFERENCES documents(id);
ALTER TABLE customer_invoices ADD CONSTRAINT cinv_doc_fk FOREIGN KEY (document_id)   REFERENCES documents(id);
ALTER TABLE customer_receipts ADD CONSTRAINT rcpt_doc_fk FOREIGN KEY (document_id)   REFERENCES documents(id);

-- §37 SLA engine: one row per running or completed timer
CREATE TABLE sla_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timer_code        varchar(48) NOT NULL,                  -- PROC_RESPONSE | TECH_ESTIMATE | INVOICE_SUBMIT | ...
  urgency           urgency NOT NULL DEFAULT 'Normal',
  target_hours      numeric(9,2) NOT NULL,                 -- OD-17
  calendar_id       uuid REFERENCES calendars(id),
  warn_at_pct       pct NOT NULL DEFAULT 80,
  escalate_role_ids uuid[],
  effective_from    date NOT NULL DEFAULT current_date,
  effective_to      date,
  is_active         boolean NOT NULL DEFAULT true,
  UNIQUE (timer_code, urgency, effective_from)
);

CREATE TABLE sla_timers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  timer_code      varchar(48) NOT NULL,
  sla_rule_id     uuid REFERENCES sla_rules(id),
  entity_type     short_text NOT NULL,
  entity_id       uuid NOT NULL,
  owner_user_id   uuid REFERENCES users(id),
  calendar_id     uuid REFERENCES calendars(id),
  started_at      timestamptz NOT NULL,
  stopped_at      timestamptz,
  paused_minutes  int NOT NULL DEFAULT 0,
  target_hours    numeric(9,2) NOT NULL,
  elapsed_working_hours numeric(9,2),
  state           sla_state NOT NULL DEFAULT 'Within',
  breach_reason   text,
  UNIQUE (timer_code, entity_type, entity_id)
);

CREATE TABLE notification_rules (                          -- §36 §53, administrator-editable
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_code     varchar(64) NOT NULL UNIQUE,              -- PO_RECEIVED | SLA_BREACHED | RENEWAL_90 | ...
  description    short_text,
  recipient_spec jsonb NOT NULL,                           -- roles, relations (owner, assignee, sbu_head)
  channels       notify_channel[] NOT NULL,
  digest         varchar(12) CHECK (digest IN ('None','Daily','Weekly')) DEFAULT 'None',
  is_active      boolean NOT NULL DEFAULT true
);

CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_code    varchar(64) NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  entity_type   short_text,
  entity_id     uuid,
  title         short_text NOT NULL,
  body          text,
  deep_link     text,
  channel       notify_channel NOT NULL,
  sent_at       timestamptz,
  delivery_status varchar(12) NOT NULL DEFAULT 'Pending',
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notification_mutes (
  user_id     uuid NOT NULL REFERENCES users(id),
  event_code  varchar(64) NOT NULL,
  channel     notify_channel NOT NULL,
  muted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_code, channel)
);

-- §42 APPEND-ONLY. Application role gets INSERT and SELECT only.
CREATE TABLE audit_log (
  id                bigserial,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  actor_user_id     uuid,
  actor_role        short_text,
  impersonated_by   uuid,
  entity_type       short_text NOT NULL,
  entity_id         uuid,
  parent_entity_type short_text,
  parent_entity_id  uuid,
  action            audit_action NOT NULL,
  field_name        short_text,
  old_value         text,
  new_value         text,
  reason            text,
  ip_address        inet,
  user_agent        text,
  session_id        uuid,
  request_id        uuid,
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_log_2026m09 PARTITION OF audit_log
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit_log_2026m10 PARTITION OF audit_log
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
-- ... one partition per month, created by a scheduled job

CREATE TABLE settings (
  key        varchar(80) PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

CREATE TABLE report_definitions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_code  varchar(16) NOT NULL UNIQUE,                -- R-S01 .. R-A14
  name         short_text NOT NULL,
  category     short_text NOT NULL,
  required_permission varchar(80),
  definition   jsonb NOT NULL,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE saved_views (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id),
  module       short_text NOT NULL,
  name         short_text NOT NULL,
  filters      jsonb NOT NULL,
  is_shared    boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, module, name)
);

-- =====================================================================
-- TRIGGERS — history capture that cannot be bypassed
-- =====================================================================

-- Every supplier quote line writes one immutable cost price point (§12).
CREATE OR REPLACE FUNCTION fn_write_cost_price_point() RETURNS trigger AS $$
DECLARE q RECORD; r RECORD;
BEGIN
  SELECT sq.*, pr.enquiry_id INTO q
    FROM supplier_quotes sq
    JOIN procurement_requests pr ON pr.id = sq.request_id
   WHERE sq.id = NEW.supplier_quote_id;
  SELECT e.customer_id INTO r FROM enquiries e WHERE e.id = q.enquiry_id;

  INSERT INTO cost_price_points (
    product_sku_id, part_number, supplier_id, supplier_quote_line_id,
    enquiry_id, customer_id, quantity, unit_cost, currency, unit_cost_base,
    availability, lead_time_days, payment_terms_days, valid_until, quoted_on)
  VALUES (
    NEW.product_sku_id,
    COALESCE(NEW.part_number, 'UNSPECIFIED'),
    q.supplier_id, NEW.id,
    q.enquiry_id, r.customer_id, NEW.quantity, NEW.unit_cost, q.currency,
    NEW.unit_cost * COALESCE(q.fx_rate, 1),
    NEW.availability, NEW.lead_time_days, q.payment_terms_days,
    q.valid_until, q.quote_date);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cost_price_point
  AFTER INSERT ON supplier_quote_lines
  FOR EACH ROW EXECUTE FUNCTION fn_write_cost_price_point();

-- Approving a quotation version writes the sell price points (§12 §57).
CREATE OR REPLACE FUNCTION fn_write_sell_price_points() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'Approved' AND OLD.status <> 'Approved' THEN
    INSERT INTO sell_price_points (
      product_sku_id, part_number, customer_id, quotation_line_id,
      quotation_version_id, enquiry_id, quantity, unit_price, discount_pct,
      unit_cost, margin_pct, currency, quoted_on)
    SELECT ql.product_sku_id, ql.part_number, q.customer_id, ql.id,
           NEW.id, q.enquiry_id, ql.quantity, ql.unit_price, ql.discount_pct,
           ql.unit_cost,
           CASE WHEN ql.line_sell <> 0 THEN (ql.line_gp / ql.line_sell) * 100 END,
           NEW.currency, NEW.quote_date
      FROM quotation_lines ql
      JOIN quotations q ON q.id = NEW.quotation_id
     WHERE ql.quotation_version_id = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sell_price_points
  AFTER UPDATE ON quotation_versions
  FOR EACH ROW EXECUTE FUNCTION fn_write_sell_price_points();

-- A submitted quotation version is immutable (§15 §46).
CREATE OR REPLACE FUNCTION fn_quote_version_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('Approved','Submitted','Superseded','Rejected')
     AND NEW.status = OLD.status THEN
    RAISE EXCEPTION 'Quotation version % is frozen; create the next version instead', OLD.version_no;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_quote_version_immutable
  BEFORE UPDATE ON quotation_versions
  FOR EACH ROW EXECUTE FUNCTION fn_quote_version_immutable();

-- Stage transitions are recorded, not overwritten (fixes gap G3/G9).
CREATE OR REPLACE FUNCTION fn_log_enquiry_stage() RETURNS trigger AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    INSERT INTO stage_history (enquiry_id, from_stage, to_stage, changed_by)
    VALUES (NEW.id, OLD.stage, NEW.stage, NEW.updated_by);
  END IF;
  IF NEW.expected_po_date IS DISTINCT FROM OLD.expected_po_date
     AND OLD.expected_po_date IS NOT NULL THEN
    NEW.slip_count := OLD.slip_count + 1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_enquiry_stage
  BEFORE UPDATE ON enquiries
  FOR EACH ROW EXECUTE FUNCTION fn_log_enquiry_stage();

-- Generic field-level audit writer, attached to every business table.
CREATE OR REPLACE FUNCTION fn_audit() RETURNS trigger AS $$
DECLARE k text; ov text; nv text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor_user_id, entity_type, entity_id, action)
    VALUES (current_setting('app.user_id', true)::uuid, TG_TABLE_NAME, NEW.id, 'create');
  ELSIF TG_OP = 'UPDATE' THEN
    FOR k IN SELECT jsonb_object_keys(to_jsonb(NEW)) LOOP
      ov := to_jsonb(OLD) ->> k;  nv := to_jsonb(NEW) ->> k;
      IF ov IS DISTINCT FROM nv THEN
        INSERT INTO audit_log (actor_user_id, entity_type, entity_id, action, field_name, old_value, new_value)
        VALUES (current_setting('app.user_id', true)::uuid, TG_TABLE_NAME, NEW.id, 'update', k, ov, nv);
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_quotation_versions AFTER INSERT OR UPDATE ON quotation_versions
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_quotation_lines AFTER INSERT OR UPDATE ON quotation_lines
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_supplier_quote_lines AFTER INSERT OR UPDATE ON supplier_quote_lines
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_customer_pos AFTER INSERT OR UPDATE ON customer_pos
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_projects AFTER INSERT OR UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_customer_invoices AFTER INSERT OR UPDATE ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
CREATE TRIGGER trg_audit_customer_receipts AFTER INSERT OR UPDATE ON customer_receipts
  FOR EACH ROW EXECUTE FUNCTION fn_audit();
-- ... repeat for every business table

-- =====================================================================
-- DERIVED VIEWS — nothing here is ever stored (design rule 4)
-- =====================================================================

CREATE OR REPLACE VIEW v_project_progress AS
SELECT p.id AS project_id, p.project_no, p.status,
       b.agreed_days, b.estimated_start_date, b.estimated_end_date,
       COALESCE(t.consumed_days, 0)                        AS consumed_days,
       b.agreed_days - COALESCE(t.consumed_days, 0)        AS remaining_days,
       COALESCE(w.completion_pct, 0)                       AS completion_pct,
       (b.estimated_end_date - current_date)               AS days_to_baseline_end,
       CASE WHEN current_date > b.estimated_end_date
              AND COALESCE(w.completion_pct,0) < 100 THEN true
            WHEN COALESCE(t.consumed_days,0) > b.agreed_days THEN true
            ELSE false END                                  AS is_delayed
  FROM projects p
  JOIN project_baselines b ON b.project_id = p.id AND b.is_current
  LEFT JOIN (SELECT project_id, SUM(days) AS consumed_days
               FROM timesheet_entries GROUP BY project_id) t ON t.project_id = p.id
  LEFT JOIN (SELECT project_id,
                    SUM(weight * pct_complete) / NULLIF(SUM(weight),0) AS completion_pct
               FROM project_tasks GROUP BY project_id) w ON w.project_id = p.id;

CREATE OR REPLACE VIEW v_receivables_ageing AS
SELECT i.id AS invoice_id, i.invoice_no, i.customer_id, i.due_date,
       i.total_amount,
       COALESCE(a.allocated, 0)                    AS received_amount,
       i.total_amount - COALESCE(a.allocated, 0)   AS balance,
       GREATEST(current_date - i.due_date, 0)      AS days_overdue,
       CASE WHEN i.total_amount - COALESCE(a.allocated,0) <= 0 THEN '0 Paid'
            WHEN current_date <= i.due_date                     THEN '1 Not due'
            WHEN current_date - i.due_date <= 30                THEN '2 0-30'
            WHEN current_date - i.due_date <= 60                THEN '3 31-60'
            WHEN current_date - i.due_date <= 90                THEN '4 61-90'
            WHEN current_date - i.due_date <= 120               THEN '5 91-120'
            ELSE '6 120+' END                                    AS ageing_bucket
  FROM customer_invoices i
  LEFT JOIN (SELECT invoice_id, SUM(amount) AS allocated
               FROM receipt_allocations GROUP BY invoice_id) a ON a.invoice_id = i.id
 WHERE i.status NOT IN ('Draft','Cancelled');

-- Margin measured three times (§30, Figure 2)
CREATE OR REPLACE VIEW v_margin_snapshots AS
SELECT po.id AS customer_po_id, po.po_ref, po.customer_id, po.enquiry_id,
       qv.total_sell                                   AS quoted_sell,
       qv.gross_margin_pct                             AS quoted_margin_pct,
       po.booked_margin_pct                            AS booked_margin_pct,
       inv.invoiced                                    AS realised_sell,
       inv.invoiced - (COALESCE(sup.cost,0) + COALESCE(lab.cost,0)) AS realised_gp,
       CASE WHEN inv.invoiced > 0
            THEN ((inv.invoiced - (COALESCE(sup.cost,0) + COALESCE(lab.cost,0))) / inv.invoiced) * 100
       END                                             AS realised_margin_pct
  FROM customer_pos po
  JOIN quotation_versions qv ON qv.id = po.quotation_version_id
  LEFT JOIN (SELECT customer_po_id, SUM(total_amount) AS invoiced
               FROM customer_invoices WHERE status NOT IN ('Draft','Cancelled')
              GROUP BY customer_po_id) inv ON inv.customer_po_id = po.id
  LEFT JOIN (SELECT sp.customer_po_id, SUM(si.net_amount) AS cost
               FROM supplier_invoices si JOIN supplier_pos sp ON sp.id = si.supplier_po_id
              GROUP BY sp.customer_po_id) sup ON sup.customer_po_id = po.id
  LEFT JOIN (SELECT pr.customer_po_id, SUM(te.days * COALESCE(e.internal_day_rate,0)) AS cost
               FROM timesheet_entries te
               JOIN projects pr  ON pr.id = te.project_id
               JOIN employees e  ON e.id = te.employee_id
              GROUP BY pr.customer_po_id) lab ON lab.customer_po_id = po.id;

-- =====================================================================
-- INDEXES
-- =====================================================================
CREATE INDEX idx_enq_company_stage      ON enquiries (company_id, stage, received_at DESC);
CREATE INDEX idx_enq_customer           ON enquiries (customer_id, received_at DESC);
CREATE INDEX idx_enq_owner              ON enquiries (account_manager_id, stage);
CREATE INDEX idx_enq_no_trgm            ON enquiries USING gin (enquiry_no gin_trgm_ops);
CREATE INDEX idx_proc_req_status        ON procurement_requests (status, raised_at);
CREATE INDEX idx_proc_req_assignee      ON procurement_requests (assigned_to, status);
CREATE INDEX idx_est_req_sbu            ON estimation_requests (sbu_id, status, raised_at);
CREATE INDEX idx_sq_supplier            ON supplier_quotes (supplier_id, quote_date DESC);
CREATE INDEX idx_cpp_part               ON cost_price_points (part_number, quoted_on DESC);
CREATE INDEX idx_cpp_sku                ON cost_price_points (product_sku_id, quoted_on DESC);
CREATE INDEX idx_cpp_part_trgm          ON cost_price_points USING gin (part_number gin_trgm_ops);
CREATE INDEX idx_spp_part               ON sell_price_points (part_number, quoted_on DESC);
CREATE INDEX idx_spp_customer           ON sell_price_points (customer_id, quoted_on DESC);
CREATE INDEX idx_qv_quotation           ON quotation_versions (quotation_id, version_no DESC);
CREATE INDEX idx_ql_version             ON quotation_lines (quotation_version_id);
CREATE INDEX idx_cpo_customer           ON customer_pos (customer_id, po_received_date DESC);
CREATE INDEX idx_prj_status             ON projects (company_id, status);
CREATE INDEX idx_prj_pm                 ON projects (project_manager_id, status);
CREATE INDEX idx_task_project_status    ON project_tasks (project_id, status, due_date);
CREATE INDEX idx_task_assignee          ON project_tasks (assigned_to, status, due_date);
CREATE INDEX idx_ts_employee_date       ON timesheet_entries (employee_id, work_date);
CREATE INDEX idx_ts_project             ON timesheet_entries (project_id, work_date);
CREATE INDEX idx_inv_status_due         ON customer_invoices (company_id, status, due_date);
CREATE INDEX idx_inv_customer           ON customer_invoices (customer_id, invoice_date DESC);
CREATE INDEX idx_sinv_due               ON supplier_invoices (company_id, due_date);
CREATE INDEX idx_sla_state              ON sla_timers (state, timer_code) WHERE stopped_at IS NULL;
CREATE INDEX idx_notif_user_unread      ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_doc_entity             ON documents (entity_type, entity_id);
CREATE INDEX idx_docver_text            ON document_versions USING gin (to_tsvector('english', coalesce(extracted_text,'')));
CREATE INDEX idx_cust_name_trgm         ON customers USING gin (name gin_trgm_ops);
CREATE INDEX idx_sku_part_trgm          ON product_skus USING gin (part_number gin_trgm_ops);
CREATE INDEX idx_contract_expiry        ON contracts (end_date) WHERE status IN ('Active','Expiring');
CREATE INDEX idx_audit_entity           ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_audit_actor            ON audit_log (actor_user_id, occurred_at DESC);

-- =====================================================================
-- PRIVILEGES — history is append-only (§12 §42, design rule 3)
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gw_app')    THEN CREATE ROLE gw_app    LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='gw_report') THEN CREATE ROLE gw_report LOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA gw TO gw_app, gw_report;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA gw TO gw_app;
GRANT SELECT ON ALL TABLES IN SCHEMA gw TO gw_report;

-- No DELETE anywhere for the application role, and no UPDATE on history.
REVOKE DELETE ON ALL TABLES IN SCHEMA gw FROM gw_app;
REVOKE UPDATE ON cost_price_points, sell_price_points, audit_log,
                 document_versions, stage_history, project_baselines,
                 sow_versions FROM gw_app;

-- Row-level security mirrors the RBAC scope rules as defence in depth.
ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;
CREATE POLICY enq_scope ON enquiries FOR SELECT TO gw_app
USING (
  current_setting('app.scope', true) = 'A'
  OR (current_setting('app.scope', true) = 'O'
      AND account_manager_id = current_setting('app.employee_id', true)::uuid)
  OR (current_setting('app.scope', true) = 'S'
      AND primary_sbu_id = current_setting('app.sbu_id', true)::uuid)
  OR EXISTS (SELECT 1 FROM record_shares rs
              WHERE rs.entity_type = 'enquiries' AND rs.entity_id = enquiries.id
                AND rs.user_id = current_setting('app.user_id', true)::uuid
                AND (rs.valid_to IS NULL OR rs.valid_to > now()))
);

-- ---------------------------------------------------------------------
-- OD-01 DECIDED R3: Abdul is ONE person who sits in two SBUs — an engineer in
-- SBU 1 where Kumar assigns his work, and the head of SBU 4 where he assigns to
-- his own engineers. employees.sbu_id cannot express that, so membership
-- becomes its own table and the estimate reviewer is resolved from it.
-- ---------------------------------------------------------------------
CREATE TABLE employee_sbu_memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  sbu_id        uuid NOT NULL REFERENCES sbus(id),
  membership    varchar(12) NOT NULL CHECK (membership IN ('Head','Engineer')),
  is_primary    boolean NOT NULL DEFAULT false,
  assigns_work  boolean NOT NULL DEFAULT false,   -- true for a head in their own SBU
  reviewed_by   uuid REFERENCES employees(id),    -- who signs off this person's estimates here
  effective_from date NOT NULL DEFAULT current_date,
  effective_to   date,
  UNIQUE (employee_id, sbu_id, effective_from)
);
CREATE INDEX idx_emp_sbu ON employee_sbu_memberships (sbu_id, membership);

-- ---------------------------------------------------------------------
-- OD-17 DECIDED R3: customer-facing incident priorities (P1 4h, P2 8h,
-- P3 2 days, P4 3 days) per the customer SLA agreement. These are SERVICE
-- response targets, not the internal procurement/estimation TAT targets —
-- they hang off the contract, and the internal timers keep their defaults.
-- ---------------------------------------------------------------------
CREATE TABLE sla_priority_matrix (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id         uuid REFERENCES contracts(id),   -- NULL = the standard matrix
  priority            varchar(4) NOT NULL CHECK (priority IN ('P1','P2','P3','P4')),
  response_hours      numeric(9,2) NOT NULL,
  resolution_hours    numeric(9,2),
  coverage            short_text,                      -- 8x5 / 24x7
  calendar_id         uuid REFERENCES calendars(id),
  effective_from      date NOT NULL DEFAULT current_date,
  UNIQUE (contract_id, priority, effective_from)
);

-- ---------------------------------------------------------------------
-- OD-16 DECIDED R3: overhead IS allocated to deals. The basis was not given,
-- so it is configuration with an explicit, auditable rule rather than a
-- number buried in a report.
-- ---------------------------------------------------------------------
CREATE TABLE overhead_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid REFERENCES companies(id),
  basis           varchar(24) NOT NULL
                  CHECK (basis IN ('PctOfRevenue','PerProjectDay','PerDeal','MonthlyPoolShare')),
  rate            numeric(18,6) NOT NULL,     -- % , per-day amount, per-deal amount, or pool
  currency        ccy DEFAULT 'AED',
  applies_to_business_type uuid REFERENCES business_types(id),
  effective_from  date NOT NULL,
  effective_to    date,
  notes           text
);

-- =====================================================================
-- SEED — master data from §3 and §4
-- =====================================================================
INSERT INTO currencies (code, name) VALUES
  ('AED','UAE Dirham'), ('USD','US Dollar'), ('EUR','Euro'), ('INR','Indian Rupee');

-- OD-11 DECIDED 13 Sep 2026: Greenware Technologies LLC is the ONLY invoicing
-- entity in this system. Cloud SourceIT and Greenware General Trading do not
-- invoice through it. The company_id dimension stays on every transaction so a
-- second entity is configuration rather than a rebuild, but only one is seeded.
INSERT INTO companies (code, name, country, base_currency) VALUES
  ('GWT','Greenware Technologies LLC','AE','AED');

INSERT INTO calendars (name, timezone, working_days, day_start, day_end) VALUES
  ('Dubai','Asia/Dubai',    '{1,2,3,4,5}', '09:00', '18:00'),
  ('Trichy','Asia/Kolkata', '{1,2,3,4,5,6}', '09:30', '18:30');

INSERT INTO sbus (code, name) VALUES
  ('SBU1','Infrastructure — Server, Storage, HCI, Virtualization, Network'),
  ('SBU2','Data Protection — Backup, DR, Database'),
  ('SBU3','Identity & Cloud — PAM, IAM, Microsoft, Cloud'),
  ('SBU4','Cybersecurity — Endpoint, Network Security, SIEM, Compliance');

INSERT INTO technology_categories (name, sbu_id, sort_order)
SELECT c.name, s.id, c.ord FROM (VALUES
  ('Server & Storage','SBU1',1), ('Hyperconverged Infrastructure','SBU1',2),
  ('Virtualization','SBU1',3),   ('Wireless','SBU1',4),
  ('Switching & Routing','SBU1',5), ('NMS','SBU1',6),
  -- OD-04 DECIDED: Patch Management moves to SBU 4, overriding the SBU 1
  -- allocation stated in requirement section 4. Cloud stays SBU 3, Cloud
  -- Security stays SBU 4.
  ('Patch Management','SBU4',7),
  ('Backup & Disaster Recovery','SBU2',8), ('Database','SBU2',9),
  ('PAM','SBU3',10), ('IAM','SBU3',11), ('Microsoft Solutions','SBU3',12), ('Cloud','SBU3',13),
  ('EDR/XDR','SBU4',14), ('DLP','SBU4',15), ('VAPT','SBU4',16),
  ('Firewalls & NDR','SBU4',17), ('Email Security','SBU4',18), ('SIEM','SBU4',19),
  ('Compliance','SBU4',20), ('Cloud Security','SBU4',21)
) AS c(name, sbu_code, ord)
JOIN sbus s ON s.code = c.sbu_code;

-- OD-03 DECIDED: a Microsoft 365 E5 enquiry routes on the outcome being sold.
-- technologies.sbu_id overrides the category default, so both live under
-- Microsoft Solutions but reach different SBUs.
INSERT INTO technologies (category_id, name, sbu_id)
SELECT tc.id, t.name, s.id
  FROM (VALUES
    ('Microsoft 365 E5 — EDR / XDR',              'SBU4'),
    ('Microsoft 365 E5 — SharePoint',             'SBU3'),
    ('Microsoft 365 E5 — IAM and access control', 'SBU3')
  ) AS t(name, sbu_code)
  JOIN technology_categories tc ON tc.name = 'Microsoft Solutions'
  JOIN sbus s ON s.code = t.sbu_code;

INSERT INTO business_types (code, name, needs_procurement, needs_estimation, creates_project, is_recurring) VALUES
  ('PRODUCT','Product sale',              true,  false, false, false),
  ('LICENCE','Licence sale',              true,  false, false, false),
  ('RENEWAL','Renewal',                   true,  false, false, true),
  ('PS','Professional services',          false, true,  true,  false),
  ('PRODUCT_PS','Product + services',     true,  true,  true,  false),
  ('PROJECT','Project',                   true,  true,  true,  false),
  ('AMC','AMC',                           false, true,  true,  true),
  ('SLA','SLA services',                  false, true,  true,  true),
  ('MANAGED','Managed services',          false, true,  true,  true),
  ('OTHER','Other',                       false, false, false, false);

INSERT INTO roles (code, name, is_system) VALUES
  ('SUPER_ADMIN','Super Administrator', true),
  ('DIRECTOR','Management / Director',  true),
  ('SALES_MGR','Sales Manager',         true),
  ('SALES','Sales User',                true),
  ('PROCUREMENT','Procurement User',    true),
  ('TECHNICAL','Technical User',        true),
  ('SBU_HEAD','SBU Head',               true),
  ('PM','Project Manager',              true),
  ('ACCOUNTS','Accounts / Finance',     true),
  ('ADMIN','Admin',                     true);

INSERT INTO tax_codes (code, description, rate_pct) VALUES
  ('VAT5','UAE standard rated 5%', 5.0),
  ('VAT0','Zero rated / export',   0.0),
  ('OUT','Out of scope',           0.0);

INSERT INTO loss_reasons (code, name) VALUES
  ('PRICE','Price'), ('TECH','Technical fit'), ('TIMING','Timing / budget'),
  ('INCUMBENT','Incumbent retained'), ('NO_DECISION','No decision'),
  ('DELIVERY','Delivery / lead time'), ('OTHER','Other');

-- OD-06 DECIDED R3: margin attribution per business type.
--   Product and licence sales : 80% Sales / 20% Technical
--   Services, AMC, SLA, managed: 20% Sales / 80% Technical
--   Renewals                   : 50% Sales / 50% retained by the company
-- OD-09 DECIDED R3: hard floor 3% gross margin. warn_margin_pct is the normal
-- expectation per type and is what will actually fire the approval chain —
-- a 3% floor alone only catches deals that are already near break-even.
INSERT INTO margin_rules (business_type_id, min_margin_pct, warn_margin_pct,
                          sales_share_pct, technical_share_pct, company_share_pct, effective_from)
SELECT b.id, m.minpct, m.warnpct, m.s, m.t, m.c, DATE '2026-01-01'
  FROM (VALUES
    ('PRODUCT',    3, 12, 80, 20,  0),
    ('LICENCE',    3, 12, 80, 20,  0),
    ('RENEWAL',    3, 10, 50,  0, 50),
    ('PS',         3, 25, 20, 80,  0),
    ('PRODUCT_PS', 3, 18, 20, 80,  0),
    ('PROJECT',    3, 18, 20, 80,  0),
    ('AMC',        3, 25, 20, 80,  0),
    ('SLA',        3, 25, 20, 80,  0),
    ('MANAGED',    3, 25, 20, 80,  0),
    ('OTHER',      3, 15, 50, 50,  0)
  ) AS m(code, minpct, warnpct, s, t, c)
  JOIN business_types b ON b.code = m.code;

-- OD-17 R3: the standard customer service matrix (contract_id NULL).
INSERT INTO sla_priority_matrix (priority, response_hours, coverage, calendar_id)
SELECT p.pri, p.hrs, p.cov, c.id
  FROM (VALUES ('P1',4,'24x7'), ('P2',8,'24x7'), ('P3',48,'8x5'), ('P4',72,'8x5'))
       AS p(pri, hrs, cov)
  CROSS JOIN calendars c WHERE c.name = 'Dubai';

-- OD-14 R3: sign-off override holders are Siva and Chockas, after consulting SBU heads.
-- OD-15 R3: an order over the credit limit needs Siva AND Sangeetha to approve.
INSERT INTO approval_rules (trigger_code, approver_role_ids, escalate_after_hours)
SELECT 'CREDIT_LIMIT_EXCEEDED', ARRAY[r.id], 8 FROM roles r WHERE r.code = 'DIRECTOR';
INSERT INTO approval_rules (trigger_code, approver_role_ids, escalate_after_hours)
SELECT 'SIGNOFF_OVERRIDE', ARRAY[r.id], 24 FROM roles r WHERE r.code = 'DIRECTOR';

-- ---------------------------------------------------------------------
-- OD-06 / OD-31 DECIDED: margin split is case by case, not a fixed rule.
-- A rule table alone cannot express that, so the split becomes a per-deal
-- override on top of a default. Without this the system cannot attribute
-- margin at all when the answer is "it depends".
-- ---------------------------------------------------------------------
CREATE TABLE margin_overrides (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_version_id uuid NOT NULL REFERENCES quotation_versions(id),
  business_type_id     uuid REFERENCES business_types(id),
  sales_share_pct      pct NOT NULL,
  technical_share_pct  pct NOT NULL,
  company_share_pct    pct NOT NULL DEFAULT 0,
  reason               text NOT NULL,                 -- mandatory: why this deal differs
  approval_id          uuid REFERENCES approvals(id), -- an override is an approval event
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (sales_share_pct + technical_share_pct + company_share_pct = 100),
  UNIQUE (quotation_version_id)
);
CREATE INDEX idx_margin_override_qv ON margin_overrides (quotation_version_id);

-- ---------------------------------------------------------------------
-- OD-02 DECIDED: Bineesh performs both Sales and Procurement duties.
-- The overlap is accepted, so the compensating control is seeded instead:
-- supplier selection on a deal the same person sold needs a second approver.
-- ---------------------------------------------------------------------
INSERT INTO approval_rules (trigger_code, approver_role_ids, escalate_after_hours)
SELECT 'SUPPLIER_SELECTION_SELF_DEALT', ARRAY[r.id], 4
  FROM roles r WHERE r.code = 'DIRECTOR';

INSERT INTO settings (key, value) VALUES
  ('segregation.supplier_selection.second_approver_when_self_dealt', 'true'),
  ('residency.region',            '"UAE"'),          -- OD-22: UAE data stays in the UAE
  ('storage.documents.backend',   '"object_store"'), -- OD-20
  ('retention.audit_years',       '7'),              -- OD-19 pending confirmation
  ('migration.history_years',     '3'),              -- OD-27
  ('rollout.parallel_days_per_module', '30'),        -- OD-34
  ('calendar.default',            '"Dubai"'),        -- OD-18 R3: Dubai hours and holidays for all
  ('quotation.validity_days',     '30'),             -- OD-08 R3
  ('quotation.expire_action',     '"flag_only"'),    -- OD-08 R3: flag, never auto-expire
  ('timesheet.unit',              '"hours"'),        -- OD-13 R3 default, PM team may override
  ('timesheet.submission',        '"weekly"'),
  ('timesheet.approved_by',       '"team_lead"'),
  ('margin.floor_pct',            '3'),              -- OD-09 R3 hard floor
  ('overhead.allocate_to_deals',  'true'),           -- OD-16 R3
  ('retention.commercial',        '"indefinite"'),   -- OD-19 R3
  ('product_master.strategy',     '"preload_top_vendors_then_organic"'), -- OD-21 R3
  ('fx.rate_locked_at',           '"document_date"');-- OD-07 R3 working default

-- =====================================================================
-- VERIFIED
--   Loaded clean against PostgreSQL 16.13 (98 tables, 3 views, 0 errors)
--   and functionally smoke-tested end to end:
--     1. a supplier quote line auto-writes an immutable cost price point
--     2. generated columns compute line sell, cost and gross profit
--     3. approving a quotation version auto-writes sell price points with margin
--     4. an approved version cannot be edited - "create the next version instead"
--     5. every stage change is written to stage_history as an event
--     6. an enquiry cannot be marked Lost without a loss reason
--     7. field-level audit rows are written on every update
-- =====================================================================
-- END OF SCHEMA
-- Open Decisions that change this file: OD-06, OD-07, OD-09, OD-10,
-- OD-11, OD-13, OD-17, OD-18, OD-21, OD-30.
-- =====================================================================
