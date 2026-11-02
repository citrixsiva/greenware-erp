import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api, errorMessage, type Page, UserError } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtDec, fmtInt, fmtPct, isNum } from '../lib/format';
import { useEmployees, usePagedList } from '../lib/hooks';
import type { AdminUser, Grant, Role } from '../lib/types';
import { FormDialog, MessageDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import {
  Chip, DataView, EmptyState, ErrorState, Field, LoadingState, MoreButton, PageHead, Panel, PlusIcon, StatusPill,
} from '../components/ui';

/* ───────────────────────── shapes these screens own ───────────────────────── */

interface Setting { key: string; value: unknown; updated_at: string | null; updated_by: string | null }
interface MarginRule {
  id: string; business_type_id: string; business_type_code: string; business_type_name: string;
  min_margin_pct: number | null; warn_margin_pct: number | null;
  sales_share_pct: number; technical_share_pct: number; company_share_pct: number;
  effective_from: string; effective_to: string | null;
}
interface SlaRule {
  id: string; timer_code: string; urgency: string; target_hours: number; calendar_id: string | null;
  calendar_name: string | null; warn_at_pct: number | null; escalate_role_ids: string[] | null;
  effective_from: string; effective_to: string | null; is_active: boolean;
}

/** Only these groups can be granted; the list mirrors the server's own enum. */
const FIELD_GROUPS = ['supplier_cost', 'sell_price', 'margin', 'day_rate', 'supplier_terms', 'credit'] as const;
const GROUP_LABEL: Record<string, string> = {
  supplier_cost: 'Supplier cost', sell_price: 'Selling price', margin: 'Margin',
  day_rate: 'Engineer day rate', supplier_terms: 'Supplier terms', credit: 'Customer credit',
};

type TabKey = 'users' | 'roles' | 'grants' | 'settings' | 'margin' | 'sla';
const TABS: { key: TabKey; label: string; /** the permission the GET behind it really needs */ perm: 'admin.view' | 'admin.edit' }[] = [
  { key: 'users', label: 'Users', perm: 'admin.view' },
  { key: 'roles', label: 'Roles', perm: 'admin.view' },
  { key: 'grants', label: 'Field access', perm: 'admin.view' },
  { key: 'settings', label: 'Settings', perm: 'admin.view' },
  { key: 'margin', label: 'Margin rules', perm: 'admin.edit' },
  { key: 'sla', label: 'SLA rules', perm: 'admin.edit' },
];

/** Small wrapper so every tab gets the same loading / error / empty treatment. */
function Section<T>({ query, title, count, actions, empty, children }: {
  query: UseQueryResult<T[]>; title: string; count?: number; actions?: ReactNode; empty: string;
  children: (rows: T[]) => ReactNode;
}) {
  return (
    <Panel title={title} count={count ?? (query.data?.length ?? '')} actions={actions} flush>
      <DataView query={query} isEmpty={(d) => d.length === 0} empty={<EmptyState title={empty} />}>
        {(rows) => <>{children(rows)}</>}
      </DataView>
    </Panel>
  );
}

/* ───────────────────────── users ───────────────────────── */

function NewUserDialog({ roles, onClose, onDone }: { roles: Role[]; onClose: () => void; onDone: () => void }) {
  const emp = useEmployees();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <FormDialog
      title="Add a user"
      submitLabel="Create user"
      onClose={onClose}
      onSubmit={async () => {
        if (!email.trim()) throw new UserError('A work email address is required.');
        if (!name.trim()) throw new UserError('Give the person a display name.');
        await api.post('/admin/users', {
          email: email.trim(),
          displayName: name.trim(),
          employeeId: employeeId || undefined,
          roleCodes: picked,
        });
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Work email" required>{(p) => <input {...p} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label="Display name" required>{(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Employee record" hint="Links the login to the person's record so ownership and SBU scope work.">
          {(p) => (
            <select {...p} className="select" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">{emp.isPending ? 'Loading…' : 'Not linked'}</option>
              {emp.data?.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}
            </select>
          )}
        </Field>
      </div>
      <Field label="Roles" hint="A user with no role can sign in but sees nothing.">
        {() => (
          <div className="stack" style={{ gap: 6, maxHeight: 220, overflow: 'auto' }}>
            {roles.map((r) => (
              <label key={r.id} className="check">
                <input
                  type="checkbox"
                  checked={picked.includes(r.code)}
                  onChange={(e) => setPicked(e.target.checked ? [...picked, r.code] : picked.filter((c) => c !== r.code))}
                />
                {r.name} <span className="muted mono">{r.code}</span>
              </label>
            ))}
          </div>
        )}
      </Field>
    </FormDialog>
  );
}

function RolesDialog({ user, roles, onClose, onDone }: { user: AdminUser; roles: Role[]; onClose: () => void; onDone: () => void }) {
  const held = new Set(user.roles.map((r) => r.code));
  const [add, setAdd] = useState('');
  return (
    <FormDialog
      title={`Roles for ${user.display_name}`}
      submitLabel="Add role"
      onClose={onClose}
      disabled={!add}
      onSubmit={async () => {
        if (!add) throw new UserError('Choose a role to add.');
        await api.post(`/admin/users/${user.id}/roles`, { roleCode: add });
        onDone();
      }}
    >
      <Field label="Roles held now">
        {() => (
          <div className="tag-list">
            {user.roles.length === 0 ? <span className="muted">None</span> : user.roles.map((r) => <Chip key={r.code} mono title={r.name}>{r.code}</Chip>)}
          </div>
        )}
      </Field>
      <Field label="Add a role">
        {(p) => (
          <select {...p} className="select" value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Choose a role…</option>
            {roles.filter((r) => !held.has(r.code)).map((r) => <option key={r.id} value={r.code}>{r.name} · {r.code}</option>)}
          </select>
        )}
      </Field>
      <p className="muted">Removing a role is done from the user row. Only a Super Administrator may hand out or take away SUPER_ADMIN.</p>
    </FormDialog>
  );
}

function UsersTab({ roles, onError }: { roles: Role[]; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = useCan('admin.edit');
  const canCreate = useCan('admin.create');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [active, setActive] = useState('all');
  const [role, setRole] = useState('');
  const [dlg, setDlg] = useState<null | { kind: 'new' } | { kind: 'roles'; user: AdminUser } | { kind: 'drop'; user: AdminUser; code: string }>(null);

  const list = usePagedList<AdminUser>(['admin-users'], '/admin/users', {
    q: term || undefined, active, role: role || undefined,
  });
  const reload = () => qc.invalidateQueries({ queryKey: ['admin-users'] });

  return (
    <>
      <form className="filters" onSubmit={(e) => { e.preventDefault(); setTerm(q.trim()); }}>
        <label className="field" style={{ minWidth: 240 }}>
          <span className="label">Search</span>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or email" />
        </label>
        <label className="field">
          <span className="label">Status</span>
          <select className="select" value={active} onChange={(e) => setActive(e.target.value)}>
            <option value="all">Any</option><option value="true">Active</option><option value="false">Deactivated</option>
          </select>
        </label>
        <label className="field">
          <span className="label">Role</span>
          <select className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Any role</option>
            {roles.map((r) => <option key={r.id} value={r.code}>{r.name}</option>)}
          </select>
        </label>
        <button type="submit" className="btn">Search</button>
      </form>

      <Panel
        title="Users"
        count={list.isPending ? '' : `${list.rows.length}${list.hasMore ? '+' : ''}`}
        flush
        actions={canCreate ? <button type="button" className="btn btn--sm" onClick={() => setDlg({ kind: 'new' })}><PlusIcon /> Add user</button> : null}
      >
        {list.isPending ? <LoadingState label="Loading users" /> : list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : list.rows.length === 0 ? (
          <EmptyState title="No user matches" hint="Clear the search, or widen the status and role filters." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Employee</th><th>Roles</th><th>Last signed in</th><th>Status</th>{canEdit ? <th><span className="sr-only">Actions</span></th> : null}</tr>
                </thead>
                <tbody>
                  {list.rows.map((u) => (
                    <tr key={u.id}>
                      <td>{u.display_name}</td>
                      <td className="break">{u.email}</td>
                      <td>{u.employee_name ?? <span className="muted">Not linked</span>}</td>
                      <td className="wrap">
                        <span className="tag-list">
                          {u.roles.length === 0 ? <span className="muted">None</span> : u.roles.map((r) => (
                            canEdit ? (
                              <button key={r.code} type="button" className="chip chip--mono" title={`Remove ${r.name}`} onClick={() => setDlg({ kind: 'drop', user: u, code: r.code })}>
                                {r.code} ×
                              </button>
                            ) : <Chip key={r.code} mono title={r.name}>{r.code}</Chip>
                          ))}
                        </span>
                      </td>
                      <td className="nowrap">{u.last_login_at ? fmtDateTime(u.last_login_at) : <span className="muted">Never</span>}</td>
                      <td><StatusPill value={u.is_active ? 'Live' : 'Rejected'} /></td>
                      {canEdit ? (
                        <td className="nowrap">
                          <span className="row row--tight">
                            <button type="button" className="btn btn--sm" onClick={() => setDlg({ kind: 'roles', user: u })}>Roles</button>
                            <button
                              type="button"
                              className={`btn btn--sm${u.is_active ? ' btn--danger' : ''}`}
                              onClick={() => void api.patch(`/admin/users/${u.id}`, { isActive: !u.is_active })
                                .then(() => { toast.push('ok', `${u.display_name} ${u.is_active ? 'deactivated' : 'reactivated'}.`); void reload(); })
                                .catch((e) => onError(errorMessage(e)))}
                            >
                              {u.is_active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          </span>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <MoreButton cursor={list.hasMore ? 'y' : null} loading={list.isFetchingNextPage} onMore={list.more} />
          </>
        )}
      </Panel>

      {dlg?.kind === 'new' ? <NewUserDialog roles={roles} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'User created.'); void reload(); }} /> : null}
      {dlg?.kind === 'roles' ? <RolesDialog user={dlg.user} roles={roles} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Role added.'); void reload(); }} /> : null}
      {dlg?.kind === 'drop' ? (
        <FormDialog
          title={`Remove ${dlg.code} from ${dlg.user.display_name}?`}
          submitLabel="Remove role"
          danger
          onClose={() => setDlg(null)}
          onSubmit={async () => {
            await api.del(`/admin/users/${dlg.user.id}/roles/${dlg.code}`);
            toast.push('ok', 'Role removed.');
            void reload();
          }}
        >
          <p className="muted">They lose every permission that role carried as soon as they next sign in.</p>
        </FormDialog>
      ) : null}
    </>
  );
}

/* ───────────────────────── grants ───────────────────────── */

function GrantsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const isSuper = !!user?.roles.includes('SUPER_ADMIN');
  const canEdit = useCan('admin.edit');
  const [status, setStatus] = useState<'live' | 'all'>('live');
  const [dlg, setDlg] = useState<null | { kind: 'new' } | { kind: 'revoke'; grant: Grant }>(null);
  const emp = useQuery({
    queryKey: ['admin-users', 'for-grants'],
    enabled: isSuper,
    queryFn: async () => (await api.get<Page<AdminUser>>('/admin/users', { active: 'true', limit: 200 })).data,
  });
  const list = useQuery({
    queryKey: ['admin-grants', status],
    queryFn: async () => (await api.get<Page<Grant>>('/admin/grants', { status, limit: 100 })).data,
  });
  const reload = () => qc.invalidateQueries({ queryKey: ['admin-grants'] });

  return (
    <>
      <div className="notice notice--info" role="status">
        <span className="prewrap">
          A grant widens what one person can see beyond their role — cost, margin, day rates, credit. Grants are time-boxed and logged,
          and only a Super Administrator can create one.
        </span>
      </div>

      <div className="filters">
        <div className="field">
          <span className="label" id="g-l">Show</span>
          <div className="seg" role="group" aria-labelledby="g-l">
            <button type="button" aria-pressed={status === 'live'} onClick={() => setStatus('live')}>Live</button>
            <button type="button" aria-pressed={status === 'all'} onClick={() => setStatus('all')}>Including ended</button>
          </div>
        </div>
      </div>

      <Section
        query={list}
        title="Field access grants"
        empty={status === 'live' ? 'No live grant' : 'No grant has ever been made'}
        actions={isSuper ? <button type="button" className="btn btn--sm" onClick={() => setDlg({ kind: 'new' })}><PlusIcon /> Grant access</button> : null}
      >
        {(rows) => (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>User</th><th>Field group</th><th>Reason</th><th>From</th><th>Until</th><th>State</th>{canEdit ? <th><span className="sr-only">Actions</span></th> : null}</tr></thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={g.id}>
                    <td>{g.user_name}</td>
                    <td>{GROUP_LABEL[g.field_group] ?? g.field_group}</td>
                    <td className="wrap">{g.reason}<span className="sub">{g.granted_by_name ? `granted by ${g.granted_by_name}` : ''}</span></td>
                    <td className="nowrap">{fmtDate(g.valid_from)}</td>
                    <td className="nowrap">{g.valid_to ? fmtDate(g.valid_to) : <span className="muted">Open-ended</span>}</td>
                    <td>{g.revoked_at ? <Chip tone="crit">Revoked {fmtDate(g.revoked_at)}</Chip> : g.is_live ? <Chip tone="ok">Live</Chip> : <Chip>Ended</Chip>}</td>
                    {canEdit ? (
                      <td className="nowrap">
                        {g.is_live && !g.revoked_at ? (
                          <button type="button" className="btn btn--sm btn--danger" onClick={() => setDlg({ kind: 'revoke', grant: g })}>Revoke</button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {dlg?.kind === 'new' ? (
        <GrantDialog users={emp.data ?? []} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Access granted and logged.'); void reload(); }} />
      ) : null}
      {dlg?.kind === 'revoke' ? (
        <RevokeDialog grant={dlg.grant} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Grant revoked.'); void reload(); }} />
      ) : null}
    </>
  );
}

function GrantDialog({ users, onClose, onDone }: { users: AdminUser[]; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  const [userId, setUserId] = useState('');
  const [group, setGroup] = useState<string>(FIELD_GROUPS[0]);
  const [validTo, setValidTo] = useState('');
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      title="Grant access to a restricted field group"
      submitLabel="Grant access"
      onClose={onClose}
      onSubmit={async () => {
        if (!userId) throw new UserError('Choose who the grant is for.');
        if (userId === user?.id) throw new UserError('You cannot grant restricted-field access to yourself. Ask another Super Administrator.');
        if (reason.trim().length < 5) throw new UserError('Say why this access is needed.');
        await api.post('/admin/grants', { userId, fieldGroup: group, reason: reason.trim(), validTo: validTo || undefined });
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="User" required>
          {(p) => (
            <select {...p} className="select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose a user…</option>
              {users.filter((u) => u.id !== user?.id).map((u) => <option key={u.id} value={u.id}>{u.display_name} · {u.email}</option>)}
            </select>
          )}
        </Field>
        <Field label="Field group" required>
          {(p) => (
            <select {...p} className="select" value={group} onChange={(e) => setGroup(e.target.value)}>
              {FIELD_GROUPS.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
            </select>
          )}
        </Field>
        <Field label="Until" hint="Leave empty for an open-ended grant. A date is safer.">
          {(p) => <input {...p} className="input" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />}
        </Field>
      </div>
      <Field label="Why this person needs it" required>
        {(p) => <textarea {...p} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}

function RevokeDialog({ grant, onClose, onDone }: { grant: Grant; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <FormDialog
      title={`Revoke ${GROUP_LABEL[grant.field_group] ?? grant.field_group} from ${grant.user_name}?`}
      submitLabel="Revoke"
      danger
      onClose={onClose}
      onSubmit={async () => {
        await api.del(`/admin/grants/${grant.id}`, { reason: reason.trim() || undefined });
        onDone();
      }}
    >
      <p className="muted">They stop seeing those fields the next time their session is checked.</p>
      <Field label="Reason for the record">{(p) => <textarea {...p} className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </FormDialog>
  );
}

/* ───────────────────────── settings ───────────────────────── */

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

function SettingsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const canEdit = useCan('admin.edit');
  const [edit, setEdit] = useState<Setting | null>(null);
  const list = useQuery({
    queryKey: ['admin-settings'],
    queryFn: async () => (await api.get<{ data: Setting[] }>('/admin/settings')).data,
  });
  return (
    <>
      <Section query={list} title="Settings" empty="No setting is stored">
        {(rows) => (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Key</th><th>Value</th><th>Last changed</th>{canEdit ? <th><span className="sr-only">Actions</span></th> : null}</tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.key}>
                    <td className="mono">{s.key}</td>
                    <td className="wrap mono break">{show(s.value)}</td>
                    <td className="nowrap">{s.updated_at ? fmtDateTime(s.updated_at) : <span className="muted">Never</span>}</td>
                    {canEdit ? <td><button type="button" className="btn btn--sm" onClick={() => setEdit(s)}>Edit</button></td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {edit ? (
        <SettingDialog
          setting={edit}
          onClose={() => setEdit(null)}
          onDone={() => { toast.push('ok', 'Setting saved.'); void qc.invalidateQueries({ queryKey: ['admin-settings'] }); }}
        />
      ) : null}
    </>
  );
}

function SettingDialog({ setting, onClose, onDone }: { setting: Setting; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(setting.value, null, 2));
  return (
    <FormDialog
      title={setting.key}
      submitLabel="Save setting"
      onClose={onClose}
      onSubmit={async () => {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          throw new UserError('The value must be valid JSON. Text needs double quotes around it, for example "Dubai".');
        }
        await api.put(`/admin/settings/${encodeURIComponent(setting.key)}`, { value });
        onDone();
      }}
    >
      <Field label="Value (JSON)" hint='A plain word still needs quotes: "Dubai", not Dubai.'>
        {(p) => <textarea {...p} className="textarea mono" style={{ minHeight: 140 }} value={text} onChange={(e) => setText(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}

/* ───────────────────────── margin rules ───────────────────────── */

function MarginTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState<MarginRule | null>(null);
  const list = useQuery({
    queryKey: ['admin-margin-rules'],
    queryFn: async () => (await api.get<{ data: MarginRule[] }>('/admin/margin-rules')).data,
  });
  return (
    <>
      <div className="notice notice--info" role="status">
        <span className="prewrap">
          The warn level is where a quotation starts needing approval. The minimum is the hard floor below which the server refuses
          the submission outright. The three shares decide how gross profit is attributed and must add up to 100.
        </span>
      </div>
      <Section query={list} title="Margin rules by business type" empty="No margin rule is configured">
        {(rows) => (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr><th>Business type</th><th className="num">Floor</th><th className="num">Warn at</th><th className="num">Sales</th><th className="num">Technical</th><th className="num">Company</th><th>Effective</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.business_type_name}<span className="sub mono">{r.business_type_code}</span></td>
                    <td className="num">{isNum(r.min_margin_pct) ? fmtPct(r.min_margin_pct, 1) : <span className="muted">Default</span>}</td>
                    <td className="num">{isNum(r.warn_margin_pct) ? fmtPct(r.warn_margin_pct, 1) : <span className="muted">Floor</span>}</td>
                    <td className="num">{fmtPct(r.sales_share_pct, 0)}</td>
                    <td className="num">{fmtPct(r.technical_share_pct, 0)}</td>
                    <td className="num">{fmtPct(r.company_share_pct, 0)}</td>
                    <td className="nowrap">{fmtDate(r.effective_from)}{r.effective_to ? ` – ${fmtDate(r.effective_to)}` : ' onwards'}</td>
                    <td><button type="button" className="btn btn--sm" onClick={() => setEdit(r)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {edit ? (
        <MarginDialog
          rule={edit}
          onClose={() => setEdit(null)}
          onDone={() => { toast.push('ok', 'Margin rule saved. It applies to the next quotation submitted.'); void qc.invalidateQueries({ queryKey: ['admin-margin-rules'] }); }}
        />
      ) : null}
    </>
  );
}

function MarginDialog({ rule, onClose, onDone }: { rule: MarginRule; onClose: () => void; onDone: () => void }) {
  const str = (v: number | null) => (isNum(v) ? String(v) : '');
  const [min, setMin] = useState(str(rule.min_margin_pct));
  const [warn, setWarn] = useState(str(rule.warn_margin_pct));
  const [sales, setSales] = useState(String(rule.sales_share_pct));
  const [tech, setTech] = useState(String(rule.technical_share_pct));
  const [company, setCompany] = useState(String(rule.company_share_pct));
  const [to, setTo] = useState(rule.effective_to ?? '');
  const sum = [sales, tech, company].reduce((a, s) => a + (Number(s) || 0), 0);

  return (
    <FormDialog
      wide
      title={`Margin rule for ${rule.business_type_name}`}
      submitLabel="Save rule"
      onClose={onClose}
      onSubmit={async () => {
        const pct = (s: string, what: string, nullable = false) => {
          if (s.trim() === '') {
            if (nullable) return null;
            throw new UserError(`${what} is required.`);
          }
          const v = Number(s);
          if (!Number.isFinite(v) || v < 0 || v > 100) throw new UserError(`${what} must be between 0 and 100.`);
          return v;
        };
        const body = {
          minMarginPct: pct(min, 'The floor', true),
          warnMarginPct: pct(warn, 'The warn level', true),
          salesSharePct: pct(sales, 'The sales share')!,
          technicalSharePct: pct(tech, 'The technical share')!,
          companySharePct: pct(company, 'The company share')!,
          effectiveTo: to || null,
        };
        if (Math.abs(body.salesSharePct + body.technicalSharePct + body.companySharePct - 100) > 1e-6) {
          throw new UserError('The sales, technical and company shares must add up to exactly 100.');
        }
        if (body.minMarginPct !== null && body.warnMarginPct !== null && body.warnMarginPct < body.minMarginPct) {
          throw new UserError('The warn level cannot be below the floor.');
        }
        await api.put(`/admin/margin-rules/${rule.id}`, body);
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Hard floor %" hint="Below this the server refuses the submission. Empty uses the company default.">
          {(p) => <input {...p} className="input input--num" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />}
        </Field>
        <Field label="Warn at %" hint="Below this an approval chain is raised.">
          {(p) => <input {...p} className="input input--num" inputMode="decimal" value={warn} onChange={(e) => setWarn(e.target.value)} />}
        </Field>
        <Field label="Rule ends" hint="Leave empty to keep it in force.">
          {(p) => <input {...p} className="input" type="date" min={rule.effective_from} value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Sales share %" required>{(p) => <input {...p} className="input input--num" inputMode="decimal" value={sales} onChange={(e) => setSales(e.target.value)} />}</Field>
        <Field label="Technical share %" required>{(p) => <input {...p} className="input input--num" inputMode="decimal" value={tech} onChange={(e) => setTech(e.target.value)} />}</Field>
        <Field label="Company share %" required error={Math.abs(sum - 100) > 1e-6 ? `These add up to ${fmtDec(sum, 1)}, not 100.` : null}>
          {(p) => <input {...p} className="input input--num" inputMode="decimal" value={company} onChange={(e) => setCompany(e.target.value)} />}
        </Field>
      </div>
      <p className="muted">In force since {fmtDate(rule.effective_from)}. Changing a rule does not re-judge quotations already submitted.</p>
    </FormDialog>
  );
}

/* ───────────────────────── SLA rules ───────────────────────── */

function SlaTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const [edit, setEdit] = useState<SlaRule | null>(null);
  const list = useQuery({
    queryKey: ['admin-sla-rules'],
    queryFn: async () => (await api.get<{ data: SlaRule[] }>('/admin/sla-rules')).data,
  });
  return (
    <>
      <Section query={list} title="SLA rules" empty="No SLA rule is configured">
        {(rows) => (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr><th>Timer</th><th>Urgency</th><th className="num">Target</th><th className="num">Warn at</th><th>Calendar</th><th>Effective</th><th>State</th><th><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.timer_code}</td>
                    <td>{r.urgency === 'Urgent' ? <Chip tone="crit">Urgent</Chip> : <span className="muted">Normal</span>}</td>
                    <td className="num">{fmtDec(r.target_hours, 0)} h</td>
                    <td className="num">{isNum(r.warn_at_pct) ? fmtPct(r.warn_at_pct, 0) : <span className="muted">Not set</span>}</td>
                    <td>{r.calendar_name ?? <span className="muted">Company default</span>}</td>
                    <td className="nowrap">{fmtDate(r.effective_from)}{r.effective_to ? ` – ${fmtDate(r.effective_to)}` : ' onwards'}</td>
                    <td>{r.is_active ? <Chip tone="ok">Active</Chip> : <Chip>Off</Chip>}</td>
                    <td><button type="button" className="btn btn--sm" onClick={() => setEdit(r)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {edit ? (
        <SlaDialog
          rule={edit}
          onClose={() => setEdit(null)}
          onDone={() => { toast.push('ok', 'SLA rule saved. New requests use it immediately.'); void qc.invalidateQueries({ queryKey: ['admin-sla-rules'] }); }}
        />
      ) : null}
    </>
  );
}

function SlaDialog({ rule, onClose, onDone }: { rule: SlaRule; onClose: () => void; onDone: () => void }) {
  const [hours, setHours] = useState(String(rule.target_hours));
  const [warn, setWarn] = useState(isNum(rule.warn_at_pct) ? String(rule.warn_at_pct) : '');
  const [to, setTo] = useState(rule.effective_to ?? '');
  const [active, setActive] = useState(rule.is_active);
  return (
    <FormDialog
      title={`${rule.timer_code} · ${rule.urgency}`}
      submitLabel="Save rule"
      onClose={onClose}
      onSubmit={async () => {
        const h = Number(hours);
        if (!Number.isFinite(h) || h <= 0 || h > 8760) throw new UserError('The target must be more than zero and at most 8760 hours.');
        const body: Record<string, unknown> = { targetHours: h, effectiveTo: to || null, isActive: active };
        if (warn.trim() !== '') {
          const w = Number(warn);
          if (!Number.isFinite(w) || w < 0 || w > 100) throw new UserError('The warning level is a percentage between 0 and 100.');
          body.warnAtPct = w;
        }
        await api.put(`/admin/sla-rules/${rule.id}`, body);
        onDone();
      }}
    >
      <div className="form-grid">
        <Field label="Target (working hours)" required>
          {(p) => <input {...p} className="input input--num" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />}
        </Field>
        <Field label="Warn at %" hint="How far through the target a request turns to “Approaching”.">
          {(p) => <input {...p} className="input input--num" inputMode="decimal" value={warn} onChange={(e) => setWarn(e.target.value)} />}
        </Field>
        <Field label="Rule ends" hint="Leave empty to keep it in force.">
          {(p) => <input {...p} className="input" type="date" min={rule.effective_from} value={to} onChange={(e) => setTo(e.target.value)} />}
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Rule is active
      </label>
      <p className="muted">Hours are counted on the {rule.calendar_name ?? 'company default'} calendar, so evenings and weekends do not burn the clock.</p>
    </FormDialog>
  );
}

/* ───────────────────────── page ───────────────────────── */

export default function Admin() {
  const [sp, setSp] = useSearchParams();
  const canEdit = useCan('admin.edit');
  const [error, setError] = useState<string | null>(null);

  const tabs = TABS.filter((t) => t.perm === 'admin.view' || canEdit);
  const raw = sp.get('tab') ?? '';
  const tab: TabKey = tabs.find((t) => t.key === raw)?.key ?? tabs[0].key;
  const setTab = (k: TabKey) => {
    const next = new URLSearchParams(sp);
    if (k === tabs[0].key) next.delete('tab');
    else next.set('tab', k);
    setSp(next, { replace: true });
  };

  // Roles are needed by two tabs and never change during a session.
  const roles = useQuery({
    queryKey: ['admin-roles'],
    staleTime: 10 * 60 * 1000,
    queryFn: async () => (await api.get<{ data: Role[] }>('/admin/roles')).data,
  });

  return (
    <>
      <PageHead
        title="Administration"
        sub={canEdit ? 'Who can sign in, what they may see, and the rules the gates enforce.' : 'Read-only: your role can view this, but not change it.'}
      />

      <div className="filters">
        <div className="field">
          <span className="label" id="t-l">Section</span>
          <div className="seg" role="group" aria-labelledby="t-l">
            {tabs.map((t) => (
              <button key={t.key} type="button" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'users' ? (
        roles.isPending ? <Panel><EmptyState title="Loading roles…" /></Panel> : <UsersTab roles={roles.data ?? []} onError={setError} />
      ) : null}

      {tab === 'roles' ? (
        <Section query={roles} title="Roles" empty="No role is configured">
          {(rows) => (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Code</th><th>Name</th><th className="num">Active users</th><th>Kind</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.code}</td>
                      <td>{r.name}</td>
                      <td className="num">{fmtInt(r.user_count)}</td>
                      <td><Chip>Built in</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      ) : null}

      {tab === 'grants' ? <GrantsTab /> : null}
      {tab === 'settings' ? <SettingsTab /> : null}
      {tab === 'margin' ? <MarginTab /> : null}
      {tab === 'sla' ? <SlaTab /> : null}

      {!canEdit ? (
        <div className="notice notice--info" role="status">
          <span className="prewrap">Margin and SLA rules are not shown because reading them needs the “admin.edit” permission.</span>
        </div>
      ) : null}

      {error ? <MessageDialog title="That could not be done" message={error} onClose={() => setError(null)} /> : null}
    </>
  );
}
