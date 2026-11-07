import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePlaybackVideos, createStartupTrace, diagnosticBuild, playFailureResult } from '../src/lib/playbackSnapshot.ts';

function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  const events = [];
  const trace = createStartupTrace({ now: () => time, schedule: (callback, delay) => { const key = ++id; timers.set(key, { callback, at: time + delay }); return key; },
    clear: (key) => timers.delete(key), emit: (reason, elapsedMs, message) => events.push({ reason, elapsedMs, message }) });
  return { trace, timers, events, advance(target) {
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]); time = next[1].at; next[1].callback();
    }
    time = target;
  } };
}

test('one attempt emits five bounded snapshots and at most one failure without idle timers', () => {
  const run = clock();
  run.trace.start('play');
  assert.equal(run.timers.size, 4);
  run.advance(21000);
  assert.deepEqual(run.events.map(({ reason, elapsedMs }) => [reason, elapsedMs]), [
    ['play', 0], ['after-2s', 2000], ['after-5s', 5000], ['after-10s', 10000], ['after-20s', 20000],
  ]);
  assert.equal(run.timers.size, 0);
  run.trace.failure('bounded failure'); run.trace.failure('duplicate'); run.advance(100000);
  assert.equal(run.events.length, 6);
  assert.equal(run.timers.size, 0);
});

test('pause/background/unmount cancellation and fresh retries leave no stale scheduled work', () => {
  const run = clock();
  run.trace.start('play'); run.advance(1000); run.trace.cancel(); run.advance(25000);
  assert.equal(run.events.length, 1);
  assert.equal(run.timers.size, 0);
  run.trace.start('retry'); run.advance(26000); run.trace.start('play'); run.advance(28000);
  assert.deepEqual(run.events.map((event) => event.reason), ['play', 'retry', 'play', 'after-2s']);
  run.trace.cancel(); assert.equal(run.timers.size, 0);
});

test('video snapshots cap tracks/ranges and never copy source URLs or unbounded native properties', () => {
  const video = { currentTime: NaN, readyState: 2, networkState: 2, paused: true, seeking: false, playbackRate: 1,
    muted: true, playsInline: true, ended: false,
    src: 'https://private.example/video?mt=secret', error: { message: 'secret' }, hasAttribute: (name) => name === 'src',
    buffered: { length: 100, start: (index) => index, end: (index) => index + 0.04 } };
  const result = capturePlaybackVideos(Array.from({ length: 9 }, () => ({ surfaceKey: 'floor', video, variant: 'av1-lossless' })));
  assert.equal(result.length, 5);
  assert.equal(result[0].buffered.length, 3);
  assert.equal(result[0].currentTime, 0);
  assert.equal(result[0].hasSource, true);
  assert.equal(result[0].muted, true); assert.equal(result[0].playsInline, true); assert.equal(result[0].ended, false);
  assert.equal(result[0].playAttempts, 0); assert.equal(result[0].lastPlayResult, null);
  assert.doesNotMatch(JSON.stringify(result), /https|secret|private|mt=/);
  assert.equal(diagnosticBuild(['https://private.example/assets/index-build123.js?mt=secret']), 'index-build123.js');
  assert.equal(diagnosticBuild([]), 'unknown');
  assert.equal(playFailureResult({ name: 'AbortError', message: 'private media URL' }), 'AbortError');
  assert.equal(playFailureResult({ name: 'NotAllowedError' }), 'NotAllowedError');
  assert.equal(playFailureResult({ name: 'secret error URL', message: 'private media URL' }), 'other');
});
