import type { PlayerSurface, SurfaceKey } from './types';
import type { PlaybackVariant } from './mediaCompatibility';
import type { PlaybackSnapshot } from './playbackSnapshot';

export interface MediaFailureDiagnostic {
  event: 'error' | 'recovered' | 'snapshot';
  snapshot?: PlaybackSnapshot;
  variant: PlaybackVariant;
  surfaceKey: SurfaceKey;
  surfaceName: string;
  code: number;
  category: 'aborted' | 'network' | 'decode' | 'unsupported' | 'unknown';
  message: string;
  browserMessage: string;
  width: number;
  height: number;
  readyState: number;
  networkState: number;
  activeSurfaceKeys: SurfaceKey[];
  mode: 'single' | 'group';
}

type ErrorLike = { code: number; message?: string } | null;
type VideoState = { error: ErrorLike; videoWidth: number; videoHeight: number; readyState: number; networkState: number };
type SurfaceInfo = Pick<PlayerSurface, 'key' | 'name' | 'width' | 'height' | 'previewWidth' | 'previewHeight' | 'mobilePreview'>;

export function shouldIgnoreMediaError(_active: boolean, _hasSource: boolean, error: ErrorLike): boolean {
  // A queued event from the old source can arrive after load() cleared its
  // MediaError, including while an alternate is active. Only native error state
  // is evidence that the current source failed or review readiness was lost.
  return !error;
}

export function mediaFailureDiagnostic(surface: SurfaceInfo, video: VideoState, activeSurfaceKeys: SurfaceKey[], focused: boolean, variant: PlaybackVariant = 'primary', event: 'error' | 'recovered' = 'error'): MediaFailureDiagnostic {
  const code = event === 'error' && [1, 2, 3, 4].includes(video.error?.code || 0) ? video.error!.code : 0;
  const category = ({ 1: 'aborted', 2: 'network', 3: 'decode', 4: 'unsupported' } as const)[code as 1 | 2 | 3 | 4] || 'unknown';
  const width = video.videoWidth || (variant === 'mobile' ? surface.mobilePreview?.width : 0) || surface.previewWidth || surface.width || 0;
  const height = video.videoHeight || (variant === 'mobile' ? surface.mobilePreview?.height : 0) || surface.previewHeight || surface.height || 0;
  const label = `${surface.name}${width && height ? ` (${width} × ${height})` : ''}`;
  const reason = {
    aborted: 'загрузка прервана. Нажмите «Повторить».',
    network: 'браузер не смог получить данные видео. Проверьте соединение и нажмите «Повторить».',
    decode: 'браузер не смог декодировать видео. Попробуйте открыть эту поверхность в режиме «Один экран».',
    unsupported: 'браузер не распознал или не поддерживает этот видеоисточник. Попробуйте открыть эту поверхность отдельно.',
    unknown: 'браузер сообщил об ошибке видео без указания причины. Нажмите «Повторить».',
  }[category];
  // Browser messages can contain a signed media URL. Diagnostics never include
  // source URLs, access tokens, cookies or arbitrary unbounded browser text.
  const browserMessage = String(video.error?.message || '')
    .replace(/(?:https?:|blob:|data:)\S+/gi, '[URL]')
    .replace(/\b(mt|token|password|authorization)=[^\s&]+/gi, '$1=[скрыто]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 240);
  return {
    event, variant,
    surfaceKey: surface.key, surfaceName: surface.name, code, category,
    message: event === 'recovered' ? `${label}: совместимое видео загружено без изменения качества.` : `${label}: ${reason}${code ? ` Код видео: ${code}.` : ''}`,
    browserMessage, width, height, readyState: video.readyState, networkState: video.networkState,
    activeSurfaceKeys: [...activeSurfaceKeys], mode: focused ? 'single' : 'group',
  };
}
