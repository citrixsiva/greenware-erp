import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type One, UserError } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtDec, fmtMoney, isNum } from '../lib/format';
import { useBootstrap } from '../lib/hooks';
import type { EstDetail, Estimate } from '../lib/types';
import { FormDialog, MessageDialog } from '../components/Dialog';
import { useToast } from '../components/Toast';
import { Chip, DataView, EmptyState, Field, Kpi, PageHead, Panel, PlusIcon, SlaPill, StatusPill, UrgencyChip } from '../components/ui';

type Dlg = null | 'estimate' | 'clarify' | 'resume' | 'cancel';
interface ResRow { role: string; band: string; headcount: string; days: string; mode: string }

const SERVICE_COST_HELP = 'There is no day rate configured — enter the service cost directly.';

function EstimateForm({ req, prev, onClose, onDone }: { req: EstDetail; prev: Estimate | null; onClose: () => void; onDone: () => void }) {
  const boot = useBootstrap();
  const [scope, setScope] = useState(prev?.scope_understanding ?? '');
  const [solution, setSolution] = useState(prev?.proposed_solution ?? '');
  const [mode, setMode] = useState(prev?.mode ?? 'Remote');
  const [travel, setTravel] = useState(prev?.travel_required ?? false);
  const [travelCost, setTravelCost] = useState('');
  const [cost, setCost] = useState(isNum(prev?.estimated_service_cost) ? String(prev!.estimated_service_cost) : '');
  const [currency, setCurrency] = useState(prev?.currency?.trim() || 'AED');
  const [totalDays, setTotalDays] = useState(prev && !prev.resources.length ? String(prev.total_days) : '');
  const [assumptions, setAssumptions] = useState(prev?.assumptions ?? '');
  const [exclusions, setExclusions] = useState(prev?.exclusions ?? '');
  const [dependencies, setDependencies] = useState(prev?.dependencies ?? '');
  const [remarks, setRemarks] = useState('');
  const [res, setRes] = useState<ResRow[]>(prev?.resources.map((r) => ({ role: r.role_name, band: r.seniority_band ?? '', headcount: String(r.headcount), days: String(r.days), mode: r.mode })) ?? []);
  const [costErr, setCostErr] = useState<string | null>(null);

  const sum = res.reduce((a, r) => a + (Number(r.headcount) || 0) * (Number(r.days) || 0), 0);
  const setRow = (i: number, p: Partial<ResRow>) => setRes((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <FormDialog
      wide
      title={`${prev ? `New version of the estimate` : 'Submit estimate'} for ${req.request_no}`}
      submitLabel={prev ? `Submit version ${prev.version + 1}` : 'Submit estimate'}
      onClose={onClose}
      onSubmit={async () => {
        if (cost.trim() === '') {
          setCostErr('Enter the service cost.');
          throw new UserError('Enter the service cost — there is no day rate configured to derive it from.');
        }
        setCostErr(null);
        if (!scope.trim() || !solution.trim()) throw new UserError('Describe your understanding of the scope and the proposed solution.');
        const resources = res
          .filter((r) => r.role.trim())
          .map((r) => ({ roleName: r.role.trim(), seniorityBand: r.band.trim() || undefined, headcount: Number(r.headcount) || 1, days: Number(r.days), mode: r.mode }));
        await api.post(`/estimation/requests/${req.id}/estimate`, {
          scopeUnderstanding: scope.trim(),
          proposedSolution: solution.trim(),
          mode,
          travelRequired: travel,
          travelCost: travel && travelCost.trim() !== '' ? Number(travelCost) : undefined,
          estimatedServiceCost: Number(cost),
          currency,
          totalDays: resources.length ? undefined : totalDays.trim() === '' ? undefined : Number(totalDays),
          assumptions: assumptions.trim() || undefined,
          exclusions: exclusions.trim() || undefined,
          dependencies: dependencies.trim() || undefined,
          remarks: remarks.trim() || undefined,
          resources,
        });
        onDone();
      }}
    >
      <Field label="Understanding of the scope" required>{(p) => <textarea {...p} className="textarea" value={scope} onChange={(e) => setScope(e.target.value)} />}</Field>
      <Field label="Proposed solution" required>{(p) => <textarea {...p} className="textarea" value={solution} onChange={(e) => setSolution(e.target.value)} />}</Field>

      <div className="form-grid">
        <Field label="Estimated service cost" required hint={SERVICE_COST_HELP} error={costErr}>
          {(p) => <input {...p} className="input input--num" inputMode="decimal" value={cost} onChange={(e) => { setCost(e.target.value); setCostErr(null); }} />}
        </Field>
        <Field label="Currency">
          {(p) => (
            <select {...p} className="select" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(boot.data?.currencies.map((c) => c.code) ?? ['AED', 'USD', 'EUR', 'INR']).map((c) => <option key={c}>{c}</option>)}
            </select>
          )}
        </Field>
        <Field label="Delivery mode">
          {(p) => <select {...p} className="select" value={mode} onChange={(e) => setMode(e.target.value)}><option>Remote</option><option>Onsite</option><option>Hybrid</option></select>}
        </Field>
        {res.length === 0 ? (
          <Field label="Total effort (days)" required hint="Or list the resources below and it is added up for you.">
            {(p) => <input {...p} className="input input--num" inputMode="decimal" value={totalDays} onChange={(e) => setTotalDays(e.target.value)} />}
          </Field>
        ) : (
          <Field label="Total effort (days)" hint="Calculated from the resources.">
            {(p) => <input {...p} className="input input--num" readOnly value={fmtDec(sum, 2)} />}
          </Field>
        )}
      </div>

      <div className="row">
        <label className="check"><input type="checkbox" checked={travel} onChange={(e) => setTravel(e.target.checked)} /> Travel required</label>
        {travel ? (
          <label className="field" style={{ width: 200 }}>
            <span className="label">Travel cost ({currency})</span>
            <input className="input input--num" inputMode="decimal" value={travelCost} onChange={(e) => setTravelCost(e.target.value)} />
          </label>
        ) : null}
      </div>

      <div>
        <div className="row" style={{ marginBottom: 6 }}>
          <b>Resources</b>
          <button type="button" className="btn btn--sm" onClick={() => setRes([...res, { role: '', band: '', headcount: '1', days: '', mode: 'Remote' }])}><PlusIcon /> Add resource</button>
        </div>
        {res.length ? (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Role</th><th>Band</th><th className="num">People</th><th className="num">Days each</th><th>Mode</th><th><span className="sr-only">Remove</span></th></tr></thead>
              <tbody>
                {res.map((r, i) => (
                  <tr key={i}>
                    <td><input className="input input--cell" aria-label={`Role, resource ${i + 1}`} value={r.role} onChange={(e) => setRow(i, { role: e.target.value })} /></td>
                    <td><input className="input input--cell" aria-label={`Seniority band, resource ${i + 1}`} value={r.band} onChange={(e) => setRow(i, { band: e.target.value })} /></td>
                    <td><input className="input input--cell input--num w-sm" aria-label={`People, resource ${i + 1}`} inputMode="numeric" value={r.headcount} onChange={(e) => setRow(i, { headcount: e.target.value })} /></td>
                    <td><input className="input input--cell input--num w-sm" aria-label={`Days each, resource ${i + 1}`} inputMode="decimal" value={r.days} onChange={(e) => setRow(i, { days: e.target.value })} /></td>
                    <td><select className="select input--cell" aria-label={`Mode, resource ${i + 1}`} value={r.mode} onChange={(e) => setRow(i, { mode: e.target.value })}><option>Remote</option><option>Onsite</option><option>Hybrid</option></select></td>
                    <td><button type="button" className="btn btn--sm btn--ghost" onClick={() => setRes(res.filter((_, j) => j !== i))}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No resources listed. That is fine if you enter the total effort above.</p>}
      </div>

      <div className="form-grid">
        <Field label="Assumptions">{(p) => <textarea {...p} className="textarea" value={assumptions} onChange={(e) => setAssumptions(e.target.value)} />}</Field>
        <Field label="Exclusions">{(p) => <textarea {...p} className="textarea" value={exclusions} onChange={(e) => setExclusions(e.target.value)} />}</Field>
        <Field label="Dependencies">{(p) => <textarea {...p} className="textarea" value={dependencies} onChange={(e) => setDependencies(e.target.value)} />}</Field>
        <Field label="Remarks">{(p) => <textarea {...p} className="textarea" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}</Field>
      </div>
    </FormDialog>
  );
}

function TextDialog({ title, label, submit, danger, minLen, optional, onClose, run }: { title: string; label: string; submit: string; danger?: boolean; minLen?: number; optional?: boolean; onClose: () => void; run: (t: string) => Promise<void> }) {
  const [text, setText] = useState('');
  return (
    <FormDialog title={title} submitLabel={submit} danger={danger} onClose={onClose} onSubmit={async () => {
      if (!optional && text.trim().length < (minLen ?? 1)) throw new UserError(`Write at least ${minLen ?? 1} characters.`);
      await run(text.trim());
    }}>
      <Field label={label} required={!optional}>{(p) => <textarea {...p} className="textarea" autoFocus value={text} onChange={(e) => setText(e.target.value)} />}</Field>
    </FormDialog>
  );
}

export default function EstimationDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const canEdit = useCan('technical_estimations.edit');
  const [dlg, setDlg] = useState<Dlg>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const q = useQuery({ queryKey: ['est', id], queryFn: async () => (await api.get<One<EstDetail>>(`/estimation/requests/${id}`)).data });
  const reload = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['est', id] }), qc.invalidateQueries({ queryKey: ['est-by-enq'] }), qc.invalidateQueries({ queryKey: ['sla'] })]);
  };
  async function direct(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    try {
      await fn();
      toast.push('ok', okText);
      await reload();
    } catch (e) {
      setBlocked(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <DataView query={q} label="Loading the request">
      {(r) => {
        const closed = r.status === 'Submitted' || r.status === 'Cancelled';
        const mine = r.assigned_to === user?.id;
        const e = r.estimate;
        const canSubmit = canEdit && r.status !== 'Cancelled';
        return (
          <>
            <PageHead
              crumbs={<><Link to="/estimation">Estimation</Link><span>/</span><span className="mono">{r.request_no}</span></>}
              title={<span className="id">{r.request_no}</span>}
              sub={<><SlaPill state={r.sla_state} clock={r.sla_clock} elapsed={r.elapsed_working_hours} target={r.target_hours} /> <StatusPill value={r.status} /> <span className="muted"> · <Link to={`/enquiries/${r.enquiry_id}`}>{r.enquiry_no}</Link> · {r.customer_name} · {r.sbu_name}</span></>}
              actions={
                <>
                  {canEdit && !closed && !mine ? <button type="button" className="btn" disabled={busy} onClick={() => void direct(() => api.patch(`/estimation/requests/${id}/assign`, { assignedTo: user!.id }), 'Assigned to you.')}>Assign to me</button> : null}
                  {canEdit && r.status === 'Assigned' ? <button type="button" className="btn" disabled={busy} onClick={() => void direct(() => api.post(`/estimation/requests/${id}/start`), 'Review started.')}>Start review</button> : null}
                  {canEdit && (r.status === 'Assigned' || r.status === 'InReview') ? <button type="button" className="btn" onClick={() => setDlg('clarify')}>Ask Sales a question</button> : null}
                  {canEdit && r.status === 'ClarificationNeeded' ? <button type="button" className="btn" onClick={() => setDlg('resume')}>Sales answered: resume</button> : null}
                  {canSubmit ? <button type="button" className="btn btn--primary" onClick={() => setDlg('estimate')}><PlusIcon /> {e ? 'New estimate version' : 'Submit estimate'}</button> : null}
                  {canEdit && !closed ? <button type="button" className="btn btn--danger" onClick={() => setDlg('cancel')}>Cancel request</button> : null}
                </>
              }
            />

            <div className="kpis">
              <Kpi label="Elapsed" value={`${fmtDec(r.elapsed_working_hours, 1)} h`} sub={isNum(r.target_hours) ? `of ${fmtDec(r.target_hours, 0)} h target` : 'No target set'} />
              <Kpi label="Urgency" value={<UrgencyChip urgency={r.urgency} />} />
              <Kpi label="Engineer" value={r.assigned_to_name ?? <span className="muted">Unassigned</span>} />
              <Kpi label="Needed by" value={r.required_by ? fmtDate(r.required_by) : <span className="muted">Not set</span>} />
              <Kpi label="Clarification rounds" value={r.clarification_rounds} />
            </div>

            {r.status === 'ClarificationNeeded' && r.open_clarification ? (
              <div className="notice notice--warn" role="status"><div><b>Waiting on Sales. </b><span className="prewrap">{r.open_clarification}</span><div className="muted">The SLA clock is paused until this is answered.</div></div></div>
            ) : null}
            {r.scope_notes ? <Panel title="Scope notes from Sales" id="notes"><p className="prewrap">{r.scope_notes}</p></Panel> : null}

            <div className="two-col">
              <Panel title={e ? `Estimate, version ${e.version}` : 'Estimate'} id="estimate" flush={!e}>
                {!e ? (
                  <EmptyState title="No estimate submitted yet" hint={canEdit ? 'Once the work is understood, submit the estimate. The service cost is entered directly.' : undefined} />
                ) : (
                  <div className="stack--lg stack">
                    <dl className="dl">
                      <div><dt>Submitted</dt><dd>{fmtDateTime(e.submitted_at)}{e.submitted_by_name ? ` by ${e.submitted_by_name}` : ''}</dd></div>
                      <div><dt>Total effort</dt><dd className="mono">{fmtDec(e.total_days, 1)} person-days</dd></div>
                      <div><dt>Mode</dt><dd>{e.mode}</dd></div>
                      {isNum(e.estimated_service_cost) ? <div><dt>Service cost</dt><dd className="mono">{fmtMoney(e.estimated_service_cost, e.currency)}</dd></div> : null}
                      <div><dt>Travel</dt><dd>{e.travel_required ? <>Required{isNum(e.travel_cost) ? <> · <span className="mono">{fmtMoney(e.travel_cost, e.currency)}</span></> : null}</> : 'Not required'}</dd></div>
                    </dl>
                    <div><div className="muted">Scope understanding</div><p className="prewrap">{e.scope_understanding}</p></div>
                    <div><div className="muted">Proposed solution</div><p className="prewrap">{e.proposed_solution}</p></div>
                    {e.resources.length ? (
                      <div className="table-wrap">
                        <table className="t">
                          <thead><tr><th>Role</th><th>Band</th><th className="num">People</th><th className="num">Days each</th><th>Mode</th>{e.resources.some((x) => x.day_rate !== undefined) ? <th className="num">Day rate</th> : null}</tr></thead>
                          <tbody>
                            {e.resources.map((x) => (
                              <tr key={x.id}>
                                <td>{x.role_name}</td><td>{x.seniority_band}</td><td className="num">{x.headcount}</td><td className="num">{fmtDec(x.days, 1)}</td><td>{x.mode}</td>
                                {e.resources.some((y) => y.day_rate !== undefined) ? <td className="num">{isNum(x.day_rate) ? fmtMoney(x.day_rate, e.currency) : null}</td> : null}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {(['assumptions', 'exclusions', 'dependencies', 'remarks'] as const).map((k) => e[k] ? <div key={k}><div className="muted" style={{ textTransform: 'capitalize' }}>{k}</div><p className="prewrap">{e[k]}</p></div> : null)}
                  </div>
                )}
              </Panel>

              <div className="side-stack">
                <Panel title="Clarifications" count={r.clarifications.length} id="clar">
                  {r.clarifications.length === 0 ? <EmptyState title="No questions asked" /> : (
                    <ol className="timeline">
                      {r.clarifications.map((c, i) => (
                        <li key={i}>
                          <div className="when">{fmtDateTime(c.occurred_at)} · {c.actor_name ?? 'System'} · {c.kind === 'question' ? 'Question' : 'Answer'}</div>
                          <div className="prewrap">{c.text}</div>
                        </li>
                      ))}
                    </ol>
                  )}
                </Panel>
                <Panel title="Versions" count={r.estimate_history.length} id="ver" flush>
                  {r.estimate_history.length === 0 ? <EmptyState title="Nothing submitted" /> : (
                    <div className="table-wrap">
                      <table className="t">
                        <tbody>
                          {r.estimate_history.map((v) => (
                            <tr key={v.id}><td className="mono">v{v.version}</td><td>{fmtDateTime(v.submitted_at)}</td><td>{v.submitted_by_name}</td><td>{v.version === r.estimate_version ? <Chip tone="accent">Current</Chip> : <span className="muted">Superseded</span>}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              </div>
            </div>

            {dlg === 'estimate' ? <EstimateForm req={r} prev={e} onClose={() => setDlg(null)} onDone={() => { toast.push('ok', 'Estimate submitted.'); void reload(); }} /> : null}
            {dlg === 'clarify' ? <TextDialog title="Ask Sales a question" label="What do you need to know?" submit="Send question" minLen={3} onClose={() => setDlg(null)} run={async (t) => { await api.post(`/estimation/requests/${id}/clarify`, { question: t }); toast.push('info', 'Question sent. The SLA clock is paused.'); void reload(); }} /> : null}
            {dlg === 'resume' ? <TextDialog title="Resume the estimate" label="Sales' answer (optional)" optional submit="Resume" onClose={() => setDlg(null)} run={async (t) => { await api.post(`/estimation/requests/${id}/resume`, { answer: t || undefined }); toast.push('ok', 'Resumed. The SLA clock is running.'); void reload(); }} /> : null}
            {dlg === 'cancel' ? <TextDialog title={`Cancel ${r.request_no}`} label="Why is this being cancelled?" submit="Cancel request" danger minLen={3} onClose={() => setDlg(null)} run={async (t) => { await api.post(`/estimation/requests/${id}/cancel`, { reason: t }); toast.push('ok', 'Request cancelled.'); void reload(); }} /> : null}
            {blocked ? <MessageDialog title="That could not be done" message={blocked} onClose={() => setBlocked(null)} /> : null}
          </>
        );
      }}
    </DataView>
  );
}
