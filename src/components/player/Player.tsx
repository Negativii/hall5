import { LegalLinks } from '../LegalLinks';
import { useLegalConfig, type FeedbackConsent } from '../../lib/legal';
import { FeedbackConsentField } from '../FeedbackConsent';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Box,
  Check,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Minimize2,
  Monitor,
  Pause,
  Play,
  Repeat2,
  RotateCcw,
} from 'lucide-react';
import { Comment, PlayerProject, PlayerSurface } from '../../lib/types';
import { formatDate, formatTime } from '../../lib/format';
import { Btn, IconBtn, Spinner } from '../ui';
import { Logo } from '../Logo';
import { Modal } from '../Modal';
import { useToast } from '../Toast';
import { usePlayer } from './usePlayer';
import type { MediaFailureDiagnostic } from '../../lib/mediaFailure';
import { diagnosticBuild } from '../../lib/playbackSnapshot';
import { usePlaybackHealth } from './usePlaybackHealth';
import { VideoStage } from './VideoStage';
import { SurfaceBoard, FocusView } from './SurfaceBoard';
import { Timeline } from './Timeline';
import { SoundControl } from './SoundControl';
import { SidePanel } from './SidePanel';

type ViewMode = 'room' | 'board';

const Room3D = lazy(() => import('./Room3D').then((module) => ({ default: module.Room3D })));

