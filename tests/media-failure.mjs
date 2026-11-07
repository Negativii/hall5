import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaFailureDiagnostic, shouldIgnoreMediaError } from '../src/lib/mediaFailure.ts';
import { canTryCompatibility, losslessCompatibility, mediaSourceIdentity } from '../src/lib/mediaCompatibility.ts';

const floor = { key: 'floor', name: 'Пол', width: 4800, height: 2400, previewWidth: 4800, previewHeight: 2400 };
const video = { error: null, videoWidth: 0, videoHeight: 0, readyState: 0, networkState: 3 };

test('media failures distinguish aborted, network, decode and unsupported source without inventing a hardware cause', () => {
  for (const [code, category] of [[1, 'aborted'], [2, 'network'], [3, 'decode'], [4, 'unsupported']]) {
    const diagnostic = mediaFailureDiagnostic(floor, { ...video, error: { code, message: 'AVFoundationErrorDomain -11800' } }, ['right', 'floor'], false);
    assert.equal(diagnostic.category, category);
    assert.equal(diagnostic.code, code);
    assert.match(diagnostic.message, /Пол \(4800 × 2400\)/);
    assert.match(diagnostic.message, new RegExp(`Код видео: ${code}`));
    assert.doesNotMatch(diagnostic.message, /не хватает памяти|лимит декодеров|слишком слаб/);
    assert.equal(diagnostic.browserMessage, 'AVFoundationErrorDomain -11800');
    assert.deepEqual(diagnostic.activeSurfaceKeys, ['right', 'floor']);
    assert.equal(diagnostic.mode, 'group');
    assert.equal(diagnostic.variant, 'primary');
    assert.equal(diagnostic.event, 'error');
  }
});

test('lossless fallback requires matching dimensions/fps and only handles native decode/source errors once', () => {
  const compatibilityPreview = { url: '/same-pixels.mp4', codec: 'av1', mimeType: 'video/mp4; codecs="av01.0.16M.08"', mode: 'lossless', width: 4800, height: 2400, fps: 24 };
  const surface = { ...floor, fps: 24, previewFps: 24, compatibilityPreview };
  assert.deepEqual(losslessCompatibility(surface), compatibilityPreview);
  for (const patch of [{ width: 2400 }, { height: 1200 }, { fps: 12 }, { fps: NaN }, { mode: 'converted' }, { codec: 'h264' }, { url: '' }]) {
    assert.equal(losslessCompatibility({ ...surface, compatibilityPreview: { ...compatibilityPreview, ...patch } }), null);
  }
  for (const code of [undefined, 0, 1, 2]) assert.equal(canTryCompatibility(code, 'primary'), false);
  for (const code of [3, 4]) {
    assert.equal(canTryCompatibility(code, 'primary'), true);
    assert.equal(canTryCompatibility(code, 'av1-lossless'), false);
  }
});

test('alternate errors and actual recovery identify the variant separately', () => {
  const failed = mediaFailureDiagnostic(floor, { ...video, error: { code: 4 } }, ['floor'], true, 'av1-lossless');
  assert.equal(failed.variant, 'av1-lossless');
  assert.equal(failed.event, 'error');
  assert.equal(failed.code, 4);
  const recovered = mediaFailureDiagnostic(floor, { ...video, readyState: 3, videoWidth: 4800, videoHeight: 2400 }, ['floor'], true, 'av1-lossless', 'recovered');
  assert.equal(recovered.variant, 'av1-lossless');
  assert.equal(recovered.event, 'recovered');
  assert.equal(recovered.code, 0);
  assert.doesNotMatch(recovered.message, /ошибк|Код видео/);
});

test('source identity excludes access-token rotation and retains actual file version', () => {
  assert.equal(mediaSourceIdentity('/floor.mp4?mt=expired&v=1'), mediaSourceIdentity('/floor.mp4?mt=fresh&v=1'));
  assert.notEqual(mediaSourceIdentity('/floor.mp4?mt=fresh&v=1'), mediaSourceIdentity('/floor.mp4?mt=fresh&v=2'));
  assert.notEqual(mediaSourceIdentity('/floor.mp4?v=1'), mediaSourceIdentity('/different.mp4?v=1'));
});

test('diagnostics use decoded dimensions and omit signed URLs, tokens and unbounded browser messages', () => {
  const diagnostic = mediaFailureDiagnostic(floor, { ...video, videoWidth: 2400, videoHeight: 1200,
    error: { code: 3, message: 'Failed https://local.invalid/video?mt=secret.token token=also-secret\n' + 'x'.repeat(300) } }, ['floor'], true);
  assert.equal(diagnostic.width, 2400);
  assert.equal(diagnostic.height, 1200);
  assert.equal(diagnostic.mode, 'single');
  assert.ok(diagnostic.browserMessage.length <= 240);
  assert.doesNotMatch(diagnostic.browserMessage, /secret|https:|\n/);
  assert.ok(!Object.keys(diagnostic).some(key => /url|cookie|token/i.test(key)));
});

test('queued error events without native MediaError are ignored after source release or replacement', () => {
  assert.equal(shouldIgnoreMediaError(false, false, null), true);
  assert.equal(shouldIgnoreMediaError(false, false, { code: 3 }), false);
  assert.equal(shouldIgnoreMediaError(false, true, null), true);
  assert.equal(shouldIgnoreMediaError(true, false, null), true);
  assert.equal(shouldIgnoreMediaError(true, true, null), true);
  const diagnostic = mediaFailureDiagnostic(floor, video, ['floor'], true);
  assert.equal(diagnostic.category, 'unknown');
  assert.equal(diagnostic.code, 0);
  assert.match(diagnostic.message, /без указания причины/);
});
