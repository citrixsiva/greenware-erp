export type Scope = 'A' | 'D' | 'S' | 'T' | 'O';

/** The six field groups from the blueprint's sensitive-field matrix. */
export type FieldGroup =
  | 'supplier_cost' | 'sell_price' | 'margin' | 'day_rate' | 'service_cost' | 'supplier_terms' | 'credit';

export interface AuthCtx {
  userId: string;
  employeeId: string | null;
  email: string;
  displayName: string;
  roles: string[];
  /** permission key -> widest scope held */
  perms: Map<string, Scope>;
  /** SBUs this employee belongs to (OD-01: a person can be in more than one) */
  sbuIds: string[];
  /** field groups visible, after role baseline plus live permission_grants */
  fields: Set<FieldGroup>;
  /** true where the field group is limited to records the user owns */
  fieldsOwnOnly: Set<FieldGroup>;
}
