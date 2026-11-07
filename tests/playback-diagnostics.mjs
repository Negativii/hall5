import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPlaybackDiagnostic, playbackDiagnostics } from '../server/playbackDiagnostics.js';
test('diagnostics keep bounded media state, redact URLs and expire without writing project data', () => {
  const now = Date.now();
  assert.equal(recordPlaybackDiagnostic('diag-test', { surfaceKey: 'bad' }, now), false);
  for (let i = 0; i < 40; i++) recordPlaybackDiagnostic('diag-test', {
    surfaceKey:'floor', code:3, width:4800, height:2400, readyState:0, networkState:3,
    activeSurfaceKeys:['floor','bad','floor'], mode:'single', contentRevision:11,
    browserMessage:'decode https://example.test/private?token=secret blob:secret data:secret token=secret failed', arbitrary:'secret',
  }, now);
  const reports = playbackDiagnostics('diag-test', now);
  assert.equal(reports.length,30); assert.equal(reports[0].code,3);
  assert.deepEqual(reports[0].activeSurfaceKeys,['floor']);
  assert.ok(!JSON.stringify(reports).includes('secret'));
  assert.deepEqual(playbackDiagnostics('diag-test', now + 31 * 60 * 1000), []);
});
test('diagnostics identify a recovered lossless variant with bounded event names', () => {
  const now = Date.now();
  recordPlaybackDiagnostic('diag-recovered', { surfaceKey: 'floor', event: 'recovered', variant: 'av1-lossless', code: 0 }, now);
  recordPlaybackDiagnostic('diag-recovered', { surfaceKey: 'floor', event: 'arbitrary', variant: 'untrusted' }, now);
  recordPlaybackDiagnostic('diag-recovered', { surfaceKey: 'floor', event: 'snapshot', variant: 'mobile',
    videoSceneId: 'intro',
    snapshot: { reason: 'after-2s', videos: [{ surfaceKey: 'floor', variant: 'mobile' }] } }, now);
  const reports = playbackDiagnostics('diag-recovered', now);
  assert.deepEqual(reports.map(({event, variant, code}) => ({event, variant, code})), [
    {event: 'recovered', variant: 'av1-lossless', code: 0},
    {event: 'error', variant: 'primary', code: 0},
    {event: 'snapshot', variant: 'mobile', code: 0},
  ]);
  assert.equal(reports[2].snapshot.videos[0].variant, 'mobile');
  assert.equal(reports[2].videoSceneId, 'intro');
  assert.equal(reports[0].videoSceneId, 'main');
});
test('startup snapshots retain bounded media state and build identity without arbitrary data', () => {
  const now = Date.now();
  recordPlaybackDiagnostic('diag-snapshot', { surfaceKey: 'floor', event: 'snapshot', build: 'index-TEST.js',
    snapshot: { reason: 'after-5s', elapsedMs: 5000, arbitrary: 'secret', controller: { desired: true, running: false, time: 0, heldKeys: ['floor','bad'] },
      videos: Array.from({ length: 20 }, () => ({ surfaceKey: 'floor', currentTime: 0.041666, readyState: 2, networkState: 2, paused: true,
        src: 'https://example.test/?token=secret', buffered: [[0, 0.04], [-1, 2], [0, 999999]] })) } }, now);
  const [report] = playbackDiagnostics('diag-snapshot', now);
  assert.equal(report.build, 'index-TEST.js');
  assert.equal(report.snapshot.videos.length, 5);
  assert.deepEqual(report.snapshot.videos[0].buffered, [[0, 0.04]]);
  assert.deepEqual(report.snapshot.controller.heldKeys, ['floor']);
  assert.equal(report.snapshot.videos[0].currentTime, 0.042);
  assert.ok(!JSON.stringify(report).includes('secret'));
});
