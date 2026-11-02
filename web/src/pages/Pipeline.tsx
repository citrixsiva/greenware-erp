import { useMemo, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, type One } from '../lib/api';
import { useCan } from '../lib/auth';
import { fmtCompact, fmtInt, fmtMoney, isNum, fmtPct } from '../lib/format';
import { useBootstrap, useEmployees } from '../lib/hooks';
import { STAGES, type Board, type BoardStage, type EnquiryRow, type Stage } from '../lib/types';
import { MessageDialog } from '../components/Dialog';
import { StageDialog, needsInput, postStage } from '../components/StageDialog';
import { Chip, DataView, Kpi, PageHead } from '../components/ui';
import { useToast } from '../components/Toast';

interface Summary { open_count: number; open_value: number; weighted_value: number; overdue_follow_ups: number; won_count: number; won_value: number; conversion_pct: number | null }

/** Applies in-flight (optimistic) moves to the server's board without mutating it. */
function applyMoves(board: Board, moved: Record<string, Stage>): BoardStage[] {
  const ids = Object.keys(moved);
  if (!ids.length) return board.stages;
  const stages = board.stages.map((s) => ({ ...s, cards: [...s.cards] }));
  const byStage = new Map(stages.map((s) => [s.stage, s]));
  for (const id of ids) {
    const from = stages.find((s) => s.cards.some((c) => c.id === id));
    const to = byStage.get(moved[id]);
    if (!from || !to || from === to) continue;
    const card = from.cards.find((c) => c.id === id)!;
    from.cards = from.cards.filter((c) => c.id !== id);
    from.count -= 1;
    from.total_value -= Number(card.value_aed ?? 0);
    from.weighted_value -= Number(card.weighted_value_aed ?? 0);
    to.cards.unshift({ ...card, stage: moved[id], days_in_stage: 0 });
    to.count += 1;
    to.total_value += Number(card.value_aed ?? 0);
    to.weighted_value += Number(card.weighted_value_aed ?? 0);
  }
  return stages;
}

