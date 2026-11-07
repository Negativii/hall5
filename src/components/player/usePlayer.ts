import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlayerProject, PlayerSurface, SurfaceKey } from '../../lib/types';
import { hasStartupBuffer } from '../../lib/playbackBuffer';
import { mediaFailureDiagnostic, shouldIgnoreMediaError, type MediaFailureDiagnostic } from '../../lib/mediaFailure';
import { canTryCompatibility, losslessCompatibility, mediaSourceIdentity, playbackSource, prefersMobilePreview, type PlaybackVariant, type FullQualityVariant } from '../../lib/mediaCompatibility';
import { synchronizationPlan } from '../../lib/playbackSync';
import { capturePlaybackVideos, createStartupTrace, playFailureResult, type SnapshotReason, type VideoPlayAttempt, type VideoVisibility } from '../../lib/playbackSnapshot';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const STARTUP_TIMEOUT_MS = 12000;

export interface PlayerController {
  videos: React.MutableRefObject<Partial<Record<SurfaceKey, HTMLVideoElement>>>;
  sourceUrls: Partial<Record<SurfaceKey, string>>;
  mobileOverview: boolean;
  syncSource: (key: SurfaceKey, sourceUrl: string | null) => void;
  register: (key: SurfaceKey, element: HTMLVideoElement | null) => void;
  focusedSurface: SurfaceKey | null;
  setFocusedSurface: (key: SurfaceKey | null) => void;
  playing: boolean;
  time: number;
  duration: number;
  buffering: boolean;
  playbackError: string | null;
  mediaFailures: Partial<Record<SurfaceKey, MediaFailureDiagnostic>>;
  readyKeys: Set<SurfaceKey>;
  reviewReadyKeys: Set<SurfaceKey>;
  errorKeys: Set<SurfaceKey>;
  muted: boolean;
  audioKey: SurfaceKey | null;
  volume: number;
  loop: boolean;
  play: () => void;
  pause: () => void;
  retry: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  setLoop: (value: boolean) => void;
  toggleSound: () => void;
  setAudioKey: (key: SurfaceKey | null) => void;
  setVolume: (value: number) => void;
  markReady: (key: SurfaceKey) => void;
  markWaiting: (key: SurfaceKey) => void;
  markError: (key: SurfaceKey) => void;
  markEnded: (key?: SurfaceKey) => void;
  markPaused: (key: SurfaceKey) => void;
  firstAudioKey: SurfaceKey | null;
}

