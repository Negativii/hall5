import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
try {
  for (const scenario of ['normal', 'starved', 'starved-during', 'play-driven', 'pause', 'focus', 'seek', 'timeout'].filter((value) => !process.env.STARTUP_CASE || value === process.env.STARTUP_CASE)) {
    const initialStarvation = scenario === 'starved';
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/s/*/playback-diagnostics', (route) => route.fulfill({ status: 204 }));
    await page.addInitScript(() => {
      const nativePlay = HTMLMediaElement.prototype.play;
      const nativePause = HTMLMediaElement.prototype.pause;
      const paused = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
      const currentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
      const readyState = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
      const delayed = new WeakMap();
      const nativeFrame = window.requestAnimationFrame;
      window.__frameRequests = 0;
      window.requestAnimationFrame = function (callback) { window.__frameRequests += 1; return nativeFrame.call(this, callback); };
      window.__floorStarts = 0;
      window.__backwardSeeks = [];
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get() { return delayed.has(this) ? false : paused.get.call(this); } });
      Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { configurable: true, get() { return window.__starvedDuringStart && delayed.has(this) ? 2 : readyState.get.call(this); } });
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true,
        get() { return currentTime.get.call(this); },
        set(value) {
          const prior = currentTime.get.call(this);
          if (window.__delayFloor && prior > 0.08 && value < prior - 0.08) window.__backwardSeeks.push({ key: this.dataset.surface, from: prior, to: value });
          currentTime.set.call(this, value);
        },
      });
      HTMLMediaElement.prototype.play = function () {
        if (window.__delayFloor && this.dataset.surface === 'floor' && paused.get.call(this) && !delayed.has(this)) {
          window.__floorStarts += 1;
          if (window.__playDrivesFetch) window.__hasStartupData = true;
          // AV1 may resolve play() before its media clock starts. Pausing this
          // decoder during the delay discards its warmup, reproducing the loop.
          const timer = setTimeout(() => { delayed.delete(this); void nativePlay.call(this).catch(() => {}); }, window.__floorDelay || 320);
          delayed.set(this, timer);
          if (window.__starvedDuringStart) setTimeout(() => this.dispatchEvent(new Event('waiting')), 0);
          return Promise.resolve();
        }
        return nativePlay.call(this);
      };
      HTMLMediaElement.prototype.pause = function () {
        if (delayed.has(this)) { clearTimeout(delayed.get(this)); delayed.delete(this); }
        return nativePause.call(this);
      };
    });
    await page.goto(`${process.env.BASE || 'http://127.0.0.1:3100'}${process.env.SHARE_PATH || '/s/demo'}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelectorAll('.video-pool video').length === 5 && [...document.querySelectorAll('.video-pool video')].every((video) => video.readyState >= 3));
    await page.evaluate(({ starved, scenario }) => {
      window.__delayFloor = true;
      window.__starvedDuringStart = scenario === 'starved-during';
      window.__playDrivesFetch = scenario === 'play-driven';
      window.__floorDelay = scenario === 'timeout' ? 60000 : ['pause', 'focus', 'seek'].includes(scenario) ? 1000 : 320;
      if (starved || window.__playDrivesFetch) {
        const floor = document.querySelector('.video-pool video[data-surface="floor"]');
        window.__hasStartupData = false;
        Object.defineProperty(floor, 'readyState', { configurable: true, get: () => window.__hasStartupData || window.__playDrivesFetch ? 3 : 2 });
        Object.defineProperty(floor, 'networkState', { configurable: true, get: () => 2 });
        Object.defineProperty(floor, 'buffered', { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => window.__hasStartupData ? 14 : 0.04 }) });
      }
    }, { starved: initialStarvation, scenario });
    await page.locator('.curtain__play').click();
    if (['pause', 'focus', 'seek', 'timeout'].includes(scenario)) {
      await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].some((video) => video.dataset.surface !== 'floor' && video.paused && video.currentTime > 0.06));
      if (scenario === 'pause') {
        await page.locator('.playbtn').click();
        await page.waitForTimeout(1200);
        assert.ok(await page.locator('.video-pool video').evaluateAll((videos) => videos.every((video) => video.paused)));
        assert.equal(await page.locator('.player').getAttribute('data-playback-state'), 'paused');
        const frames = await page.evaluate(() => window.__frameRequests);
        await page.waitForTimeout(250);
        assert.ok(await page.evaluate((before) => window.__frameRequests - before <= 2, frames), 'paused player has no idle animation loop');
        console.log('ok   user pause cancels decoder warmup and intentional holds without idle RAF');
      } else if (scenario === 'focus') {
        await page.getByRole('button', { name: 'Один экран', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.video-pool__focused')?.currentTime > 0.2 && document.querySelector('.player')?.dataset.playbackState === 'playing');
        await page.waitForTimeout(1100);
        assert.equal(await page.locator('.video-pool video[data-surface="floor"]').getAttribute('src'), null);
        assert.ok(await page.locator('.video-pool video:not(.video-pool__focused)').evaluateAll((videos) => videos.every((video) => video.paused)));
        console.log('ok   changing focus cancels the held group and releases the warming floor');
      } else if (scenario === 'seek') {
        await page.getByRole('slider', { name: 'Перемотка' }).press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing' && [...document.querySelectorAll('.video-pool video')].every((video) => !video.paused && video.currentTime > 5.05), null, { timeout: 6000 });
        console.log('ok   explicit user seeking cancels old holds and starts at the requested time');
      } else {
        await page.locator('.playback-error').waitFor({ timeout: 15000 });
        assert.match(await page.locator('.playback-error p').textContent(), /Не удалось синхронно запустить/);
        assert.equal(await page.evaluate(() => window.__floorStarts), 1, 'a stuck decoder is not restarted in a loop');
        assert.ok(await page.locator('.video-pool video').evaluateAll((videos) => videos.every((video) => video.paused)));
        await page.waitForTimeout(300);
        const frames = await page.evaluate(() => window.__frameRequests);
        await page.waitForTimeout(250);
        assert.ok(await page.evaluate((before) => window.__frameRequests - before <= 2, frames), 'timeout stops the startup animation loop');
        console.log('ok   a permanently stuck decoder reaches one bounded error and stops all startup work');
      }
      assert.equal(await page.locator('.playback-error').count(), scenario === 'timeout' ? 1 : 0);
      assert.deepEqual(errors, []);
      await page.close();
      continue;
    }
    if (initialStarvation) {
      await page.waitForTimeout(350);
      assert.ok(await page.locator('.video-pool video').evaluateAll((videos) => videos.every((video) => video.currentTime < 0.03 && video.paused)), 'no source runs ahead while initial data is still missing');
      await page.evaluate(() => { window.__hasStartupData = true; document.querySelector('.video-pool video[data-surface="floor"]').dispatchEvent(new Event('progress')); });
    }
    try {
      await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => !video.paused && video.currentTime > 0.6), null, { timeout: 6000 });
    } catch (error) {
      console.error('startup evidence', await page.evaluate(() => ({ starts: window.__floorStarts, rewinds: window.__backwardSeeks.length,
        clocks: [...document.querySelectorAll('.video-pool video')].map((video) => ({ key: video.dataset.surface, time: video.currentTime })), state: document.querySelector('.player')?.dataset.playbackState })));
      throw error;
    }
    const evidence = await page.evaluate(() => ({ starts: window.__floorStarts, rewinds: window.__backwardSeeks,
      clocks: [...document.querySelectorAll('.video-pool video')].map((video) => video.currentTime), state: document.querySelector('.player')?.dataset.playbackState }));
    assert.ok(evidence.starts <= 2, `slow decoder warmup must not restart repeatedly: ${JSON.stringify(evidence)}`);
    assert.deepEqual(evidence.rewinds, [], 'startup preserves beginning frames without rewinding leaders or skipping the lagging source');
    assert.ok(Math.max(...evidence.clocks) - Math.min(...evidence.clocks) < 0.18);
    assert.equal(evidence.state, 'playing');
    assert.deepEqual(errors, []);
    console.log(`ok   320ms delayed floor clock starts without rewinds${initialStarvation ? ' after initial buffer starvation' : scenario === 'starved-during' ? ' with readyState2/waiting during warmup' : scenario === 'play-driven' ? ' with .04s buffer/network LOADING and play-driven fetching' : ''}`);
    await page.close();
  }
} finally { await browser.close(); }
