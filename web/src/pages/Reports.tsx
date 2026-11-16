import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, downloadFile } from '../lib/api';
import { useCan } from '../lib/auth';
import { fmtDec, fmtInt, fmtMoney, fmtPct, isNum } from '../lib/format';
import { useBootstrap, useEmployees } from '../lib/hooks';
import { useToast } from '../components/Toast';
import {
  Chip, DataView, EmptyState, Kpi, Notice, PageHead, Panel,
} from '../components/ui';

interface Catalogue { key: string; name: string; sub: string; available: boolean }
interface ReportPayload {
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
  meta: Record<string, unknown>;
}

const num = (v: unknown) => (isNum(v) ? Number(v) : null);

/** A margin movement in percentage points: the sign is the whole story. */
function Pts({ v }: { v: unknown }) {
  const n = num(v);
  if (n === null) return <span className="muted">—</span>;
  const tone = n < -1 ? 'crit' : n < 0 ? 'warn' : 'ok';
  return <Chip tone={tone} mono>{n > 0 ? `+${fmtDec(n, 1)}` : fmtDec(n, 1)}</Chip>;
}

/* ───────────────────────── per-report tables ───────────────────────── */

function MarginTable({ d }: { d: ReportPayload }) {
  const seesSell = d.rows.length > 0 && 'quoted_sell' in d.rows[0];
  const seesMargin = d.rows.length > 0 && 'quoted_margin_pct' in d.rows[0];
  const awaiting = Number(d.meta.awaiting_close ?? 0);

  return (
    <>
      <div className="kpis">
        <Kpi label="Orders" value={fmtInt(d.totals.orders)} sub={awaiting ? `${awaiting} not yet closed` : 'all closed'} />
        {seesSell ? <Kpi label="Booked value" value={fmtMoney(d.totals.booked_sell, 'AED', true)} sub={`quoted ${fmtMoney(d.totals.quoted_sell, 'AED', true)}`} /> : null}
        {seesMargin ? <Kpi label="Quoted margin" value={fmtPct(d.totals.quoted_margin_pct)} sub="average at quotation" /> : null}
        {seesMargin ? <Kpi label="Realised margin" value={num(d.totals.realised_margin_pct) != null ? fmtPct(d.totals.realised_margin_pct) : '—'} sub={`${d.totals.eroded ?? 0} eroded after booking`} /> : null}
      </div>

      {/* Either leg can be null on its own: quote-to-book needs a booked margin,
          book-to-actual needs a closed order. Say which one is missing rather
          than printing a bare "pts" with nothing in front of it. */}
      {seesMargin && (num(d.totals.quote_to_book_pts) !== null || num(d.totals.book_to_actual_pts) !== null) ? (
        <Notice tone={Math.min(num(d.totals.quote_to_book_pts) ?? 0, num(d.totals.book_to_actual_pts) ?? 0) < -1 ? 'warn' : 'info'} title="Where the margin goes">
          Quote to book: <strong>{num(d.totals.quote_to_book_pts) !== null ? `${fmtDec(d.totals.quote_to_book_pts, 1)} pts` : 'nothing booked yet'}</strong> ·
          {' '}book to actual: <strong>{num(d.totals.book_to_actual_pts) !== null ? `${fmtDec(d.totals.book_to_actual_pts, 1)} pts` : 'nothing closed yet'}</strong>.
          {' '}Negative means margin was lost after the number was agreed — discounting at PO, or cost overruns in delivery.
        </Notice>
      ) : null}

      <div className="table-wrap">
        <table className="t">
          <thead>
            <tr>
              <th>Order</th><th>Customer</th><th>Owner</th>
              {seesSell ? <th className="num">Booked</th> : null}
              {seesMargin ? <><th className="num">Quoted %</th><th className="num">Booked %</th><th className="num">Realised %</th><th className="num">Q→B</th><th className="num">B→A</th></> : null}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="wrap"><span className="id">{String(r.po_ref)}</span><span className="sub">{String(r.enquiry_no)} · {String(r.po_date)}</span></td>
                <td className="wrap">{String(r.customer_name)}{r.sbu_code ? <span className="sub">{String(r.sbu_code)}</span> : null}</td>
                <td>{r.account_manager_name ? String(r.account_manager_name) : <span className="muted">—</span>}</td>
                {seesSell ? <td className="num">{fmtMoney(r.booked_sell, 'AED', true)}</td> : null}
                {seesMargin ? (
                  <>
                    <td className="num">{fmtPct(r.quoted_margin_pct)}</td>
                    <td className="num">{fmtPct(r.booked_margin_pct)}</td>
                    <td className="num">{num(r.realised_margin_pct) != null ? fmtPct(r.realised_margin_pct) : <span className="muted">open</span>}</td>
                    <td className="num"><Pts v={r.quote_to_book_pts} /></td>
                    <td className="num"><Pts v={r.book_to_actual_pts} /></td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function WinLossTable({ d }: { d: ReportPayload }) {
  const reasons = (d.meta.loss_reasons ?? []) as { reason: string; lost: number }[];
  return (
    <>
      <div className="kpis">
        <Kpi label="Enquiries" value={fmtInt(d.totals.enquiries)} sub={`${fmtInt(d.totals.open)} still open`} />
        <Kpi label="Won" value={fmtInt(d.totals.won)} />
        <Kpi label="Lost" value={fmtInt(d.totals.lost)} />
        <Kpi label="Win rate" value={num(d.totals.win_rate_pct) != null ? fmtPct(d.totals.win_rate_pct) : '—'} sub="of decided enquiries" />
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Group</th><th className="num">Enquiries</th><th className="num">Won</th><th className="num">Lost</th><th className="num">Open</th><th className="num">Win rate</th></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={String(r.group_key)}>
                <td className="wrap">{r.group_label ? String(r.group_label) : <span className="muted">Unassigned</span>}</td>
                <td className="num">{fmtInt(r.enquiries)}</td>
                <td className="num">{fmtInt(r.won)}</td>
                <td className="num">{fmtInt(r.lost)}</td>
                <td className="num">{fmtInt(r.open)}</td>
                <td className="num">{num(r.win_rate_pct) != null
                  ? <Chip tone={Number(r.win_rate_pct) >= 50 ? 'ok' : Number(r.win_rate_pct) >= 25 ? 'warn' : 'crit'} mono>{fmtPct(r.win_rate_pct)}</Chip>
                  : <span className="muted">none decided</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {reasons.length ? (
        <>
          <div className="subhead"><h3>Why deals were lost</h3><span className="count">{reasons.length}</span></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Reason</th><th className="num">Lost</th></tr></thead>
              <tbody>{reasons.map((r) => <tr key={r.reason}><td className="wrap">{r.reason}</td><td className="num">{fmtInt(r.lost)}</td></tr>)}</tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}

function PipelineTable({ d }: { d: ReportPayload }) {
  return (
    <>
      <div className="kpis">
        <Kpi label="Enquiries" value={fmtInt(d.totals.enquiries)} />
        <Kpi label="Budget in play" value={fmtMoney(d.totals.budget, 'AED', true)} sub="customer's own figure" />
        <Kpi label="Overdue follow-ups" value={fmtInt(d.totals.overdue_follow_ups)} sub="past their promised date" />
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Stage</th><th className="num">Enquiries</th><th className="num">Budget</th><th className="num">Avg days in stage</th><th className="num">Overdue follow-ups</th></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={String(r.stage)}>
                <td>{String(r.stage)}</td>
                <td className="num">{fmtInt(r.enquiries)}</td>
                <td className="num">{fmtMoney(r.budget, 'AED', true)}</td>
                <td className="num">{num(r.avg_days_in_stage) != null ? fmtDec(r.avg_days_in_stage, 1) : <span className="muted">—</span>}</td>
                <td className="num">{Number(r.overdue_follow_ups) > 0 ? <Chip tone="crit" mono>{fmtInt(r.overdue_follow_ups)}</Chip> : fmtInt(r.overdue_follow_ups)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SlaTable({ d }: { d: ReportPayload }) {
  return (
    <>
      <div className="kpis">
        <Kpi label="Timers" value={fmtInt(d.totals.timers)} sub="Dubai working hours" />
        <Kpi label="Breached" value={fmtInt(d.totals.breached)} />
        <Kpi label="Met" value={num(d.totals.met_pct) != null ? fmtPct(d.totals.met_pct) : '—'} />
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Timer</th><th>Entity</th><th className="num">Started</th><th className="num">Finished</th><th className="num">Breached</th><th className="num">Avg hours</th><th className="num">Target</th><th className="num">Met</th></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={`${r.timer_code}-${r.entity_type}`}>
                <td className="wrap"><span className="id">{String(r.timer_code)}</span></td>
                <td>{String(r.entity_type)}</td>
                <td className="num">{fmtInt(r.timers)}</td>
                <td className="num">{fmtInt(r.finished)}</td>
                <td className="num">{Number(r.breached) > 0 ? <Chip tone="crit" mono>{fmtInt(r.breached)}</Chip> : '0'}</td>
                <td className="num">{num(r.avg_hours) != null ? fmtDec(r.avg_hours, 1) : <span className="muted">—</span>}</td>
                <td className="num">{fmtDec(r.target_hours, 1)}</td>
                <td className="num">{num(r.met_pct) != null
                  ? <Chip tone={Number(r.met_pct) >= 90 ? 'ok' : Number(r.met_pct) >= 70 ? 'warn' : 'crit'} mono>{fmtPct(r.met_pct)}</Chip>
                  : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ReceivablesTable({ d }: { d: ReportPayload }) {
  const worst = (d.meta.worst_customers ?? []) as Record<string, unknown>[];
  return (
    <>
      <div className="kpis">
        <Kpi label="Open invoices" value={fmtInt(d.totals.invoices)} />
        <Kpi label="Outstanding" value={fmtMoney(d.totals.balance, 'AED', true)} />
        <Kpi label="Overdue" value={fmtMoney(d.totals.overdue, 'AED', true)} sub="past the due date" />
      </div>
      <div className="table-wrap">
        <table className="t">
          <thead><tr><th>Bucket</th><th className="num">Invoices</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {d.rows.map((r) => (
              <tr key={String(r.ageing_bucket)}>
                {/* The bucket is stored with a sort prefix ("3 31-60") so it orders correctly in SQL. */}
                <td>{String(r.ageing_bucket).replace(/^\d\s/, '')}</td>
                <td className="num">{fmtInt(r.invoices)}</td>
                <td className="num">{fmtMoney(r.balance, 'AED', true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {worst.length ? (
        <>
          <div className="subhead"><h3>Most owed</h3><span className="count">{worst.length}</span></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Customer</th><th className="num">Invoices</th><th className="num">Balance</th><th className="num">Worst age</th></tr></thead>
              <tbody>
                {worst.map((c) => (
                  <tr key={String(c.customer_name)}>
                    <td className="wrap">{String(c.customer_name)}</td>
                    <td className="num">{fmtInt(c.invoices)}</td>
                    <td className="num">{fmtMoney(c.balance, 'AED', true)}</td>
                    <td className="num">{fmtInt(c.worst_days)}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}

/* ───────────────────────── page ───────────────────────── */

export default function Reports() {
  const [sp, setSp] = useSearchParams();
  const key = sp.get('r') ?? 'margin';
  const from = sp.get('from') ?? '';
  const to = sp.get('to') ?? '';
  const sbuId = sp.get('sbu') ?? '';
  const ownerId = sp.get('owner') ?? '';
  const groupBy = sp.get('groupBy') ?? 'owner';

  const boot = useBootstrap();
  const employees = useEmployees();
  const toast = useToast();
  const canExport = useCan('reports.export');
  const [exporting, setExporting] = useState(false);

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v); else n.delete(k);
    setSp(n, { replace: true });
  };

  const catalogue = useQuery({
    queryKey: ['reports', 'catalogue'],
    queryFn: () => api.get<{ data: Catalogue[] }>('/reports'),
    select: (r) => r.data,
  });

  const query = { from: from || undefined, to: to || undefined, sbuId: sbuId || undefined, ownerId: ownerId || undefined, ...(key === 'win-loss' ? { groupBy } : {}) };
  const report = useQuery({
    queryKey: ['report', key, query],
    queryFn: () => api.get<{ data: ReportPayload }>(`/reports/${key}`, query),
    select: (r) => r.data,
    retry: false,
  });

  const current = (catalogue.data ?? []).find((c) => c.key === key);
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <>
      <PageHead
        title="Reports"
        sub="Figures are scoped to what you can see, and any column your role may not read is left out rather than blanked."
        actions={canExport ? (
          <button
            type="button"
            className="btn"
            disabled={exporting || report.isPending || report.isError}
            onClick={async () => {
              setExporting(true);
              try {
                await downloadFile(`/reports/${key}/export${qs ? `?${qs}` : ''}`, `${key}.csv`);
              } catch (e) {
                toast.push('crit', e instanceof Error ? e.message : 'The export failed.');
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? 'Preparing…' : 'Export CSV'}
          </button>
        ) : null}
      />

      <div className="filters">
        <div className="field">
          <span className="label" id="rpt">Report</span>
          <div className="seg seg--wrap" role="group" aria-labelledby="rpt">
            {(catalogue.data ?? []).map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={key === c.key}
                disabled={!c.available}
                title={c.available ? c.sub : 'Not available to your role'}
                onClick={() => set('r', c.key)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          <span className="label">From</span>
          <input className="input" type="date" value={from} onChange={(e) => set('from', e.target.value)} />
        </label>
        <label className="field">
          <span className="label">To</span>
          <input className="input" type="date" value={to} onChange={(e) => set('to', e.target.value)} />
        </label>
        <label className="field">
          <span className="label">SBU</span>
          <select className="select" value={sbuId} onChange={(e) => set('sbu', e.target.value)}>
            <option value="">All</option>
            {(boot.data?.sbus ?? []).map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Owner</span>
          <select className="select" value={ownerId} onChange={(e) => set('owner', e.target.value)}>
            <option value="">Anyone</option>
            {(employees.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </label>
        {key === 'win-loss' ? (
          <label className="field">
            <span className="label">Group by</span>
            <select className="select" value={groupBy} onChange={(e) => set('groupBy', e.target.value)}>
              <option value="owner">Account manager</option>
              <option value="sbu">SBU</option>
              <option value="customer">Customer</option>
              <option value="business_type">Business type</option>
              <option value="month">Month</option>
            </select>
          </label>
        ) : null}
      </div>

      <Panel title={current?.name ?? 'Report'} flush>
        <DataView
          query={report}
          label="Running the report"
          isEmpty={(d) => d.rows.length === 0}
          empty={<EmptyState title="Nothing to report" hint="No records match these filters — widen the dates, or clear the SBU and owner." />}
        >
          {(d) => (
            key === 'margin' ? <MarginTable d={d} />
              : key === 'win-loss' ? <WinLossTable d={d} />
              : key === 'pipeline' ? <PipelineTable d={d} />
              : key === 'sla' ? <SlaTable d={d} />
              : <ReceivablesTable d={d} />
          )}
        </DataView>
      </Panel>
    </>
  );
}
