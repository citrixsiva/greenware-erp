/**
 * Shapes of what the API returns. Anything that a field-level permission can remove is optional on purpose:
 * `undefined` means "the server did not send it", which the UI treats as "you may not see this".
 */

export type Scope = 'A' | 'D' | 'S' | 'T' | 'O';

export interface User {
  id: string;
  email: string;
  displayName: string;
  employeeId: string | null;
  roles: string[];
  sbuIds: string[];
  permissions: Record<string, Scope>;
  fields: string[];
  fieldsOwnOnly: string[];
}

export interface Sbu { id: string; code: string; name: string }
export interface BusinessType { id: string; code: string; name: string }
export interface TaxCode { id: string; code: string; description: string; rate_pct: number }
export interface LossReason { id: string; code: string; name: string }
export interface Bootstrap {
  sbus: Sbu[];
  business_types: BusinessType[];
  tax_codes: TaxCode[];
  currencies: { code: string; name: string }[];
  loss_reasons: LossReason[];
}

export interface Employee { id: string; full_name: string; is_active: boolean; roles: string[] }
export interface Supplier { id: string; supplier_code: string; name: string; default_currency: string }

export const STAGES = ['New', 'Qualifying', 'Working', 'Submitted', 'Pending', 'Won', 'Lost', 'Cancelled', 'Dropped'] as const;
export type Stage = (typeof STAGES)[number];

export interface EnquiryRow {
  id: string;
  enquiry_no: string;
  title: string;
  customer_id: string;
  customer_name: string;
  stage: Stage;
  probability: number | null;
  approx_budget: number | null;
  budget_currency: string | null;
  expected_po_date: string | null;
  expected_quote_date: string | null;
  account_manager_id: string;
  account_manager_name: string;
  primary_sbu_id: string | null;
  primary_sbu_code: string | null;
  business_type_id: string;
  received_at: string;
  slip_count: number;
  days_in_stage: number;
  next_follow_up: string | null;
  follow_up_overdue: boolean;
  value_aed: number | null;
  weighted_value_aed: number | null;
  /** Not sent by every role. Absent = not permitted. */
  gross_margin_pct?: number | null;
}

export interface BoardStage {
  stage: Stage;
  count: number;
  total_value: number;
  weighted_value: number;
  unconverted_count: number;
  cards: EnquiryRow[];
}
export interface Board { currency: string; cards_per_stage: number; stages: BoardStage[] }

export type SlaState = 'Within' | 'Approaching' | 'Breached';
export type SlaClock = 'running' | 'paused' | 'stopped';
export interface SlaFields {
  sla_state: SlaState;
  sla_clock: SlaClock;
  elapsed_working_hours: number;
  target_hours: number | null;
  pct_of_target: number | null;
}

export interface ProcRequest extends SlaFields {
  id: string;
  request_no: string;
  enquiry_id: string;
  enquiry_no: string;
  enquiry_title: string;
  customer_name: string;
  status: string;
  urgency: 'Normal' | 'Urgent';
  required_by: string | null;
  requested_by_name: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  raised_at: string;
  first_responded_at: string | null;
  line_count: number;
  supplier_quote_count: number;
  remarks: string | null;
  open_rfq?: { suppliers?: { id: string; name: string }[]; reference?: string | null } | null;
}
export interface ProcLine {
  id: string;
  enquiry_line_no: number | null;
  part_number: string | null;
  manufacturer_name: string | null;
  description: string;
  quantity: number;
}
export interface QuoteLine {
  id: string;
  part_number: string | null;
  description: string | null;
  quantity: number;
  unit_cost?: number;
  availability: string | null;
  lead_time_days: number | null;
}
export interface SupplierQuote {
  id: string;
  quote_no: string;
  supplier_id: string;
  supplier_name: string;
  supplier_ref: string | null;
  quote_date: string;
  valid_until: string | null;
  currency: string;
  payment_terms_days?: number | null;
  is_recommended: boolean;
  recommendation_reason: string | null;
  lines: QuoteLine[];
}
export interface ProcDetail extends ProcRequest {
  lines: ProcLine[];
  supplier_quotes: SupplierQuote[] | null;
}

