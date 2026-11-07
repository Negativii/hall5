/** Share a decoded-frame subscription between views of the same video. */
type Listener = () => void;
type Subscription = { listeners: Set<Listener>; dispose: () => void };
const subscriptions = new WeakMap<HTMLVideoElement, Subscription>();

export function subscribeVideoFrames(video: HTMLVideoElement, listener: Listener): () => void {
  let subscription = subscriptions.get(video);
  if (!subscription) {
    const listeners = new Set<Listener>();
    let callback = 0;
    let animation = 0;
    let disposed = false;
    let lastToken = '';
    const nativeFrames = typeof video.requestVideoFrameCallback === 'function';
    const emit = () => { for (const fn of listeners) fn(); };
    const cancel = () => {
      if (callback) video.cancelVideoFrameCallback(callback);
      if (animation) cancelAnimationFrame(animation);
      callback = animation = 0;
    };
    const running = () => !disposed && !document.hidden && !video.paused && !video.ended;
    const schedule = () => {
      if (!running() || callback || animation) return;
      if (nativeFrames) {
        callback = video.requestVideoFrameCallback(() => {
          callback = 0;
          if (!document.hidden && !disposed) emit();
          schedule();
        });
      } else {
        animation = requestAnimationFrame(() => {
          animation = 0;
          if (!running()) return;
          const quality = video.getVideoPlaybackQuality?.();
          const token = quality && quality.totalVideoFrames > 0
            ? `f:${quality.totalVideoFrames}` : `t:${video.currentTime}`;
          if (token !== lastToken && video.readyState >= 2) { lastToken = token; emit(); }
          schedule();
        });
      }
    };
    const refresh = () => {
      if (!document.hidden && !disposed) emit();
      if (!running()) cancel();
      else schedule();
    };
    const events = ['playing', 'play', 'pause', 'ended', 'seeked', 'loadeddata', 'canplay', 'resize'];
    for (const event of events) video.addEventListener(event, refresh);
    document.addEventListener('visibilitychange', refresh);
    subscription = { listeners, dispose: () => {
      disposed = true;
      cancel();
      for (const event of events) video.removeEventListener(event, refresh);
      document.removeEventListener('visibilitychange', refresh);
      subscriptions.delete(video);
    } };
    subscriptions.set(video, subscription);
    schedule();
  }
  subscription.listeners.add(listener);
  if (!document.hidden) listener();
  return () => {
    subscription.listeners.delete(listener);
    if (!subscription.listeners.size) subscription.dispose();
  };
}
