// Recent playback errors stay on this server in memory, never in the project
// database. Accept only media state, not arbitrary client data or source URLs.
const recent = new Map();
const TTL = 30 * 60 * 1000;
let expirationTimer;
function expireDiagnostics(now = Date.now()) {
  clearTimeout(expirationTimer);
  let nextExpiry = Infinity;
  for (const [id, events] of recent) {
    const alive = events.filter(item => now - Date.parse(item.at) < TTL);
    if (alive.length) {
      recent.set(id, alive);
      nextExpiry = Math.min(nextExpiry, ...alive.map(item => Date.parse(item.at) + TTL));
    } else recent.delete(id);
  }
  if (Number.isFinite(nextExpiry)) {
    expirationTimer = setTimeout(() => expireDiagnostics(), Math.max(1, nextExpiry - now));
    expirationTimer.unref();
  }
}
const keys = new Set(['right', 'back', 'left', 'center', 'floor']);
const integer = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum ? value : 0;
const number = (value, maximum, minimum = 0) => Number.isFinite(value) && value >= minimum && value <= maximum ? Math.round(value * 1000) / 1000 : 0;
const keyList = value => [...new Set(Array.isArray(value) ? value.filter(key => keys.has(key)) : [])].slice(0, 5);
const snapshotReasons = new Set(['play', 'retry', 'after-2s', 'after-5s', 'after-10s', 'after-20s', 'failure']);
const mediaVariant = value => ['av1-lossless', 'mobile'].includes(value) ? value : 'primary';
function sanitizeSnapshot(value) {
  if (!value || typeof value !== 'object' || !snapshotReasons.has(value.reason)) return undefined;
  const controller = value.controller || {};
  return {
    reason: value.reason, elapsedMs: number(value.elapsedMs, 3600000),
    visibilityState: value.visibilityState === 'hidden' ? 'hidden' : 'visible',
    userActivation: { isActive: typeof value.userActivation?.isActive === 'boolean' ? value.userActivation.isActive : null,
      hasBeenActive: typeof value.userActivation?.hasBeenActive === 'boolean' ? value.userActivation.hasBeenActive : null },
    controller: { desired: controller.desired === true, running: controller.running === true,
      starting: controller.starting === true, time: number(controller.time, 604800),
      heldKeys: keyList(controller.heldKeys), resumingKeys: keyList(controller.resumingKeys),
      settling: controller.settling ? { target: number(controller.settling.target, 604800), remainingMs: number(controller.settling.remainingMs, 60000) } : null },
    videos: (Array.isArray(value.videos) ? value.videos : []).filter(video => video && keys.has(video.surfaceKey)).slice(0, 5).map(video => ({
      surfaceKey: video.surfaceKey, currentTime: number(video.currentTime, 604800), readyState: integer(video.readyState, 4), networkState: integer(video.networkState, 3),
      paused: video.paused === true, seeking: video.seeking === true, playbackRate: number(video.playbackRate, 16), hasSource: video.hasSource === true,
      muted: video.muted === true, playsInline: video.playsInline === true, ended: video.ended === true,
      playAttempts: integer(video.playAttempts, 1e6),
      lastPlayPhase: ['warmup', 'start', 'resume'].includes(video.lastPlayPhase) ? video.lastPlayPhase : 'none',
      lastPlayResult: ['pending', 'resolved', 'AbortError', 'NotAllowedError', 'NotSupportedError', 'other'].includes(video.lastPlayResult) ? video.lastPlayResult : 'none',
      visibility: video.visibility ? { display: video.visibility.display === 'none' ? 'none' : 'other',
        visibility: ['visible', 'hidden'].includes(video.visibility.visibility) ? video.visibility.visibility : 'other',
        opacity: number(video.visibility.opacity, 1), width: number(video.visibility.width, 65536), height: number(video.visibility.height, 65536),
        x: number(video.visibility.x, 65536, -65536), y: number(video.visibility.y, 65536, -65536) } : null,
      variant: mediaVariant(video.variant),
      buffered: (Array.isArray(video.buffered) ? video.buffered : []).slice(0, 3)
        .filter(range => Array.isArray(range) && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] >= 0 && range[1] >= range[0] && range[1] <= 604800)
        .map(range => [number(range[0], 604800), number(range[1], 604800)]),
    })),
  };
}
export function recordPlaybackDiagnostic(projectId, body, now = Date.now()) {
  if (!body || !keys.has(body.surfaceKey)) return false;
  const browserMessage = typeof body.browserMessage === 'string'
    ? body.browserMessage.replace(/(?:https?:|blob:|data:|\/api\/)\S+/gi, '[адрес скрыт]')
      .replace(/\b(mt|token|password|authorization)=[^\s&]+/gi, '$1=[скрыто]')
      .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240) : '';
  const event = {
    at: new Date(now).toISOString(), contentRevision: integer(body.contentRevision, 1e9),
    videoSceneId: typeof body.videoSceneId === 'string' && /^[a-z0-9_-]{1,64}$/i.test(body.videoSceneId) ? body.videoSceneId : 'main',
    event: ['recovered', 'snapshot'].includes(body.event) ? body.event : 'error',
    build: typeof body.build === 'string' && /^index-[a-zA-Z0-9_-]{1,80}\.js$/.test(body.build) ? body.build : 'unknown',
    variant: mediaVariant(body.variant),
    surfaceKey: body.surfaceKey, code: integer(body.code, 4), browserMessage,
    width: integer(body.width, 65536), height: integer(body.height, 65536),
    readyState: integer(body.readyState, 4), networkState: integer(body.networkState, 3),
    mode: body.mode === 'single' ? 'single' : 'group',
    activeSurfaceKeys: keyList(body.activeSurfaceKeys),
    ...(body.event === 'snapshot' ? { snapshot: sanitizeSnapshot(body.snapshot) } : {}),
  };
  for (const [id, events] of recent) {
    const alive = events.filter(item => now - Date.parse(item.at) < TTL);
    if (alive.length) recent.set(id, alive); else recent.delete(id);
  }
  if (!recent.has(projectId) && recent.size >= 100) recent.delete(recent.keys().next().value);
  recent.set(projectId, [...(recent.get(projectId) || []), event].slice(-30));
  expireDiagnostics(now);
  return true;
}
export function playbackDiagnostics(projectId, now = Date.now()) {
  return (recent.get(projectId) || []).filter(item => now - Date.parse(item.at) < TTL);
}
