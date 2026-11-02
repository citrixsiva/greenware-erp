import { useQuery } from '@tanstack/react-query';
import { api, type One } from '../lib/api';
import { fmtDec, fmtInt } from '../lib/format';
import { Kpi } from './ui';

interface Bucket { total: number; Within: number; Approaching: number; Breached: number; average_elapsed_hours: number | null }
interface SlaSummary { window_days: number; open: Bucket; total: number; by_state: { Within: number; Approaching: number; Breached: number } }

/** Exceptions first: breached and approaching lead, totals follow. */
export function SlaKpis({ path, label }: { path: '/procurement/sla' | '/estimation/sla'; label: string }) {
  const q = useQuery({ queryKey: ['sla', path], queryFn: async () => (await api.get<One<SlaSummary>>(path)).data });
  if (!q.data) return null;
  const o = q.data.open;
  return (
    <div className="kpis" aria-label={`${label} service levels`}>
      <Kpi
        label="Breached"
        value={<span style={o.Breached > 0 ? { color: 'var(--crit-ink)' } : undefined}>{fmtInt(o.Breached)}</span>}
        sub={o.Breached > 0 ? 'Open past the SLA target' : 'None open past target'}
      />
      <Kpi
        label="Approaching"
        value={<span style={o.Approaching > 0 ? { color: 'var(--warn-ink)' } : undefined}>{fmtInt(o.Approaching)}</span>}
        sub="Open, nearing the target"
      />
      <Kpi label="Within SLA" value={fmtInt(o.Within)} sub="Open and on time" />
      <Kpi label="Open requests" value={fmtInt(o.total)} />
      <Kpi label={`Avg. response, ${q.data.window_days} d`} value={q.data.total ? `${fmtDec(q.data.open.average_elapsed_hours ?? 0, 1)} h` : '0 h'} sub="working hours, open items" />
    </div>
  );
}
