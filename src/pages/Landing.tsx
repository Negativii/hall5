import { Link } from 'react-router-dom';
import { ArrowRight, LockKeyhole } from 'lucide-react';
import { Logo } from '../components/Logo';
import '../styles/private-entry.css';

export function Landing() {
  return (
    <div className="private-entry">
      <header className="private-entry__header">
        <Logo />
        <span className="private-entry__status"><LockKeyhole size={14} /> Закрытый доступ</span>
      </header>

      <main className="private-entry__main">
        <div className="private-entry__symbol" aria-hidden="true"><LockKeyhole size={27} strokeWidth={1.4} /></div>
        <span className="eyebrow">Пространство для согласования</span>
        <h1>Ваш показ.<br /><span>Только по приглашению.</span></h1>
        <p className="private-entry__lead">
          KUOG HALL — закрытый сервис для просмотра и обсуждения видеоконтента в виртуальном зале.
        </p>
        <div className="private-entry__invite">
          <strong>Пришли посмотреть проект?</strong>
          <p>Откройте ссылку на показ и введите пароль, который передал организатор.</p>
        </div>
        <Link to="/login" className="btn btn--primary btn--lg">
          Вход для команды <ArrowRight size={17} />
        </Link>
      </main>

      <footer className="private-entry__footer">
        <p>Сервис предназначен для демонстрации и обсуждения материалов. Продажи и оплата на сайте не осуществляются.</p>
        <nav aria-label="Документы сайта">
          <Link to="/legal/privacy">Конфиденциальность</Link>
          <Link to="/legal/terms">Условия использования</Link>
          <Link to="/legal/cookies">Файлы cookie</Link>
        </nav>
        <span>© {new Date().getFullYear()} KUOG HALL</span>
      </footer>
    </div>
  );
}
