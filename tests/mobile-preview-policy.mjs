import test from 'node:test';
import assert from 'node:assert/strict';
import { prefersMobilePreview, mobileCompatibility, playbackSource, canTryCompatibility } from '../src/lib/mediaCompatibility.ts';
import { mediaFailureDiagnostic } from '../src/lib/mediaFailure.ts';

const desktop = { userAgent: 'Mozilla Macintosh', coarsePointer: false, screenWidth: 1440, screenHeight: 900, maxTouchPoints: 0 };
const surface = { key: 'floor', name: 'Пол', previewUrl: '/full', width: 4800, height: 2400, previewWidth: 4800, previewHeight: 2400, fps: 24, previewFps: 24,
  compatibilityPreview: { url: '/lossless', codec: 'av1', mode: 'lossless', width: 4800, height: 2400, fps: 24 },
  mobilePreview: { url: '/mobile', codec: 'h264', mimeType: 'video/mp4', mode: 'mobile', width: 1920, height: 960, fps: 24 } };

test('mobile overview detection includes phones/tablets and leaves normal desktop screens alone', () => {
  assert.equal(prefersMobilePreview(desktop), false);
  assert.equal(prefersMobilePreview({ ...desktop, screenWidth: 430, screenHeight: 932 }), false);
  assert.equal(prefersMobilePreview({ ...desktop, userAgent: 'iPhone Safari' }), true);
  assert.equal(prefersMobilePreview({ ...desktop, userAgent: 'Android Chrome' }), true);
  assert.equal(prefersMobilePreview({ ...desktop, maxTouchPoints: 5 }), true);
  assert.equal(prefersMobilePreview({ ...desktop, userAgent: 'Tablet', coarsePointer: true, screenWidth: 1024, screenHeight: 1366 }), true);
});

test('mobile overview and full single source retain independent choices', () => {
  assert.deepEqual(playbackSource(surface, undefined, true), { url: '/mobile', variant: 'mobile' });
  assert.deepEqual(playbackSource(surface, undefined, false), { url: '/full', variant: 'primary' });
  assert.deepEqual(playbackSource(surface, 'av1-lossless', false), { url: '/lossless', variant: 'av1-lossless' });
  assert.deepEqual(playbackSource(surface, 'av1-lossless', true), { url: '/mobile', variant: 'mobile' });
  assert.deepEqual(playbackSource({ ...surface, mobilePreview: null }, 'av1-lossless', true), { url: '/lossless', variant: 'av1-lossless' });
  assert.equal(canTryCompatibility(4, 'mobile'), false, 'mobile failure never silently downloads full-quality AV1');
});

test('mobile metadata cannot increase size or lower fps and diagnostics show selected dimensions', () => {
  assert.ok(mobileCompatibility(surface));
  for (const patch of [{ width: Infinity }, { height: NaN }, { width: 2400 }, { height: 1200 }, { fps: 12 }, { fps: Infinity }]) {
    assert.equal(mobileCompatibility({ ...surface, mobilePreview: { ...surface.mobilePreview, ...patch } }), null);
  }
  const diagnostic = mediaFailureDiagnostic(surface, { videoWidth: 0, videoHeight: 0, readyState: 0, networkState: 3, error: { code: 4 } }, ['floor'], false, 'mobile');
  assert.equal(diagnostic.variant, 'mobile');
  assert.equal(diagnostic.width, 1920); assert.equal(diagnostic.height, 960);
});
