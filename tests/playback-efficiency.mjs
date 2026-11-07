import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Read-only browser checks; no project or feedback mutations.
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.route('**/api/s/*/playback-diagnostics', (route) => route.fulfill({ status: 204 }));
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const sample = () => page.locator('.video-pool video').evaluateAll((videos) => videos.map((video) => ({ key: video.dataset.surface, time: video.currentTime, paused: video.paused, src: video.currentSrc, attr: video.getAttribute('src'), ready: video.readyState, network: video.networkState, focused: video.classList.contains('video-pool__focused') })));
const state = (expected) => page.waitForFunction((value) => document.querySelector('.player')?.dataset.playbackState === value, expected);
async function oneDecoder() {
  await page.waitForFunction(() => {
    const videos = [...document.querySelectorAll('.video-pool video')];
    const selected = videos.find((video) => video.classList.contains('video-pool__focused'));
    return selected && !selected.paused && selected.currentTime > 0.15 && videos.filter((video) => video !== selected).every((video) => video.paused);
  });
  const videos = await sample(); assert.equal(videos.filter((video) => !video.paused).length, 1);
  return videos.find((video) => video.focused);
}
try {
  await page.goto(`${process.env.BASE || 'http://127.0.0.1:3100'}${process.env.SHARE_PATH || '/s/demo'}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.video-pool video').length === 5);
  const originals = await page.locator('.video-pool video').evaluateAll((videos) => Object.fromEntries(videos.map((video) => [video.dataset.surface, video.src])));
  await page.evaluate(() => { window.__originalVideoNodes = [...document.querySelectorAll('.video-pool video')]; });
  // A preload hint may be ignored on mobile. Only calling play() unlocks the
  // simulated cold source; the four inactive sources must never be started.
  await page.locator('.video-pool video').evaluateAll((videos) => {
    window.__coldPlayKeys = [];
    for (const video of videos) {
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 1 });
      const original = video.play;
      video.play = function () {
        window.__coldPlayKeys.push(this.dataset.surface);
        delete this.readyState;
        return original.call(this);
      };
    }
  });
  await page.locator('.curtain__single').click();
  await page.locator('.focus--native').waitFor();
  if (await page.getByRole('button', { name: 'Воспроизвести видео', exact: true }).count()) {
    await page.getByRole('button', { name: 'Воспроизвести видео', exact: true }).click();
  }
  await state('playing');
  const first = await oneDecoder();
  assert.equal(await page.locator('.room3d canvas').count(), 0, 'single-first does not create a WebGL renderer');
  assert.deepEqual(await page.evaluate(() => [...new Set(window.__coldPlayKeys)]), [first.key], 'cold startup only primes the chosen source');
  await page.locator('.video-pool video').evaluateAll((videos) => {
    for (const video of videos) { delete video.readyState; delete video.play; }
  });
  console.log('ok   ignored metadata preload is unlocked without starting inactive videos');
  assert.ok((await sample()).filter((video) => !video.focused).every((video) => video.attr === null && video.ready === 0 && video.network === 0), `inactive decoders have released their sources: ${JSON.stringify(await sample())}`);
  console.log('ok   single-screen mode uses exactly one active decoder');

  // Slow/failed inactive media must not block the chosen full-quality video.
  const inactive = page.locator('.video-pool video:not(.video-pool__focused)').first();
  await inactive.evaluate((video) => {
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 2 });
    video.dispatchEvent(new Event('waiting')); video.dispatchEvent(new Event('error'));
  });
  await page.waitForTimeout(300); await state('playing'); await oneDecoder();
  await inactive.evaluate((video) => {
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 3 });
    video.dispatchEvent(new Event('canplay')); delete video.readyState;
  });
  console.log('ok   inactive buffering/error does not stop the selected surface');

  await page.locator('.video-pool video:not(.video-pool__focused)').evaluateAll((videos) => {
    window.__switchColdKeys = [];
    for (const video of videos) {
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 1 });
      video.play = function () {
        window.__switchColdKeys.push(this.dataset.surface);
        delete this.readyState;
        return HTMLMediaElement.prototype.play.call(this);
      };
    }
  });
  await page.getByRole('button', { name: 'Следующая поверхность', exact: true }).click();
  const second = await oneDecoder();
  assert.deepEqual(await page.evaluate(() => [...new Set(window.__switchColdKeys)]), [second.key], 'cold switch restores src before unlocking the selected decoder');
  await page.locator('.video-pool video').evaluateAll((videos) => {
    for (const video of videos) { delete video.readyState; delete video.play; }
  });
  assert.notEqual(first.key, second.key);
  assert.ok(second.time >= first.time - 0.18, 'switching surfaces retains timeline');
  assert.equal(second.src, originals[second.key], 'focused mode uses the original full-quality URL');
  assert.ok((await sample()).filter((video) => !video.focused).every((video) => video.attr === null && video.ready === 0 && video.network === 0), 'changing focus releases the previous decoder');
  assert.ok(await page.evaluate(() => window.__originalVideoNodes.every((node, index) => node === document.querySelectorAll('.video-pool video')[index])), 'same native elements survive view changes');
  console.log('ok   switching surfaces preserves the timeline, source URLs and native elements');

  await page.getByRole('button', { name: 'Пауза видео', exact: true }).click();
  await state('paused');
  const position = (await sample()).find((video) => video.focused).time;
  await page.waitForTimeout(350);
  assert.ok((await sample()).every((video) => video.paused));
  assert.ok(Math.abs((await sample()).find((video) => video.focused).time - position) < 0.04);
  await page.locator('.focus__close').click();
  await page.waitForFunction(() => !document.querySelector('.focus'));
  await page.waitForFunction((position) => [...document.querySelectorAll('.video-pool video')].every((video) => video.readyState >= 3 && !video.seeking && Math.abs(video.currentTime - position) < 0.08), position);
  const restored = await sample();
  assert.deepEqual(Object.fromEntries(restored.map((video) => [video.key, video.src])), originals, 'returning restores every original URL');
  assert.ok(restored.every((video) => video.paused && Math.abs(video.time - position) < 0.08), `restore align: ${JSON.stringify(restored)}`);
  await page.locator('.playbtn').click(); await state('playing');
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => !video.paused));
  const running = await sample(); const times = running.map((video) => video.time);
  assert.ok(Math.max(...times) - Math.min(...times) < 0.18);
  console.log('ok   closing single view restores synchronized group playback and pause intent');
  await page.locator('.room3d canvas').waitFor();
  await page.getByRole('button', { name: 'Один экран', exact: true }).click();
  await oneDecoder();
  await page.waitForFunction(() => !document.querySelector('.room3d canvas'));
  await page.locator('.video-pool video:not(.video-pool__focused)').evaluateAll((videos) => {
    window.__returnColdKeys = [];
    window.__expectedReturnKeys = videos.map((video) => video.dataset.surface);
    for (const video of videos) {
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 1 });
      video.play = function () {
        window.__returnColdKeys.push(this.dataset.surface);
        delete this.readyState;
        return HTMLMediaElement.prototype.play.call(this);
      };
    }
  });
  await page.locator('.focus__close').click();
  await state('playing');
  await page.locator('.room3d canvas').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => !video.paused));
  assert.ok(await page.evaluate(() => window.__expectedReturnKeys.every((key) => window.__returnColdKeys.includes(key))), 'cold return unlocks all restored group sources');
  console.log('ok   single-screen mode releases WebGL and cold return restores every decoder');
  assert.deepEqual(errors, []);
  await page.close();
  const review = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await review.route('**/api/s/*/playback-diagnostics', (route) => route.fulfill({ status: 204 }));
  review.on('pageerror', (error) => errors.push(error.message));
  await review.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
    const nativePlay = HTMLMediaElement.prototype.play;
    const unlocked = new WeakSet();
    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get() { const actual = descriptor.get.call(this); return unlocked.has(this) ? actual : Math.min(actual, 1); },
    });
    HTMLMediaElement.prototype.play = function () { unlocked.add(this); return nativePlay.call(this); };
  });
  await review.goto(`${process.env.BASE || 'http://127.0.0.1:3100'}${process.env.SHARE_PATH || '/s/demo'}`, { waitUntil: 'networkidle' });
  const approval = review.getByRole('button', { name: 'Согласовать', exact: true });
  assert.ok(await approval.isDisabled(), 'unloaded surfaces are not yet review-ready');
  await review.locator('.curtain__single').click();
  for (let index = 0; index < 5; index += 1) {
    await review.waitForFunction(() => {
      const selected = document.querySelector('.video-pool__focused');
      return document.querySelector('.player')?.dataset.playbackState === 'playing' && selected && !selected.paused && selected.readyState >= 3;
    });
    if (index < 4) {
      assert.ok(await approval.isDisabled(), 'approval waits for every surface to be individually ready');
      await review.getByRole('button', { name: 'Следующая поверхность', exact: true }).click();
    }
  }
  await approval.waitFor();
  assert.ok(await approval.isEnabled(), 'all five individually viewed sources allow approval after inactive buffers are released');
  await review.locator('.video-pool video:not(.video-pool__focused)').first().evaluate((video) => {
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 3, message: 'Injected decode failure' }) });
    video.dispatchEvent(new Event('error'));
    delete video.error;
  });
  await review.waitForFunction(() => [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Согласовать')?.disabled);
  await review.getByRole('button', { name: 'Следующая поверхность', exact: true }).click();
  await review.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing');
  assert.ok(await approval.isEnabled(), 'recovering the failed source restores its review readiness');
  assert.deepEqual(errors, []);
  console.log('ok   sequential surface review survives decoder release; real errors invalidate readiness');
  console.log('Playback efficiency checks passed.');
} finally { await browser.close(); }