export function Player({
  project,
  isAdmin = false,
  backTo,
  comments,
  onAddComment,
  onApprove,
  initialView,
  onViewChange,
  autoStart = false,
  onSelectVideoScene,
  switchingScene = null,
  sceneMessage = '',
  onLogout,
}: {
  project: PlayerProject;
  onLogout?: () => void;
  initialView?: ViewMode;
  onViewChange?: (view: ViewMode) => void;
  autoStart?: boolean;
  onSelectVideoScene?: (id: string) => void;
  switchingScene?: string | null;
  sceneMessage?: string;
  isAdmin?: boolean;
  backTo?: string;
  comments: Comment[];
  onAddComment?: (author: string, text: string, time: number, consent: FeedbackConsent) => Promise<void>;
  onApprove?: (author: string, note: string, consent: FeedbackConsent) => Promise<void>;
}) {
  const sentDiagnostics = useRef(new Map<string, number>());
  const reportMediaError = useCallback((failure: MediaFailureDiagnostic) => {
    if (isAdmin || import.meta.env.VITE_STATIC_DEMO === 'true') return;
    const key = `${project.videoSceneId || 'main'}:${project.contentRevision}:${failure.surfaceKey}:${failure.event}:${failure.variant}:${failure.code}:${failure.mode}`;
    const now = Date.now();
    if (failure.event !== 'snapshot') {
      if (now - (sentDiagnostics.current.get(key) || 0) < 60000) return;
      sentDiagnostics.current.set(key, now);
    }
    const build = diagnosticBuild([...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((script) => script.src));
    void fetch(`/api/s/${encodeURIComponent(project.slug)}/playback-diagnostics`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ ...failure, build, videoSceneId: project.videoSceneId || 'main', contentRevision: project.contentRevision }),
    }).catch(() => { /* Diagnostics must never interfere with playback/retry. */ });
  }, [isAdmin, project.slug, project.videoSceneId, project.contentRevision]);
  const controller = usePlayer(project, reportMediaError);
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const resumeRef = useRef(false);
  const hasSceneObjects = Boolean(project.scene?.objects.length);
  const [view, setView] = useState<ViewMode>(() => initialView || (hasSceneObjects ? 'room' : 'board'));
  const [started, setStarted] = useState(false);
  const [roomRequested, setRoomRequested] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [panel, setPanel] = useState<'screens' | 'comments' | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const [approveOpen, setApproveOpen] = useState(false);

  const autoStarted = useRef(false);
  useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    setStarted(true);
    if (project.duration) controller.play();
  }, [autoStart, project.duration, controller.play]);
  const publishedScenes = project.videoScenes?.filter((scene) => scene.published) || [];

  const canReview = !isAdmin && project.allowComments;
  const requiredCount = project.requiredSurfaceKeys.length;
  const readyCount = project.surfaces.filter((surface) => project.requiredSurfaceKeys.includes(surface.key) && surface.status === 'ready').length;
  const loadedCount = project.requiredSurfaceKeys.filter((key) => controller.readyKeys.has(key)).length;
  const canApprove = project.canApprove && project.requiredSurfaceKeys.every((key) => controller.reviewReadyKeys.has(key)) && !controller.playbackError && !controller.buffering;
  const focusSurface = focusIndex !== null ? project.surfaces[focusIndex] : null;
  const watchable = project.surfaces.filter((surface) => project.requiredSurfaceKeys.includes(surface.key) && surface.status === 'ready' && surface.previewUrl);
  const strained = usePlaybackHealth(controller.videos, started && controller.playing && !focusSurface, controller.buffering);
  useEffect(() => {
    if (started && view === 'room' && !focusSurface) setRoomRequested(true);
  }, [started, view, focusSurface]);

  useEffect(() => {
    controller.setFocusedSurface(focusSurface?.key ?? null);
  }, [focusSurface?.key, controller.setFocusedSurface]);

  const openSingleScreen = () => {
    const surface = watchable.find((item) => controller.mediaFailures[item.key]?.message === controller.playbackError)
      || watchable.find((item) => controller.errorKeys.has(item.key)) || watchable[0];
    if (!surface) return;
    // Select the active decoder during the gesture, before attempting playback.
    controller.setFocusedSurface(surface.key);
    setFocusIndex(project.surfaces.indexOf(surface));
    setStarted(true);
    controller.play();
  };

  const start = useCallback(() => {
    if (!project.duration && !hasSceneObjects) return;
    setStarted(true);
    if (project.duration) controller.play();
    else setView('room');
  }, [controller, project.duration, hasSceneObjects]);

  const handleRoomFail = useCallback(() => {
    setView('board');
    const first = project.surfaces.findIndex((surface) => project.requiredSurfaceKeys.includes(surface.key) && surface.status === 'ready' && surface.previewUrl);
    if (first >= 0) { setFocusIndex(first); setStarted(true); }
    toast.push('3D недоступен', {
      description: first >= 0 ? 'Открыт один экран. Можно смотреть видео по очереди в полном качестве.' : 'Переключились на схему поверхностей.',
      tone: 'info',
    });
  }, [toast, project.surfaces, project.requiredSurfaceKeys]);

  const seekTo = useCallback(
    (time: number) => {
      controller.seek(time);
      if (!started) setStarted(true);
    },
    [controller, started],
  );

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (rootRef.current) {
        await rootRef.current.requestFullscreen();
      }
    } catch {
      toast.push('Полный экран недоступен в этом браузере', { tone: 'error' });
    }
  }, [toast]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space') {
        if (target?.closest('button, a')) return;
        event.preventDefault();
        if (!started) start();
        else controller.toggle();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        controller.seek(controller.time + 5);
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        controller.seek(controller.time - 5);
      }
      if (event.key.toLowerCase() === 'm') controller.toggleSound();
      if (event.key.toLowerCase() === 'f') toggleFullscreen();
      if (event.key === 'Escape') {
        if (focusIndex !== null) { controller.setFocusedSurface(null); setFocusIndex(null); }
        else if (panel) setPanel(null);
      }
      if (/^[1-5]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        const surface = project.surfaces[index];
        if (surface?.status === 'ready' && project.requiredSurfaceKeys.includes(surface.key) && surface.previewUrl) {
          controller.setFocusedSurface(surface.key); setFocusIndex(index); setStarted(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [controller, focusIndex, panel, project.surfaces, project.requiredSurfaceKeys, started, start, toggleFullscreen]);

  const moveFocus = (direction: number) => {
    if (focusIndex === null || !watchable.length) return;
    const current = watchable.findIndex((surface) => surface.key === focusSurface?.key);
    const next = watchable[(current + direction + watchable.length) % watchable.length];
    controller.setFocusedSurface(next.key);
    setFocusIndex(project.surfaces.indexOf(next));
  };

  const bgPoster = useMemo(() => {
    const used = project.surfaces.filter((surface) => project.requiredSurfaceKeys.includes(surface.key));
    const floor = used.find((surface) => surface.key === 'floor');
    return floor?.posterUrl || used.find((surface) => surface.posterUrl)?.posterUrl || null;
  }, [project.surfaces, project.requiredSurfaceKeys]);

  return (
    <div className={`player ${fullscreen ? 'is-fullscreen' : ''} ${panel ? 'has-panel' : ''}`} ref={rootRef}
      data-video-scene={project.videoSceneId || 'main'} data-scene-revision={project.contentRevision}
      data-playback-state={controller.playbackError ? 'error' : controller.buffering ? 'buffering' : controller.playing ? 'playing' : 'paused'}>
      <header className="player__head">
        <div className="player__ident">
          <Logo link={!isAdmin} />
          {isAdmin && backTo ? (
            <Link to={backTo} className="player__back">
              <ArrowLeft size={15} />
              Кабинет
            </Link>
          ) : null}
          <span className="player__rule" />
          <div className="player__heading">
            <h1>{project.title}</h1>
            <p>
              {project.client || 'Без заказчика'}
              {project.eventDate ? ` · ${formatDate(project.eventDate)}` : ''}
              {project.demo ? <span className="tag tag--accent">демо</span> : null}
            </p>
          </div>
        </div>
        <div className="player__actions">
          {project.approval ? (
            <span className="approved-pill">
              <Check size={14} />
              Согласовано
            </span>
          ) : canReview ? (
            <Btn variant="primary" size="sm" onClick={() => { controller.pause(); setApproveOpen(true); }}
              disabled={!canApprove} title={canApprove ? 'Согласовать эту версию показа' : 'Сначала дождитесь готовности всего контента сцены'}>
              Согласовать
            </Btn>
          ) : null}
          <button
            className={`comments-btn ${panel === 'comments' ? 'is-active' : ''}`}
            onClick={() => setPanel(panel === 'comments' ? null : 'comments')}
          >
            <MessageSquare size={16} />
            <span className="comments-btn__label">Отзывы</span>
            {comments.length ? <span className="comments-btn__count">{comments.length}</span> : null}
          </button>
        </div>
      </header>

      {onSelectVideoScene && (publishedScenes.length > 1 || sceneMessage) ? (
        <nav className="video-scene-switcher" aria-label="Видеосцены" aria-busy={Boolean(switchingScene)}>
          {publishedScenes.length > 1 ? <>
            <span className="video-scene-switcher__label">Видеосцена</span>
            <div className="video-scene-switcher__items">
              {publishedScenes.map((scene) => <button key={scene.id} type="button"
                className={`video-scene-switcher__button${scene.id === (project.videoSceneId || 'main') ? ' is-active' : ''}`}
                aria-pressed={scene.id === (project.videoSceneId || 'main')}
                title={`${scene.name}${scene.approved ? ' · Согласовано' : ''}`}
                disabled={Boolean(switchingScene)}
                onClick={() => {
                  if (scene.id === (project.videoSceneId || 'main')) return;
                  controller.pause(); setPanel(null); setApproveOpen(false);
                  onSelectVideoScene(scene.id);
                }}>
                <span>{scene.name}</span>
                {switchingScene === scene.id ? <Spinner size={13} /> : scene.approved ? <Check size={13} aria-label="Согласовано" /> : null}
              </button>)}
            </div>
          </> : null}
          {sceneMessage ? <p className="video-scene-switcher__message" role="status">{sceneMessage}</p> : null}
        </nav>
      ) : null}

      <main className="player__stage">
        <VideoStage project={project} controller={controller} started={started} />
        {view === 'room' ? (
          <Suspense
            fallback={
              <div className="room3d-loader">
                <Spinner size={20} />
                <span>Собираем 3D-зал</span>
              </div>
            }
          >
            {roomRequested ? <Room3D
              project={project}
              videos={controller.videos}
              resetSignal={resetSignal}
              onFail={handleRoomFail}
              suspended={Boolean(focusSurface) || !started}
            /> : null}
          </Suspense>
        ) : (
          <div className="board-wrap">
            <SurfaceBoard
              project={project}
              controller={controller}
              active={!focusSurface && started}
              onFocus={(surface) => { controller.setFocusedSurface(surface.key); setFocusIndex(project.surfaces.indexOf(surface)); }}
            />
          </div>
        )}

        <div className="viewswitch">
          <button
            className={view === 'room' ? 'is-active' : ''}
            onClick={() => setView('room')}
            title="3D-зал"
          >
            <Box size={15} />
            3D
          </button>
          <button
            className={view === 'board' ? 'is-active' : ''}
            onClick={() => setView('board')}
            title="Схема поверхностей"
          >
            <LayoutGrid size={15} />
            Схема
          </button>
          {watchable.length ? <button onClick={openSingleScreen} title="Один экран в полном качестве">
            <Monitor size={15} /> Один экран
          </button> : null}
          {view === 'room' ? (
            <button className="viewswitch__reset" onClick={() => setResetSignal((value) => value + 1)} title="Сбросить ракурс">
              <RotateCcw size={14} />
            </button>
          ) : null}
        </div>

        {started && controller.buffering && project.duration > 0 ? (
          <div className="buffering" role="status">
            <Spinner size={16} />
            Подгружаем и синхронизируем видео…
          </div>
        ) : null}

        {controller.playbackError ? (
          <div className="playback-error" role="alert">
            <p>{controller.playbackError}</p>
            <button className="btn btn--primary" onClick={() => { setStarted(true); controller.retry(); }}>Повторить</button>
            {watchable.length ? <button className="btn btn--secondary" onClick={openSingleScreen}>Смотреть по одному экрану</button> : null}
          </div>
        ) : null}

        {strained && watchable.length ? <div className="playback-advice" role="status">
          <span>Пять видео тяжело воспроизводятся на этом устройстве или соединении.</span>
          <button onClick={openSingleScreen}>Смотреть по одному экрану · полное качество</button>
        </div> : null}

        {!started ? (
          <div className="curtain">
            {bgPoster ? (
              <div className="curtain__bg" style={{ backgroundImage: `url(${bgPoster})` }} />
            ) : (
              <div className="curtain__bg curtain__bg--blank" />
            )}
            <div className="curtain__veil" />
            <div className="curtain__content">
              <span className="eyebrow">
                <span className="eyebrow__dot" />
                {hasSceneObjects ? 'Показ · ваша сцена' : 'Показ · пять поверхностей'}
              </span>
              <h2>{project.title}</h2>
              <p className="curtain__meta">
                {project.client ? `${project.client} · ` : ''}
                {project.eventDate ? `${formatDate(project.eventDate)} · ` : ''}
                {formatTime(project.duration)}
              </p>
              <button className="curtain__play" onClick={start} disabled={!project.duration && !hasSceneObjects}>
                <span className="curtain__play-icon">
                  <Play size={24} fill="currentColor" />
                </span>
                Смотреть
              </button>
              {watchable.length ? <button className="curtain__single" onClick={openSingleScreen}>
                <Monitor size={15} /> Смотреть по одному экрану
              </button> : null}
              <div className="curtain__foot">
                <span>{requiredCount ? `Видео: ${readyCount} из ${requiredCount} · загружено ${loadedCount}` : hasSceneObjects ? `${project.scene.objects.length} объектов в сцене` : 'Сцена ещё не настроена'}</span>
                <span className="curtain__dot" />
                <span>{project.duration ? 'звук в плеере' : 'осмотр в 3D'}</span>
                {readyCount < requiredCount ? (
                  <>
                    <span className="curtain__dot" />
                    <span className="curtain__warn">
                      {readyCount ? 'часть контента ещё не готова' : 'видео ещё не загружены'}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        <div className="transport">
          {controller.mobileOverview ? <div className="mobile-overview-note">Облегчённый обзор · Полное качество в «Один экран»</div> : null}
          <div className="transport__row">
            <button
              className="playbtn"
              onClick={() => {
                if (!started) start();
                else controller.toggle();
              }}
              disabled={!project.duration}
              aria-label={controller.playing ? 'Пауза' : 'Играть'}
            >
              {controller.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
            </button>
            <div className="transport__time">
              <span>{formatTime(controller.time)}</span>
              <em>/ {formatTime(controller.duration)}</em>
            </div>
            <Timeline
              time={controller.time}
              duration={controller.duration}
              comments={comments}
              onSeekStart={() => {
                resumeRef.current = controller.playing;
                controller.pause();
              }}
              onSeek={(value) => controller.seek(value)}
              onSeekEnd={() => {
                if (resumeRef.current) controller.play();
                resumeRef.current = false;
              }}
            />
            <div className="transport__tools">
              <SoundControl
                surfaces={project.surfaces.filter((surface) => project.requiredSurfaceKeys.includes(surface.key))}
                muted={controller.muted}
                audioKey={controller.audioKey}
                volume={controller.volume}
                onToggle={controller.toggleSound}
                onAudio={controller.setAudioKey}
                onVolume={controller.setVolume}
              />
              <IconBtn
                label={controller.loop ? 'Выключить повтор' : 'Включить повтор'}
                active={controller.loop}
                onClick={() => controller.setLoop(!controller.loop)}
              >
                <Repeat2 size={17} />
              </IconBtn>
              <IconBtn
                label="Поверхности"
                active={panel === 'screens'}
                onClick={() => setPanel(panel === 'screens' ? null : 'screens')}
              >
                <LayoutGrid size={17} />
              </IconBtn>
              <IconBtn label={fullscreen ? 'Выйти из полного экрана' : 'На весь экран'} onClick={toggleFullscreen}>
                {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </IconBtn>
            </div>
          </div>
        </div>

        {panel ? (
          <SidePanel
            project={project}
            controller={controller}
            comments={comments}
            currentTime={controller.time}
            tab={panel}
            onTab={setPanel}
            onClose={() => setPanel(null)}
            onSeek={seekTo}
            onFocus={(surface: PlayerSurface) => { controller.setFocusedSurface(surface.key); setFocusIndex(project.surfaces.indexOf(surface)); }}
            onAddComment={onAddComment}
            canComment={canReview}
            isAdmin={isAdmin}
          />
        ) : null}

        {focusSurface ? (
          <FocusView
            surface={focusSurface}
            controller={controller}
            nativeVideo
            onClose={() => { controller.setFocusedSurface(null); setFocusIndex(null); }}
            onPrev={() => moveFocus(-1)}
            onNext={() => moveFocus(1)}
          />
        ) : null}
      </main>

      <footer className="player-legal"><LegalLinks />{onLogout ? <button type="button" onClick={() => { controller.pause(); onLogout(); }}>Выйти из показа</button> : null}</footer>

      {onApprove && canReview ? (
        <ApproveModal
          open={approveOpen}
          onClose={() => setApproveOpen(false)}
          project={project}
          onApprove={onApprove}
          canApprove={canApprove}
        />
      ) : null}
    </div>
  );
}

function ApproveModal({
  open,
  onClose,
  project,
  onApprove,
  canApprove,
}: {
  open: boolean;
  onClose: () => void;
  project: PlayerProject;
  onApprove: (author: string, note: string, consent: FeedbackConsent) => Promise<void>;
  canApprove: boolean;
}) {
  const toast = useToast();
  const [author, setAuthor] = useState('');
  const { config: legal } = useLegalConfig();
  const [consented, setConsented] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setAuthor('');
      setConsented(false);
      setNote('');
      setError('');
    }
  }, [open]);

  const submit = async () => {
    if (!canApprove) {
      setError('Для согласования должен быть готов весь контент сцены.');
      return;
    }
    if (!author.trim()) {
      setError('Укажите имя — оно попадёт в историю согласования');
      return;
    }
    if (!legal?.configured || !consented) { setError('Для согласования отметьте отдельное согласие.'); return; }
    setPending(true);
    setError('');
    try {
      await onApprove(author.trim(), note.trim(), { accepted: true, version: legal.consentVersion });
      toast.push('Показ согласован', { description: 'Команда увидит это в кабинете.', tone: 'success' });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось согласовать');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Согласовать показ"
      eyebrow={project.title}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Отмена
          </Btn>
          <Btn variant="primary" onClick={submit} loading={pending} disabled={!canApprove || !legal?.configured || !consented} icon={<Check size={16} />}>
            Согласовать
          </Btn>
        </>
      }
    >
      <p className="modal__lead">
        Подтвердите, что весь контент сцены готов к показу. Имя и дата сохранятся
        в истории проекта.
      </p>
      <label className="field">
        <span className="field__label">Ваше имя</span>
        <input
          className="input"
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
          placeholder="Например, Анна, арт-директор"
          maxLength={40}
        />
      </label>
      <label className="field">
        <span className="field__label">Комментарий <span className="muted">— необязательно</span></span>
        <textarea
          className="textarea"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
          maxLength={600}
          placeholder="Что важно учесть перед премьерой"
        />
      </label>
      <FeedbackConsentField config={legal} checked={consented} onChange={setConsented} />
      {error ? <span className="field__error">{error}</span> : null}
    </Modal>
  );
}
