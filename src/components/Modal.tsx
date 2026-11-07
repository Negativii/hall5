import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from './ui';

const openPanels: HTMLDivElement[] = [];
let originalOverflow = '';
const focusable = (panel: HTMLElement) => [...panel.querySelectorAll<HTMLElement>(
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
)].filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  size = 'md',
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  dismissable?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const dismissableRef = useRef(dismissable);
  closeRef.current = onClose;
  dismissableRef.current = dismissable;

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!openPanels.length) {
      originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    openPanels.push(panel);
    const onKey = (event: KeyboardEvent) => {
      if (openPanels.at(-1) !== panel) return;
      if (event.key === 'Escape' && dismissableRef.current) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === 'Tab') {
        const elements = focusable(panel);
        const first = elements[0];
        const last = elements.at(-1);
        if (!first) { event.preventDefault(); panel.focus(); }
        else if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const timer = window.setTimeout(() => {
      if (openPanels.at(-1) !== panel || panel.contains(document.activeElement)) return;
      const input = panel.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])');
      (input || focusable(panel)[0] || panel).focus();
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      const wasTop = openPanels.at(-1) === panel;
      const index = openPanels.indexOf(panel);
      if (index !== -1) openPanels.splice(index, 1);
      if (!openPanels.length) document.body.style.overflow = originalOverflow;
      if (wasTop && previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissable) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cx('modal__panel', `modal__panel--${size}`)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal__head">
          <div>
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            <h2 className="modal__title">{title}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} disabled={!dismissable} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
