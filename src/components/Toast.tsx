import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';

type Tone = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  title: string;
  description?: string;
  tone: Tone;
}

interface ToastApi {
  push: (title: string, options?: { description?: string; tone?: Tone }) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (title: string, options?: { description?: string; tone?: Tone }) => {
      counter.current += 1;
      const id = counter.current;
      setItems((current) => [...current, { id, title, tone: options?.tone || 'info', description: options?.description }]);
      window.setTimeout(() => remove(id), 4600);
    },
    [remove],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone}`}>
            <span className="toast__icon">
              {item.tone === 'success' ? <Check size={16} /> : item.tone === 'error' ? <AlertTriangle size={16} /> : <Info size={16} />}
            </span>
            <div className="toast__body">
              <span className="toast__title">{item.title}</span>
              {item.description ? <span className="toast__desc">{item.description}</span> : null}
            </div>
            <button className="toast__close" onClick={() => remove(item.id)} aria-label="Закрыть">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('ToastProvider отсутствует');
  return context;
}
