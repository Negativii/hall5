import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Copy, Plus, Search, Sparkles } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Project } from '../lib/types';
import { formatDate, formatTime, relativeDate } from '../lib/format';
import { copyText } from '../lib/clipboard';
import { Btn, IconBtn } from '../components/ui';
import { Modal } from '../components/Modal';
import { MiniNet } from '../components/MiniNet';
import { StatusChip } from '../components/StatusChip';
import { useToast } from '../components/Toast';

const emptyForm = () => ({ title: '', client: '', eventDate: '', description: '' });

function accessState(project: Project) {
  if (!project.share.enabled) return { label: 'Доступ закрыт', note: 'Доступ выключен. Включите его в настройках проекта.' };
  if (project.share.expiresAt && Date.parse(project.share.expiresAt) < Date.now()) {
    return { label: 'Срок доступа истёк', note: 'Срок доступа истёк. Измените дату в настройках проекта.' };
  }
  if (!project.share.passcodeSet) return { label: 'Не задан пароль', note: 'Показ закрыт. Сначала задайте пароль в проекте.' };
  if (project.videoScenes && !project.videoScenes.some((scene) => scene.published)) {
    return { label: 'Нет опубликованных сцен', note: 'Сначала опубликуйте хотя бы одну видеосцену.' };
  }
  return { label: 'Доступ по паролю', note: 'Передайте пароль отдельно. Проверьте опубликованную сцену перед отправкой ссылки.' };
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [hasLoaded, setHasLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const loadRequest = useRef<AbortController | null>(null);
  const createPending = useRef(false);
  const mounted = useRef(true);
  const requestedNew = searchParams.get('new') === '1';

  const load = useCallback(async () => {
    if (loadRequest.current) return;
    const request = new AbortController();
    loadRequest.current = request;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.abort(); }, 15000);
    setRefreshing(true);
    try {
      const data = await api<{ projects: Project[] }>('/api/projects', { signal: request.signal });
      if (request.signal.aborted) return;
      setProjects(data.projects);
      setHasLoaded(true);
      setLoadError('');
    } catch (error) {
      if (request.signal.aborted && !timedOut) return;
      if (error instanceof ApiError && error.status === 401) {
        navigate('/login?next=/admin', { replace: true });
      } else {
        setLoadError(timedOut ? 'Сервер не ответил вовремя. Попробуйте загрузить проекты ещё раз.' : 'Не удалось обновить проекты. Проверьте соединение и попробуйте ещё раз.');
      }
    } finally {
      window.clearTimeout(timeout);
      if (loadRequest.current === request) loadRequest.current = null;
      if (!request.signal.aborted || (timedOut && mounted.current)) { setLoading(false); setRefreshing(false); }
    }
  }, [navigate]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted.current = false;
      loadRequest.current?.abort();
      loadRequest.current = null;
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const openCreate = useCallback(() => {
    if (createPending.current) return;
    setForm(emptyForm());
    setFormError('');
    setCreateOpen(true);
  }, []);

  useEffect(() => {
    if (requestedNew) openCreate();
  }, [requestedNew, openCreate]);

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return projects;
    return projects.filter(
      (project) =>
        project.title.toLowerCase().includes(value) ||
        project.client.toLowerCase().includes(value),
    );
  }, [projects, query]);

  const closeCreate = () => {
    if (createPending.current) return;
    setCreateOpen(false);
    setForm(emptyForm());
    setFormError('');
    if (searchParams.get('new')) setSearchParams((current) => {
      const next = new URLSearchParams(current); next.delete('new'); return next;
    }, { replace: true });
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (createPending.current) return;
    if (!form.title.trim()) {
      setFormError('Дайте проекту название');
      return;
    }
    createPending.current = true;
    setCreating(true);
    setFormError('');
    try {
      const data = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        body: {
          title: form.title,
          client: form.client,
          eventDate: form.eventDate,
          description: form.description,
        },
      });
      if (!mounted.current) return;
      toast.push('Проект создан', { description: 'Настройте зал, загрузите видео и задайте пароль для заказчика.', tone: 'success' });
      navigate(`/admin/p/${data.project.id}`);
    } catch (caught) {
      if (!mounted.current) return;
      setFormError(caught instanceof Error ? caught.message : 'Не удалось создать проект');
    } finally {
      createPending.current = false;
      if (mounted.current) setCreating(false);
    }
  };

  const copy = async (project: Project) => {
    const ok = await copyText(`${project.publicUrl || window.location.origin}${project.share.path}`);
    toast.push(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', {
      description: ok ? accessState(project).note : undefined,
      tone: ok ? 'success' : 'error',
    });
  };

  const approved = projects.filter((project) => project.status === 'approved').length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="eyebrow">
            <span className="eyebrow__dot" />
            Кабинет
          </span>
          <h1>Проекты</h1>
          <p>
            {projects.length} {projects.length === 1 ? 'показ' : 'показов'} · {approved} согласовано
          </p>
        </div>
        <Btn variant="primary" icon={<Plus size={17} />} onClick={openCreate}>
          Новый показ
        </Btn>
      </div>

      <div className="toolbar">
        <div className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти по названию или заказчику"
            aria-label="Поиск проектов"
          />
        </div>
        <span className="toolbar__hint">Зал, видеосцены и доступ заказчика</span>
      </div>

      {loadError ? <div className="alert alert--warn" role="alert" style={{ marginBottom: 18, flexWrap: 'wrap' }}>
        <span>{loadError}{hasLoaded ? ' Ниже показаны последние загруженные данные.' : ''}</span>
        <Btn size="sm" onClick={() => void load()} loading={refreshing}>Повторить загрузку</Btn>
      </div> : null}

      {loading ? (
        <div className="project-grid">
          {[0, 1, 2, 3].map((index) => (
            <div className="project-card project-card--skeleton" key={index}>
              <div className="skeleton skeleton--cover" />
              <div className="skeleton skeleton--line" />
              <div className="skeleton skeleton--line skeleton--short" />
            </div>
          ))}
        </div>
      ) : !hasLoaded && loadError ? null : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__art">
            <MiniNet
              surfaces={[
                { key: 'right', num: 1, label: 'RIGHT', posterUrl: null },
                { key: 'back', num: 2, label: 'BACK', posterUrl: null },
                { key: 'left', num: 3, label: 'LEFT', posterUrl: null },
                { key: 'center', num: 4, label: 'CENTER', posterUrl: null },
                { key: 'floor', num: 5, label: 'FLOOR', posterUrl: null },
              ]}
            />
          </div>
          <h2>{query ? 'Ничего не нашлось' : 'Пока ни одного показа'}</h2>
          <p>
            {query
              ? 'Попробуйте другое название или имя заказчика.'
              : 'Создайте проект, настройте зал и видео. Перед отправкой ссылки опубликуйте сцену и задайте пароль.'}
          </p>
          {!query ? (
            <Btn variant="primary" icon={<Plus size={16} />} onClick={openCreate}>
              Создать первый показ
            </Btn>
          ) : null}
        </div>
      ) : (
        <div className="project-grid">
          {filtered.map((project) => (
            <article className="project-card" key={project.id}>
              <Link to={`/admin/p/${project.id}`} className="project-card__main">
                <div className="project-card__cover">
                  <MiniNet surfaces={project.surfaces.filter((surface) => project.requiredSurfaceKeys?.includes(surface.key) ?? true)} />
                  <div className="project-card__badges">
                    <StatusChip status={project.status} />
                    {project.demo ? <span className="tag tag--accent">демо</span> : null}
                  </div>
                  <span className="project-card__open">
                    <ArrowUpRight size={16} />
                  </span>
                </div>
                <div className="project-card__body">
                  <h3>{project.title}</h3>
                  <p>
                    {project.client || 'Без заказчика'}
                    {project.eventDate ? ` · ${formatDate(project.eventDate)}` : ''}
                  </p>
                  <div className="project-card__meta">
                    <span>{project.total ? `${project.ready} / ${project.total} видео` : 'Без видео'}</span>
                    <span>{project.duration ? formatTime(project.duration) : '—'}</span>
                    <span>{relativeDate(project.updatedAt)}</span>
                  </div>
                  <p title={accessState(project).note}>{accessState(project).label}</p>
                </div>
              </Link>
              <IconBtn
                className="project-card__copy"
                label="Скопировать ссылку"
                onClick={() => copy(project)}
              >
                <Copy size={15} />
              </IconBtn>
            </article>
          ))}
        </div>
      )}

      <div className="page-foot">
        <Sparkles size={14} />
        Перед отправкой ссылки опубликуйте видеосцену, задайте пароль и проверьте срок доступа.
      </div>

      <Modal
        open={createOpen}
        onClose={closeCreate}
        title="Новый показ"
        eyebrow="KUOG HALL"
        dismissable={!creating}
        footer={
          <>
            <Btn variant="ghost" onClick={closeCreate} disabled={creating}>
              Отмена
            </Btn>
            <Btn variant="primary" type="submit" form="create-project-form" loading={creating} icon={<Plus size={16} />}>
              Создать
            </Btn>
          </>
        }
      >
        <form id="create-project-form" className="form" onSubmit={create} aria-busy={creating}>
          <label className="field">
            <span className="field__label">Название</span>
            <input
              className="input"
              disabled={creating}
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              placeholder="Например, Ночь музеев · Main show"
              autoFocus
              maxLength={120}
            />
          </label>
          <div className="form__row">
            <label className="field">
              <span className="field__label">Заказчик</span>
              <input
                className="input"
                disabled={creating}
                value={form.client}
                onChange={(event) => setForm({ ...form, client: event.target.value })}
                placeholder="Музей современного искусства"
                maxLength={120}
              />
            </label>
            <label className="field">
              <span className="field__label">Дата показа</span>
              <input
                className="input"
                disabled={creating}
                type="date"
                value={form.eventDate}
                onChange={(event) => setForm({ ...form, eventDate: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">
              Описание <span className="muted">— необязательно</span>
            </span>
            <textarea
              className="textarea"
              disabled={creating}
              rows={3}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="Коротко о том, что за показ"
              maxLength={2000}
            />
          </label>
          {formError ? <div className="form-error">{formError}</div> : null}
        </form>
      </Modal>
    </div>
  );
}
