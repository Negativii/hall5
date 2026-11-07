/** Coalesce scene changes and decoded video frames into one display frame. */
export function createDemandRenderer(options: {
  request: (callback: (now: number) => void) => number;
  cancel: (id: number) => void;
  step: (now: number) => boolean;
  render: (now: number) => void;
}) {
  let frame: number | null = null;
  let dirty = false;
  let suspended = false;
  let ticking = false;
  let disposed = false;
  const schedule = () => {
    if (!disposed && !suspended && !ticking && frame === null) frame = options.request(tick);
  };
  const tick = (now: number) => {
    frame = null;
    if (disposed || suspended) return;
    ticking = true;
    const continuous = options.step(now);
    if (dirty && !disposed && !suspended) {
      dirty = false;
      options.render(now);
    }
    ticking = false;
    if (dirty || continuous) schedule();
  };
  return {
    invalidate() { dirty = true; schedule(); },
    suspend(value: boolean) {
      if (value === suspended || disposed) return;
      suspended = value;
      if (frame !== null) options.cancel(frame);
      frame = null;
      if (!value) { dirty = true; schedule(); }
    },
    dispose() {
      disposed = true;
      if (frame !== null) options.cancel(frame);
      frame = null;
    },
  };
}

/** Old browsers lack rVFC; frame counters still avoid re-uploading duplicate frames. */
export function decodedFrameToken(video: HTMLVideoElement): number {
  if (typeof video.getVideoPlaybackQuality === 'function') return video.getVideoPlaybackQuality().totalVideoFrames;
  const legacy = video as HTMLVideoElement & { webkitDecodedFrameCount?: number };
  if (typeof legacy.webkitDecodedFrameCount === 'number') return legacy.webkitDecodedFrameCount;
  return video.currentTime;
}
