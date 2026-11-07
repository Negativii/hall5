import { SurfaceKey } from '../lib/types';

const LABELS: Record<string, { text: string; tone: string }> = {
  draft: { text: 'Черновик', tone: 'neutral' },
  ready: { text: 'Готов к показу', tone: 'live' },
  approved: { text: 'Согласовано', tone: 'success' },
  processing: { text: 'Обработка', tone: 'warn' },
  empty: { text: 'Нет видео', tone: 'neutral' },
  error: { text: 'Ошибка', tone: 'danger' },
  pending: { text: 'Ожидает', tone: 'neutral' },
  online: { text: 'Онлайн', tone: 'live' },
};

export function StatusChip({ status, label }: { status: string; label?: string }) {
  const config = LABELS[status] || { text: status, tone: 'neutral' };
  return (
    <span className={`chip chip--${config.tone}`}>
      <span className="chip__dot" />
      {label || config.text}
    </span>
  );
}

export function SurfaceBadge({
  num,
  label,
  keyName,
  muted,
}: {
  num: number;
  label: string;
  keyName?: SurfaceKey;
  muted?: boolean;
}) {
  return (
    <span className={`surface-badge ${muted ? 'is-muted' : ''}`} data-key={keyName}>
      <span className="surface-badge__num">{num}</span>
      <span className="surface-badge__label">{label}</span>
    </span>
  );
}