export interface Offer {
  quote_id: string;
  quote_no: string;
  supplier_name: string;
  currency: string;
  is_recommended: boolean;
  quantity: number;
  availability: string | null;
  lead_time_days: number | null;
  valid_until: string | null;
  unit_cost?: number;
  unit_cost_base?: number;
  delta_pct_vs_last_purchase?: number;
  last_purchase: null | {
    supplier_name: string;
    quote_no: string;
    quoted_on: string;
    currency: string;
    unit_cost?: number;
    unit_cost_base?: number;
  };
}
export interface Comparison {
  request: { id: string; request_no: string; status: string; urgency: string; enquiry_no: string };
  lines: {
    request_line_id: string;
    enquiry_line_no: number | null;
    part_number: string | null;
    description: string;
    quantity: number;
    lowest_quote_id: string | null;
    offers: Offer[];
  }[];
  other_offers: (Offer & { part_number: string | null; description: string | null })[];
}

export interface EstRequest extends SlaFields {
  id: string;
  request_no: string;
  enquiry_id: string;
  enquiry_no: string;
  enquiry_title: string;
  customer_name: string;
  sbu_id: string;
  sbu_code: string;
  sbu_name: string;
  status: string;
  urgency: 'Normal' | 'Urgent';
  required_by: string | null;
  assigned_to: string | null;
  assigned_to_name: string | null;
  raised_at: string;
  first_responded_at: string | null;
  clarification_rounds: number;
  scope_notes: string | null;
  estimate_version: number | null;
  open_clarification: string | null;
}
export interface EstimateResource {
  id: string;
  role_name: string;
  seniority_band: string | null;
  headcount: number;
  days: number;
  mode: string;
  day_rate?: number | null;
}
export interface Estimate {
  id: string;
  version: number;
  submitted_by_name: string | null;
  submitted_at: string;
  scope_understanding: string;
  proposed_solution: string;
  total_days: number;
  mode: string;
  travel_required: boolean;
  travel_cost?: number | null;
  estimated_service_cost?: number | null;
  currency: string;
  assumptions: string | null;
  exclusions: string | null;
  dependencies: string | null;
  remarks: string | null;
  resources: EstimateResource[];
}
export interface EstDetail extends EstRequest {
  estimate: Estimate | null;
  estimate_history: { id: string; version: number; submitted_at: string; submitted_by_name: string | null }[];
  clarifications: { occurred_at: string; actor_name: string | null; kind: 'question' | 'answer'; text: string }[];
}

export interface QuoteVersionSummary {
  id: string;
  version_no: number;
  status: string;
  quote_date: string | null;
  valid_until: string | null;
  currency: string;
  total_sell?: number;
  total_cost?: number;
  gross_margin_pct?: number | null;
  gross_profit?: number;
  requires_approval: boolean;
}
export interface EnquiryDetail extends EnquiryRow {
  description: string | null;
  remarks: string | null;
  end_customer_name: string | null;
  business_type_code: string;
  business_type_name: string;
  loss_reason: string | null;
  loss_remarks: string | null;
  campaign_name: string | null;
  contact_name: string | null;
  contact_designation: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  created_at: string;
  lines: {
    id: string; line_no: number; technology_name: string | null; technology_category: string | null;
    description: string; quantity: number; sbu_code: string | null;
  }[];
  stage_history: { id: string; from_stage: string | null; to_stage: string; changed_at: string; changed_by_name: string | null; remarks: string | null }[];
  follow_ups: {
    id: string; followed_up_at: string; next_follow_up: string | null; channel: string | null;
    remarks: string; customer_feedback: string | null; created_by_name: string | null;
  }[];
  competitors: { id: string; competitor: string; known_price: number | null; currency: string | null; notes: string | null }[];
  /** null = the caller lacks the permission for the section; [] = none yet. */
  procurement_requests: { id: string; request_no: string; status: string; urgency: string; raised_at: string }[] | null;
  estimation_requests: { id: string; request_no: string; sbu_code: string | null; status: string; urgency: string; raised_at: string }[] | null;
  quotations: { id: string; quotation_no: string; current_version: number; versions: QuoteVersionSummary[] }[] | null;
  customer_pos: { id: string; po_ref: string; customer_po_number: string | null; po_date: string; currency: string; po_amount: number; booked_margin_pct?: number }[] | null;
}

