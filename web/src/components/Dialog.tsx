import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../lib/api';
import { Icon } from './Icon';

interface DialogProps {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  tone?: 'default' | 'crit';
}

/**
 * Native <dialog>: focus is trapped, Esc closes, and the page behind is inert. Mount it only while it
 * is open (`{open && <Dialog …/>}`) so its form state resets every time.
 */
export function Dialog({ title, onClose, wide, children, footer, tone = 'default' }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => {
      if (el?.open) el.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dlg${wide ? ' dlg--wide' : ''}`}
      aria-labelledby="dlg-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dlg__head">
        <h2 id="dlg-title" style={tone === 'crit' ? { color: 'var(--crit-ink)' } : undefined}>{title}</h2>
        <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close dialog">
          <Icon name="close" />
        </button>
      </div>
      {children}
      {footer ? <div className="dlg__foot">{footer}</div> : null}
    </dialog>
  );
}

/** A message dialog: used for blocked actions where the API's own message is the content. */
export function MessageDialog({ title, message, onClose, children }: { title: string; message: string; onClose: () => void; children?: ReactNode }) {
  return (
    <Dialog
      title={title}
      tone="crit"
      onClose={onClose}
      footer={<button type="button" className="btn btn--primary" onClick={onClose} autoFocus>OK</button>}
    >
      <div className="dlg__body" role="alert">
        <p className="prewrap">{message}</p>
        {children}
      </div>
    </Dialog>
  );
}

interface FormDialogProps {
  title: string;
  submitLabel: string;
  onClose: () => void;
  /** Throw to keep the dialog open and show the error; resolve to close it. */
  onSubmit: () => Promise<void>;
  children: ReactNode;
  wide?: boolean;
  danger?: boolean;
  disabled?: boolean;
  extraFooter?: ReactNode;
}

export function FormDialog({ title, submitLabel, onClose, onSubmit, children, wide, danger, disabled, extraFooter }: FormDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={title} onClose={onClose} wide={wide}>
      <form onSubmit={submit} style={{ display: 'contents' }} noValidate>
        <div className="dlg__body">
          {children}
          {error ? (
            <div className="notice notice--crit" role="alert">
              <Icon name="alert" />
              <span className="prewrap">{error}</span>
            </div>
          ) : null}
        </div>
        <div className="dlg__foot">
          {extraFooter}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} disabled={busy || disabled}>
            {busy ? 'Working…' : submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
