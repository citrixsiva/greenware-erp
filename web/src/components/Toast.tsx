import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

type Tone = 'ok' | 'info' | 'warn' | 'crit';
interface Toast { id: number; tone: Tone; text: string }
interface Api { push(tone: Tone, text: string): void }

const Ctx = createContext<Api>({ push() {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: Tone, text: string) => {
      const id = ++seq.current;
      setItems((l) => [...l.slice(-3), { id, tone, text }]);
      if (tone === 'ok' || tone === 'info') setTimeout(() => dismiss(id), 6000);
    },
    [dismiss],
  );
  const api = useMemo(() => ({ push }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`notice notice--${t.tone}`}>
            <span className="prewrap">{t.text}</span>
            <button type="button" className="btn btn--ghost btn--icon btn--sm close" onClick={() => dismiss(t.id)} aria-label="Dismiss message">
              <Icon name="close" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
