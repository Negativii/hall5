import { memo, useEffect, useRef } from 'react';
import { SurfaceKey } from '../../lib/types';
import { subscribeVideoFrames } from '../../lib/videoFrames';

export const SurfaceCanvas = memo(function SurfaceCanvas({
  videos,
  surfaceKey,
  className,
  active = true,
}: {
  videos: React.MutableRefObject<Partial<Record<SurfaceKey, HTMLVideoElement>>>;
  surfaceKey: SurfaceKey;
  className?: string;
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const video = videos.current[surfaceKey];
    if (!canvas || !video) return;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    let visible = true;
    let unsubscribe: (() => void) | undefined;
    const draw = () => {
      if (!visible || document.hidden || video.readyState < 2) return;
      try { context.drawImage(video, 0, 0, canvas.width, canvas.height); }
      catch { /* A seek can invalidate the frame between readiness and upload. */ }
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      // Canvas pixels serve the displayed size; the source video is unchanged.
      const width = Math.max(2, Math.round(rect.width * ratio));
      const height = Math.max(2, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
        draw();
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();
    unsubscribe = subscribeVideoFrames(video, draw);
    const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !unsubscribe) unsubscribe = subscribeVideoFrames(video, draw);
      else if (!visible && unsubscribe) { unsubscribe(); unsubscribe = undefined; }
    }) : null;
    intersection?.observe(canvas);
    return () => {
      unsubscribe?.();
      resizeObserver.disconnect();
      intersection?.disconnect();
    };
  }, [videos, surfaceKey, active]);

  return <canvas ref={canvasRef} className={className} />;
});
