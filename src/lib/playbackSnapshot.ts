import type { SurfaceKey } from './types';
import type { PlaybackVariant } from './mediaCompatibility';

export type SnapshotReason = 'play' | 'retry' | 'after-2s' | 'after-5s' | 'after-10s' | 'after-20s' | 'failure';
export interface VideoPlayAttempt {
  playAttempts: number;
  lastPlayPhase: 'warmup' | 'start' | 'resume' | null;
  lastPlayResult: 'pending' | 'resolved' | 'AbortError' | 'NotAllowedError' | 'other' | null;
}
export interface VideoVisibility {
  display: 'none' | 'other'; visibility: 'hidden' | 'visible' | 'other';
  opacity: number; width: number; height: number; x: number; y: number;
}
export interface PlaybackSnapshot {
  reason: SnapshotReason;
  elapsedMs: number;
  visibilityState: 'visible' | 'hidden';
  userActivation: { isActive: boolean | null; hasBeenActive: boolean | null };
  controller: {
    desired: boolean; running: boolean; starting: boolean; time: number;
    heldKeys: SurfaceKey[]; resumingKeys: SurfaceKey[];
    settling: { target: number; remainingMs: number } | null;
  };
  videos: Array<VideoPlayAttempt & {
    surfaceKey: SurfaceKey; currentTime: number; readyState: number; networkState: number;
    paused: boolean; seeking: boolean; playbackRate: number;
    buffered: Array<[number, number]>; hasSource: boolean; variant: PlaybackVariant;
    muted: boolean; playsInline: boolean; ended: boolean; visibility?: VideoVisibility;
  }>;
}

type SnapshotVideo = Pick<HTMLVideoElement, 'currentTime' | 'readyState' | 'networkState' | 'paused' | 'seeking' | 'playbackRate' | 'buffered' | 'hasAttribute' | 'muted' | 'playsInline' | 'ended'>;
const finite = (value: number) => Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0;

export function playFailureResult(error: unknown): VideoPlayAttempt['lastPlayResult'] {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : null;
  return name === 'AbortError' || name === 'NotAllowedError' ? name : 'other';
}

export function capturePlaybackVideos(entries: Array<{ surfaceKey: SurfaceKey; video: SnapshotVideo; variant: PlaybackVariant; play?: VideoPlayAttempt; visibility?: VideoVisibility }>): PlaybackSnapshot['videos'] {
  return entries.slice(0, 5).map(({ surfaceKey, video, variant, play, visibility }) => {
    const buffered: Array<[number, number]> = [];
    try {
      for (let index = 0; index < Math.min(3, video.buffered.length); index += 1) buffered.push([finite(video.buffered.start(index)), finite(video.buffered.end(index))]);
    } catch { /* A native TimeRanges snapshot can change between reads. */ }
    return { surfaceKey, currentTime: finite(video.currentTime), readyState: video.readyState, networkState: video.networkState,
      paused: video.paused, seeking: video.seeking, playbackRate: finite(video.playbackRate),
      buffered, hasSource: video.hasAttribute('src'), variant,
      muted: video.muted, playsInline: video.playsInline, ended: video.ended,
      playAttempts: play?.playAttempts || 0, lastPlayPhase: play?.lastPlayPhase || null, lastPlayResult: play?.lastPlayResult || null,
      ...(visibility ? { visibility: { display: visibility.display, visibility: visibility.visibility,
        opacity: finite(visibility.opacity), width: finite(visibility.width), height: finite(visibility.height), x: finite(visibility.x), y: finite(visibility.y) } } : {}),
    };
  });
}

export function diagnosticBuild(sources: string[]): string {
  const names = sources.map((source) => {
    try { return new URL(source, 'https://hall.invalid').pathname.split('/').at(-1) || ''; } catch { return ''; }
  }).filter((name) => /^[a-z\d_.-]{1,100}$/i.test(name));
  return names.find((name) => /^index-[a-z\d_-]+\.js$/i.test(name)) || names[0] || 'unknown';
}

/** Five scheduled samples plus at most one failure; no intervals or idle RAF. */
export function createStartupTrace({ now, schedule, clear, emit }: {
  now: () => number;
  schedule: (callback: () => void, delay: number) => number;
  clear: (timer: number) => void;
  emit: (reason: SnapshotReason, elapsedMs: number, message?: string) => void;
}) {
  let startedAt = 0;
  let active = false;
  let emitted = 0;
  let timers: number[] = [];
  let generation = 0;
  const cancel = () => { generation += 1; active = false; for (const timer of timers) clear(timer); timers = []; };
  const sample = (reason: SnapshotReason, message?: string) => {
    if (!active || emitted >= 6) return;
    emitted += 1;
    try { emit(reason, Math.max(0, Math.round(now() - startedAt)), message); } catch { /* Instrumentation cannot affect playback. */ }
  };
  return {
    start(reason: 'play' | 'retry') {
      cancel(); active = true; emitted = 0; startedAt = now();
      const ticket = generation;
      sample(reason);
      for (const [delay, label] of [[2000, 'after-2s'], [5000, 'after-5s'], [10000, 'after-10s'], [20000, 'after-20s']] as const) {
        const timer = schedule(() => {
          timers = timers.filter((item) => item !== timer);
          if (ticket === generation) sample(label);
        }, delay);
        timers.push(timer);
      }
    },
    failure(message?: string) { sample('failure', message); cancel(); },
    cancel,
  };
}
