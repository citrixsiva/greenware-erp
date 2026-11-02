-- =====================================================================
-- 003 — defect fixes found by integration testing, 2 Nov 2026
--
-- Three real defects in 001/002, all of which would have reached a build
-- partner as-is:
--   A. Trigger functions referenced tables unqualified and had no
--      search_path, so every one of them failed for any session whose
--      search_path was not already gw. That breaks stage changes, the
--      audit log and both price-history writers.
--   B. audit_log had partitions only for Sep and Oct 2026 and no DEFAULT,
--      so from 1 Nov every INSERT — and therefore every write in the
--      application — failed.
--   C. No monthly partition maintenance existed at all.
-- =====================================================================
SET search_path = gw, public;

-- ---- A. pin search_path on every trigger function ------------------
ALTER FUNCTION gw.fn_audit()                  SET search_path = gw, public;
ALTER FUNCTION gw.fn_log_enquiry_stage()      SET search_path = gw, public;
ALTER FUNCTION gw.fn_write_cost_price_point() SET search_path = gw, public;
ALTER FUNCTION gw.fn_write_sell_price_points()SET search_path = gw, public;
ALTER FUNCTION gw.fn_quote_version_immutable()SET search_path = gw, public;

-- ---- B. a DEFAULT partition so a missing month can never lose a row --
CREATE TABLE IF NOT EXISTS gw.audit_log_default PARTITION OF gw.audit_log DEFAULT;

-- ---- C. monthly partition maintenance ------------------------------
CREATE OR REPLACE FUNCTION gw.ensure_audit_partitions(months_ahead int DEFAULT 24)
RETURNS int AS $$
DECLARE
  m date := date_trunc('month', current_date)::date;
  i int := 0;
  nm text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    nm := 'audit_log_' || to_char(m + (i || ' month')::interval, 'YYYY"m"MM');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = nm) THEN
      EXECUTE format(
        'CREATE TABLE gw.%I PARTITION OF gw.audit_log FOR VALUES FROM (%L) TO (%L)',
        nm,
        (m + (i || ' month')::interval)::date,
        (m + ((i + 1) || ' month')::interval)::date);
    END IF;
  END LOOP;
  RETURN months_ahead;
END $$ LANGUAGE plpgsql SET search_path = gw, public;

SELECT gw.ensure_audit_partitions(24);

-- ---- D. the stage trigger could not record why ----------------------
-- stage_history is append-only, so the reason has to arrive with the change.
-- The application sets app.stage_reason inside its transaction.
CREATE OR REPLACE FUNCTION gw.fn_log_enquiry_stage() RETURNS trigger AS $$
BEGIN
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    INSERT INTO gw.stage_history (enquiry_id, from_stage, to_stage, changed_by, remarks)
    VALUES (NEW.id, OLD.stage, NEW.stage, NEW.updated_by,
            NULLIF(current_setting('app.stage_reason', true), ''));
  END IF;
  IF NEW.expected_po_date IS DISTINCT FROM OLD.expected_po_date
     AND OLD.expected_po_date IS NOT NULL THEN
    NEW.slip_count := OLD.slip_count + 1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = gw, public;

-- ---- E. audit coverage on the tables the app writes directly --------
CREATE TRIGGER trg_audit_customers AFTER INSERT OR UPDATE ON gw.customers
  FOR EACH ROW EXECUTE FUNCTION gw.fn_audit();
CREATE TRIGGER trg_audit_enquiries AFTER INSERT OR UPDATE ON gw.enquiries
  FOR EACH ROW EXECUTE FUNCTION gw.fn_audit();
CREATE TRIGGER trg_audit_suppliers AFTER INSERT OR UPDATE ON gw.suppliers
  FOR EACH ROW EXECUTE FUNCTION gw.fn_audit();
CREATE TRIGGER trg_audit_procurement_requests AFTER INSERT OR UPDATE ON gw.procurement_requests
  FOR EACH ROW EXECUTE FUNCTION gw.fn_audit();
CREATE TRIGGER trg_audit_estimation_requests AFTER INSERT OR UPDATE ON gw.estimation_requests
  FOR EACH ROW EXECUTE FUNCTION gw.fn_audit();
CREATE TRIGGER trg_audit_leads AFTER INSERT OR UPDATE ON gw.leads
  FOR EACH ROW EXECUTE FUNCTION gw.fn_audit();

-- ---- F. fn_audit must not choke on a null id ------------------------
CREATE OR REPLACE FUNCTION gw.fn_audit() RETURNS trigger AS $$
DECLARE k text; ov text; nv text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO gw.audit_log (actor_user_id, entity_type, entity_id, action)
    VALUES (NULLIF(current_setting('app.user_id', true),'')::uuid, TG_TABLE_NAME, NEW.id, 'create');
  ELSIF TG_OP = 'UPDATE' THEN
    FOR k IN SELECT jsonb_object_keys(to_jsonb(NEW)) LOOP
      ov := to_jsonb(OLD) ->> k;  nv := to_jsonb(NEW) ->> k;
      IF ov IS DISTINCT FROM nv AND k <> 'updated_at' THEN
        INSERT INTO gw.audit_log (actor_user_id, entity_type, entity_id, action,
                                  field_name, old_value, new_value)
        VALUES (NULLIF(current_setting('app.user_id', true),'')::uuid, TG_TABLE_NAME, NEW.id,
                'update', k, ov, nv);
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql SET search_path = gw, public;
