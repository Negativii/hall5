import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemandRenderer, decodedFrameToken } from '../src/lib/demandRender.ts';
import { FrameVideoTexture } from '../src/components/scene/FrameVideoTexture.ts';

function harness(step = () => false) {
  let serial = 0;
  const pending = new Map(); const rendered = [];
  const renderer = createDemandRenderer({
    request(callback) { const id = ++serial; pending.set(id, callback); return id; },
    cancel(id) { pending.delete(id); },
    step, render(now) { rendered.push(now); },
  });
  return { renderer, rendered, pending,
    flush(now) { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach((callback) => callback(now)); },
  };
}

test('five decoded surfaces coalesce into one display frame, with no idle polling', () => {
  const h = harness();
  for (let i = 0; i < 5; i++) h.renderer.invalidate();
  assert.equal(h.pending.size, 1);
  h.flush(16);
  assert.deepEqual(h.rendered, [16]);
  assert.equal(h.pending.size, 0);
  h.flush(32);
  assert.equal(h.rendered.length, 1);
});

test('native 24, 30 and 60 fps are retained without a 30 fps cap or duplicate draws', () => {
  for (const fps of [24, 30, 60]) {
    const h = harness();
    for (let i = 0; i < fps * 2; i++) {
      for (let surface = 0; surface < 5; surface++) h.renderer.invalidate();
      h.flush(i * 1000 / fps);
    }
    assert.equal(h.rendered.length, fps * 2);
    assert.equal(h.pending.size, 0);
  }
});

test('camera damping continues until settled, then the RAF loop sleeps', () => {
  let remaining = 3;
  const h = harness(() => {
    if (remaining-- > 0) { h.renderer.invalidate(); return true; }
    return false;
  });
  h.renderer.invalidate();
  for (let i = 1; i <= 8; i++) h.flush(i * 16);
  assert.equal(h.rendered.length, 3);
  assert.equal(h.pending.size, 0);
});

test('hidden or covered scene cancels scheduled work and redraws once on return', () => {
  const h = harness();
  h.renderer.invalidate();
  h.renderer.suspend(true);
  assert.equal(h.pending.size, 0);
  for (let i = 0; i < 60; i++) { h.renderer.invalidate(); h.flush(i * 16); }
  assert.equal(h.rendered.length, 0);
  h.renderer.suspend(false);
  assert.equal(h.pending.size, 1);
  h.flush(1000);
  assert.deepEqual(h.rendered, [1000]);
  assert.equal(h.pending.size, 0);
  h.renderer.invalidate(); h.renderer.dispose();
  assert.equal(h.pending.size, 0);
  h.renderer.invalidate(); h.flush(2000);
  assert.deepEqual(h.rendered, [1000]);
});

test('fallback compares decoded frames instead of treating advancing media time as a new frame', () => {
  const video = { currentTime: 1, getVideoPlaybackQuality: () => ({ totalVideoFrames: 24 }) };
  const token = decodedFrameToken(video);
  video.currentTime = 1.01;
  assert.equal(decodedFrameToken(video), token);
  assert.equal(decodedFrameToken({ webkitDecodedFrameCount: 42, currentTime: 2 }), 42);
  assert.equal(decodedFrameToken({ currentTime: 2 }), 2);
});

test('video texture reuses Three callback and cancels it on disposal', () => {
  const callbacks = new Map();
  let id = 0; let notifications = 0;
  const video = Object.assign(new EventTarget(), {
    requestVideoFrameCallback(callback) { callbacks.set(++id, callback); return id; },
    cancelVideoFrameCallback(request) { callbacks.delete(request); },
  });
  const texture = new FrameVideoTexture(video, () => notifications++);
  assert.equal(callbacks.size, 1);
  const [request, callback] = [...callbacks][0];
  callbacks.delete(request); callback();
  assert.equal(texture.version, 1);
  assert.equal(notifications, 1);
  assert.equal(callbacks.size, 1, 'must not add a second rVFC subscription');
  texture.dispose();
  assert.equal(callbacks.size, 0);
});

test('fallback texture upload does not reschedule a paused scene from inside render', () => {
  let notifications = 0;
  const texture = new FrameVideoTexture(Object.assign(new EventTarget(), { readyState: 4, HAVE_CURRENT_DATA: 2 }), () => notifications++);
  assert.equal(texture.version, 1, 'the existing paused frame is ready for the first upload');
  texture.update();
  assert.equal(texture.version, 2);
  assert.equal(notifications, 0);
  texture.dispose();
});

test('recreated paused video texture uploads the existing frame and later seek/load frames', () => {
  let notifications = 0;
  const video = Object.assign(new EventTarget(), {
    readyState: 2, requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {},
  });
  const texture = new FrameVideoTexture(video, () => notifications++);
  assert.equal(texture.version, 1);
  assert.equal(notifications, 1);
  video.dispatchEvent(new Event('seeked'));
  video.dispatchEvent(new Event('loadeddata'));
  assert.equal(texture.version, 3);
  assert.equal(notifications, 3);
  video.readyState = 0;
  video.dispatchEvent(new Event('loadeddata'));
  assert.equal(texture.version, 3, 'an empty source must not be uploaded');
  texture.dispose();
  video.readyState = 2;
  video.dispatchEvent(new Event('seeked'));
  assert.equal(texture.version, 3, 'disposed textures remove media listeners');
});
