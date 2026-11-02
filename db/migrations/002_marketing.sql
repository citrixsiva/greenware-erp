-- =====================================================================
-- GREENWARE DEAL DESK — SALES & MARKETING MODULE
-- Cluster 15 · schema extension  ·  PostgreSQL 16
--
-- Modelled on HubSpot's object model, adapted to the enquiry-to-cash
-- spine. Run AFTER greenware_erp_schema.sql.
--
-- Mapping, in one line each:
--   HubSpot contact   -> customer_contacts   (already exists)
--   HubSpot company   -> customers           (already exists)
--   HubSpot deal      -> enquiries           (already exists)
--   HubSpot quote     -> quotation_versions  (already exists, versioned)
--   HubSpot timeline  -> activities + audit_log
--   Everything below is what HubSpot has that the base schema did not.
-- =====================================================================

SET search_path = gw, public;

CREATE TYPE lead_status     AS ENUM ('New','Working','Nurturing','Qualified','Disqualified','Recycled');
CREATE TYPE activity_kind   AS ENUM ('Call','Email','Meeting','Note','Task','LinkedIn','WhatsApp','SiteVisit');
CREATE TYPE email_event_kind AS ENUM ('Sent','Delivered','Opened','Clicked','Replied','Bounced','Unsubscribed');
CREATE TYPE seq_enrol_status AS ENUM ('Active','Paused','Completed','Replied','Unenrolled');
CREATE TYPE task_state      AS ENUM ('Open','Done','Cancelled');

-- ---------------------------------------------------------------------
-- CAMPAIGNS & ATTRIBUTION  (HubSpot: campaigns)
-- ---------------------------------------------------------------------
CREATE TABLE campaigns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_code  varchar(32) NOT NULL UNIQUE,
  name           short_text NOT NULL,
  channel        varchar(32) NOT NULL,          -- Email | Webinar | Event | Digital | Content | Outbound
  owner_id       uuid REFERENCES employees(id),
  technology_category_id uuid REFERENCES technology_categories(id),
  start_date     date NOT NULL,
  end_date       date,
  budget         money_amt,
  spend          money_amt NOT NULL DEFAULT 0,
  currency       ccy NOT NULL DEFAULT 'AED',
  target_leads   int,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_costs (                    -- spend recorded as it lands, not guessed at year end
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  cost_date    date NOT NULL,
  description  short_text,
  amount       money_amt NOT NULL,
  currency     ccy NOT NULL DEFAULT 'AED',
  supplier_id  uuid REFERENCES suppliers(id)
);

-- ---------------------------------------------------------------------
-- LEADS  (HubSpot: contacts before they become a deal)
-- ---------------------------------------------------------------------
CREATE TABLE leads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_no           varchar(32) NOT NULL UNIQUE,          -- LED-2026-00318
  company_id        uuid NOT NULL REFERENCES companies(id),
  company_name      short_text NOT NULL,                  -- free text until it becomes a customer
  customer_id       uuid REFERENCES customers(id),        -- set when matched to an existing account
  contact_name      short_text,
  designation       short_text,
  email             short_text,
  phone             short_text,
  country           varchar(2),
  campaign_id       uuid REFERENCES campaigns(id),
  source            short_text,                           -- 'Backup & DR webinar', 'GITEX booth scan'
  source_detail     text,
  technology_id     uuid REFERENCES technologies(id),
  sbu_id            uuid REFERENCES sbus(id),             -- routed from technology
  estimated_value   money_amt,
  currency          ccy DEFAULT 'AED',
  score             int NOT NULL DEFAULT 0,
  status            lead_status NOT NULL DEFAULT 'New',
  owner_id          uuid REFERENCES employees(id),
  qualified_at      timestamptz,
  qualified_enquiry_id uuid REFERENCES enquiries(id),     -- the handoff into enquiry-to-cash
  disqualify_reason short_text,
  consent_marketing boolean NOT NULL DEFAULT false,       -- lawful basis for outbound
  consent_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  row_version       int NOT NULL DEFAULT 1,
  CONSTRAINT lead_disqualify_reason
    CHECK (status <> 'Disqualified' OR disqualify_reason IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- LEAD SCORING  (HubSpot: score properties)
-- ---------------------------------------------------------------------
CREATE TABLE scoring_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          varchar(48) NOT NULL UNIQUE,
  name          short_text NOT NULL,
  dimension     varchar(12) NOT NULL CHECK (dimension IN ('Fit','Behaviour')),
  condition     jsonb NOT NULL,                 -- {field, op, value} evaluated by the rules engine
  weight        int NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL DEFAULT current_date
);

