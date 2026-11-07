import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { FolderOpen, LogOut } from 'lucide-react';
import { api } from '../lib/api';
import { LegalLinks } from '../components/LegalLinks';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/ui';

export function AdminLayout() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'denied'>('loading');
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let alive = true;
    api<{ authenticated: boolean }>('/api/me')
      .then((me) => {
        if (!alive) return;
        setStatus(me.authenticated ? 'ok' : 'denied');
      })
      .catch(() => {
        if (alive) setStatus('denied');
      });
    return () => {
      alive = false;
    };
  }, []);

  if (status === 'loading') {
    return (
      <div className="boot">
        <Logo />
        <Spinner size={22} />
      </div>
    );
  }

  if (status === 'denied') {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }

  const logout = async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } finally {
      navigate('/login', { replace: true });
    }
  };

  return (
    <div className="admin-shell">
      <aside className="rail">
        <div className="rail__top">
          <Logo link />
          <span className="rail__caption">Кабинет</span>
        </div>
        <nav className="rail__nav">
          <NavLink to="/admin" end className={({ isActive }) => `rail__link ${isActive ? 'is-active' : ''}`}>
            <FolderOpen size={17} />
            Проекты
          </NavLink>
        </nav>
        <div className="rail__bottom">
          <LegalLinks />
          <div className="rail__user">
            <span className="avatar avatar--1">A</span>
            <div>
              <strong>Администратор</strong>
              <span>полный доступ</span>
            </div>
          </div>
          <button className="rail__logout" onClick={logout}>
            <LogOut size={15} />
            Выйти
          </button>
        </div>
      </aside>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
