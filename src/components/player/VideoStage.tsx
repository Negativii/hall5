import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import { PlayerProject, PlayerSurface, SurfaceKey } from '../../lib/types';
import { PlayerController } from './usePlayer';
import { mediaSourceIdentity } from '../../lib/mediaCompatibility';

export function VideoStage({
  project,
  controller,
  focusedKey = controller.focusedSurface,
  started = true,
}: {
  project: PlayerProject;
  controller: PlayerController;
  focusedKey?: SurfaceKey | null;
  started?: boolean;
}) {
  return (
    <div className={`video-pool${focusedKey ? ' video-pool--focused' : ''}`} aria-hidden="true">
      {project.surfaces.map((surface) =>
        project.requiredSurfaceKeys.includes(surface.key) && surface.previewUrl ? (
          <SourceVideo key={`${surface.key}:${mediaSourceIdentity(surface.previewUrl)}`} surface={surface}
            sourceUrl={controller.sourceUrls[surface.key] || surface.previewUrl}
            focused={focusedKey === surface.key}
            enabled={!focusedKey || focusedKey === surface.key}
            preload={!focusedKey || focusedKey === surface.key ? (started ? 'auto' : 'metadata') : 'none'}
            register={controller.register} syncSource={controller.syncSource} markReady={controller.markReady} markWaiting={controller.markWaiting}
            markError={controller.markError} markEnded={controller.markEnded} markPaused={controller.markPaused} />
        ) : null,
      )}
    </div>
  );
}

// A stable ref prevents the timeline's React updates from detaching and
// re-registering every media element while its decoder is playing.
const SourceVideo = memo(function SourceVideo({ surface, sourceUrl, focused, enabled, preload, register, syncSource, markReady, markWaiting, markError, markEnded, markPaused }: {
  surface: PlayerSurface;
  sourceUrl: string;
  focused: boolean;
  enabled: boolean;
  preload: 'none' | 'metadata' | 'auto';
} & Pick<PlayerController, 'register' | 'syncSource' | 'markReady' | 'markWaiting' | 'markError' | 'markEnded' | 'markPaused'>) {
  const elementRef = useRef<HTMLVideoElement | null>(null);
  const setRef = useCallback((element: HTMLVideoElement | null) => {
    elementRef.current = element;
    register(surface.key, element);
  }, [register, surface.key]);
  useLayoutEffect(() => {
    const video = elementRef.current;
    if (!video) return;
    // The controller may already restore this URL during a click gesture. Avoid
    // assigning it twice: a second src assignment would reset the warmup.
    syncSource(surface.key, enabled ? sourceUrl : null);
  }, [enabled, sourceUrl, surface.key, syncSource]);
  return <video
    className={focused ? 'video-pool__focused' : undefined}
    data-surface={surface.key}
    ref={setRef}
    poster={surface.posterUrl || undefined}
    preload={preload}
    playsInline
    muted
    disablePictureInPicture
    onCanPlay={() => markReady(surface.key)}
    onSeeked={() => markReady(surface.key)}
    onProgress={() => markReady(surface.key)}
    onWaiting={() => markWaiting(surface.key)}
    onStalled={() => markWaiting(surface.key)}
    onSeeking={() => markWaiting(surface.key)}
    onEmptied={() => markWaiting(surface.key)}
    onError={() => markError(surface.key)}
    onEnded={() => markEnded(surface.key)}
    onPause={() => markPaused(surface.key)}
  />;
});
