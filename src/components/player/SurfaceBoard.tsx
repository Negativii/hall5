import { useLayoutEffect, useRef } from 'react';
import { Maximize2, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { PlayerProject, PlayerSurface } from '../../lib/types';
import { SurfaceBadge } from '../StatusChip';
import { SurfaceCanvas } from './SurfaceCanvas';
import { PlayerController } from './usePlayer';
import { formatTime } from '../../lib/format';

export function SurfaceBoard({
  project,
  controller,
  onFocus,
  active = true,
}: {
  project: PlayerProject;
  controller: PlayerController;
  onFocus: (surface: PlayerSurface) => void;
  active?: boolean;
}) {
  return (
    <div className="board">
      {project.surfaces.filter((surface) => project.requiredSurfaceKeys.includes(surface.key)).map((surface) => (
        <button
          key={surface.key}
          type="button"
          className={`board__cell board__cell--${surface.key}`}
          onClick={() => onFocus(surface)}
          aria-label={`Развернуть: ${surface.name}`}
        >
          <div className="board__media">
            {surface.posterUrl ? (
              <img className="board__poster" src={surface.posterUrl} alt="" loading="lazy" />
            ) : (
              <div className="board__blank" />
            )}
            {surface.status === 'ready' && surface.previewUrl ? (
              <SurfaceCanvas
                videos={controller.videos}
                surfaceKey={surface.key}
                className="board__canvas"
                active={active}
              />
            ) : null}
            <div className="board__shade" />
            <div className="board__top">
              <SurfaceBadge num={surface.num} label={surface.label} keyName={surface.key} />
              <span className="board__open">
                <Maximize2 size={15} />
              </span>
            </div>
            {surface.status !== 'ready' ? (
              <div className="board__empty">
                <span className="board__empty-num">{String(surface.num).padStart(2, '0')}</span>
                <span className="board__empty-title">
                  {surface.status === 'error' ? 'Ошибка загрузки' : 'Нет видео'}
                </span>
                <span className="board__empty-spec">
                  {surface.specW} × {surface.specH}
                </span>
              </div>
            ) : (
              <div className="board__bottom">
                <span className="board__name">{surface.name}</span>
                <span className="board__spec">
                  {surface.width} × {surface.height}
                  {surface.aspectWarning ? ' · не совпадает' : ''}
                </span>
              </div>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

export function FocusView({
  surface,
  controller,
  onClose,
  onPrev,
  onNext,
  nativeVideo = false,
}: {
  surface: PlayerSurface;
  controller: PlayerController;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  nativeVideo?: boolean;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const videoWidth = surface.previewWidth || surface.width || surface.specW;
  const videoHeight = surface.previewHeight || surface.height || surface.specH;
  const videoFps = surface.previewFps || surface.fps;
  const qualityLabel = surface.previewMode === 'copy' ? 'без повторного сжатия'
    : surface.previewMode === 'converted' ? 'полное разрешение' : '';
  useLayoutEffect(() => {
    if (!nativeVideo) return;
    const viewport = viewportRef.current;
    const stage = viewport?.closest<HTMLElement>('.player__stage');
    if (!viewport || !stage) return;
    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      const parent = stage.getBoundingClientRect();
      stage.style.setProperty('--focus-left', `${rect.left - parent.left}px`);
      stage.style.setProperty('--focus-top', `${rect.top - parent.top}px`);
      stage.style.setProperty('--focus-width', `${rect.width}px`);
      stage.style.setProperty('--focus-height', `${rect.height}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport); observer.observe(stage); measure();
    return () => {
      observer.disconnect();
      for (const variable of ['--focus-left', '--focus-top', '--focus-width', '--focus-height']) stage.style.removeProperty(variable);
    };
  }, [nativeVideo]);
  return (
    <div className={`focus${nativeVideo ? ' focus--native' : ''}`} role="dialog" aria-modal="true" aria-label={surface.name}>
      <div className="focus__bar">
        <SurfaceBadge num={surface.num} label={surface.label} keyName={surface.key} />
        <span className="focus__name">{surface.name}</span>
        <span className="focus__spec">
          {videoWidth} × {videoHeight} px{videoFps ? ` · ${Number(videoFps.toFixed(2))} кадр/с` : ''}
          {qualityLabel ? ` · ${qualityLabel}` : ''}
        </span>
        <button className="focus__close" onClick={onClose} aria-label="Закрыть">
          Закрыть
        </button>
      </div>
      <div className="focus__viewport" ref={viewportRef} onClick={onClose}>
        <div
          className="focus__screen"
          style={{ aspectRatio: String(videoWidth / videoHeight) }}
          onClick={(event) => event.stopPropagation()}
        >
          {!nativeVideo && surface.posterUrl ? (
            <img className="focus__poster" src={surface.posterUrl} alt="" />
          ) : null}
          {surface.status === 'ready' && surface.previewUrl ? (nativeVideo ? null :
            <SurfaceCanvas
              videos={controller.videos}
              surfaceKey={surface.key}
              className="focus__canvas"
            />
          ) : (
            <div className="focus__empty">Видео не загружено</div>
          )}
        </div>
      </div>
      <div className="focus__controls">
        {controller.playbackError ? <div className="focus__status" role="alert">
          <span>{controller.playbackError}</span><button onClick={controller.retry}>Повторить</button>
        </div> : controller.buffering ? <div className="focus__status" role="status">Загружаем видео…</div> : null}
        <input className="focus__timeline" type="range" min="0" max={controller.duration || 1} step="0.01"
          value={Math.min(controller.time, controller.duration || 1)} aria-label="Позиция видео"
          onChange={(event) => controller.seek(Number(event.target.value))} />
        <div className="focus__nav">
          <button onClick={onPrev} className="focus__arrow" aria-label="Предыдущая поверхность">←</button>
          <button onClick={controller.toggle} className="focus__arrow" aria-label={controller.playing ? 'Пауза видео' : 'Воспроизвести видео'}>
            {controller.playing ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <span className="focus__time">{formatTime(controller.time)} / {formatTime(controller.duration)}</span>
          <button onClick={controller.toggleSound} disabled={!surface.hasAudio} className="focus__arrow"
            aria-label={controller.muted ? 'Включить звук видео' : 'Выключить звук видео'}>
            {controller.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <button onClick={onNext} className="focus__arrow" aria-label="Следующая поверхность">→</button>
        </div>
      </div>
    </div>
  );
}
