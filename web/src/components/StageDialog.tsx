import { useState } from 'react';
import { api, type One } from '../lib/api';
import { useBootstrap } from '../lib/hooks';
import { STAGES, type EnquiryRow, type Stage } from '../lib/types';
import { FormDialog } from './Dialog';
import { Field } from './ui';

export const needsInput = (s: Stage) => s === 'Lost' || s === 'Cancelled' || s === 'Dropped';

export async function postStage(id: string, body: { stage: Stage; lossReasonId?: string | null; lossRemarks?: string; remarks?: string }) {
  return (await api.post<One<EnquiryRow>>(`/enquiries/${id}/stage`, body)).data;
}

/**
 * Change an enquiry's stage. The server owns the gates (no approved quote → cannot submit, no PO → cannot win …);
 * whatever it says is shown here word for word.
 */
export function StageDialog({
  enquiry, initialStage, onClose, onChanged,
}: {
  enquiry: { id: string; enquiry_no: string; stage: Stage };
  initialStage?: Stage;
  onClose: () => void;
  onChanged: () => void;
}) {
  const boot = useBootstrap();
  const [stage, setStage] = useState<Stage>(initialStage ?? STAGES.find((s) => s !== enquiry.stage)!);
  const [reason, setReason] = useState('');
  const [lossRemarks, setLossRemarks] = useState('');
  const [remarks, setRemarks] = useState('');

  return (
    <FormDialog
      title={`Move ${enquiry.enquiry_no} to ${stage}`}
      submitLabel="Change stage"
      onClose={onClose}
      onSubmit={async () => {
        await postStage(enquiry.id, {
          stage,
          lossReasonId: stage === 'Lost' ? reason || null : undefined,
          lossRemarks: stage === 'Lost' ? lossRemarks || undefined : undefined,
          remarks: remarks || undefined,
        });
        onChanged();
      }}
    >
      <Field label="New stage" required>
        {(p) => (
          <select {...p} className="select" value={stage} onChange={(e) => setStage(e.target.value as Stage)} disabled={!!initialStage}>
            {STAGES.filter((s) => s !== enquiry.stage).map((s) => <option key={s}>{s}</option>)}
          </select>
        )}
      </Field>
      {stage === 'Lost' ? (
        <>
          <Field label="Loss reason" required>
            {(p) => (
              <select {...p} className="select" value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">Choose a reason…</option>
                {boot.data?.loss_reasons.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="What happened">
            {(p) => <textarea {...p} className="textarea" value={lossRemarks} onChange={(e) => setLossRemarks(e.target.value)} />}
          </Field>
        </>
      ) : null}
      <Field
        label={stage === 'Cancelled' || stage === 'Dropped' ? 'Why is this being closed' : 'Remarks'}
        required={stage === 'Cancelled' || stage === 'Dropped'}
      >
        {(p) => <textarea {...p} className="textarea" value={remarks} onChange={(e) => setRemarks(e.target.value)} />}
      </Field>
    </FormDialog>
  );
}
