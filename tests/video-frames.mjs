import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subscribeVideoFrames } from '../src/lib/videoFrames.ts';

function environment() {
  const document = new EventTarget(); document.hidden = false;
  const raf = new Map(); let id = 0;
  globalThis.document = document;
  globalThis.requestAnimationFrame = (callback) => { raf.set(++id, callback); return id; };
  globalThis.cancelAnimationFrame = (ticket) => raf.delete(ticket);
  return { document, raf, step: () => { const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach((callback) => callback(0)); } };
}
function media({ native = true } = {}) {
  const video = new EventTarget();
  video.paused = true; video.ended = false; video.readyState = 3; video.currentTime = 0;
  video.frames = 0;
  video.getVideoPlaybackQuality = () => ({ totalVideoFrames: video.frames });
  const callbacks = new Map(); let id = 0;
  if (native) {
    video.requestVideoFrameCallback = (callback) => { callbacks.set(++id, callback); return id; };
    video.cancelVideoFrameCallback = (ticket) => callbacks.delete(ticket);
  }
  return { video, callbacks, frame: () => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach((callback) => callback()); } };
}

test('multiple canvas views share one decoder-frame callback; paused/hidden subscriptions sleep', () => {
  const { document, raf } = environment();
  const { video, callbacks, frame } = media();
  let first = 0; let second = 0;
  const one = subscribeVideoFrames(video, () => first++);
  const two = subscribeVideoFrames(video, () => second++);
  assert.equal(callbacks.size, 0); assert.equal(raf.size, 0);
  assert.deepEqual([first, second], [1, 1]);
  video.paused = false; video.dispatchEvent(new Event('playing'));
  assert.equal(callbacks.size, 1, 'one scheduled callback for both subscribers');
  frame(); assert.deepEqual([first, second], [3, 3]); assert.equal(callbacks.size, 1);
  document.hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(callbacks.size, 0);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(callbacks.size, 1);
  video.paused = true; video.dispatchEvent(new Event('pause'));
  assert.equal(callbacks.size, 0); assert.equal(raf.size, 0);
  const before = first;
  video.dispatchEvent(new Event('seeked'));
  assert.equal(first, before + 1, 'paused seeks refresh their frame once');
  one(); two();
  video.paused = false; video.dispatchEvent(new Event('playing'));
  assert.equal(callbacks.size, 0, 'unmount removes playback listeners');
});

test('fallback checks decoded-frame counters without redrawing duplicates or running while paused', () => {
  const { raf, step } = environment();
  const { video } = media({ native: false });
  let draws = 0;
  const unsubscribe = subscribeVideoFrames(video, () => draws++);
  assert.equal(raf.size, 0);
  video.paused = false; video.dispatchEvent(new Event('playing'));
  video.frames = 1; step();
  const decoded = draws;
  video.currentTime += 0.01; step();
  assert.equal(draws, decoded, 'changing clock without a decoded frame does not upload');
  video.frames += 1; step();
  assert.equal(draws, decoded + 1);
  video.paused = true; video.dispatchEvent(new Event('pause'));
  assert.equal(raf.size, 0);
  unsubscribe();
});
