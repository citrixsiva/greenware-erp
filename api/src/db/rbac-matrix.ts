/**
 * The RBAC matrix from Part 2 of the blueprint, as data.
 * This is the single source of truth: the seed builds role_permissions from it,
 * and the test suite asserts every allow and every deny against it.
 * Codes: F full · W create+edit · R read · P approve · N none
 * Scope: A all · D department · S SBU · T team · O own/assigned
 */
export const ROLES = ['SUPER_ADMIN','DIRECTOR','SALES_MGR','SALES','PROCUREMENT','TECHNICAL','SBU_HEAD','PM','ACCOUNTS','ADMIN'] as const;
export type RoleCode = typeof ROLES[number];

export const MODULES = [
  'customers','enquiries','procurement_requests','supplier_quotes','technical_estimations',
  'quotations','customer_pos','projects','project_tasks','signoff','supplier_pos',
  'customer_invoices','receipts','supplier_invoices','suppliers','products','price_history',
  'documents','reports','admin','audit_log',
] as const;
export type ModuleCode = typeof MODULES[number];

export const MATRIX: Record<ModuleCode, Record<RoleCode, string>> = {
  customers:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'W/T', SALES:'W/O', PROCUREMENT:'R/A', TECHNICAL:'R/O', SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'W/A', ADMIN:'F/A' },
  enquiries:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'F/T', SALES:'F/O', PROCUREMENT:'R/A', TECHNICAL:'R/S', SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'R/A' },
  procurement_requests: { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'W/O', PROCUREMENT:'F/A', TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'N' },
  supplier_quotes:      { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'F/A', TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'N',   ACCOUNTS:'R/A', ADMIN:'N' },
  technical_estimations:{ SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'W/O', PROCUREMENT:'N',   TECHNICAL:'F/O', SBU_HEAD:'F/S', PM:'R/O', ACCOUNTS:'N',   ADMIN:'N' },
  quotations:           { SUPER_ADMIN:'F/A', DIRECTOR:'P/A', SALES_MGR:'P/T', SALES:'F/O', PROCUREMENT:'R/A', TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'N' },
  customer_pos:         { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'W/O', PROCUREMENT:'R/A', TECHNICAL:'R/S', SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'N' },
  projects:             { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'R/A', TECHNICAL:'W/O', SBU_HEAD:'F/S', PM:'F/O', ACCOUNTS:'R/A', ADMIN:'N' },
  project_tasks:        { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'R/O', PROCUREMENT:'N',   TECHNICAL:'W/O', SBU_HEAD:'F/S', PM:'F/O', ACCOUNTS:'R/A', ADMIN:'N' },
  signoff:              { SUPER_ADMIN:'F/A', DIRECTOR:'P/A', SALES_MGR:'N',   SALES:'R/O', PROCUREMENT:'N',   TECHNICAL:'W/O', SBU_HEAD:'P/S', PM:'F/O', ACCOUNTS:'R/A', ADMIN:'N' },
  supplier_pos:         { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'N',   PROCUREMENT:'F/A', TECHNICAL:'N',   SBU_HEAD:'N',   PM:'R/O', ACCOUNTS:'R/A', ADMIN:'N' },
  customer_invoices:    { SUPER_ADMIN:'F/A', DIRECTOR:'P/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'N',   PM:'R/O', ACCOUNTS:'F/A', ADMIN:'N' },
  receipts:             { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'N',   PM:'N',   ACCOUNTS:'F/A', ADMIN:'N' },
  supplier_invoices:    { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'N',   PROCUREMENT:'R/A', TECHNICAL:'N',   SBU_HEAD:'N',   PM:'N',   ACCOUNTS:'F/A', ADMIN:'N' },
  suppliers:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'R/A', PROCUREMENT:'F/A', TECHNICAL:'R/A', SBU_HEAD:'R/A', PM:'N',   ACCOUNTS:'R/A', ADMIN:'F/A' },
  products:             { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/A', SALES:'R/A', PROCUREMENT:'W/A', TECHNICAL:'R/A', SBU_HEAD:'W/S', PM:'R/A', ACCOUNTS:'R/A', ADMIN:'F/A' },
  price_history:        { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'R/A', TECHNICAL:'N',   SBU_HEAD:'R/S', PM:'N',   ACCOUNTS:'R/A', ADMIN:'N' },
  documents:            { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'W/O', PROCUREMENT:'W/A', TECHNICAL:'W/O', SBU_HEAD:'R/S', PM:'W/O', ACCOUNTS:'W/A', ADMIN:'F/A' },
  reports:              { SUPER_ADMIN:'F/A', DIRECTOR:'R/A', SALES_MGR:'R/T', SALES:'R/O', PROCUREMENT:'R/A', TECHNICAL:'R/O', SBU_HEAD:'R/S', PM:'R/O', ACCOUNTS:'R/A', ADMIN:'R/A' },
  admin:                { SUPER_ADMIN:'F/A', DIRECTOR:'N',   SALES_MGR:'N',   SALES:'N',   PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'N',   PM:'N',   ACCOUNTS:'N',   ADMIN:'W/A' },
  audit_log:            { SUPER_ADMIN:'R/A', DIRECTOR:'R/A', SALES_MGR:'N',   SALES:'N',   PROCUREMENT:'N',   TECHNICAL:'N',   SBU_HEAD:'N',   PM:'N',   ACCOUNTS:'N',   ADMIN:'N' },
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
