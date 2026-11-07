import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/ui';
import '../styles/private-entry.css';

export function Login() {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const requestedNext = params.get('next') || '/admin';
  const next = requestedNext.startsWith('/') && !requestedNext.startsWith('//') ? requestedNext : '/admin';

  useEffect(() => {
    let alive = true;
    api<{ authenticated: boolean }>('/api/me')
      .then((me) => {
        if (alive && me.authenticated) navigate(next, { replace: true });
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setChecking(false);
      });
    return () => {
      alive = false;
    };
  }, [navigate, next]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password.trim()) {
      setError('Введите пароль');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await api('/api/login', { method: 'POST', body: { password } });
      navigate(next, { replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось войти');
      setLoading(false);
    }
  };

  return (
    <div className="login login--private">
      <div className="login__panel">
        <div className="login__top">
          <Logo link />
          <Link to="/" className="login__back">
            <ArrowLeft size={14} /> На главную
          </Link>
        </div>

        <div className="login__form-wrap">
          <span className="eyebrow">
            <span className="eyebrow__dot" />
            Кабинет
          </span>
          <h1>Вход для команды</h1>
          <p className="login__lead">
            Управление проектами, сценами и доступом к показам. Введите пароль администратора.
          </p>

          {checking ? (
            <div className="login__checking">
              <Spinner /> Проверяем сессию
            </div>
          ) : (
            <form className="login__form" onSubmit={submit}>
              <label className="field">
                <span className="field__label">Пароль</span>
                <span className="input-wrap">
                  <Lock size={16} className="input-wrap__icon" />
                  <input
                    className="input input--with-icon input--with-action"
                    type={show ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="••••••••"
                    autoFocus
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="input-wrap__action"
                    onClick={() => setShow((value) => !value)}
                    aria-label={show ? 'Скрыть пароль' : 'Показать пароль'}
                  >
                    {show ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
              </label>
              {error ? <div className="form-error" role="alert">{error}</div> : null}
              <button className="btn btn--primary btn--lg btn--full" type="submit" disabled={loading}>
                {loading ? <Spinner size={17} /> : null}
                Войти
                <ArrowRight size={17} />
              </button>
            </form>
          )}

          <p className="login__hint">
            Если вы приглашены на просмотр, откройте отдельную ссылку на показ от организатора.
          </p>
        </div>

        <footer className="private-entry__footer private-entry__footer--login">
          <nav aria-label="Документы сайта">
            <Link to="/legal/privacy">Конфиденциальность</Link>
            <Link to="/legal/terms">Условия использования</Link>
            <Link to="/legal/cookies">Файлы cookie</Link>
          </nav>
          <p>Для входа используются необходимые файлы cookie. Подробнее — в документах сайта.</p>
          <span>© {new Date().getFullYear()} KUOG HALL</span>
        </footer>
      </div>

      <aside className="login__visual private-entry__visual" aria-label="О сервисе">
        <div className="private-entry__visual-content">
          <span className="eyebrow">KUOG HALL</span>
          <p className="private-entry__visual-title">Место,<br />где показ<br /><em>обретает форму.</em></p>
          <p>Закрытое рабочее пространство для демонстрации и обсуждения видеоконтента.</p>
          <span className="private-entry__visual-note">Доступ к материалам — по приглашению организатора.</span>
        </div>
      </aside>
    </div>
  );
}