export function usePlayer(project: PlayerProject, onMediaError?: (diagnostic: MediaFailureDiagnostic) => void): PlayerController {
  const videos = useRef<Partial<Record<SurfaceKey, HTMLVideoElement>>>({});
  const duration = project.duration || 0;
  const durationRef = useRef(duration);
  const keys = project.requiredSurfaceKeys;
  const keysRef = useRef(keys);
  const allKeysRef = useRef(keys);
  const sourceUrlsRef = useRef<Partial<Record<SurfaceKey, string>>>({});
  const surfacesRef = useRef(project.surfaces);
  const onMediaErrorRef = useRef(onMediaError);
  const failuresRef = useRef<Partial<Record<SurfaceKey, MediaFailureDiagnostic>>>({});
  const [focusedSurface, setFocusedSurfaceState] = useState<SurfaceKey | null>(null);
  const focusedRef = useRef<SurfaceKey | null>(null);
  const [mobileDevice] = useState(() => prefersMobilePreview({ userAgent: navigator.userAgent,
    coarsePointer: matchMedia('(pointer: coarse)').matches, screenWidth: screen.width, screenHeight: screen.height, maxTouchPoints: navigator.maxTouchPoints || 0 }));
  const signature = `${project.id}|${project.videoSceneId || 'main'}|${project.contentRevision}|${keys.join(',')}|${project.surfaces.filter((surface) => keys.includes(surface.key)).map((surface) => `${surface.key}:${mediaSourceIdentity(surface.previewUrl)}`).join('|')}`;
  const [sourceSelection, setSourceSelection] = useState<{ signature: string; variants: Partial<Record<SurfaceKey, FullQualityVariant>> }>({ signature, variants: {} });
  const fullVariantsRef = useRef<Partial<Record<SurfaceKey, FullQualityVariant>>>({});
  const variantsRef = useRef<Partial<Record<SurfaceKey, PlaybackVariant>>>({});
  const compatibilityPending = useRef(new Set<SurfaceKey>());
  const selectedVariants = sourceSelection.signature === signature ? sourceSelection.variants : {};
  const sources = project.surfaces.map((surface) => ({ key: surface.key, ...playbackSource(surface, selectedVariants[surface.key], mobileDevice && !focusedSurface) }));
  const sourceUrls = Object.fromEntries(sources.filter((source) => source.url).map((source) => [source.key, source.url!]));
  const effectiveVariants = Object.fromEntries(sources.map((source) => [source.key, source.variant]));
  const mobileOverview = mobileDevice && !focusedSurface && keys.length > 0 && keys.every((key) => effectiveVariants[key] === 'mobile');
  const [playing, setPlaying] = useState(false);
  // User intent is separate from actual playback: buffering and background tabs
  // pause every decoder, while retaining the request to resume together.
  const desiredRef = useRef(false);
  const runningRef = useRef(false);
  const startingRef = useRef(false);
  const generation = useRef(0);
  const attemptStartRef = useRef<() => void>(() => {});
  const markErrorRef = useRef<(key: SurfaceKey) => void>(() => {});
  const heldKeys = useRef(new Set<SurfaceKey>());
  const resumingKeys = useRef(new Set<SurfaceKey>());
  const settlingRef = useRef<{ target: number; deadline: number } | null>(null);
  const emitSnapshotRef = useRef<(reason: SnapshotReason, elapsedMs: number, message?: string) => void>(() => {});
  const playAttemptsRef = useRef<Partial<Record<SurfaceKey, VideoPlayAttempt>>>({});
  const traceRef = useRef<ReturnType<typeof createStartupTrace> | null>(null);
  if (!traceRef.current) traceRef.current = createStartupTrace({
    now: () => performance.now(), schedule: (callback, delay) => window.setTimeout(callback, delay), clear: (timer) => window.clearTimeout(timer),
    emit: (reason, elapsedMs, message) => emitSnapshotRef.current(reason, elapsedMs, message),
  });
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const [buffering, setBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [mediaFailures, setMediaFailures] = useState<Partial<Record<SurfaceKey, MediaFailureDiagnostic>>>({});
  const [readyKeys, setReadyKeys] = useState<Set<SurfaceKey>>(new Set());
  const [reviewReadyKeys, setReviewReadyKeys] = useState<Set<SurfaceKey>>(new Set());
  const [errorKeys, setErrorKeys] = useState<Set<SurfaceKey>>(new Set());
  const errorsRef = useRef(new Set<SurfaceKey>());
  const [muted, setMuted] = useState(true);
  const [audioKey, setAudioKeyState] = useState<SurfaceKey | null>(null);
  const [volume, setVolumeState] = useState(0.85);
  const [loop, setLoopState] = useState(true);
  const mutedRef = useRef(muted);
  const audioRef = useRef(audioKey);
  const volumeRef = useRef(volume);
  const loopRef = useRef(loop);

  durationRef.current = duration;
  allKeysRef.current = keys;
  sourceUrlsRef.current = sourceUrls;
  fullVariantsRef.current = selectedVariants;
  variantsRef.current = effectiveVariants;
  surfacesRef.current = project.surfaces;
  onMediaErrorRef.current = onMediaError;
  keysRef.current = focusedRef.current ? [focusedRef.current] : keys;
  mutedRef.current = muted;
  audioRef.current = audioKey;
  volumeRef.current = volume;
  loopRef.current = loop;
  emitSnapshotRef.current = (reason, elapsedMs, message) => {
    const key = allKeysRef.current.includes('floor') ? 'floor' : keysRef.current[0] || allKeysRef.current[0];
    const video = videos.current[key];
    const surface = surfacesRef.current.find((item) => item.key === key);
    if (!video || !surface || !onMediaErrorRef.current) return;
    const diagnostic = mediaFailureDiagnostic(surface, video, keysRef.current, Boolean(focusedRef.current), variantsRef.current[key] || 'primary');
    const activation = navigator.userActivation;
    const settling = settlingRef.current;
    onMediaErrorRef.current({ ...diagnostic, event: 'snapshot', code: 0, category: 'unknown', browserMessage: '',
      message: (message || 'Состояние запуска видео').slice(0, 300),
      snapshot: {
        reason, elapsedMs, visibilityState: document.hidden ? 'hidden' : 'visible',
        userActivation: { isActive: activation?.isActive ?? null, hasBeenActive: activation?.hasBeenActive ?? null },
        controller: { desired: desiredRef.current, running: runningRef.current, starting: startingRef.current, time: timeRef.current,
          heldKeys: [...heldKeys.current], resumingKeys: [...resumingKeys.current],
          settling: settling ? { target: settling.target, remainingMs: Math.max(0, Math.round(settling.deadline - performance.now())) } : null },
        videos: capturePlaybackVideos(allKeysRef.current.flatMap((surfaceKey) => {
          const element = videos.current[surfaceKey];
          if (!element) return [];
          let visibility: VideoVisibility | undefined;
          try {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            visibility = { display: style.display === 'none' ? 'none' : 'other',
              visibility: style.visibility === 'hidden' ? 'hidden' : style.visibility === 'visible' ? 'visible' : 'other',
              opacity: Number(style.opacity), width: rect.width, height: rect.height, x: rect.x, y: rect.y };
          } catch { /* Geometry is optional if this element has just detached. */ }
          return [{ surfaceKey, video: element, variant: variantsRef.current[surfaceKey] || 'primary', play: playAttemptsRef.current[surfaceKey], visibility }];
        })),
      },
    });
  };

  const observedPlay = useCallback((key: SurfaceKey, video: HTMLVideoElement, phase: NonNullable<VideoPlayAttempt['lastPlayPhase']>) => {
    const attempt: VideoPlayAttempt = { playAttempts: Math.min(1000000, (playAttemptsRef.current[key]?.playAttempts || 0) + 1), lastPlayPhase: phase, lastPlayResult: 'pending' };
    playAttemptsRef.current[key] = attempt;
    const record = (result: VideoPlayAttempt['lastPlayResult']) => {
      if (playAttemptsRef.current[key] === attempt) attempt.lastPlayResult = result;
    };
    try {
      const original = video.play();
      void Promise.resolve(original).then(() => record('resolved'), (error: unknown) => record(playFailureResult(error)));
      return original;
    } catch (error) { record(playFailureResult(error)); throw error; }
  }, []);

  const firstAudioKey = useMemo(() => {
    const withAudio = project.surfaces.filter((surface) => (focusedSurface ? surface.key === focusedSurface : project.requiredSurfaceKeys.includes(surface.key)) && surface.status === 'ready' && surface.hasAudio);
    return withAudio.find((surface) => surface.key === 'floor')?.key || withAudio[0]?.key || null;
  }, [project.surfaces, project.requiredSurfaceKeys, focusedSurface]);

  const applyAudio = useCallback((element: HTMLVideoElement, key: SurfaceKey) => {
    element.muted = mutedRef.current || (focusedRef.current || audioRef.current) !== key;
    element.volume = volumeRef.current;
  }, []);

  const register = useCallback((key: SurfaceKey, element: HTMLVideoElement | null) => {
    if (element) {
      videos.current[key] = element;
      applyAudio(element, key);
    } else {
      const previous = videos.current[key];
      delete videos.current[key];
      if (previous) {
        previous.pause();
        previous.removeAttribute('src');
        previous.load();
      }
    }
  }, [applyAudio]);

  const align = useCallback((target: number) => {
    for (const key of keysRef.current) {
      const video = videos.current[key];
      if (!video) continue;
      if (video.playbackRate !== 1) video.playbackRate = 1;
      if (video.readyState >= 1 && Math.abs(video.currentTime - target) > 0.015) {
        try { video.currentTime = target; } catch { /* Metadata will trigger another alignment. */ }
      }
    }
  }, []);

  const freeze = useCallback((waiting: boolean, preserveSettling = false) => {
    const wasActive = runningRef.current || startingRef.current;
    runningRef.current = false;
    startingRef.current = false;
    generation.current += 1;
    heldKeys.current.clear();
    resumingKeys.current.clear();
    if (!preserveSettling) settlingRef.current = null;
    if (wasActive) {
      const positions = keysRef.current.map((key) => videos.current[key]?.currentTime).filter((value): value is number => value !== undefined && Number.isFinite(value));
      // Resume from the slowest screen, so a temporary stall never skips content.
      if (positions.length) timeRef.current = clamp(Math.min(...positions), 0, durationRef.current);
    }
    for (const video of Object.values(videos.current)) video?.pause();
    align(timeRef.current);
    setTime(timeRef.current);
    setBuffering(waiting);
  }, [align]);

  const pause = useCallback(() => {
    traceRef.current?.cancel();
    desiredRef.current = false;
    setPlaying(false);
    freeze(false);
  }, [freeze]);

  const fail = useCallback((message: string) => {
    traceRef.current?.failure(message);
    pause();
    setPlaybackError(message);
  }, [pause]);

  const activeFailureMessage = useCallback(() => {
    const key = keysRef.current.find((activeKey) => errorsRef.current.has(activeKey));
    return key ? failuresRef.current[key]?.message || 'Не удалось загрузить часть видео. Нажмите «Повторить».' : null;
  }, []);

  const attemptStart = useCallback(() => {
    if (!desiredRef.current || runningRef.current || startingRef.current || document.hidden || keysRef.current.some((key) => errorsRef.current.has(key))) return;
    const entries = keysRef.current.map((key) => videos.current[key]);
    if (!entries.length || entries.some((video) => !video || video.readyState < 3 || video.seeking)) {
      setBuffering(true);
      return;
    }
    const tracks = entries as HTMLVideoElement[];
    if (tracks.some((video) => Math.abs(video.currentTime - timeRef.current) > 0.04)) {
      align(timeRef.current);
      return;
    }
    if (tracks.some((video) => !hasStartupBuffer(video.buffered, timeRef.current, durationRef.current, video))) {
      setBuffering(true);
      return;
    }
    startingRef.current = true;
    setBuffering(true);
    if (!settlingRef.current) settlingRef.current = { target: timeRef.current, deadline: performance.now() + STARTUP_TIMEOUT_MS };
    const ticket = ++generation.current;
    // Start all elements in the same gesture/event before awaiting any promise.
    const starts = tracks.map((video, index) => {
      try { return Promise.resolve(observedPlay(keysRef.current[index], video, 'start')); } catch (error) { return Promise.reject(error); }
    });
    let timeout = 0;
    const startupTimeout = new Promise<never>((_, reject) => {
      timeout = window.setTimeout(() => reject(new Error('Playback start timed out')), Math.max(1, settlingRef.current!.deadline - performance.now()));
    });
    Promise.race([Promise.all(starts), startupTimeout]).then(() => {
      window.clearTimeout(timeout);
      if (ticket !== generation.current || !desiredRef.current) return;
      startingRef.current = false;
      if (document.hidden) {
        freeze(true);
        return;
      }
      runningRef.current = true;
      // A cold browser may have emitted canplay before its gesture unlock.
      // Successful synchronized playback is also concrete readiness evidence.
      const activeKeys = keysRef.current;
      setReadyKeys((current) => new Set([...current, ...activeKeys]));
      setReviewReadyKeys((current) => new Set([...current, ...activeKeys]));
      // play() may resolve before a decoder's media clock advances. Keep the
      // startup barrier until every track has actually left the target frame.
      setPlaybackError(null);
    }).catch((error: unknown) => {
      window.clearTimeout(timeout);
      if (ticket !== generation.current || !desiredRef.current) return;
      const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
      const failedKey = keysRef.current.find((key) => videos.current[key]?.error);
      if (!blocked && failedKey) { markErrorRef.current(failedKey); return; }
      fail(blocked ? 'Браузер не разрешил воспроизведение. Нажмите «Повторить».' : 'Не удалось запустить все поверхности. Нажмите «Повторить».');
    });
  }, [align, fail, freeze, observedPlay]);
  attemptStartRef.current = attemptStart;

  const prepareActiveTracks = useCallback(() => {
    // preload is only a browser hint. A user-initiated play/pause asks a cold
    // decoder to load even when metadata preloading stops short of canplay.
    // Pause synchronously, before any frame can advance out of synchronization.
    for (const key of keysRef.current) {
      const video = videos.current[key];
      if (!video || !video.getAttribute('src') || video.readyState >= 3 || !video.paused || video.error) continue;
      video.preload = 'auto';
      try {
        const warming = observedPlay(key, video, 'warmup');
        video.pause();
        warming?.catch(() => { /* The synchronized start reports actual failures. */ });
      } catch { /* The synchronized start reports actual failures. */ }
    }
  }, [observedPlay]);

  const syncSource = useCallback((key: SurfaceKey, sourceUrl: string | null) => {
    const video = videos.current[key];
    if (!video || video.getAttribute('src') === sourceUrl) return;
    const active = keysRef.current.includes(key);
    const target = timeRef.current;
    // Access-token rotation changes the URL, not the media or user's choice.
    // Pause before resetting this decoder, so an emptied event cannot turn its
    // temporary zero clock into the new shared timeline.
    if (active) freeze(desiredRef.current);
    if (sourceUrl) video.setAttribute('src', sourceUrl);
    else video.removeAttribute('src');
    video.load();
    if (active) {
      timeRef.current = target;
      setTime(target);
      align(target);
      if (desiredRef.current) prepareActiveTracks();
      attemptStartRef.current();
    }
  }, [freeze, align, prepareActiveTracks]);

  const play = useCallback(() => {
    if (!durationRef.current || !keysRef.current.length) return;
    if (keysRef.current.some((key) => errorsRef.current.has(key))) {
      setPlaybackError(activeFailureMessage());
      traceRef.current?.start('play');
      return;
    }
    if (timeRef.current >= durationRef.current - 0.04) {
      timeRef.current = 0;
      setTime(0);
      align(0);
    }
    prepareActiveTracks();
    desiredRef.current = true;
    setPlaying(true);
    setPlaybackError(null);
    attemptStartRef.current();
    traceRef.current?.start('play');
  }, [align, prepareActiveTracks, activeFailureMessage]);

  const retry = useCallback(() => {
    setPlaybackError(null);
    desiredRef.current = true;
    setPlaying(true);
    setBuffering(true);
    for (const key of keysRef.current) if (errorsRef.current.has(key)) videos.current[key]?.load();
    prepareActiveTracks();
    attemptStartRef.current();
    traceRef.current?.start('retry');
  }, [prepareActiveTracks]);

  const seek = useCallback((value: number) => {
    freeze(desiredRef.current);
    const target = clamp(Number.isFinite(value) ? value : 0, 0, Math.max(0, durationRef.current - 0.03));
    timeRef.current = target;
    setTime(target);
    align(target);
    attemptStartRef.current();
  }, [align, freeze]);

  const markReady = useCallback((key: SurfaceKey) => {
    const video = videos.current[key];
    if (!video || video.readyState < 3 || video.error) return;
    // A restored inactive source initially loads at zero. Align it even while
    // paused, when attemptStart intentionally does nothing.
    if (keysRef.current.includes(key) && !runningRef.current && !startingRef.current
      && !video.seeking && Math.abs(video.currentTime - timeRef.current) > 0.04) {
      try { video.currentTime = timeRef.current; } catch { /* Another metadata event can retry. */ }
      return;
    }
    const recovered = errorsRef.current.delete(key);
    if (recovered) {
      setErrorKeys(new Set(errorsRef.current));
      const nextFailures = { ...failuresRef.current };
      delete nextFailures[key]; failuresRef.current = nextFailures; setMediaFailures(nextFailures);
    }
    setReadyKeys((current) => current.has(key) ? current : new Set(current).add(key));
    setReviewReadyKeys((current) => current.has(key) ? current : new Set(current).add(key));
    if (recovered && !keysRef.current.some((activeKey) => errorsRef.current.has(activeKey))) setPlaybackError(null);
    attemptStartRef.current();
  }, []);

  const markWaiting = useCallback((key: SurfaceKey) => {
    const video = videos.current[key];
    // A network stalled event can occur while enough media remains buffered.
    if (video && !video.seeking && video.readyState >= 3) return;
    setReadyKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (desiredRef.current && keysRef.current.includes(key)) {
      // During startup, pausing a warming decoder can discard the very work
      // needed for its next frame. The barrier holds ready peers in place.
      if (settlingRef.current && (runningRef.current || startingRef.current)) setBuffering(true);
      else freeze(true, true);
    }
  }, [freeze]);

  const markError = useCallback((key: SurfaceKey) => {
    const video = videos.current[key];
    const surface = surfacesRef.current.find((item) => item.key === key);
    if (!video || !surface || shouldIgnoreMediaError(keysRef.current.includes(key), video.hasAttribute('src'), video.error)) return;
    const variant = variantsRef.current[key] || 'primary';
    const diagnostic = mediaFailureDiagnostic(surface, video, keysRef.current, Boolean(focusedRef.current), variant);
    try { onMediaErrorRef.current?.(diagnostic); } catch { /* Diagnostics cannot block playback recovery. */ }
    setReviewReadyKeys((current) => { const next = new Set(current); next.delete(key); return next; });
    setReadyKeys((current) => { const next = new Set(current); next.delete(key); return next; });
    const alternate = canTryCompatibility(video.error?.code, variant) ? losslessCompatibility(surface) : null;
    if (alternate) {
      const active = keysRef.current.includes(key);
      // A failing decoder may already have reset its media clock to zero.
      // Preserve the shared timeline and invalidate any old play() promises.
      const target = timeRef.current;
      if (active) {
        freeze(desiredRef.current);
        timeRef.current = target;
        setTime(target);
      }
      fullVariantsRef.current = { ...fullVariantsRef.current, [key]: 'av1-lossless' };
      setSourceSelection({ signature, variants: fullVariantsRef.current });
      variantsRef.current = { ...variantsRef.current, [key]: 'av1-lossless' };
      sourceUrlsRef.current[key] = alternate.url;
      compatibilityPending.current.add(key);
      errorsRef.current.delete(key);
      setErrorKeys(new Set(errorsRef.current));
      const remaining = { ...failuresRef.current };
      delete remaining[key]; failuresRef.current = remaining; setMediaFailures(remaining);
      if (active) {
        setPlaybackError(activeFailureMessage());
        video.preload = 'auto';
        video.setAttribute('src', alternate.url);
        video.load();
        align(target);
        if (desiredRef.current) prepareActiveTracks();
        attemptStartRef.current();
      }
      return;
    }
    if (variant === 'av1-lossless') compatibilityPending.current.add(key);
    failuresRef.current = { ...failuresRef.current, [key]: diagnostic };
    setMediaFailures(failuresRef.current);
    errorsRef.current.add(key);
    setErrorKeys(new Set(errorsRef.current));
    if (keysRef.current.includes(key)) fail(diagnostic.message);
  }, [signature, fail, freeze, align, prepareActiveTracks, activeFailureMessage]);
  markErrorRef.current = markError;

  const markEnded = useCallback((key?: SurfaceKey) => {
    if (!desiredRef.current || (key && !keysRef.current.includes(key))) return;
    freeze(false);
    if (loopRef.current) {
      timeRef.current = 0;
      setTime(0);
      align(0);
      setBuffering(true);
      attemptStartRef.current();
    } else {
      desiredRef.current = false;
      setPlaying(false);
      timeRef.current = durationRef.current;
      setTime(durationRef.current);
    }
  }, [align, freeze]);

  const markPaused = useCallback((key: SurfaceKey) => {
    if (runningRef.current && desiredRef.current && keysRef.current.includes(key) && !heldKeys.current.has(key) && !resumingKeys.current.has(key) && videos.current[key]?.paused) {
      // An ended element dispatches pause before ended. Let the loop handler run.
      if (keysRef.current.some((activeKey) => videos.current[activeKey]?.ended)) return;
      fail('Браузер приостановил видео. Нажмите «Повторить», чтобы продолжить все поверхности.');
    }
  }, [fail]);

  const reportCompatibilityRecovery = useCallback(() => {
    for (const key of keysRef.current) {
      const video = videos.current[key];
      const surface = surfacesRef.current.find((item) => item.key === key);
      if (!video || !surface || video.error || video.readyState < 3 || variantsRef.current[key] !== 'av1-lossless'
        || !compatibilityPending.current.delete(key)) continue;
      const diagnostic = mediaFailureDiagnostic(surface, video, keysRef.current, Boolean(focusedRef.current), 'av1-lossless', 'recovered');
      try { onMediaErrorRef.current?.(diagnostic); } catch { /* Reporting is best effort. */ }
    }
  }, []);

  const resumeHeld = useCallback((key: SurfaceKey, video: HTMLVideoElement) => {
    if (resumingKeys.current.has(key)) return;
    resumingKeys.current.add(key);
    const ticket = generation.current;
    let start: Promise<void>;
    try { start = Promise.resolve(observedPlay(key, video, 'resume')); } catch (error) { start = Promise.reject(error); }
    start.then(() => {
      if (ticket !== generation.current) return;
      heldKeys.current.delete(key);
      resumingKeys.current.delete(key);
    }).catch(() => {
      if (ticket !== generation.current || !desiredRef.current) return;
      heldKeys.current.delete(key);
      resumingKeys.current.delete(key);
      if (video.error) markErrorRef.current(key);
      else fail('Браузер не разрешил продолжить видео. Нажмите «Повторить».');
    });
  }, [fail, observedPlay]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let lastReport = 0;
    const tick = (now: number) => {
      if (settlingRef.current && now >= settlingRef.current.deadline) {
        fail('Не удалось синхронно запустить видео. Нажмите «Повторить» или откройте один экран.');
        return;
      }
      if (runningRef.current) {
        const entries = keysRef.current.map((key) => videos.current[key]);
        if (entries.some((video) => !video || video.readyState < 3 || video.seeking)) {
          if (settlingRef.current && entries.every((video) => Boolean(video))) {
            const tracks = entries as HTMLVideoElement[];
            const waitingPlan = synchronizationPlan(tracks.map((video) => video.currentTime), keysRef.current.map((key) => heldKeys.current.has(key)), true);
            timeRef.current = waitingPlan.time;
            setBuffering(true);
            for (let index = 0; index < tracks.length; index += 1) {
              const video = tracks[index];
              const key = keysRef.current[index];
              if (waitingPlan.resume[index]) resumeHeld(key, video);
              else if (waitingPlan.hold[index] && video.readyState >= 3 && !video.seeking && !heldKeys.current.has(key)) {
                heldKeys.current.add(key);
                video.pause();
              }
            }
          } else freeze(true, true);
        } else {
          const tracks = entries as HTMLVideoElement[];
          const plan = synchronizationPlan(tracks.map((video) => video.currentTime), keysRef.current.map((key) => heldKeys.current.has(key)), Boolean(settlingRef.current));
          // The slowest decoded clock owns the timeline. Faster tracks wait
          // in place instead of resetting the lagging decoder's startup work.
          const expected = Math.min(durationRef.current, plan.time);
          timeRef.current = expected;
          if (expected >= durationRef.current - 0.015 || tracks.some((video) => video.ended)) {
            markEnded();
          } else {
            for (let index = 0; index < tracks.length; index += 1) {
              const video = tracks[index];
              const key = keysRef.current[index];
              if (plan.hold[index]) {
                heldKeys.current.add(key);
                video.pause();
                if (!settlingRef.current) settlingRef.current = { target: expected, deadline: now + STARTUP_TIMEOUT_MS };
                setBuffering(true);
              } else if (plan.resume[index]) resumeHeld(key, video);
              if (video.playbackRate !== plan.rates[index]) video.playbackRate = plan.rates[index];
            }
            if (settlingRef.current && expected > settlingRef.current.target + 0.1 && plan.aligned
              && !heldKeys.current.size && !resumingKeys.current.size) {
              settlingRef.current = null;
              setBuffering(false);
              reportCompatibilityRecovery();
            }
            if (now - lastReport >= 120) {
              setTime(timeRef.current);
              lastReport = now;
            }
          }
        }
      } else if (!startingRef.current) attemptStartRef.current();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, freeze, markEnded, fail, resumeHeld, reportCompatibilityRecovery]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        traceRef.current?.cancel();
        if (desiredRef.current) freeze(true);
      } else attemptStartRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [freeze]);

  useEffect(() => {
    for (const [key, video] of Object.entries(videos.current)) if (video) applyAudio(video, key as SurfaceKey);
  }, [muted, audioKey, volume, focusedSurface, applyAudio]);

  const setFocusedSurface = useCallback((key: SurfaceKey | null) => {
    const next = key && allKeysRef.current.includes(key) ? key : null;
    if (focusedRef.current === next) return;
    // Capture the clock before releasing inactive decoders. Returning to the
    // room restores those sources and seeks them once to the retained timeline.
    freeze(desiredRef.current);
    focusedRef.current = next;
    keysRef.current = next ? [next] : allKeysRef.current;
    for (const surface of surfacesRef.current) {
      const source = playbackSource(surface, fullVariantsRef.current[surface.key], mobileDevice && !next);
      sourceUrlsRef.current[surface.key] = source.url || undefined;
      variantsRef.current[surface.key] = source.variant;
    }
    // Do this during the user's gesture. Waiting for React to restore src would
    // leave cold tracks unavailable to the gesture's play/pause warmup.
    for (const [activeKey, video] of Object.entries(videos.current)) {
      if (video && !keysRef.current.includes(activeKey as SurfaceKey) && video.hasAttribute('src')) {
        video.removeAttribute('src');
        video.load();
      }
    }
    for (const activeKey of keysRef.current) {
      const video = videos.current[activeKey];
      const source = sourceUrlsRef.current[activeKey];
      if (video && source) {
        video.preload = 'auto';
        const changed = video.getAttribute('src') !== source;
        if (changed) video.setAttribute('src', source);
        if (changed || (next && (video.error || errorsRef.current.has(activeKey)))) {
          // A source that failed with five decoders can succeed after the other
          // four are released. Retry the same file in the user's focus gesture.
          video.load();
          errorsRef.current.delete(activeKey);
          const nextFailures = { ...failuresRef.current };
          delete nextFailures[activeKey]; failuresRef.current = nextFailures; setMediaFailures(nextFailures);
          setErrorKeys(new Set(errorsRef.current));
        }
      }
    }
    setFocusedSurfaceState(next);
    setPlaybackError(activeFailureMessage());
    align(timeRef.current);
    for (const [activeKey, video] of Object.entries(videos.current)) if (video) applyAudio(video, activeKey as SurfaceKey);
    prepareActiveTracks();
    attemptStartRef.current();
  }, [freeze, align, applyAudio, prepareActiveTracks, activeFailureMessage, mobileDevice]);

  const setAudioKey = useCallback((key: SurfaceKey | null) => {
    if (!key || (audioRef.current === key && !mutedRef.current)) {
      setMuted(true);
      setAudioKeyState(null);
    } else {
      setAudioKeyState(key);
      setMuted(false);
    }
  }, []);

  const toggleSound = useCallback(() => {
    if (!mutedRef.current) setMuted(true);
    else {
      const key = focusedRef.current ? firstAudioKey : audioRef.current || firstAudioKey;
      if (key) { setAudioKeyState(key); setMuted(false); }
    }
  }, [firstAudioKey]);

  const setLoop = useCallback((value: boolean) => { loopRef.current = value; setLoopState(value); }, []);
  const setVolume = useCallback((value: number) => setVolumeState(clamp(value, 0, 1)), []);
  const toggle = useCallback(() => { if (desiredRef.current) pause(); else play(); }, [pause, play]);

  useEffect(() => {
    pause();
    focusedRef.current = null;
    keysRef.current = allKeysRef.current;
    setFocusedSurfaceState(null);
    timeRef.current = 0;
    setTime(0);
    errorsRef.current.clear();
    failuresRef.current = {};
    playAttemptsRef.current = {};
    compatibilityPending.current.clear();
    variantsRef.current = {};
    fullVariantsRef.current = {};
    setSourceSelection({ signature, variants: {} });
    setMediaFailures({});
    setReadyKeys(new Set());
    setReviewReadyKeys(new Set());
    setErrorKeys(new Set());
    setPlaybackError(null);
    align(0);
    for (const key of keysRef.current) markReady(key);
    return () => {
      traceRef.current?.cancel();
      desiredRef.current = false;
      runningRef.current = false;
      startingRef.current = false;
      generation.current += 1;
      for (const video of Object.values(videos.current)) video?.pause();
    };
  }, [signature, pause, align, markReady]);

  return { videos, sourceUrls, mobileOverview, syncSource, register, focusedSurface, setFocusedSurface, playing, time, duration, buffering, playbackError, mediaFailures, readyKeys, reviewReadyKeys, errorKeys,
    muted, audioKey, volume, loop, play, pause, retry, toggle, seek, setLoop, toggleSound,
    setAudioKey, setVolume, markReady, markWaiting, markError, markEnded, markPaused, firstAudioKey };
}

export function surfaceList(project: PlayerProject): PlayerSurface[] { return project.surfaces; }