CREATE TABLE lead_score_events (                -- append-only: why a score is what it is
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  rule_id    uuid REFERENCES scoring_rules(id),
  delta      int NOT NULL,
  reason     short_text,
  scored_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- ACTIVITIES & TASKS  (HubSpot: timeline + task queue)
-- ---------------------------------------------------------------------
CREATE TABLE activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          activity_kind NOT NULL,
  entity_type   short_text NOT NULL,            -- lead | customer | enquiry | project | customer_invoice
  entity_id     uuid NOT NULL,
  customer_id   uuid REFERENCES customers(id),  -- denormalised so Customer 360 is one query
  lead_id       uuid REFERENCES leads(id),
  enquiry_id    uuid REFERENCES enquiries(id),
  contact_id    uuid REFERENCES customer_contacts(id),
  subject       short_text NOT NULL,
  body          text,
  outcome       short_text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  duration_mins int,
  performed_by  uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        short_text NOT NULL,
  notes        text,
  entity_type  short_text,
  entity_id    uuid,
  assigned_to  uuid NOT NULL REFERENCES users(id),
  due_at       timestamptz,
  priority     varchar(8) CHECK (priority IN ('Low','Normal','High')),
  state        task_state NOT NULL DEFAULT 'Open',
  source       varchar(24),                     -- Manual | Sequence | Automation
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid REFERENCES users(id)
);

-- ---------------------------------------------------------------------
-- EMAIL TRACKING  (HubSpot: email events)  — sent via M365 Graph
-- ---------------------------------------------------------------------
CREATE TABLE email_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction     varchar(8) NOT NULL CHECK (direction IN ('Out','In')),
  entity_type   short_text,
  entity_id     uuid,
  lead_id       uuid REFERENCES leads(id),
  enquiry_id    uuid REFERENCES enquiries(id),
  contact_id    uuid REFERENCES customer_contacts(id),
  campaign_id   uuid REFERENCES campaigns(id),
  sequence_id   uuid,
  from_user_id  uuid REFERENCES users(id),      -- sent from the rep's own mailbox
  to_address    short_text NOT NULL,
  subject       short_text,
  graph_message_id short_text,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  kind        email_event_kind NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  link_url    text,
  user_agent  text
);

-- ---------------------------------------------------------------------
-- SEQUENCES  (HubSpot: sequences)
-- ---------------------------------------------------------------------
CREATE TABLE sequences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        short_text NOT NULL,
  description text,
  owner_id    uuid REFERENCES employees(id),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id   uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_no       int NOT NULL,
  delay_days    int NOT NULL DEFAULT 0,
  action        varchar(16) NOT NULL CHECK (action IN ('Email','Task','Call','Wait')),
  template_id   uuid,
  subject       short_text,
  body          text,
  UNIQUE (sequence_id, step_no)
);

CREATE TABLE sequence_enrollments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id   uuid NOT NULL REFERENCES sequences(id),
  lead_id       uuid REFERENCES leads(id),
  contact_id    uuid REFERENCES customer_contacts(id),
  enrolled_by   uuid REFERENCES users(id),
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  current_step  int NOT NULL DEFAULT 0,
  next_action_at timestamptz,
  status        seq_enrol_status NOT NULL DEFAULT 'Active',
  ended_at      timestamptz,
  CHECK (lead_id IS NOT NULL OR contact_id IS NOT NULL)
);

