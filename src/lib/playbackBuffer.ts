const START_BUFFER_SECONDS = 0.75;
const SEEK_TOLERANCE_SECONDS = 0.025;

/** Browser readiness can start the bounded decoder barrier, even on one frame. */
export function hasStartupBuffer(buffered: TimeRanges, target: number, duration: number,
  { readyState = 0 }: { readyState?: number; networkState?: number } = {}): boolean {
  // Safari may report NETWORK_LOADING while waiting for play() to request the
  // next bytes. HAVE_FUTURE_DATA is enough to begin: the synchronization barrier
  // holds ready peers during decoder warmup instead of rewinding the group.
  if (readyState >= 3) return true;
  if (readyState > 0) return false;
  const needed = Math.min(START_BUFFER_SECONDS, Math.max(0, duration - target - SEEK_TOLERANCE_SECONDS));
  if (needed <= 0) return true;
  for (let index = 0; index < buffered.length; index += 1) {
    if (buffered.start(index) <= target + SEEK_TOLERANCE_SECONDS
      && buffered.end(index) >= target + needed) return true;
  }
  return false;
}
