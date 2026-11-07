import type { FeedbackConsent } from '../lib/legal';
import { LegalLinks } from '../components/LegalLinks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Lock, Play } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { PublicProject, toPlayerProject } from '../lib/types';
import { Logo } from '../components/Logo';
import { Player } from '../components/player/Player';
import { Spinner } from '../components/ui';
import { mediaSourceIdentity } from '../lib/mediaCompatibility';

const POLL_MS = 5000;
const SCENE_POLL_MS = 30000;
const videoSceneId = (project: PublicProject) => project.videoSceneId || 'main';
const publicEndpoint = (slug: string, sceneId: string) => `/api/s/${encodeURIComponent(slug)}${sceneId ? `?videoScene=${encodeURIComponent(sceneId)}` : ''}`;
const MAX_POLLS = 120;

function pending(project: PublicProject) {
  const required = project.requiredSurfaceKeys ?? ['right', 'back', 'left', 'center', 'floor'];
  return project.processing > 0 || required.some((key) => project.surfaces.find((surface) => surface.key === key)?.status !== 'ready');
}

// Refreshing metadata must not replace a playing video's URL just because its
// authorization token was reissued. The version query still detects new files.
function preserveMedia(current: PublicProject, next: PublicProject): PublicProject {
  if (videoSceneId(current) !== videoSceneId(next)) return next;
  const keep = (oldUrl: string | null | undefined, newUrl: string | null | undefined) => {
    if (!oldUrl || !newUrl || mediaSourceIdentity(oldUrl) !== mediaSourceIdentity(newUrl)) return newUrl;
    const oldToken = new URL(oldUrl, window.location.origin).searchParams.get('mt');
    const nextToken = new URL(newUrl, window.location.origin).searchParams.get('mt');
    if (oldToken || nextToken) {
      const oldParts = oldToken?.split('.') || [];
      const nextParts = nextToken?.split('.') || [];
      if (oldParts.length !== 5 || nextParts.length !== 5 || oldParts[2] !== nextParts[2]
        || Number(oldParts[3]) <= Date.now() / 1000 + 60) return newUrl;
    }
    return oldUrl;
  };
  return {
    ...next,
    surfaces: next.surfaces.map((surface) => {
      const old = current.surfaces.find((item) => item.key === surface.key);
      return old ? { ...surface,
        previewUrl: keep(old.previewUrl, surface.previewUrl) ?? null,
        compatibilityPreview: surface.compatibilityPreview ? { ...surface.compatibilityPreview,
          url: keep(old.compatibilityPreview?.url, surface.compatibilityPreview.url) || surface.compatibilityPreview.url,
        } : null,
        mobilePreview: surface.mobilePreview ? { ...surface.mobilePreview,
          url: keep(old.mobilePreview?.url, surface.mobilePreview.url) || surface.mobilePreview.url,
        } : null,
        posterUrl: keep(old.posterUrl, surface.posterUrl) ?? null,
        originalUrl: keep(old.originalUrl, surface.originalUrl) ?? null,
        downloadUrl: keep(old.downloadUrl, surface.downloadUrl) ?? null,
      } : surface;
    }),
    scene: next.scene ? { ...next.scene, assets: next.scene.assets.map((asset) => {
      const old = current.scene?.assets.find((item) => item.id === asset.id);
      return old ? { ...asset, url: keep(old.url, asset.url) || asset.url } : asset;
    }) } : next.scene,
  };
}