-- ---------------------------------------------------------------------
-- FORMS & LISTS  (HubSpot: forms, lists)
-- ---------------------------------------------------------------------
CREATE TABLE web_forms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         varchar(48) NOT NULL UNIQUE,
  name         short_text NOT NULL,
  campaign_id  uuid REFERENCES campaigns(id),
  fields       jsonb NOT NULL,
  redirect_url text,
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE form_submissions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id      uuid NOT NULL REFERENCES web_forms(id),
  lead_id      uuid REFERENCES leads(id),
  payload      jsonb NOT NULL,
  page_url     text,
  ip_address   inet,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         short_text NOT NULL,
  is_dynamic   boolean NOT NULL DEFAULT true,
  criteria     jsonb,                            -- dynamic membership
  owner_id     uuid REFERENCES employees(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing_list_members (
  list_id    uuid NOT NULL REFERENCES marketing_lists(id) ON DELETE CASCADE,
  lead_id    uuid REFERENCES leads(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES customer_contacts(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (lead_id IS NOT NULL OR contact_id IS NOT NULL)
);
CREATE UNIQUE INDEX uq_mlm_lead    ON marketing_list_members (list_id, lead_id)    WHERE lead_id IS NOT NULL;
CREATE UNIQUE INDEX uq_mlm_contact ON marketing_list_members (list_id, contact_id) WHERE contact_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- AUTOMATION  (HubSpot: workflows)
-- ---------------------------------------------------------------------
CREATE TABLE automation_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          varchar(48) NOT NULL UNIQUE,
  name          short_text NOT NULL,
  description   text,
  trigger_event varchar(64) NOT NULL,            -- PO_RECEIVED | CONTRACT_EXPIRING | SLA_80 | LEAD_SCORED | ...
  conditions    jsonb,
  actions       jsonb NOT NULL,                  -- ordered list of typed actions
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id)
);

CREATE TABLE automation_runs (
  id           bigserial PRIMARY KEY,
  rule_id      uuid NOT NULL REFERENCES automation_rules(id),
  entity_type  short_text,
  entity_id    uuid,
  ran_at       timestamptz NOT NULL DEFAULT now(),
  outcome      varchar(12) NOT NULL CHECK (outcome IN ('Executed','Skipped','Failed')),
  detail       text
);

-- ---------------------------------------------------------------------
-- ATTRIBUTION HOOKS ON THE EXISTING SPINE
-- ---------------------------------------------------------------------
ALTER TABLE enquiries ADD COLUMN lead_id     uuid REFERENCES leads(id);
ALTER TABLE enquiries ADD COLUMN campaign_id uuid REFERENCES campaigns(id);
ALTER TABLE enquiries ADD COLUMN source      short_text;

-- Campaign performance, end to end. This is the number nothing in the
-- current three workbooks can produce.
CREATE OR REPLACE VIEW v_campaign_attribution AS
SELECT c.id AS campaign_id, c.campaign_code, c.name, c.channel, c.spend,
       COUNT(DISTINCT l.id)                                        AS leads,
       COUNT(DISTINCT l.id) FILTER (WHERE l.status='Qualified')    AS qualified,
       COUNT(DISTINCT e.id)                                        AS enquiries,
       COALESCE(SUM(DISTINCT e.approx_budget),0)                   AS enquiry_value,
       COUNT(DISTINCT e.id) FILTER (WHERE e.stage='Won')           AS won_count,
       COALESCE(SUM(po.net_value),0)                               AS won_value,
       CASE WHEN COUNT(DISTINCT l.id) FILTER (WHERE l.status='Qualified') > 0
            THEN c.spend / COUNT(DISTINCT l.id) FILTER (WHERE l.status='Qualified')
       END                                                          AS cost_per_qualified_lead,
       CASE WHEN c.spend > 0 THEN COALESCE(SUM(po.net_value),0) / c.spend END AS return_multiple
  FROM campaigns c
  LEFT JOIN leads l      ON l.campaign_id = c.id
  LEFT JOIN enquiries e  ON e.campaign_id = c.id
  LEFT JOIN customer_pos po ON po.enquiry_id = e.id
 GROUP BY c.id, c.campaign_code, c.name, c.channel, c.spend;

-- The lead inbox, ordered the way the screen orders it.
CREATE OR REPLACE VIEW v_lead_inbox AS
SELECT l.id, l.lead_no, l.company_name, l.contact_name, l.designation,
       l.source, c.name AS campaign, t.name AS technology, s.code AS sbu,
       l.score, l.estimated_value, l.status,
       e.full_name AS owner,
       EXTRACT(day FROM now() - l.created_at)::int AS age_days
  FROM leads l
  LEFT JOIN campaigns c    ON c.id = l.campaign_id
  LEFT JOIN technologies t ON t.id = l.technology_id
  LEFT JOIN sbus s         ON s.id = l.sbu_id
  LEFT JOIN employees e    ON e.id = l.owner_id
 WHERE l.status IN ('New','Working','Nurturing');

-- ---------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------
CREATE INDEX idx_leads_status_score ON leads (status, score DESC, created_at DESC);
CREATE INDEX idx_leads_owner        ON leads (owner_id, status);
CREATE INDEX idx_leads_campaign     ON leads (campaign_id);
CREATE INDEX idx_leads_company_trgm ON leads USING gin (company_name gin_trgm_ops);
CREATE INDEX idx_act_customer       ON activities (customer_id, occurred_at DESC);
CREATE INDEX idx_act_entity         ON activities (entity_type, entity_id, occurred_at DESC);
CREATE INDEX idx_act_lead           ON activities (lead_id, occurred_at DESC);
CREATE INDEX idx_tasks_queue        ON tasks (assigned_to, state, due_at);
CREATE INDEX idx_email_lead         ON email_messages (lead_id, sent_at DESC);
CREATE INDEX idx_email_ev           ON email_events (message_id, kind);
CREATE INDEX idx_seq_next           ON sequence_enrollments (next_action_at) WHERE status = 'Active';
CREATE INDEX idx_enq_campaign       ON enquiries (campaign_id);
CREATE INDEX idx_autoruns_rule      ON automation_runs (rule_id, ran_at DESC);

-- ---------------------------------------------------------------------
-- SEED — the automation rules shown in the prototype
-- ---------------------------------------------------------------------
INSERT INTO automation_rules (code, name, description, trigger_event, actions) VALUES
 ('PO_MOBILISE','PO received — mobilise everyone',
  'One action replaces a chain of forwarded emails.','PO_RECEIVED',
  '[{"a":"create_project"},{"a":"freeze_booked_margin"},{"a":"notify","to":["pm","procurement","sbu_head","accounts","sales"]},{"a":"create_task","for":"procurement","title":"Raise supplier PO"}]'),
 ('RENEWAL_WINDOW','Renewal expiring',
  'Closes the largest silent revenue leak in the business.','CONTRACT_EXPIRING',
  '[{"a":"create_enquiry","business_type":"RENEWAL"},{"a":"assign","to":"account_manager"},{"a":"notify","channels":["Teams","Email"]}]'),
 ('FOLLOWUP_OVERDUE','Follow-up overdue',
  'Pipeline discipline without a manager chasing it.','FOLLOWUP_DUE',
  '[{"a":"notify","to":["owner"]},{"a":"escalate_after_days","n":3,"to":["sales_manager"]}]'),
 ('MARGIN_GATE','Margin below threshold',
  'Interrupts the quotation before it reaches the customer.','QUOTATION_PRICED',
  '[{"a":"evaluate","rule":"margin_rules"},{"a":"raise_approval","chain":["SALES_MGR","DIRECTOR"]},{"a":"block","action":"submit"}]'),
 ('SLA_WATCH','SLA approaching or breached',
  'Most breaches are avoidable with one reminder at 80 percent.','SLA_THRESHOLD',
  '[{"a":"notify","to":["assignee"],"at_pct":80},{"a":"notify","to":["manager"],"at_pct":100}]'),
 ('LEAD_ROUTE','Lead scoring and routing',
  'Score on fit and behaviour, route on technology to the owning SBU.','LEAD_SCORED',
  '[{"a":"score","rules":"scoring_rules"},{"a":"route_by","field":"technology_id"},{"a":"create_task","for":"owner","title":"Qualify lead"}]');

INSERT INTO scoring_rules (code, name, dimension, condition, weight) VALUES
 ('FIT_SIZE',      'Company size band',        'Fit',       '{"field":"employee_band","op":"gte","value":200}', 15),
 ('FIT_INDUSTRY',  'Target industry',          'Fit',       '{"field":"industry","op":"in","value":["Banking","Healthcare","Logistics","Government"]}', 12),
 ('FIT_EXISTING',  'Existing customer',        'Fit',       '{"field":"customer_id","op":"not_null"}', 20),
 ('FIT_TECH',      'Technology we lead in',    'Fit',       '{"field":"technology_id","op":"in_sbu","value":["SBU2","SBU4"]}', 10),
 ('BEH_FORM',      'Submitted a form',         'Behaviour', '{"event":"form_submission"}', 18),
 ('BEH_WEBINAR',   'Attended a webinar',       'Behaviour', '{"event":"webinar_attended"}', 22),
 ('BEH_PRICING',   'Viewed the pricing page',  'Behaviour', '{"event":"page_view","value":"/pricing"}', 14),
 ('BEH_REPLY',     'Replied to a sequence',    'Behaviour', '{"event":"email_replied"}', 25),
 ('BEH_STALE',     'No engagement in 30 days', 'Behaviour', '{"event":"inactive_days","value":30}', -15);

-- =====================================================================
-- VERIFIED: loads clean on top of greenware_erp_schema.sql
--   18 tables, 2 views, 6 automation rules, 9 scoring rules seeded.
-- Open Decisions this cluster raises:
--   OD-29 marketing in scope  -> ANSWERED: yes, HubSpot-modelled
--   OD-35 marketing consent / lawful basis for outbound email
--   OD-36 does the corporate website post forms here, or stay separate
--   OD-37 sending domain and reputation: rep mailbox via Graph, or bulk sender
-- =====================================================================