function EnquiryCard({
  card, canEdit, pending, onMove, onDragState,
}: {
  card: EnquiryRow; canEdit: boolean; pending: boolean;
  onMove: (c: EnquiryRow, to: Stage) => void;
  onDragState: (id: string | null) => void;
}) {
  const value = isNum(card.approx_budget) ? fmtMoney(card.approx_budget, card.budget_currency ?? 'AED', true) : null;
  const gm = card.gross_margin_pct; // absent for roles that may not see margin: then no chip at all
  return (
    <article
      className="card"
      data-pending={pending}
      draggable={canEdit && !pending}
      onDragStart={(e: DragEvent) => {
        e.dataTransfer.setData('text/plain', card.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragState(card.id);
      }}
      onDragEnd={() => onDragState(null)}
    >
      <div className="card__top">
        <span className="card__no">{card.enquiry_no}</span>
        {value ? <span className="card__value" title={card.budget_currency && card.budget_currency !== 'AED' && isNum(card.value_aed) ? `≈ ${fmtMoney(card.value_aed, 'AED', true)}` : undefined}>{value}</span> : <span className="muted">No budget</span>}
      </div>
      <Link className="card__title" to={`/enquiries/${card.id}`} draggable={false}>{card.title}</Link>
      <div className="card__cust">{card.customer_name}</div>
      <div className="card__chips">
        {card.primary_sbu_code ? <Chip mono title="Primary SBU">{card.primary_sbu_code}</Chip> : null}
        {isNum(gm) ? <Chip mono tone="accent" title="Gross margin">GM {fmtPct(gm)}</Chip> : null}
        {isNum(card.probability) ? <Chip mono title="Probability">{fmtInt(card.probability)}%</Chip> : null}
        {card.follow_up_overdue ? <Chip tone="crit" title={card.next_follow_up ? `Follow-up was due ${card.next_follow_up}` : undefined}>Follow-up overdue</Chip> : null}
        {card.slip_count > 0 ? <Chip tone="warn" title="Times the expected date has slipped">Slipped {card.slip_count}×</Chip> : null}
      </div>
      <div className="card__foot">
        <span title={card.account_manager_name}><span className="mono">{card.days_in_stage}d</span> in stage</span>
        {canEdit ? (
          <select
            className="card__move"
            aria-label={`Move ${card.enquiry_no} to another stage`}
            value=""
            disabled={pending}
            onChange={(e) => e.target.value && onMove(card, e.target.value as Stage)}
          >
            <option value="">Move…</option>
            {STAGES.filter((s) => s !== card.stage).map((s) => <option key={s}>{s}</option>)}
          </select>
        ) : null}
      </div>
    </article>
  );
}

export default function Pipeline() {
  const [sp, setSp] = useSearchParams();
  const canEdit = useCan('enquiries.edit');
  const qc = useQueryClient();
  const toast = useToast();
  const boot = useBootstrap();
  const emps = useEmployees();

  const filters = {
    ownerId: sp.get('ownerId') ?? '',
    sbuId: sp.get('sbuId') ?? '',
    businessTypeId: sp.get('businessTypeId') ?? '',
    overdueFollowUp: sp.get('overdue') === '1',
  };
  const params = {
    ownerId: filters.ownerId || undefined,
    sbuId: filters.sbuId || undefined,
    businessTypeId: filters.businessTypeId || undefined,
    overdueFollowUp: filters.overdueFollowUp ? 'true' : undefined,
  };
  const setFilter = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };

  const board = useQuery({ queryKey: ['board', params], queryFn: async () => (await api.get<One<Board>>('/pipeline/board', params)).data });
  const summary = useQuery({
    queryKey: ['pipeline-summary', params.ownerId, params.sbuId, params.businessTypeId],
    queryFn: async () => (await api.get<One<Summary>>('/pipeline/summary', { ownerId: params.ownerId, sbuId: params.sbuId, businessTypeId: params.businessTypeId })).data,
  });

  const [moved, setMoved] = useState<Record<string, Stage>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<Stage | null>(null);
  const [blocked, setBlocked] = useState<{ no: string; to: Stage; message: string } | null>(null);
  const [ask, setAsk] = useState<{ card: EnquiryRow; to: Stage } | null>(null);

  const stages = useMemo(() => (board.data ? applyMoves(board.data, moved) : []), [board.data, moved]);
  const findCard = (id: string) => board.data?.stages.flatMap((s) => s.cards).find((c) => c.id === id);

  async function refresh() {
    await Promise.all([qc.invalidateQueries({ queryKey: ['board'] }), qc.invalidateQueries({ queryKey: ['pipeline-summary'] })]);
  }

  async function move(card: EnquiryRow, to: Stage) {
    if (card.stage === to) return;
    if (needsInput(to)) {
      setAsk({ card, to });
      return;
    }
    setMoved((m) => ({ ...m, [card.id]: to }));
    try {
      await postStage(card.id, { stage: to });
      await refresh();
      toast.push('ok', `${card.enquiry_no} moved to ${to}.`);
    } catch (e) {
      // Revert the card, then say why — the server's message is written for the user.
      setBlocked({ no: card.enquiry_no, to, message: errorMessage(e) });
    } finally {
      setMoved((m) => {
        const { [card.id]: _drop, ...rest } = m;
        return rest;
      });
    }
  }

  const exceptions = summary.data?.overdue_follow_ups ?? 0;

  return (
    <>
      <PageHead
        title="Pipeline"
        sub={board.data ? `Values in ${board.data.currency}. Drag a card to another column, or use its Move menu.` : undefined}
      />

      {summary.data ? (
        <div className="kpis" aria-label="Pipeline summary">
          <Kpi
            label="Overdue follow-ups"
            value={<span style={exceptions > 0 ? { color: 'var(--crit-ink)' } : undefined}>{fmtInt(exceptions)}</span>}
            sub={exceptions > 0 ? 'Open enquiries past their next follow-up date' : 'Nothing overdue'}
          />
          <Kpi label="Open enquiries" value={fmtInt(summary.data.open_count)} />
          <Kpi label="Open value" value={fmtCompact(summary.data.open_value)} sub={`${board.data?.currency ?? 'AED'}`} />
          <Kpi label="Weighted value" value={fmtCompact(summary.data.weighted_value)} sub="by probability" />
          <Kpi label="Won this year" value={fmtInt(summary.data.won_count)} sub={isNum(summary.data.conversion_pct) ? `${fmtPct(summary.data.conversion_pct)} win rate` : undefined} />
        </div>
      ) : null}

      <div className="filters" role="group" aria-label="Pipeline filters">
        <label className="field">
          <span className="label">Owner</span>
          <select className="select" value={filters.ownerId} onChange={(e) => setFilter('ownerId', e.target.value)}>
            <option value="">Everyone</option>
            {emps.data?.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">SBU</span>
          <select className="select" value={filters.sbuId} onChange={(e) => setFilter('sbuId', e.target.value)}>
            <option value="">All SBUs</option>
            {boot.data?.sbus.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="label">Business type</span>
          <select className="select" value={filters.businessTypeId} onChange={(e) => setFilter('businessTypeId', e.target.value)}>
            <option value="">All types</option>
            {boot.data?.business_types.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label className="check" style={{ height: 30 }}>
          <input type="checkbox" checked={filters.overdueFollowUp} onChange={(e) => setFilter('overdue', e.target.checked ? '1' : '')} />
          <span>Overdue follow-ups only</span>
        </label>
        {(filters.ownerId || filters.sbuId || filters.businessTypeId || filters.overdueFollowUp) ? (
          <button type="button" className="btn btn--sm" onClick={() => setSp({}, { replace: true })}>Clear filters</button>
        ) : null}
      </div>

      <DataView query={board} label="Loading the board">
        {() => (
          <div className="board" role="list" aria-label="Pipeline stages">
            {stages.map((s) => (
              <section
                key={s.stage}
                className="col"
                role="listitem"
                aria-label={`${s.stage}, ${s.count} enquiries`}
                data-over={overStage === s.stage && dragId !== null}
                onDragOver={(e) => {
                  if (!canEdit || !dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overStage !== s.stage) setOverStage(s.stage);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage((o) => (o === s.stage ? null : o));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const id = e.dataTransfer.getData('text/plain') || dragId;
                  setOverStage(null);
                  setDragId(null);
                  const card = id ? findCard(id) : undefined;
                  if (card) void move(card, s.stage);
                }}
              >
                <div className="col__head">
                  <div className="col__title">
                    <span>{s.stage}</span>
                    <span className="count">{s.count}</span>
                  </div>
                  <div className="col__sums">
                    <span title="Total value">Σ <b>{fmtCompact(s.total_value) || '0'}</b></span>
                    <span title="Probability-weighted value">w <b>{fmtCompact(s.weighted_value) || '0'}</b></span>
                  </div>
                </div>
                <div className="col__cards">
                  {s.cards.length === 0 ? <div className="col__empty">No enquiries</div> : null}
                  {s.cards.map((c) => (
                    <EnquiryCard key={c.id} card={c} canEdit={canEdit} pending={!!moved[c.id]} onMove={(cd, to) => void move(cd, to)} onDragState={setDragId} />
                  ))}
                  {s.count > s.cards.length && !Object.keys(moved).length ? (
                    <div className="col__more">{s.count - s.cards.length} more not shown. Narrow the filters.</div>
                  ) : null}
                </div>
              </section>
            ))}
          </div>
        )}
      </DataView>

      {blocked ? (
        <MessageDialog title={`${blocked.no} cannot move to ${blocked.to}`} message={blocked.message} onClose={() => setBlocked(null)}>
          <p className="muted">The card has been put back where it was.</p>
        </MessageDialog>
      ) : null}
      {ask ? (
        <StageDialog
          enquiry={ask.card}
          initialStage={ask.to}
          onClose={() => setAsk(null)}
          onChanged={() => {
            toast.push('ok', `${ask.card.enquiry_no} moved to ${ask.to}.`);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}