export function SharePage() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedScene = searchParams.get('scene') || '';
  const [project, setProject] = useState<PublicProject | null>(null);
  const [latestProject, setLatestProject] = useState<PublicProject | null>(null);
  const [refreshMessage, setRefreshMessage] = useState('');
  const [sceneMessage, setSceneMessage] = useState('');
  const [switchingScene, setSwitchingScene] = useState<string | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [preferredView, setPreferredView] = useState<'room' | 'board' | undefined>();
  const projectRef = useRef(project);
  const latestRef = useRef(latestProject);
  const refreshNow = useRef<() => void>(() => {});
  const navigation = useRef(0);
  const startNextScene = useRef(false);
  const loadedRoute = useRef('');
  projectRef.current = project;
  latestRef.current = latestProject;
  const [locked, setLocked] = useState<{ title: string; client: string; unconfigured?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [passcode, setPasscode] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState('');

  const denyAccess = useCallback((caught: unknown) => {
    projectRef.current = null;
    latestRef.current = null;
    loadedRoute.current = '';
    setProject(null);
    setLatestProject(null);
    setAutoStart(false);
    setPasscode('');
    setRefreshMessage('');
    if (caught instanceof ApiError && caught.status === 401) {
      setError('');
      setLocked({ title: 'Закрытый показ', client: '', unconfigured: caught.data.code === 'password_not_configured' });
    } else {
      setLocked(null);
      setError(caught instanceof Error ? caught.message : 'Показ недоступен');
    }
  }, []);

  useEffect(() => {
    setPasscode(''); setUnlockError(''); setUnlocking(false);
    return () => { navigation.current += 1; };
  }, [slug]);

  const updateSceneQuery = useCallback((id: string, replace = false) => {
    setSearchParams((current) => { const next = new URLSearchParams(current); next.set('scene', id); return next; }, { replace });
  }, [setSearchParams]);

  const applyProject = useCallback((next: PublicProject, play: boolean) => {
    projectRef.current = next;
    latestRef.current = null;
    setProject(next);
    setLatestProject(null);
    setRefreshMessage('');
    setError('');
    setLocked(null);
    setAutoStart(play);
  }, []);

  // Only the selected published scene is requested. A switch keeps the previous
  // paused view visible until its replacement is ready, then releases its media.
  useEffect(() => {
    if (!slug) return;
    const route = `${slug}|${requestedScene}`;
    if (loadedRoute.current === route) return;
    const serial = ++navigation.current;
    const request = new AbortController();
    const play = startNextScene.current;
    startNextScene.current = false;
    const existing = projectRef.current?.slug === slug ? projectRef.current : null;
    setLoading(!existing);
    setSwitchingScene(existing ? requestedScene : null);
    setSceneMessage('');
    const timeout = window.setTimeout(() => request.abort(), 15000);
    void (async () => {
      try {
        let next: PublicProject;
        let fallback = false;
        try {
          next = (await api<{ project: PublicProject }>(publicEndpoint(slug, requestedScene), { signal: request.signal })).project;
        } catch (caught) {
          if (!(requestedScene && caught instanceof ApiError && caught.status === 404)) throw caught;
          next = (await api<{ project: PublicProject }>(publicEndpoint(slug, ''), { signal: request.signal })).project;
          fallback = true;
        }
        if (serial !== navigation.current) return;
        loadedRoute.current = fallback ? `${slug}|${videoSceneId(next)}` : route;
        applyProject(next, play && !fallback);
        if (fallback) {
          setSceneMessage('Эта видеосцена больше недоступна. Открыта другая опубликованная сцена.');
          updateSceneQuery(videoSceneId(next), true);
        }
      } catch (caught) {
        if (serial !== navigation.current) return;
        if (caught instanceof ApiError && caught.status === 401 && caught.data.locked) {
          denyAccess(caught);
        } else if (existing && !(caught instanceof ApiError && [401, 403, 404].includes(caught.status))) {
          setSceneMessage('Не удалось открыть видеосцену. Проверьте соединение и попробуйте ещё раз.');
          loadedRoute.current = `${slug}|${videoSceneId(existing)}`;
          updateSceneQuery(videoSceneId(existing), true);
        } else denyAccess(caught);
      } finally {
        window.clearTimeout(timeout);
        if (serial === navigation.current) { setLoading(false); setSwitchingScene(null); }
      }
    })();
    return () => { navigation.current += 1; request.abort(); window.clearTimeout(timeout); };
  }, [slug, requestedScene, applyProject, updateSceneQuery]);

  useEffect(() => {
    if (!project?.id || !slug) return;
    let disposed = false;
    let timer = 0;
    let polls = 0;
    let inFlight = false;
    let request: AbortController | null = null;
    const selected = videoSceneId(project);
    const schedule = () => {
      window.clearTimeout(timer);
      const snapshot = latestRef.current || projectRef.current;
      if (disposed || document.hidden || !snapshot) return;
      const processing = pending(snapshot) && polls < MAX_POLLS;
      timer = window.setTimeout(() => { void refresh(true); }, processing ? POLL_MS : SCENE_POLL_MS);
    };
    const refresh = async (automatic: boolean) => {
      if (disposed || inFlight || document.hidden || switchingScene) return;
      if (automatic) polls += 1;
      inFlight = true;
      const serial = navigation.current;
      request = new AbortController();
      const timeout = window.setTimeout(() => request?.abort(), 12000);
      try {
        const { project: next } = await api<{ project: PublicProject }>(publicEndpoint(slug, selected), { signal: request.signal });
        const current = projectRef.current;
        if (disposed || serial !== navigation.current || !current || next.id !== current.id || videoSceneId(current) !== selected) return;
        setRefreshMessage(pending(next) && polls >= MAX_POLLS ? 'Видео ещё обрабатывается. Можно проверить готовность вручную.' : '');
        if (next.contentRevision !== current.contentRevision) {
          latestRef.current = next;
          setLatestProject(next);
          // Newly published scenes appear without replacing any playing video.
          const metadata = { ...current, videoScenes: next.videoScenes, videoSceneName: next.videoSceneName };
          projectRef.current = metadata;
          setProject(metadata);
        } else {
          const merged = preserveMedia(current, next);
          projectRef.current = merged;
          setProject(merged);
        }
      } catch (caught) {
        if (disposed || serial !== navigation.current) return;
        if (caught instanceof ApiError && caught.status === 404) {
          try {
            const { project: next } = await api<{ project: PublicProject }>(publicEndpoint(slug, ''), { signal: request.signal });
            if (disposed || serial !== navigation.current) return;
            loadedRoute.current = `${slug}|${videoSceneId(next)}`;
            applyProject(next, false);
            setSceneMessage('Эта видеосцена больше недоступна. Открыта другая опубликованная сцена.');
            updateSceneQuery(videoSceneId(next), true);
          } catch (fallbackError) {
            if (!disposed && serial === navigation.current) denyAccess(fallbackError);
          }
        } else if (caught instanceof ApiError && [401, 403].includes(caught.status)) denyAccess(caught);
        else setRefreshMessage('Не удалось проверить обновления. Проверьте соединение и попробуйте ещё раз.');
      } finally {
        window.clearTimeout(timeout);
        inFlight = false;
        schedule();
      }
    };
    const manual = () => { polls = 0; void refresh(false); };
    refreshNow.current = manual;
    const visible = () => { if (!document.hidden) manual(); };
    window.addEventListener('focus', manual);
    document.addEventListener('visibilitychange', visible);
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      request?.abort();
      window.removeEventListener('focus', manual);
      document.removeEventListener('visibilitychange', visible);
      refreshNow.current = () => {};
    };
  }, [project?.id, project?.videoSceneId, slug, switchingScene, applyProject, updateSceneQuery]);

  useEffect(() => {
    document.title = project ? `${project.title}${project.videoSceneName ? ` · ${project.videoSceneName}` : ''} · KUOG HALL` : 'KUOG HALL — показ';
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    document.head.appendChild(robots);
    return () => { document.title = 'KUOG HALL — превью проекционного зала'; robots.remove(); };
  }, [project?.title, project?.videoSceneName]);

  const unlock = async () => {
    if (!slug || unlocking) return;
    const serial = ++navigation.current;
    setUnlocking(true);
    setUnlockError('');
    try {
      await api(`/api/s/${encodeURIComponent(slug)}/unlock`, { method: 'POST', body: { passcode } });
      if (serial !== navigation.current) return;
      let next: PublicProject;
      try { next = (await api<{ project: PublicProject }>(publicEndpoint(slug, requestedScene))).project; }
      catch (caught) {
        if (!(requestedScene && caught instanceof ApiError && caught.status === 404)) throw caught;
        next = (await api<{ project: PublicProject }>(publicEndpoint(slug, ''))).project;
        setSceneMessage('Эта видеосцена больше недоступна. Открыта другая опубликованная сцена.');
      }
      if (serial !== navigation.current) return;
      setPasscode('');
      loadedRoute.current = `${slug}|${videoSceneId(next)}`;
      applyProject(next, false);
      updateSceneQuery(videoSceneId(next), true);
    } catch (caught) { if (serial === navigation.current) setUnlockError(caught instanceof Error ? caught.message : 'Неверный пароль'); }
    finally { if (serial === navigation.current) setUnlocking(false); }
  };

  const addComment = async (author: string, text: string, time: number, consent: FeedbackConsent) => {
    if (!slug || !project) return;
    const selected = videoSceneId(project);
    const revision = project.contentRevision;
    const data = await api<{ comment: PublicProject['comments'][number] }>(`/api/s/${encodeURIComponent(slug)}/comments`, {
      method: 'POST', body: { author, text, time, consent, videoSceneId: selected, contentRevision: revision },
    });
    setProject((current) => current && videoSceneId(current) === selected && current.contentRevision === revision
      ? { ...current, comments: [...current.comments, data.comment] } : current);
  };

  const approve = async (author: string, note: string, consent: FeedbackConsent) => {
    if (!slug || !project) return;
    if (latestRef.current) throw new Error('Показ обновлён. Откройте новую версию перед согласованием.');
    const selected = videoSceneId(project);
    const revision = project.contentRevision;
    const data = await api<{ approval: PublicProject['approval'] }>(`/api/s/${encodeURIComponent(slug)}/approve`, {
      method: 'POST', body: { author, note, consent, videoSceneId: selected, contentRevision: revision },
    });
    setProject((current) => current && videoSceneId(current) === selected && current.contentRevision === revision
      ? { ...current, approval: data.approval, approved: true, videoScenes: current.videoScenes?.map((scene) => scene.id === selected ? { ...scene, approved: true } : scene) } : current);
  };

  if (loading) {
    return (
      <div className="public-boot">
        <Logo />
        <Spinner size={22} />
      </div>
    );
  }

  if (locked) {
    return (
      <div className="gate">
        <header className="gate__head">
          <Logo link />
          <span className="gate__note">Закрытый показ</span>
        </header>
        <div className="gate__card">
          <span className="gate__icon">
            <Lock size={22} />
          </span>
          <span className="eyebrow">KUOG HALL · показ</span>
          <h1>{locked.title}</h1>
          {locked.client ? <p>{locked.client}</p> : null}
          {locked.unconfigured ? <p>Организатор ещё не настроил пароль. Попросите его открыть доступ к показу.</p> : <form
            className="gate__form"
            onSubmit={(event) => {
              event.preventDefault();
              unlock();
            }}
          >
            <input
              className="input"
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              placeholder="Пароль показа" aria-label="Пароль показа" autoComplete="current-password" required
              autoFocus
            />
            <button className="btn btn--primary btn--lg" type="submit" disabled={unlocking}>
              {unlocking ? <Spinner size={17} /> : <Play size={16} />}
              Открыть
            </button>
          </form>}
          {unlockError ? <div className="form-error">{unlockError}</div> : null}
          <p className="gate__hint">Пароль можно уточнить у команды, которая прислала ссылку.</p>
        </div>
        <footer className="gate__foot">
          <Link to="/">KUOG HALL</Link>
          <LegalLinks />
        </footer>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="gate">
        <header className="gate__head">
          <Logo link />
        </header>
        <div className="gate__card">
          <span className="eyebrow">KUOG HALL</span>
          <h1>Показ недоступен</h1>
          <p className="gate__error">{error || 'Ссылка устарела или была отозвана.'}</p>
          <Link to="/" className="btn btn--secondary">
            <ArrowLeft size={15} /> На главную
          </Link>
        </div>
        <footer className="gate__foot"><LegalLinks /></footer>
      </div>
    );
  }

  return (
    <>
    {latestProject || refreshMessage ? (
      <div className="public-version-notice" role="status">
        <span>{latestProject ? 'Показ обновлён. Для согласования откройте новую версию.' : refreshMessage}</span>
        <button className="btn btn--primary btn--sm" onClick={() => {
          const next = latestRef.current;
          if (next) {
            projectRef.current = next;
            latestRef.current = null;
            setProject(next);
            setLatestProject(null);
            setRefreshMessage('');
            setAutoStart(false);
          } else refreshNow.current();
        }}>{latestProject ? 'Открыть новую версию' : 'Проверить готовность'}</button>
      </div>
    ) : null}
    <Player
      key={`${project.id}:${videoSceneId(project)}:${project.contentRevision}`}
      project={toPlayerProject({ ...project, canApprove: project.canApprove && !latestProject }, false)}
      comments={project.comments}
      initialView={preferredView}
      onViewChange={setPreferredView}
      autoStart={autoStart}
      switchingScene={switchingScene}
      sceneMessage={sceneMessage}
      onSelectVideoScene={(id) => { startNextScene.current = true; updateSceneQuery(id); }}
      onLogout={async () => {
        try {
          await api(`/api/s/${encodeURIComponent(slug || '')}/logout`, { method: 'POST' });
          window.location.replace(`/s/${encodeURIComponent(slug || '')}`);
        } catch { setRefreshMessage('Не удалось выйти. Проверьте соединение и повторите выход.'); }
      }}
      onAddComment={addComment}
      onApprove={approve}
    />
    </>
  );
}