export interface QuoteLineRow {
  id: string;
  line_no: number;
  part_number: string | null;
  description: string;
  quantity: number;
  unit_cost?: number;
  unit_price?: number;
  discount_pct?: number;
  tax_code_id: string | null;
  tax_code: string | null;
  tax_rate_pct: number | null;
  line_sell?: number;
  line_cost?: number;
  line_gp?: number;
  supplier_quote_line_id?: string | null;
  technical_estimate_id: string | null;
}
export interface ApprovalStep {
  id: string; step_no: number; approver_name: string; status: string; acted_at: string | null; comments: string | null;
}
export interface QuoteVersion extends QuoteVersionSummary {
  quotation_id: string;
  other_project_cost?: number;
  operation_charges?: number;
  training_charges?: number;
  total_tax: number;
  payment_terms: string | null;
  delivery_terms: string | null;
  scope: string | null;
  assumptions: string | null;
  exclusions: string | null;
  warranty: string | null;
  commercial_terms: string | null;
  approved_at: string | null;
  submitted_at: string | null;
  created_at: string;
  created_by_name: string | null;
  lines: QuoteLineRow[];
  approvals: { id: string; trigger_code: string; status: string; requested_by_name: string; requested_at: string; steps: ApprovalStep[] }[];
}
export interface QuotationDetail {
  id: string;
  quotation_no: string;
  enquiry_id: string;
  enquiry_no: string;
  enquiry_title: string;
  customer_name: string;
  owner_name: string;
  current_version: number;
  business_type_name: string;
  versions: QuoteVersion[];
}
export interface QuotationListRow {
  id: string; quotation_no: string; customer_name: string; enquiry_id: string; enquiry_no: string; owner_name: string;
  current_version: number; version_no: number | null; status: string | null; currency: string | null;
  total_sell?: number; gross_margin_pct?: number | null; valid_until: string | null; days_since_submission: number | null;
}
/** The margin endpoint is the one place the API answers in camelCase. */
export interface MarginInfo {
  versionId: string;
  versionNo: number;
  currency: string;
  totals: { totalSell?: number; totalCost?: number; grossProfit?: number; grossMarginPct?: number | null };
  rule: { salesSharePct: number; technicalSharePct: number; companySharePct: number; minMarginPct: number; warnMarginPct: number | null };
  override?: { salesSharePct: number; technicalSharePct: number; companySharePct: number; reason: string; approvalStatus: string | null; applied: boolean };
  attribution: { sales: number; technical: number; company: number };
  attributionSource: 'rule' | 'override';
}

export interface ApprovalRow {
  id: string;
  trigger_code: string;
  status: string;
  requested_by_name: string;
  raised_by_me: boolean;
  requested_at: string;
  step_id: string | null;
  step_no: number | null;
  /** The user whose turn it is; compare with the signed-in user to know whether this step is theirs to decide. */
  approver_id: string | null;
  escalate_after_hours: number | null;
  version_id: string | null;
  version_no: number | null;
  version_status: string | null;
  currency: string | null;
  total_sell?: number;
  gross_margin_pct?: number | null;
  quotation_id: string | null;
  quotation_no: string | null;
  customer_name: string | null;
  waiting_working_hours: number | null;
  overdue: boolean;
}

export interface AdminUser {
  id: string; email: string; display_name: string; is_active: boolean; last_login_at: string | null;
  employee_name: string | null; roles: { code: string; name: string }[];
}
export interface Role { id: string; code: string; name: string; user_count: number }
export interface Grant {
  id: string; user_id: string; user_name: string; field_group: string; granted_by_name: string | null;
  reason: string; valid_from: string; valid_to: string | null; revoked_at: string | null; is_live: boolean;
}

export interface TrendPoint { month: string; min: number; avg: number; max: number; points: number }
export interface PriceItem {
  sku: null | {
    id: string; part_number: string; description: string | null; uom: string | null;
    product: { id: string; name: string }; manufacturer: { id: string; name: string } | null;
  };
  part_number: string;
  match_score: number;
  cost?: {
    id: string; supplier_name: string; unit_cost?: number; currency: string; unit_cost_base?: number | null; quantity: number | null;
    availability: string | null; lead_time_days: number | null; payment_terms_days?: number | null; valid_until: string | null;
    quoted_on: string; enquiry_no: string | null; superseded: boolean;
  }[];
  sell?: {
    id: string; customer_name: string; unit_price?: number; discount_pct?: number; currency: string; quantity: number | null;
    quoted_on: string; outcome: string | null; enquiry_no: string | null;
  }[];
  margin?: { sell_point_id: string; quoted_on: string; quantity: number | null; outcome: string | null; margin_pct?: number; enquiry_no: string | null }[];
  trend?: { cost?: TrendPoint[]; sell?: TrendPoint[]; currency: string };
  summary?: {
    last_purchase?: null | { supplier_name: string; unit_cost?: number; currency: string; date: string; basis: string; enquiry_no: string | null };
    best_current_price?: null | { supplier_name: string; unit_cost?: number; currency: string; unit_cost_base?: number; lead_time_days: number | null; valid_until: string | null };
    customers_quoted?: number;
    win_rate_pct?: number | null;
    won?: number;
    lost?: number;
  };
}
