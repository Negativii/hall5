import { Link } from 'react-router-dom';

export function LegalLinks() {
  return <nav className="legal-links" aria-label="Правовая информация">
    <Link to="/legal/privacy" target="_blank" rel="noopener">Конфиденциальность</Link>
    <Link to="/legal/terms" target="_blank" rel="noopener">Правила просмотра</Link>
    <Link to="/legal/cookies" target="_blank" rel="noopener">Cookie</Link>
  </nav>;
}
