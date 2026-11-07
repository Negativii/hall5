import { useEffect, useState } from 'react';
import type { SurfaceKey } from '../../lib/types';

// Offer a lighter presentation when the browser actually drops frames. This
// never selects a smaller file, lowers the video bitrate, or changes quality.
export function usePlaybackHealth(
  videos: React.MutableRefObject<Partial<Record<SurfaceKey, HTMLVideoElement>>>,
  enabled: boolean,
  buffering: boolean,
) {
  const [strained, setStrained] = useState(false);
  useEffect(() => {
    if (!enabled) { setStrained(false); return; }
    const previous = new Map<HTMLVideoElement, { total: number; dropped: number }>();
    let consecutive = 0;
    const timer = window.setInterval(() => {
      if (document.hidden) { previous.clear(); consecutive = 0; return; }
      let struggling = false;
      for (const video of Object.values(videos.current)) {
        if (!video || video.paused || video.seeking || !video.getVideoPlaybackQuality) continue;
        const quality = video.getVideoPlaybackQuality();
        const before = previous.get(video);
        if (before) {
          const total = quality.totalVideoFrames - before.total;
          const dropped = quality.droppedVideoFrames - before.dropped;
          if (total >= 20 && dropped / total > .12) struggling = true;
        }
        previous.set(video, { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames });
      }
      consecutive = struggling ? consecutive + 1 : 0;
      if (consecutive >= 2) setStrained(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [enabled, videos]);
  useEffect(() => {
    if (!enabled || !buffering) return;
    const timer = window.setTimeout(() => { if (!document.hidden) setStrained(true); }, 7000);
    return () => window.clearTimeout(timer);
  }, [enabled, buffering]);
  return strained;
}
