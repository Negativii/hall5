import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Normal Chrome autoplay rules. All media stubs are confined to this test page.
const browser = await chromium.launch({
  executablePath: browserPath(), headless: true,
});
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const errors = [];
try {
  for (const readyState of [4, 3]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('**/api/s/*/playback-diagnostics', (route) => route.fulfill({ status: 204 }));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${BASE}${process.env.SHARE_PATH || '/s/demo'}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => {
      const videos = [...document.querySelectorAll('.video-pool video')];
      return videos.length === 5 && videos.every((video) => video.readyState >= 3);
    });
    await page.locator('.video-pool video').evaluateAll((videos, ready) => {
      for (const video of videos) {
        Object.defineProperty(video, 'readyState', { configurable: true, get: () => ready });
        Object.defineProperty(video, 'networkState', { configurable: true, get: () => 1 });
        Object.defineProperty(video, 'buffered', { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 0.428 }) });
      }
    }, readyState);
    await page.locator('.curtain__play').click();
    await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing', null, { timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => !video.paused && video.currentTime > 0.15));
    const floor = page.locator('video[data-surface="floor"]');
    await floor.evaluate((video) => {
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => 2 });
      video.dispatchEvent(new Event('waiting'));
    });
    await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'buffering');
    assert.ok(await page.locator('.video-pool video').evaluateAll((videos) => videos.every((video) => video.paused)));
    await floor.evaluate((video, ready) => {
      Object.defineProperty(video, 'readyState', { configurable: true, get: () => ready });
      video.dispatchEvent(new Event('canplay'));
    }, readyState);
    await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing', null, { timeout: 5000 });
    console.log(`ok   readyState ${readyState} with idle .428s buffer starts and recovers without a gate deadlock`);
    await page.locator('.video-pool video').evaluateAll((videos) => {
      for (const video of videos) { delete video.readyState; delete video.networkState; delete video.buffered; }
    });
    if (readyState === 4) {
      await page.getByRole('button', { name: 'Один экран', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing');
      await page.getByRole('button', { name: 'Пауза видео', exact: true }).click();
      const position = await page.locator('.video-pool__focused').evaluate((video) => video.currentTime);
      await page.locator('.video-pool video:not(.video-pool__focused)').evaluateAll((videos) => {
        window.__pausedWarmups = [];
        for (const video of videos) {
          Object.defineProperty(video, 'readyState', { configurable: true, get: () => 1 });
          video.play = function () {
            window.__pausedWarmups.push(this.dataset.surface);
            delete this.readyState;
            return HTMLMediaElement.prototype.play.call(this);
          };
        }
      });
      await page.locator('.focus__close').click();
      await page.waitForFunction((position) => [...document.querySelectorAll('.video-pool video')].every((video) => video.readyState >= 3 && !video.seeking && video.paused && Math.abs(video.currentTime - position) < 0.08), position);
      assert.equal(await page.evaluate(() => new Set(window.__pausedWarmups).size), 4);
      await page.waitForTimeout(300);
      assert.ok(await page.locator('.video-pool video').evaluateAll((videos) => videos.every((video) => video.paused)));
      console.log('ok   cold return while paused warms restored sources and retains a common paused position');
    }
    await page.close();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
