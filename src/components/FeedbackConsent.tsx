import { Link } from 'react-router-dom';
import type { LegalConfig } from '../lib/legal';

export function FeedbackConsentField({ config, checked, onChange }: {
  config: LegalConfig | null; checked: boolean; onChange: (checked: boolean) => void;
}) {
  if (!config?.configured) return <p className="legal-note" role="status">Отправка отзывов недоступна: сведения об обработке данных ещё не загружены или не заполнены. Просмотр доступен без отправки отзыва.</p>;
  return <div className="feedback-consent">
    <label>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>Даю отдельное <Link to="/legal/consent" target="_blank" rel="noopener">согласие на обработку персональных данных</Link> для комментариев и согласования показа. Оператор: {config.operator.name}.</span>
    </label>
    <p>Имя и отзыв увидят команда и зрители с доступом к этому показу. <Link to="/legal/privacy" target="_blank" rel="noopener">Политика конфиденциальности</Link>. Просматривать видео можно без согласия и отзыва.</p>
  </div>;
}
