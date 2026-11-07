import { ChangeEvent, DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Box,
  ArrowLeft,
  Check,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Film,
  Link2,
  Lock,
  MessageSquare,
  Play,
  Plus,
  Pencil,
  QrCode,
  RefreshCw,
  Settings2,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { api, ApiError, uploadSurface } from '../lib/api';
import { Project, ShareInfo, Surface } from '../lib/types';
import { formatBytes, formatDate, formatTime, relativeDate } from '../lib/format';
import { copyText } from '../lib/clipboard';
import { Btn, Field, IconBtn, Spinner, Toggle } from '../components/ui';
import { Modal } from '../components/Modal';
import { StatusChip } from '../components/StatusChip';
import { useToast } from '../components/Toast';
import '../styles/scene.css';
import '../styles/video-scenes-admin.css';

type Confirm =
  | { kind: 'project' }
  | { kind: 'surface'; key: string; label: string }
  | { kind: 'video-scene'; id: string; label: string; published: boolean }
  | { kind: 'rotate' }
  | null;

export function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedSceneId = searchParams.get('videoScene');
  const context = `${id || ''}:${selectedSceneId || ''}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const loadSequence = useRef(0);
  const refreshRef = useRef<(quiet?: boolean) => Promise<void>>(async () => {});
  const toast = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [uploading, setUploading] = useState<Record<string, number>>({});
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [passcode, setPasscode] = useState('');
  const [savingPasscode, setSavingPasscode] = useState(false);
  const [settings, setSettings] = useState({ title: '', client: '', eventDate: '', description: '' });
  const [savingSettings, setSavingSettings] = useState(false);
  const settingsSavingRef = useRef(false);
  const settingsBaseline = useRef(settings);
  const [settingsError, setSettingsError] = useState('');
  const [sceneForm, setSceneForm] = useState<{ id: string | null; name: string } | null>(null);
  const [sceneNameError, setSceneNameError] = useState('');
  const [sceneSaving, setSceneSaving] = useState(false);
  const [scenePublishing, setScenePublishing] = useState(false);
  const [sceneDeleting, setSceneDeleting] = useState(false);
  const [shareSaving, setShareSaving] = useState(false);
  const shareSavingRef = useRef(false);
  const [surfaceBusy, setSurfaceBusy] = useState<Record<string, boolean>>({});
  const surfaceRequests = useRef(new Set<string>());
  const [confirmBusy, setConfirmBusy] = useState(false);
  const confirmBusyRef = useRef(false);

  const shareUrl = project
    ? `${project.publicUrl || window.location.origin}${project.share.path}`
    : '';
  const previewSurface = project?.surfaces.find((surface) => surface.key === previewKey) || null;
  const videoSceneId = project?.videoSceneId || 'main';
  const videoSceneName = project?.videoSceneName || 'Основная сцена';
  const sceneApi = project ? `/api/projects/${project.id}/video-scenes/${encodeURIComponent(videoSceneId)}` : '';

  const load = useCallback(async (quiet = false) => {
    if (!id) return;
    const ticket = ++loadSequence.current;
    const request = new AbortController();
    const timeout = window.setTimeout(() => request.abort(), 15000);
    try {
      const query = selectedSceneId ? `?videoScene=${encodeURIComponent(selectedSceneId)}` : '';
      const data = await api<{ project: Project }>(`/api/projects/${id}${query}`, { signal: request.signal });
      if (ticket !== loadSequence.current) return;
      setProject(data.project);
      setNotFound(false);
      setLoadError('');
    } catch (error) {
      if (ticket !== loadSequence.current) return;
      if (error instanceof ApiError && error.status === 401) {
        const next = `/admin/p/${id}${selectedSceneId ? `?videoScene=${encodeURIComponent(selectedSceneId)}` : ''}`;
        navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
        return;
      }
      if (error instanceof ApiError && error.status === 404) setNotFound(true);
      else setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить проект. Проверьте соединение.');
    } finally {
      window.clearTimeout(timeout);
      if (ticket === loadSequence.current) setLoading(false);
    }
  }, [id, selectedSceneId, navigate]);
  refreshRef.current = load;

  const acceptProject = (next: Project, requestContext: string) => {
    if (contextRef.current !== requestContext) { void refreshRef.current(); return; }
    loadSequence.current += 1;
    setProject(next);
  };

  const selectScene = (sceneId: string) => {
    setPreviewKey(null);
    setConfirm(null);
    setSearchParams((current) => { const next = new URLSearchParams(current); next.set('videoScene', sceneId); return next; });
  };

  useEffect(() => {
    setLoading(true);
    void load();
    return () => { loadSequence.current += 1; };
  }, [load]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') load(true);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [load]);

  const hasProcessing = Boolean(project?.surfaces.some((surface) => surface.status === 'processing' || surface.replacement?.status === 'processing')
    || project?.videoScenes?.some((scene) => scene.processing > 0));

  useEffect(() => {
    if (!hasProcessing || !id) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      await load(true);
      if (alive) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1500);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [hasProcessing, id, load]);

  const openSettings = () => {
    if (!project || settingsSavingRef.current) return;
    const current = {
      title: project.title,
      client: project.client,
      eventDate: project.eventDate,
      description: project.description,
    };
    settingsBaseline.current = current;
    setSettings(current);
    setSettingsError('');
    setSettingsOpen(true);
  };

  const startUpload = async (key: string, file: File | undefined) => {
    if (!project || !file) return;
    const uploadKey = `${videoSceneId}:${key}`;
    if (uploading[uploadKey] !== undefined || scenePublishing || sceneDeleting) return;
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi|mts|m2ts|mpg|mpeg)$/i.test(file.name)) {
      toast.push('Это не видеофайл', { description: 'Нужен MP4, MOV, WebM или MKV.', tone: 'error' });
      return;
    }
    setUploading((current) => ({ ...current, [uploadKey]: 1 }));
    try {
      const handle = uploadSurface(project.id, key, file, (percent) => {
        setUploading((current) => ({ ...current, [uploadKey]: Math.max(1, percent) }));
      }, videoSceneId);
      const data = (await handle.promise) as { project: Project };
      acceptProject(data.project, context);
      toast.push('Видео загружено', {
        description: 'Готовим превью и постер — это может занять пару минут.',
        tone: 'success',
      });
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось загрузить видео', { tone: 'error' });
    } finally {
      setUploading((current) => {
        const next = { ...current };
        delete next[uploadKey];
        return next;
      });
    }
  };

  const onFileInput = (key: string, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    startUpload(key, file);
  };

  const onDrop = (key: string, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragKey(null);
    startUpload(key, event.dataTransfer.files?.[0]);
  };

  const updateShare = async (patch: Record<string, unknown>) => {
    if (!project || shareSavingRef.current) return false;
    const targetId = project.id;
    const requestContext = context;
    shareSavingRef.current = true;
    setShareSaving(true);
    try {
      const { project: saved } = await api<{ project: Project }>(`/api/projects/${targetId}/share`, {
        method: 'PATCH',
        body: patch,
      });
      if (contextRef.current === requestContext) loadSequence.current += 1;
      else void refreshRef.current(true);
      setProject(current => current?.id === targetId ? { ...current, share: saved.share, updatedAt: saved.updatedAt } : current);
      return true;
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось сохранить', { tone: 'error' });
      return false;
    } finally {
      shareSavingRef.current = false;
      setShareSaving(false);
    }
  };

  const savePasscode = async () => {
    if (!project) return;
    if (passcode.trim().length < 8) {
      toast.push('Пароль слишком короткий', { description: 'Минимум 8 символов.', tone: 'error' });
      return;
    }
    setSavingPasscode(true);
    try {
      if (!await updateShare({ passcode: passcode.trim() })) return;
      setPasscode('');
      toast.push('Пароль установлен', { tone: 'success' });
    } finally {
      setSavingPasscode(false);
    }
  };

  const copyShare = async () => {
    const ok = await copyText(shareUrl);
    const blocked = project?.share.enabled === false ? 'Доступ выключен.'
      : project?.share.expiresAt && Date.parse(project.share.expiresAt) < Date.now() ? 'Срок доступа истёк.'
      : !project?.share.passcodeSet ? 'Сначала задайте пароль показа.'
      : !project.videoScenes?.some(scene => scene.published) ? 'Сначала опубликуйте готовую сцену.' : '';
    toast.push(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', {
      description: ok ? blocked || 'Передайте заказчику ссылку и пароль показа раздельно.' : undefined,
      tone: ok ? 'success' : 'error',
    });
  };

  const saveSettings = async () => {
    if (!project || settingsSavingRef.current) return;
    if (!settings.title.trim()) {
      setSettingsError('Название не может быть пустым');
      return;
    }
    const targetId = project.id;
    const requestContext = context;
    const patch = Object.fromEntries(Object.entries(settings).filter(([key, value]) => value !== settingsBaseline.current[key as keyof typeof settings]));
    if (!Object.keys(patch).length) { setSettingsOpen(false); return; }
    settingsSavingRef.current = true;
    setSavingSettings(true);
    setSettingsError('');
    try {
      const { project: saved } = await api<{ project: Project }>(`/api/projects/${targetId}`, {
        method: 'PATCH',
        body: patch,
      });
      if (!contextRef.current.startsWith(`${targetId}:`)) return;
      if (contextRef.current === requestContext) loadSequence.current += 1;
      else void refreshRef.current(true);
      setProject(current => current?.id === targetId ? { ...current, title: saved.title, client: saved.client,
        eventDate: saved.eventDate, description: saved.description, updatedAt: saved.updatedAt } : current);
      setSettingsOpen(false);
      toast.push('Сохранено', { tone: 'success' });
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Не удалось сохранить');
    } finally {
      settingsSavingRef.current = false;
      setSavingSettings(false);
    }
  };

  const cancelReplacement = async (surface: Surface) => {
    const replacement = surface.replacement;
    if (!project || !replacement?.id) return;
    const requestKey = `${context}:${surface.key}`;
    if (surfaceRequests.current.has(requestKey)) return;
    surfaceRequests.current.add(requestKey);
    setSurfaceBusy(current => ({ ...current, [requestKey]: true }));
    try {
      const { project: next } = await api<{ project: Project }>(`${sceneApi}/surfaces/${surface.key}/replacement`, {
        method: 'DELETE', body: { contentRevision: project.contentRevision, replacementId: replacement.id },
      });
      acceptProject(next, context);
      toast.push('Замена отменена', { description: 'Рабочее видео сохранено.', tone: 'success' });
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось отменить замену', { tone: 'error' });
      void refreshRef.current(true);
    } finally {
      surfaceRequests.current.delete(requestKey);
      setSurfaceBusy(current => { const next = { ...current }; delete next[requestKey]; return next; });
    }
  };

  const deleteSurface = async (key: string) => {
    if (!project) return;
    try {
      const data = await api<{ project: Project }>(`${sceneApi}/surfaces/${key}`, {
        method: 'DELETE',
      });
      acceptProject(data.project, context);
      setConfirm(null);
      toast.push('Видео удалено');
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось удалить', { tone: 'error' });
    }
  };

  const retrySurface = async (key: string) => {
    if (!project) return;
    try {
      const data = await api<{ project: Project }>(`${sceneApi}/surfaces/${key}/retry`, {
        method: 'POST',
      });
      acceptProject(data.project, context);
      toast.push('Обработка перезапущена');
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось перезапустить', { tone: 'error' });
    }
  };

  const rebuildSurface = async (key: string) => {
    if (!project) return;
    try {
      const data = await api<{ project: Project }>(`${sceneApi}/surfaces/${key}/rebuild`, {
        method: 'POST', body: { contentRevision: project.contentRevision },
      });
      acceptProject(data.project, context);
      toast.push('Готовим видео из оригинала', { description: 'Без уменьшения разрешения. Рабочая версия доступна до завершения.' });
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось обновить качество', { tone: 'error' });
    }
  };

  const rotateLink = async () => {
    if (!project) return;
    try {
      await api<{ project: Project }>(`/api/projects/${project.id}/share/rotate`, {
        method: 'POST',
      });
      await refreshRef.current();
      setConfirm(null);
      toast.push('Ссылка обновлена', { description: 'Старая ссылка больше не работает.', tone: 'success' });
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось обновить', { tone: 'error' });
    }
  };

  const deleteProject = async () => {
    if (!project) return;
    try {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      toast.push('Проект удалён');
      navigate('/admin');
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось удалить', { tone: 'error' });
    }
  };

  const resetApproval = async () => {
    if (!project) return;
    try {
      const data = await api<{ project: Project }>(`${sceneApi}/approval/reset`, {
        method: 'POST',
      });
      acceptProject(data.project, context);
      toast.push('Согласование сброшено');
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось сбросить', { tone: 'error' });
    }
  };

  const deleteComment = async (commentId: string) => {
    if (!project) return;
    try {
      const data = await api<{ project: Project }>(
        `${sceneApi}/comments/${commentId}`,
        { method: 'DELETE' },
      );
      acceptProject(data.project, context);
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось удалить', { tone: 'error' });
    }
  };

  const saveSceneName = async () => {
    if (!project || !sceneForm || sceneSaving) return;
    const name = sceneForm.name.trim();
    if (!name) { setSceneNameError('Введите название сцены'); return; }
    setSceneSaving(true);
    setSceneNameError('');
    try {
      const editing = Boolean(sceneForm.id);
      const path = `/api/projects/${project.id}/video-scenes${editing ? `/${encodeURIComponent(sceneForm.id!)}` : ''}`;
      const data = await api<{ project: Project; videoSceneId?: string }>(path, { method: editing ? 'PATCH' : 'POST', body: { name } });
      if (contextRef.current !== context) return;
      setSceneForm(null);
      if (editing) acceptProject(data.project, context);
      else selectScene(data.videoSceneId || data.project.videoSceneId || 'main');
      toast.push(editing ? 'Название сцены сохранено' : 'Сцена добавлена', {
        description: editing ? undefined : 'Загрузите видео на поверхности и опубликуйте готовую сцену.', tone: 'success',
      });
    } catch (error) {
      setSceneNameError(error instanceof Error ? error.message : 'Не удалось сохранить сцену');
    } finally { setSceneSaving(false); }
  };

  const publishScene = async () => {
    if (!project || !project.canPublish || scenePublishing) return;
    setScenePublishing(true);
    try {
      const data = await api<{ project: Project }>(`${sceneApi}/publish`, {
        method: 'POST', body: { contentRevision: project.contentRevision },
      });
      acceptProject(data.project, context);
      toast.push('Сцена опубликована', { description: 'Заказчику доступен весь готовый комплект видео.', tone: 'success' });
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось опубликовать сцену', { tone: 'error' });
      void refreshRef.current();
    } finally { setScenePublishing(false); }
  };

  const deleteVideoScene = async (sceneId: string) => {
    if (!project || sceneDeleting) return;
    setSceneDeleting(true);
    try {
      const data = await api<{ project: Project }>(`/api/projects/${project.id}/video-scenes/${encodeURIComponent(sceneId)}`, { method: 'DELETE' });
      if (contextRef.current === context) {
        setConfirm(null);
        selectScene(data.project.videoSceneId || 'main');
      }
      toast.push('Сцена удалена');
    } catch (error) {
      toast.push(error instanceof Error ? error.message : 'Не удалось удалить сцену', { tone: 'error' });
    } finally { setSceneDeleting(false); }
  };

  const executeConfirmation = async () => {
    if (!confirm || confirmBusyRef.current) return;
    confirmBusyRef.current = true;
    setConfirmBusy(true);
    try {
      if (confirm.kind === 'project') await deleteProject();
      else if (confirm.kind === 'surface') await deleteSurface(confirm.key);
      else if (confirm.kind === 'rotate') await rotateLink();
      else if (confirm.kind === 'video-scene') await deleteVideoScene(confirm.id);
    } finally { confirmBusyRef.current = false; setConfirmBusy(false); }
  };

  useEffect(() => {
    if (!Object.keys(uploading).length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [uploading]);

  if (loading || (!loadError && !notFound && project && selectedSceneId && videoSceneId !== selectedSceneId)) {
    return (
      <div className="page">
        <div className="page-loading">
          <Spinner size={22} />
          Загружаем проект
        </div>
      </div>
    );
  }

  if (loadError && (!project || project.id !== id || (selectedSceneId && videoSceneId !== selectedSceneId))) {
    return <div className="page"><div className="empty-state"><h2>Не удалось загрузить проект</h2><p>{loadError}</p>
      <Btn onClick={() => { setLoading(true); void load(); }}>Повторить загрузку</Btn><Link to="/admin">К проектам</Link></div></div>;
  }

  if (notFound || !project) {
    return (
      <div className="page">
        <div className="empty-state">
          <h2>{selectedSceneId ? 'Сцена недоступна' : 'Проект не найден'}</h2>
          <p>{selectedSceneId ? 'Возможно, сцена удалена или не удалось загрузить её данные.' : 'Возможно, его удалили или ссылка устарела.'}</p>
          <Link to={selectedSceneId ? `/admin/p/${id}` : '/admin'} className="btn btn--secondary">
            <ArrowLeft size={16} /> {selectedSceneId ? 'Открыть основную сцену' : 'К проектам'}
          </Link>
        </div>
      </div>
    );
  }

  const aspectWarnings = project.surfaces.filter((surface) => surface.aspectWarning);
  const emptyCount = project.surfaces.filter((surface) => project.requiredSurfaceKeys.includes(surface.key) && surface.status === 'empty').length;
  const selectedScene = project.videoScenes?.find((scene) => scene.id === videoSceneId);
  const sceneUploadActive = Object.keys(uploading).some((key) => key.startsWith(`${videoSceneId}:`));
  const sceneBusy = scenePublishing || sceneDeleting;
  const adminPreviewPath = `/admin/p/${project.id}/present?videoScene=${encodeURIComponent(videoSceneId)}`;
  const sceneSharePath = `${project.share.path}?scene=${encodeURIComponent(videoSceneId)}`;
  const sceneStatus = selectedScene?.published
    ? project.hasUnpublishedChanges ? 'Есть неопубликованные изменения' : 'Опубликована'
    : 'Черновик';

  return (
    <div className="page project-page">
      <Link to="/admin" className="back-link">
        <ArrowLeft size={15} />
        Все проекты
      </Link>

      <div className="project-head">
        <div className="project-head__title">
          <span className="eyebrow">Показ</span>
          <div className="project-title-row"><h1>{project.title}</h1><IconBtn label="Переименовать проект" onClick={openSettings}><Pencil size={17} /></IconBtn></div>
          <p>
            {project.client || 'Без заказчика'}
            {project.eventDate ? ` · ${formatDate(project.eventDate)}` : ''}
            {project.duration ? ` · ${formatTime(project.duration)}` : ''}
            <StatusChip status={project.status} />
            {project.demo ? <span className="tag tag--accent">демо</span> : null}
          </p>
        </div>
        <div className="project-head__actions">
          <Btn variant="secondary" icon={<Box size={16} />} onClick={() => navigate(`/admin/p/${project.id}/scene`)}>Расстановка зала</Btn>
          <Btn variant="secondary" icon={<Settings2 size={17} />} onClick={openSettings}>Настройки проекта</Btn>
          <Btn variant="secondary" icon={<Link2 size={16} />} onClick={copyShare}>
            Ссылка
          </Btn>
          <Btn
            variant="primary"
            icon={<Play size={16} fill="currentColor" />}
            onClick={() => navigate(adminPreviewPath)}
          >
            Открыть показ
          </Btn>
        </div>
      </div>

      {loadError ? <div className="share-password-warning" role="alert">{loadError} <button className="tiny-link" onClick={() => void load(true)}>Повторить загрузку</button></div> : null}
      {Object.keys(uploading).length ? <p className="privacy-admin-note" role="status">Передаём видео на сервер. Не закрывайте вкладку до окончания загрузки; между видеосценами можно переключаться.</p> : null}

      {!project.share.passcodeSet ? <div className="share-password-warning">Доступ заказчика пока закрыт. <a href="#project-access" style={{ textDecoration: 'underline' }}>Задайте пароль показа</a>, чтобы отправить ссылку.</div> : null}

      <section className="video-scenes-admin" aria-label="Сцены показа">
        <div className="video-scenes-admin__head">
          <div><h2>Сцены показа</h2><p>Мебель и экраны общие для всех сцен. Меняются только видео.</p></div>
          <Btn icon={<Plus size={16} />} onClick={() => { setSceneNameError(''); setSceneForm({ id: null, name: '' }); }} disabled={sceneBusy}>
            Добавить сцену
          </Btn>
        </div>
        <div className="video-scenes-admin__tabs" role="tablist" aria-label="Выбрать сцену показа">
          {(project.videoScenes || []).map((scene) => (
            <button type="button" role="tab" key={scene.id} id={`video-scene-tab-${scene.id}`}
              aria-selected={scene.id === videoSceneId} aria-controls="video-scene-panel"
              className={`video-scene-tab${scene.id === videoSceneId ? ' is-selected' : ''}`}
              disabled={sceneBusy} onClick={() => selectScene(scene.id)}>
              <span className="video-scene-tab__name">{scene.name}</span>
              <span className="video-scene-tab__meta">{scene.processing ? <><Spinner size={12} /> Обработка · </> : null}{scene.ready} / {scene.total} видео</span>
              <span className={`video-scene-tab__status${scene.published ? ' is-published' : ''}`}>
                {scene.published ? scene.hasUnpublishedChanges ? 'Изменения не опубликованы' : scene.approved ? 'Согласована' : 'Опубликована' : 'Черновик'}
              </span>
            </button>
          ))}
        </div>
        <div className="video-scenes-admin__selected" role="tabpanel" id="video-scene-panel" aria-labelledby={`video-scene-tab-${videoSceneId}`}>
          <div className="video-scenes-admin__selection">
            <div><span className="eyebrow">Выбранная сцена</span><h3>{videoSceneName}</h3></div>
            <IconBtn label="Переименовать сцену" disabled={sceneBusy} onClick={() => { setSceneNameError(''); setSceneForm({ id: videoSceneId, name: videoSceneName }); }}><Pencil size={15} /></IconBtn>
            {videoSceneId !== 'main' && !selectedScene?.isDefault ? <IconBtn label="Удалить сцену" tone="danger" disabled={sceneBusy || sceneUploadActive}
              onClick={() => setConfirm({ kind: 'video-scene', id: videoSceneId, label: videoSceneName, published: Boolean(selectedScene?.published) })}><Trash2 size={15} /></IconBtn> : null}
          </div>
          <div className="video-scenes-admin__publish">
            <div role="status"><strong>{scenePublishing ? 'Публикуем сцену…' : sceneStatus}</strong>
              <p>{selectedScene?.published
                ? project.hasUnpublishedChanges ? 'Заказчик видит прежнюю версию. Опубликуйте новый комплект, когда все видео будут готовы.' : 'Комплект опубликован. Доступ заказчика определяется настройками ссылки и паролем.'
                : 'После публикации сцена появится в показе. Для доступа заказчику также нужны действующая ссылка и пароль.'}</p>
              {!project.canPublish && project.hasUnpublishedChanges ? <small>Завершите обработку всех нужных видео и исправьте ошибки замен перед публикацией.</small> : null}
            </div>
            <Btn variant="primary" icon={<UploadCloud size={15} />} loading={scenePublishing}
              disabled={sceneBusy || sceneUploadActive || !project.canPublish || (Boolean(selectedScene?.published) && !project.hasUnpublishedChanges)} onClick={publishScene}>
              {selectedScene?.published ? 'Опубликовать изменения' : 'Опубликовать сцену'}
            </Btn>
          </div>
        </div>
      </section>

      <div className="project-layout">
        <div className="project-main">
          {project.durationWarning ? (
            <div className="alert alert--warn">
              <AlertTriangle size={18} />
              <span>{project.durationWarning}</span>
            </div>
          ) : null}
          {aspectWarnings.length ? (
            <div className="alert alert--warn">
              <AlertTriangle size={18} />
              <span>
                Пропорции не совпадают с поверхностью:{' '}
                {aspectWarnings.map((surface) => `${surface.name} (${surface.width} × ${surface.height})`).join(', ')}.
                Контент может растянуться.
              </span>
            </div>
          ) : null}
          {emptyCount > 0 ? (
            <div className="alert alert--info">
              <Film size={18} />
              <span>
                Загрузите {emptyCount === 1 ? 'ещё одно видео' : `ещё ${emptyCount} видео`} — и показ
                можно будет опубликовать.
              </span>
            </div>
          ) : null}

          <div className="section-head">
            <div>
              <h2>Видео сцены «{videoSceneName}»</h2>
              <span>Перетащите файл на карточку или выберите вручную</span>
            </div>
            <span className="section-head__count">{project.ready} / {project.total}</span>
          </div>

          <div className="surface-list">
            {project.surfaces.map((surface) => (
              <SurfaceCard
                key={`${videoSceneId}:${surface.key}`}
                surface={surface}
                published={Boolean(selectedScene?.published)}
                uploading={uploading[`${videoSceneId}:${surface.key}`]}
                disabled={sceneBusy || Boolean(surfaceBusy[`${context}:${surface.key}`])}
                cancellingReplacement={Boolean(surfaceBusy[`${context}:${surface.key}`])}
                dragging={dragKey === surface.key}
                onDragEnter={() => setDragKey(surface.key)}
                onDragLeave={() => setDragKey((current) => (current === surface.key ? null : current))}
                onDrop={(event) => onDrop(surface.key, event)}
                onFile={(event) => onFileInput(surface.key, event)}
                onDelete={() => setConfirm({ kind: 'surface', key: surface.key, label: surface.name })}
                onRetry={() => retrySurface(surface.key)}
                onRebuild={() => rebuildSurface(surface.key)}
                onCancelReplacement={() => cancelReplacement(surface)}
                onPreview={() => setPreviewKey(surface.key)}
              />
            ))}
          </div>
        </div>

        <aside className="project-side">
          <section className="panel readiness">
            <div className="readiness__head">
              <span>Готовность</span>
              <strong>
                {project.ready}
                <em>/ {project.total}</em>
              </strong>
            </div>
            <div className="readiness__bar">
              <i style={{ width: `${project.total ? (project.ready / project.total) * 100 : 0}%` }} />
            </div>
            <div className="readiness__dots">
              {project.surfaces.map((surface) => (
                <span
                  key={surface.key}
                  className={`readiness__dot readiness__dot--${surface.status}`}
                  title={surface.name}
                >
                  {surface.num}
                </span>
              ))}
            </div>
            <div className="readiness__rows">
              <div>
                <span>Хронометраж</span>
                <strong>{project.duration ? formatTime(project.duration) : '—'}</strong>
              </div>
              <div>
                <span>Обработка</span>
                <strong>{project.processing ? `${project.processing} в работе` : 'завершена'}</strong>
              </div>
            </div>
            <Btn
              variant="primary"
              full
              icon={<Play size={15} fill="currentColor" />}
              onClick={() => navigate(adminPreviewPath)}
            >
              Открыть показ
            </Btn>
            {selectedScene?.published ? <a className="panel__link" href={sceneSharePath} target="_blank" rel="noreferrer">
              <ExternalLink size={14} />
              Открыть как заказчик
            </a> : <p className="panel__muted video-scenes-admin__draft-hint">Сначала опубликуйте сцену, чтобы открыть её как заказчик.</p>}
          </section>

          <section className="panel">
            <div className="panel__head">
              <h3 id="project-access">Ссылка для заказчика</h3>
              <Toggle
                checked={project.share.enabled}
                disabled={shareSaving}
                onChange={(value) => updateShare({ enabled: value })}
                label="Доступ по паролю"
              />
            </div>
            {!project.share.passcodeSet ? <div className="share-password-warning" role="status">Показ закрыт для заказчиков. Задайте пароль ниже — без него ссылка и файлы недоступны.</div> : <p className="privacy-admin-note">Для просмотра нужны ссылка и пароль этого проекта. Смена пароля завершит прежние сеансы зрителей.</p>}
            <div className="share-url">
              <input readOnly value={shareUrl} aria-label="Ссылка на показ" />
              <IconBtn label="Скопировать" onClick={copyShare}>
                <Copy size={15} />
              </IconBtn>
              <IconBtn label="QR-код" onClick={() => setQrOpen(true)}>
                <QrCode size={16} />
              </IconBtn>
            </div>

            <div className="share-grid">
              <Field label="Пароль" hint={project.share.passcodeSet ? 'Пароль задан · минимум 8 символов' : 'Обязателен · минимум 8 символов'}>
                <div className="inline-input">
                  <input
                    className="input"
                    value={passcode}
                    onChange={(event) => setPasscode(event.target.value)}
                    placeholder={project.share.passcodeSet ? 'Новый пароль' : 'Задайте пароль'}
                    type="password" autoComplete="new-password" minLength={8}
                    maxLength={64}
                  />
                  <Btn variant="secondary" size="sm" onClick={savePasscode} loading={savingPasscode} disabled={shareSaving}>
                    {project.share.passcodeSet ? 'Сменить' : 'Задать'}
                  </Btn>
                </div>
              </Field>

              <Field label="Доступ до" hint="После даты ссылка перестанет открываться">
                <input
                  className="input"
                  type="date"
                  disabled={shareSaving}
                  value={project.share.expiresAt ? project.share.expiresAt.slice(0, 10) : ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    updateShare({
                      expiresAt: value ? new Date(`${value}T23:59:59`).toISOString() : null,
                    });
                  }}
                />
              </Field>
            </div>

            <div className="panel__divider" />
            <Toggle
              checked={project.share.allowComments}
              disabled={shareSaving}
              onChange={(value) => updateShare({ allowComments: value })}
              label="Отзывы и согласование"
              description="Отдельное согласие перед отправкой; отзывы хранятся 180 дней"
            />
            <Toggle
              checked={project.share.allowDownload}
              disabled={shareSaving}
              onChange={(value) => updateShare({ allowDownload: value })}
              label="Скачивание оригиналов"
              description="Появится кнопка «Скачать» у каждой поверхности"
            />
            <button className="panel__action" onClick={() => setConfirm({ kind: 'rotate' })}>
              <RefreshCw size={14} />
              Обновить ссылку
            </button>
          </section>

          <section className="panel">
            <div className="panel__head">
              <h3>Согласование сцены</h3>
              {project.approval ? <StatusChip status="approved" /> : <StatusChip status="pending" label="Ожидает" />}
            </div>
            {project.approval ? (
              <div className="approval">
                <div className="approval__who">
                  <span className="avatar avatar--2">{project.approval.author.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <strong>{project.approval.author}</strong>
                    <span>{formatDate(project.approval.at)}</span>
                  </div>
                </div>
                {project.approval.note ? <p className="approval__note">{project.approval.note}</p> : null}
                <button className="tiny-link" onClick={resetApproval}>
                  Сбросить согласование
                </button>
              </div>
            ) : (
              <p className="panel__muted">
                Заказчик увидит кнопку «Согласовать» в показе. Имя и дата появятся здесь.
              </p>
            )}
          </section>

          <section className="panel">
            <div className="panel__head">
              <h3>Отзывы о сцене</h3>
              <span className="panel__count">{project.comments.length}</span>
            </div>
            {project.comments.length === 0 ? (
              <p className="panel__muted">Пока нет замечаний. Они появятся здесь с таймкодом.</p>
            ) : (
              <div className="admin-comments">
                {project.comments.map((comment) => (
                  <div className="admin-comment" key={comment.id}>
                    <div className="admin-comment__head">
                      <strong>{comment.author}</strong>
                      <span className="timecode">{formatTime(comment.time)}</span>
                      <button
                        className="admin-comment__delete"
                        onClick={() => deleteComment(comment.id)}
                        aria-label="Удалить комментарий"
                      >
                        <X size={13} />
                      </button>
                    </div>
                    <p>{comment.text}</p>
                    <span className="admin-comment__date">{relativeDate(comment.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      <Modal open={Boolean(sceneForm)} onClose={() => { if (!sceneSaving) setSceneForm(null); }}
        title={sceneForm?.id ? 'Переименовать сцену' : 'Добавить сцену'} eyebrow="Сцены показа" size="sm" dismissable={!sceneSaving}
        footer={<><Btn variant="ghost" disabled={sceneSaving} onClick={() => setSceneForm(null)}>Отмена</Btn>
          <Btn variant="primary" type="submit" form="video-scene-name-form" loading={sceneSaving}>{sceneForm?.id ? 'Сохранить название' : 'Добавить сцену'}</Btn></>}>
        <form id="video-scene-name-form" className="form" onSubmit={(event) => { event.preventDefault(); void saveSceneName(); }}>
          <Field label="Название сцены" hint="До 80 символов" error={sceneNameError || undefined}>
            <input className="input" value={sceneForm?.name || ''} maxLength={80} autoFocus
              placeholder="Например, Встреча гостей" disabled={sceneSaving}
              onChange={(event) => { const name = event.target.value; setSceneForm((current) => current ? { ...current, name } : null); setSceneNameError(''); }} />
          </Field>
          {!sceneForm?.id ? <p className="panel__muted">У новой сцены будет свой комплект видео. Расстановка зала останется общей.</p> : null}
        </form>
      </Modal>

      <Modal
        open={settingsOpen}
        onClose={() => { if (!savingSettings) setSettingsOpen(false); }}
        dismissable={!savingSettings}
        title="Настройки проекта"
        eyebrow="KUOG HALL"
        footer={
          <>
            <button type="button" className="danger-link" disabled={savingSettings} onClick={() => setConfirm({ kind: 'project' })}>
              <Trash2 size={14} /> Удалить проект
            </button>
            <Btn variant="primary" type="submit" form="project-settings-form" loading={savingSettings}>
              Сохранить
            </Btn>
          </>
        }
      >
        <form id="project-settings-form" className="form" onSubmit={event => { event.preventDefault(); void saveSettings(); }}>
          <label className="field">
            <span className="field__label">Название</span>
            <input
              className="input"
              value={settings.title}
              disabled={savingSettings}
              onChange={(event) => setSettings({ ...settings, title: event.target.value })}
              maxLength={120}
            />
          </label>
          <div className="form__row">
            <label className="field">
              <span className="field__label">Заказчик</span>
              <input
                className="input"
                value={settings.client}
                disabled={savingSettings}
                onChange={(event) => setSettings({ ...settings, client: event.target.value })}
                maxLength={120}
              />
            </label>
            <label className="field">
              <span className="field__label">Дата показа</span>
              <input
                className="input"
                type="date"
                value={settings.eventDate}
                disabled={savingSettings}
                onChange={(event) => setSettings({ ...settings, eventDate: event.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">Описание</span>
            <textarea
              className="textarea"
              rows={4}
              value={settings.description}
              disabled={savingSettings}
              onChange={(event) => setSettings({ ...settings, description: event.target.value })}
              maxLength={2000}
            />
          </label>
          {settingsError ? <div className="form-error">{settingsError}</div> : null}
        </form>
      </Modal>

      <Modal
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        title="QR-код показа"
        eyebrow={project.title}
        size="sm"
      >
        <QrPanel url={shareUrl} />
      </Modal>

      <Modal
        open={Boolean(previewSurface)}
        onClose={() => setPreviewKey(null)}
        title={previewSurface?.name || 'Поверхность'}
        eyebrow={previewSurface ? `${previewSurface.specW} × ${previewSurface.specH}` : undefined}
        size="lg"
      >
        {previewSurface?.previewUrl ? (
          <video
            className="modal-video"
            src={previewSurface.previewUrl}
            poster={previewSurface.posterUrl || undefined}
            controls
            autoPlay
            playsInline
          />
        ) : (
          <p className="panel__muted">Видео ещё не готово.</p>
        )}
      </Modal>

      <Modal
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        dismissable={!confirmBusy && !sceneDeleting}
        title={
          confirm?.kind === 'project'
            ? 'Удалить проект?'
            : confirm?.kind === 'rotate'
              ? 'Обновить ссылку?'
              : confirm?.kind === 'video-scene'
                ? `Удалить сцену «${confirm.label}»?`
              : `Удалить видео с поверхности «${confirm?.kind === 'surface' ? confirm.label : ''}»?`
        }
        size="sm"
        footer={
          <>
            <Btn variant="ghost" disabled={confirmBusy || sceneDeleting} onClick={() => setConfirm(null)}>
              Отмена
            </Btn>
            <Btn
              variant="danger"
              loading={confirmBusy || sceneDeleting}
              onClick={executeConfirmation}
              icon={confirm?.kind === 'rotate' ? <RefreshCw size={15} /> : <Trash2 size={15} />}
            >
              {confirm?.kind === 'rotate' ? 'Обновить' : 'Удалить'}
            </Btn>
          </>
        }
      >
        <p className="modal__lead">
          {confirm?.kind === 'project'
            ? 'Проект, все видео, отзывы и ссылка исчезнут. Это действие нельзя отменить.'
            : confirm?.kind === 'rotate'
              ? 'Старая ссылка перестанет работать. Новая будет создана автоматически.'
              : confirm?.kind === 'video-scene'
                ? `Видео, отзывы и согласование этой сцены будут удалены.${confirm.published ? ' Сцена исчезнет из показа заказчика.' : ''} Общая расстановка зала и другие сцены сохранятся.`
                : 'Видео будет удалено из редактируемой сцены. Если сцена уже опубликована, заказчик продолжит видеть прежний комплект до следующей публикации.'}
        </p>
      </Modal>
    </div>
  );
}

function SurfaceCard({
  surface,
  published,
  uploading,
  disabled = false,
  dragging,
  onDragEnter,
  onDragLeave,
  onDrop,
  onFile,
  onDelete,
  onRetry,
  onRebuild,
  onCancelReplacement,
  cancellingReplacement = false,
  onPreview,
}: {
  surface: Surface;
  published: boolean;
  uploading?: number;
  disabled?: boolean;
  dragging: boolean;
  onDragEnter: () => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onDelete: () => void;
  onRetry: () => void;
  onRebuild: () => void;
  onCancelReplacement: () => void;
  cancellingReplacement?: boolean;
  onPreview: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const processing = surface.status === 'processing' || surface.replacement?.status === 'processing';
  const job = surface.replacement || surface;
  const busy = disabled || uploading !== undefined || processing;

  return (
    <div
      className={`surface-card ${dragging ? 'is-dragging' : ''} ${busy ? 'is-busy' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!busy) onDragEnter();
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => { if (busy) event.preventDefault(); else onDrop(event); }}
    >
      <div
        className="surface-card__preview"
        style={{ aspectRatio: String(surface.specRatio) }}
        onClick={() => surface.previewUrl && onPreview()}
      >
        {surface.posterUrl ? (
          <>
            <img className="surface-card__bg" src={surface.posterUrl} alt="" aria-hidden="true" />
            <img className="surface-card__shot" src={surface.posterUrl} alt="" />
          </>
        ) : (
          <div className="surface-card__blank">
            <span>{String(surface.num).padStart(2, '0')}</span>
            <em>{surface.label}</em>
          </div>
        )}
        <div className="surface-card__shade" />
        <div className="surface-card__tag">
          <b>{surface.num}</b>
          {surface.label}
        </div>
        {surface.previewUrl && uploading === undefined ? (
          <span className="surface-card__play">
            <Play size={15} fill="currentColor" />
          </span>
        ) : null}
        {uploading !== undefined || processing ? (
          <div className="surface-card__progress">
            <Spinner size={18} />
            <strong>{uploading !== undefined ? `Загрузка ${uploading}%` : `${job.progress}%`}</strong>
            <span>{uploading !== undefined ? 'Передаём файл на сервер' : job.stage || 'Обработка'}</span>
          </div>
        ) : null}
        {surface.status === 'error' ? (
          <div className="surface-card__progress surface-card__progress--error">
            <AlertTriangle size={18} />
            <strong>Не удалось обработать</strong>
            <span>{surface.error}</span>
          </div>
        ) : null}
      </div>

      <div className="surface-card__body">
        <div className="surface-card__head">
          <div>
            <h3>
              {surface.name} <span>{surface.label}</span>
            </h3>
            <p>
              {surface.specW} × {surface.specH} px · {surface.physical}
            </p>
          </div>
          <StatusChip
            status={surface.status}
            label={
              surface.status === 'ready'
                ? 'Готово'
                : surface.status === 'empty'
                  ? 'Пусто'
                  : undefined
            }
          />
        </div>

        {surface.status === 'ready' ? (
          <div className="surface-card__meta">
            <span title={surface.originalName || ''}>
              <Film size={13} /> {surface.originalName}
            </span>
            <span>
              {surface.width} × {surface.height}
              {surface.aspectWarning ? <em className="warn-text"> · пропорции</em> : null}
            </span>
            <span>{surface.duration ? formatTime(surface.duration) : '—'}</span>
            <span>{formatBytes(surface.size)}</span>
          </div>
        ) : surface.status === 'empty' ? (
          <p className="surface-card__empty-text">Видео не загружено. Подойдёт MP4, MOV, WebM или MKV.</p>
        ) : null}

        {surface.status === 'ready' ? <div className="surface-card__quality">
          <span>{surface.previewMode === 'copy' ? 'Видео без повторного сжатия'
            : surface.previewMode === 'converted' ? 'Перекодировано для браузера · без уменьшения разрешения'
              : 'Превью подготовлено прежней версией'}</span>
          {surface.previewWidth > 0 ? <span>{surface.previewWidth} × {surface.previewHeight}{surface.previewFps ? ` · ${Number(surface.previewFps.toFixed(2))} кадр/с` : ''}</span> : null}
          {surface.previewMode === 'converted' ? <small>Оригинал сохранён. Совместимая копия использует сжатие высокого качества.</small> : null}
          {!surface.previewMode ? <button className="tiny-link" disabled={busy || Boolean(surface.replacement)} onClick={onRebuild}><RefreshCw size={13} /> Обновить качество из оригинала</button> : null}
        </div> : null}

        {surface.status === 'error' ? (
          <div className="surface-card__error">
            <span>{surface.error}</span>
            <button className="tiny-link" disabled={busy} onClick={onRetry}>
              <RefreshCw size={13} /> Повторить
            </button>
          </div>
        ) : null}

        {surface.replacement ? <div className={`scene-replacement ${surface.replacement.status === 'error' ? 'is-error' : ''}`} role="status">
          <strong>{surface.replacement.status === 'error' ? 'Новое видео не обработано' : 'Готовим замену видео'}</strong>
          <span>{surface.replacement.status === 'error' ? surface.replacement.error : `${surface.replacement.originalName} · ${surface.replacement.progress}%`}</span>
          <div>{published ? 'Заказчик продолжает видеть опубликованную версию.' : 'Рабочее видео сцены сохранено до завершения замены.'}</div>
          {surface.replacement.status === 'error' ? <button className="tiny-link" disabled={busy} onClick={onRetry}><RefreshCw size={13} /> Повторить обработку замены</button> : null}
          <button type="button" className="tiny-link" onClick={onCancelReplacement} disabled={disabled || uploading !== undefined || !surface.replacement.id}>
            {cancellingReplacement ? <Spinner size={13} /> : <X size={13} />}{cancellingReplacement ? 'Отменяем замену…' : 'Отменить замену'}
          </button>
        </div> : null}

        <div className="surface-card__actions">
          <input
            ref={inputRef}
            type="file"
            accept="video/*,.mkv,.mov,.m4v,.webm,.mts"
            onChange={onFile}
            hidden
          />
          <Btn
            size="sm"
            variant={surface.status === 'empty' ? 'primary' : 'secondary'}
            icon={<UploadCloud size={15} />}
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {surface.status === 'empty' ? 'Загрузить видео' : 'Заменить'}
          </Btn>
          {surface.downloadUrl ? (
            <a className="btn btn--ghost btn--sm" href={surface.downloadUrl} download>
              <Download size={14} />
              Скачать
            </a>
          ) : null}
          {surface.status !== 'empty' && !busy ? (
            <IconBtn label="Удалить видео" tone="danger" onClick={onDelete} className="surface-card__delete">
              <Trash2 size={15} />
            </IconBtn>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function QrPanel({ url }: { url: string }) {
  const [source, setSource] = useState('');
  const toast = useToast();

  useEffect(() => {
    QRCode.toDataURL(url, {
      width: 420,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0b0c', light: '#ffffff' },
    })
      .then(setSource)
      .catch(() => setSource(''));
  }, [url]);

  return (
    <div className="qr-panel">
      {source ? <img src={source} alt="QR-код ссылки на показ" /> : <Spinner size={24} />}
      <p className="qr-panel__url">{url}</p>
      <div className="qr-panel__actions">
        <Btn
          variant="secondary"
          icon={<Copy size={15} />}
          onClick={async () => {
            const ok = await copyText(url);
            toast.push(ok ? 'Ссылка скопирована' : 'Не удалось скопировать', {
              tone: ok ? 'success' : 'error',
            });
          }}
        >
          Скопировать
        </Btn>
        {source ? (
          <a className="btn btn--ghost" href={source} download="hall5-show-qr.png">
            <Download size={15} />
            Скачать PNG
          </a>
        ) : null}
      </div>
    </div>
  );
}
