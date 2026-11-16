/**
 * The RBAC matrix from Part 2 of the blueprint, as data.
 * This is the single source of truth: the seed builds role_permissions from it,
 * and the test suite asserts every allow and every deny against it.
 * Codes: F full · W create+edit · R read · P approve · N none
 * Scope: A all · D department · S SBU · T team · O own/assigned
 */
export const ROLES = ['SUPER_ADMIN','DIRECTOR','SALES_MGR','SALES','PROCUREMENT','TECHNICAL','SBU_HEAD','PM','ACCOUNTS','ADMIN','MARKETING'] as const;
export type RoleCode = typeof ROLES[number];

export const MODULES = [
  'customers','enquiries','procurement_requests','supplier_quotes','technical_estimations',
  'quotations','customer_pos','projects','project_tasks','signoff','supplier_pos',
  'customer_invoices','receipts','supplier_invoices','suppliers','products','price_history',
  'documents','reports','admin','audit_log',
  // Deal Desk (cluster 15). Until these existed the lead and campaign routes
  // borrowed `enquiries.*`, which meant marketing data was governed by sales
  // permissions and nobody could work leads without the sales pipeline too.
  'leads','campaigns','activities',
] as const;
export type ModuleCode = typeof MODULES[number];

export const MATRIX: Record<ModuleCode, Record<RoleCode, string>> = {
  customers:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'W/T', SALES:'W/O', PROCUREMENT:'R/A', TECHNICAL:'R/O', SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'W/A', ADMIN:'F/A', MARKETING:'R/A' },
  enquiries:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'F/T', SALES:'F/O', PROCUREMENT:'R/A', TECHNICAL:'R/S', SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'R/A', MARKETING:'R/A' },
  procurement_requests: { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'W/O', PROCUREMENT:'F/A', TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  supplier_quotes:      { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'F/A', TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'N',   ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  technical_estimations:{ SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'W/O', PROCUREMENT:'N',   TECHNICAL:'F/O', SBU_HEAD:'F/S', PM:'R/O', ACCOUNTS:'N',   ADMIN:'N', MARKETING:'N' },
  quotations:           { SUPER_ADMIN:'F/A', DIRECTOR:'P/A', SALES_MGR:'P/T', SALES:'F/O', PROCUREMENT:'R/A', TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  customer_pos:         { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'W/O', PROCUREMENT:'R/A', TECHNICAL:'R/S', SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  projects:             { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'R/A', TECHNICAL:'W/O', SBU_HEAD:'F/S', PM:'F/O', ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  project_tasks:        { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'R/O', PROCUREMENT:'N',   TECHNICAL:'W/O', SBU_HEAD:'F/S', PM:'F/O', ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  signoff:              { SUPER_ADMIN:'F/A', DIRECTOR:'P/A', SALES_MGR:'N',   SALES:'R/O', PROCUREMENT:'N',   TECHNICAL:'W/O', SBU_HEAD:'P/S', PM:'F/O', ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  supplier_pos:         { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'N',   PROCUREMENT:'F/A', TECHNICAL:'N',   SBU_HEAD:'N',   PM:'R/O', ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  customer_invoices:    { SUPER_ADMIN:'F/A', DIRECTOR:'P/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'N',   PM:'R/O', ACCOUNTS:'F/A', ADMIN:'N', MARKETING:'N' },
  receipts:             { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'N',   PM:'N',   ACCOUNTS:'F/A', ADMIN:'N', MARKETING:'N' },
  supplier_invoices:    { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'N',   PROCUREMENT:'R/A', TECHNICAL:'N',   SBU_HEAD:'N',   PM:'N',   ACCOUNTS:'F/A', ADMIN:'N', MARKETING:'N' },
  suppliers:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'R/A', PROCUREMENT:'F/A', TECHNICAL:'R/A', SBU_HEAD:'R/A', PM:'N',   ACCOUNTS:'R/A', ADMIN:'F/A', MARKETING:'N' },
  products:             { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/A', SALES:'R/A', PROCUREMENT:'W/A', TECHNICAL:'R/A', SBU_HEAD:'W/S', PM:'R/A', ACCOUNTS:'R/A', ADMIN:'F/A', MARKETING:'R/A' },
  price_history:        { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'R/A', TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'N',   ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'N' },
  documents:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'W/O', PROCUREMENT:'W/A', TECHNICAL:'W/O', SBU_HEAD:'R/S', PM:'W/O', ACCOUNTS:'W/A', ADMIN:'F/A', MARKETING:'W/O' },
  reports:              { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'R/A', TECHNICAL:'R/O', SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'R/A', MARKETING:'R/A' },
  admin:                { SUPER_ADMIN:'F/A', DIRECTOR:'N',   SALES_MGR:'N',   SALES:'N',   PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'N',   PM:'N',   ACCOUNTS:'N',   ADMIN:'W/A', MARKETING:'N' },
  audit_log:            { SUPER_ADMIN:'R/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'N',   PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'N',   PM:'N',   ACCOUNTS:'N',   ADMIN:'N', MARKETING:'N' },
  // Deal Desk. Sales keeps its own leads; marketing works the whole board.
  leads:                { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'F/T', SALES:'F/O', PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'N',   ACCOUNTS:'N',   ADMIN:'N', MARKETING:'F/A' },
  campaigns:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/A', SALES:'R/A', PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'R/A', PM:'N',   ACCOUNTS:'R/A', ADMIN:'N', MARKETING:'F/A' },
  activities:           { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'W/T', SALES:'W/O', PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'W/O', ACCOUNTS:'N',   ADMIN:'N', MARKETING:'F/A' },
};

export const ACTIONS = ['view','create','edit','approve','export','delete'] as const;
export type ActionCode = typeof ACTIONS[number];

/** Expands a matrix cell into the actions it grants. Nobody gets delete: history is append-only. */
export function actionsFor(cell: string): ActionCode[] {
  const level = cell.split('/')[0];
  switch (level) {
    case 'F': return ['view', 'create', 'edit', 'approve', 'export'];
    case 'W': return ['view', 'create', 'edit', 'export'];
    case 'P': return ['view', 'approve', 'export'];
    case 'R': return ['view', 'export'];
    default:  return [];
  }
}
export const scopeOf = (cell: string) => (cell.includes('/') ? cell.split('/')[1] : 'O') as 'A'|'D'|'S'|'T'|'O';
export const permKey = (m: ModuleCode, a: ActionCode) => `${m}.${a}`;
