import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Inject native MediaError evidence in memory; diagnostic requests are captured
// locally so this regression check never writes to project/feedback/log storage.
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const diagnostics = [];
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route(/\/api\/s\/[^/]+$/, async (route) => {
  const response = await route.fetch();
  const data = await response.json();
  // Exercise the terminal-error path independently of optional server variants.
  if (data.project) for (const surface of data.project.surfaces) surface.compatibilityPreview = null;
  await route.fulfill({ response, json: data });
});
await page.route('**/api/s/*/playback-diagnostics', async (route) => {
  diagnostics.push(route.request().postDataJSON());
  await route.fulfill({ status: 204 });
});
try {
  await page.goto(`${process.env.BASE || 'http://127.0.0.1:3100'}${process.env.SHARE_PATH || '/s/demo'}`, { waitUntil: 'networkidle' });
  await page.locator('.curtain__play').click();
  await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing'
    && [...document.querySelectorAll('.video-pool video')].every((video) => !video.paused && video.readyState >= 3));
  const floor = page.locator('.video-pool video[data-surface="floor"]');
  const original = await floor.evaluate((video) => ({ src: video.src, width: video.videoWidth, height: video.videoHeight }));
  const reportReceived = page.waitForResponse((response) => response.url().endsWith('/playback-diagnostics') && response.request().method() === 'POST');
  await floor.evaluate((video) => {
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 3, message: 'Injected decode failure: https://example.test/video?mt=private-token' }) });
    const nativeLoad = video.load;
    video.load = function () {
      // A real load() clears MediaError; emulate that reset for our injected one.
      delete this.error; delete this.load;
      window.__failedSourceReloaded = true;
      return nativeLoad.call(this);
    };
    video.dispatchEvent(new Event('error'));
  });
  await page.locator('.playback-error').waitFor();
  const message = await page.locator('.playback-error p').textContent();
  assert.match(message, /Пол/);
  assert.match(message, new RegExp(`${original.width} × ${original.height}`));
  assert.match(message, /декодировать/);
  assert.match(message, /Код видео: 3/);
  await reportReceived;
  const failures = diagnostics.filter((diagnostic) => diagnostic.event === 'error');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].surfaceKey, 'floor');
  assert.equal(failures[0].category, 'decode');
  assert.equal(failures[0].mode, 'group');
  assert.doesNotMatch(JSON.stringify(failures[0]), /private-token|example\.test/);
  console.log('ok   a native decode failure reports the exact surface, dimensions and category without signed URLs');

  await page.locator('.playback-error').getByRole('button', { name: 'Смотреть по одному экрану', exact: true }).click();
  await page.waitForFunction(() => {
    const videos = [...document.querySelectorAll('.video-pool video')];
    const selected = videos.find((video) => video.dataset.surface === 'floor');
    return document.querySelector('.player')?.dataset.playbackState === 'playing'
      && selected?.classList.contains('video-pool__focused') && !selected.paused && selected.currentTime > 0.15
      && videos.filter((video) => video !== selected).every((video) => video.paused && !video.hasAttribute('src'));
  });
  assert.equal(await page.evaluate(() => window.__failedSourceReloaded), true, 'failed source is reloaded after releasing other decoders');
  assert.deepEqual(await floor.evaluate((video) => ({ src: video.src, width: video.videoWidth, height: video.videoHeight })), original, 'recovery retains the exact source and video dimensions');
  assert.equal(await page.locator('.playback-error').count(), 0);
  console.log('ok   switching a failed group surface to single view recovers the same full-quality file');

  await page.locator('.video-pool video:not(.video-pool__focused)').first().evaluate((video) => video.dispatchEvent(new Event('error')));
  await page.waitForTimeout(150);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.event === 'error').length, 1, 'intentional inactive source release creates no false diagnostic');
  assert.equal(await page.locator('.playback-error').count(), 0);
  assert.equal(await floor.evaluate((video) => video.paused), false);
  assert.deepEqual(errors, []);
  console.log('ok   a late error event after deliberate inactive source release does not interrupt playback');
  console.log('Media failure browser checks passed.');
} finally { await browser.close(); }
