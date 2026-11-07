import type { CompatibilityPreview, MobilePreview, PlayerSurface } from './types';

export type PlaybackVariant = 'primary' | 'av1-lossless' | 'mobile';
export type FullQualityVariant = Exclude<PlaybackVariant, 'mobile'>;

export function prefersMobilePreview({ userAgent, coarsePointer, screenWidth, screenHeight, maxTouchPoints }: {
  userAgent: string; coarsePointer: boolean; screenWidth: number; screenHeight: number; maxTouchPoints: number;
}): boolean {
  return /Android|iPhone|iPad|iPod/i.test(userAgent)
    || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)
    || (coarsePointer && Math.min(screenWidth, screenHeight) <= 1100 && Math.max(screenWidth, screenHeight) <= 1600);
}

export function mobileCompatibility(surface: Pick<PlayerSurface, 'mobilePreview' | 'width' | 'height' | 'fps' | 'previewWidth' | 'previewHeight' | 'previewFps'>): MobilePreview | null {
  const mobile = surface.mobilePreview;
  const width = surface.previewWidth || surface.width;
  const height = surface.previewHeight || surface.height;
  const fps = surface.previewFps || surface.fps;
  return mobile?.url && mobile.codec === 'h264' && mobile.mode === 'mobile'
    && Number.isFinite(mobile.width) && Number.isFinite(mobile.height) && Number.isFinite(mobile.fps)
    && mobile.width > 0 && mobile.width <= Math.min(1920, width)
    && mobile.height > 0 && mobile.height <= Math.min(1080, height)
    && fps > 0 && Math.abs(mobile.fps - fps) <= 0.001 ? mobile : null;
}

export function playbackSource(surface: PlayerSurface, fullVariant: FullQualityVariant | undefined, mobileOverview: boolean): { url: string | null; variant: PlaybackVariant } {
  const mobile = mobileOverview ? mobileCompatibility(surface) : null;
  if (mobile) return { url: mobile.url, variant: 'mobile' };
  const compatible = fullVariant === 'av1-lossless' ? losslessCompatibility(surface) : null;
  return compatible ? { url: compatible.url, variant: 'av1-lossless' } : { url: surface.previewUrl, variant: 'primary' };
}

export function mediaSourceIdentity(value: string | null | undefined): string {
  if (!value) return '';
  const url = new URL(value, 'https://hall.invalid');
  url.searchParams.delete('mt');
  return url.origin + url.pathname + url.search;
}

// The server only publishes pixel-verified variants. Reject an inconsistent
// manifest too: compatibility must never silently reduce resolution or fps.
export function losslessCompatibility(surface: Pick<PlayerSurface, 'compatibilityPreview' | 'width' | 'height' | 'fps' | 'previewWidth' | 'previewHeight' | 'previewFps'>): CompatibilityPreview | null {
  const alternate = surface.compatibilityPreview;
  const width = surface.previewWidth || surface.width;
  const height = surface.previewHeight || surface.height;
  const fps = surface.previewFps || surface.fps;
  if (!alternate?.url || alternate.codec !== 'av1' || alternate.mode !== 'lossless'
    || !(width > 0) || !(height > 0) || !(fps > 0)
    || alternate.width !== width || alternate.height !== height
    || !Number.isFinite(alternate.fps) || Math.abs(alternate.fps - fps) > 0.001) return null;
  return alternate;
}

export function canTryCompatibility(code: number | undefined, variant: PlaybackVariant): boolean {
  return variant === 'primary' && (code === 3 || code === 4);
}
