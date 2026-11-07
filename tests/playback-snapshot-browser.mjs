import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// The cold readyState2 gate is only observed here, never changed. All reports
// are intercepted so synthetic evidence cannot enter the live diagnostic log.
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const reports = [], errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/s/*/playback-diagnostics', async (route) => {
  reports.push(route.request().postDataJSON()); await route.fulfill({ status: 204 });
});
try {
  await page.goto(`${process.env.BASE || 'http://127.0.0.1:3100'}${process.env.SHARE_PATH || '/s/demo'}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.video-pool video').length === 5 && [...document.querySelectorAll('.video-pool video')].every((video) => video.readyState >= 3));
  await page.locator('.video-pool video[data-surface="floor"]').evaluate((video) => {
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 2 });
    Object.defineProperty(video, 'networkState', { configurable: true, get: () => 2 });
    Object.defineProperty(video, 'buffered', { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => 0.04 }) });
  });
  await page.locator('.curtain__play').click();
  await page.waitForTimeout(2250);
  let snapshots = reports.filter((report) => report.event === 'snapshot');
  assert.deepEqual(snapshots.map((report) => report.snapshot.reason), ['play', 'after-2s']);
  const sample = snapshots[1].snapshot;
  assert.equal(sample.controller.desired, true);
  assert.equal(sample.controller.running, false);
  assert.equal(sample.controller.starting, false);
  assert.equal(sample.controller.settling, null);
  assert.equal(sample.videos.length, 5);
  const floor = sample.videos.find((video) => video.surfaceKey === 'floor');
  assert.equal(floor.readyState, 2); assert.equal(floor.networkState, 2);
  assert.equal(floor.playAttempts, 1); assert.equal(floor.lastPlayPhase, 'warmup');
  assert.ok(['resolved', 'AbortError'].includes(floor.lastPlayResult));
  assert.equal(floor.muted, true); assert.equal(floor.playsInline, true); assert.equal(floor.ended, false);
  assert.equal(typeof floor.visibility.width, 'number'); assert.equal(typeof floor.visibility.x, 'number');
  assert.deepEqual(floor.buffered, [[0, 0.04]]);
  assert.equal(sample.visibilityState, 'visible');
  assert.equal(typeof sample.userActivation.hasBeenActive, 'boolean');
  assert.match(snapshots[0].build, /^index-[a-z\d_-]+\.js$/i);
  assert.doesNotMatch(JSON.stringify(sample), /https?:|\/api\/|mt=/);
  console.log('ok   one gesture captures all five cold media states and exact pre-start blocker without source URLs');

  await page.locator('.playbtn').click();
  const pausedCount = snapshots.length;
  await page.waitForTimeout(3100);
  assert.equal(reports.filter((report) => report.event === 'snapshot').length, pausedCount, 'pause cancels the pending 5s snapshot');
  await page.locator('.playbtn').click();
  await page.waitForTimeout(100);
  snapshots = reports.filter((report) => report.event === 'snapshot');
  assert.equal(snapshots.length, pausedCount + 1, 'a fresh play attempt is not dropped by 60s deduplication');
  assert.equal(snapshots.at(-1).snapshot.reason, 'play');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(2200);
  assert.equal(reports.filter((report) => report.event === 'snapshot').length, snapshots.length, 'backgrounding cancels pending snapshots');
  assert.deepEqual(errors, []);
  console.log('ok   pause/background cancel diagnostic timers and repeated user attempts remain visible');
} finally { await browser.close(); }
