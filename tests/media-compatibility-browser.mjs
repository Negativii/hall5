import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// All changes are in intercepted responses/browser memory. No live project or
// diagnostic files are modified. The published verified AV1 is streamed over
// HTTP Range, avoiding DevTools' 100MB limit for base64 response fulfillment.
const base = process.env.BASE || 'http://127.0.0.1:3100';
const sharePath = process.env.SHARE_PATH || '/s/demo';
const slug = new URL(sharePath, base).pathname.split('/').at(-1);
const metadataPath = `/api/s/${slug}`;
const response = await fetch(`${base}/api/s/${slug}`);
assert.ok(response.ok);
const initial = await response.json();
const servedCompatibility = initial.project.surfaces.find((surface) => surface.key === 'floor').compatibilityPreview;
assert.ok(servedCompatibility?.url, 'the demo must publish a verified AV1 compatibility source');
const servedCompatibilityUrl = new URL(servedCompatibility.url, base).href;
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const state = (page, value) => page.waitForFunction((value) => document.querySelector('.player')?.dataset.playbackState === value, value);
async function setup(broken = false, nearExpiry = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const reports = [], errors = [];
  const data = structuredClone(initial);
  const floor = data.project.surfaces.find((surface) => surface.key === 'floor');
  const originalFloorUrl = floor.previewUrl;
  const expiredToken = data.project.mediaToken.split('.');
  expiredToken[3] = String(Math.floor(Date.now() / 1000) + 30);
  const alternateUrl = `/compatibility-test/floor.mp4?mt=${encodeURIComponent(nearExpiry ? expiredToken.join('.') : data.project.mediaToken)}&v=test`;
  floor.compatibilityPreview = { url: alternateUrl, codec: 'av1', mimeType: 'video/mp4; codecs="av01"', mode: 'lossless', width: floor.previewWidth, height: floor.previewHeight, fps: floor.previewFps };
  if (nearExpiry) {
    for (const surface of data.project.surfaces) if (surface.previewUrl) {
      const url = new URL(surface.previewUrl, base);
      url.searchParams.set('mt', expiredToken.join('.'));
      surface.previewUrl = url.pathname + url.search;
    }
    await page.route('**/api/s/**/media/*/proxy?*', async (route) => {
      const key = new URL(route.request().url()).pathname.split('/').at(-2);
      const original = initial.project.surfaces.find((surface) => surface.key === key).previewUrl;
      const fetched = await route.fetch({ url: new URL(original, base).href });
      await route.fulfill({ response: fetched });
    });
  }
  let alternateRequests = 0, metadataRequests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => url.pathname === metadataPath, async (route) => {
    metadataRequests += 1;
    const refreshed = structuredClone(data);
    if (metadataRequests > 1) {
      const alternate = refreshed.project.surfaces.find((surface) => surface.key === 'floor').compatibilityPreview;
      alternate.url = nearExpiry ? `/compatibility-test/floor.mp4?mt=${encodeURIComponent(data.project.mediaToken)}&v=test` : alternateUrl.replace('&v=', 'x&v=');
      if (nearExpiry) for (const surface of refreshed.project.surfaces) surface.previewUrl = initial.project.surfaces.find((item) => item.key === surface.key).previewUrl;
    }
    await route.fulfill({ json: refreshed });
  });
  await page.route('**/api/s/*/playback-diagnostics', async (route) => {
    reports.push(route.request().postDataJSON());
    await route.fulfill({ status: 204 });
  });
  await page.route('**/compatibility-test/floor.mp4?*', async (route) => {
    alternateRequests += 1;
    if (broken) { await route.fulfill({ contentType: 'video/mp4', body: 'invalid media source' }); return; }
    await route.continue({ url: servedCompatibilityUrl });
  });
  await page.goto(`${base}${sharePath}`, { waitUntil: 'networkidle' });
  await page.locator('.curtain__play').click();
  await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing'
    && [...document.querySelectorAll('.video-pool video')].every((video) => !video.paused && video.currentTime > 0.35));
  await page.evaluate(() => { window.__initialNodes = [...document.querySelectorAll('.video-pool video')]; });
  return { page, reports, errors, alternateUrl, originalFloorUrl, count: () => alternateRequests, metadataCount: () => metadataRequests };
}
async function injectFailure(page) {
  return page.locator('.video-pool video[data-surface="floor"]').evaluate((video) => {
    const time = video.currentTime;
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 4, message: 'Injected unsupported primary' }) });
    const nativeLoad = video.load;
    video.load = function () { delete this.error; delete this.load; return nativeLoad.call(this); };
    video.dispatchEvent(new Event('error'));
    // Native error may already have been handled through play() rejection when
    // its queued event arrives after load() cleared the old source's error.
    video.dispatchEvent(new Event('error'));
    return time;
  });
}
try {
  const success = await setup();
  const { page, reports, errors, alternateUrl } = success;
  const position = await injectFailure(page);
  await page.waitForFunction(() => {
    const floor = document.querySelector('.video-pool video[data-surface="floor"]');
    return document.querySelector('.player')?.dataset.playbackState === 'playing' && floor?.currentSrc.includes('/compatibility-test/') && !floor.paused && floor.readyState >= 3;
  });
  const floor = page.locator('.video-pool video[data-surface="floor"]');
  const ready = await floor.evaluate((video) => ({ time: video.currentTime, width: video.videoWidth, height: video.videoHeight }));
  assert.equal(ready.width, 4800); assert.equal(ready.height, 2400);
  assert.ok(ready.time >= position - 0.2, 'fallback preserves the shared timeline');
  assert.equal(await page.locator('.playback-error').count(), 0);
  assert.ok(reports.some((report) => report.event === 'error' && report.variant === 'primary' && report.code === 4));
  assert.ok(reports.some((report) => report.event === 'recovered' && report.variant === 'av1-lossless' && report.code === 0));
  assert.ok(await page.evaluate(() => window.__initialNodes.every((node, index) => node === document.querySelectorAll('.video-pool video')[index])));
  console.log('ok   native primary failure recovers on actual full-resolution AV1, preserving timeline, intent and native nodes');

  await page.getByRole('button', { name: 'Один экран', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.video-pool video[data-surface="floor"]')?.getAttribute('src') === null);
  await page.locator('.focus__close').click();
  await state(page, 'playing');
  assert.equal(await floor.getAttribute('src'), alternateUrl);
  assert.ok(await page.evaluate(() => window.__initialNodes.every((node, index) => node === document.querySelectorAll('.video-pool video')[index])));
  const priorRefreshCount = success.metadataCount();
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === metadataPath);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  assert.ok(success.metadataCount() > priorRefreshCount);
  await page.waitForTimeout(100);
  assert.equal(await floor.getAttribute('src'), alternateUrl, 'a refreshed authorization token does not reset the chosen source');
  assert.ok(await page.evaluate(() => window.__initialNodes.every((node, index) => node === document.querySelectorAll('.video-pool video')[index])));
  assert.deepEqual(errors, []);
  console.log('ok   focus round-trip and metadata token refresh retain AV1 and source identity');
  await page.close();

  const expiry = await setup(false, true);
  await injectFailure(expiry.page);
  await expiry.page.waitForFunction(() => document.querySelector('.video-pool video[data-surface="floor"]')?.currentSrc.includes('/compatibility-test/') && document.querySelector('.player')?.dataset.playbackState === 'playing');
  await expiry.page.getByRole('button', { name: 'Один экран', exact: true }).click();
  for (let index = 0; index < 4; index += 1) await expiry.page.getByRole('button', { name: 'Следующая поверхность', exact: true }).click();
  await expiry.page.waitForFunction(() => document.querySelector('.video-pool__focused')?.dataset.surface === 'floor' && document.querySelector('.player')?.dataset.playbackState === 'playing');
  const expiryFloor = expiry.page.locator('.video-pool video[data-surface="floor"]');
  const beforeExpiry = await expiryFloor.evaluate((video) => video.currentTime);
  const expiryResponse = expiry.page.waitForResponse((response) => new URL(response.url()).pathname === metadataPath);
  await expiry.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expiryResponse;
  await expiry.page.waitForFunction((oldUrl) => {
    const floor = document.querySelector('.video-pool video[data-surface="floor"]');
    return floor?.getAttribute('src') !== oldUrl && floor?.currentSrc.includes('/compatibility-test/') && floor.classList.contains('video-pool__focused')
      && !floor.paused && document.querySelector('.player')?.dataset.playbackState === 'playing';
  }, expiry.alternateUrl);
  assert.ok(await expiryFloor.evaluate((video, prior) => video.currentTime >= prior - 0.2, beforeExpiry), 'expired-token refresh retains timeline and play intent');
  assert.ok(await expiry.page.evaluate(() => window.__initialNodes.every((node, index) => node === document.querySelectorAll('.video-pool video')[index])), 'expired primary token does not remount native nodes');
  assert.equal(expiry.reports.filter((report) => report.event === 'error' && report.variant === 'primary').length, 1, 'expiry retains the AV1 choice');
  assert.deepEqual(expiry.errors, []);
  console.log('ok   expiring primary and alternate access tokens rotate without losing AV1, focus, native nodes or timeline');
  await expiry.page.close();

  const failed = await setup(true);
  await injectFailure(failed.page);
  await failed.page.locator('.playback-error').waitFor();
  await failed.page.waitForTimeout(300);
  assert.match(await failed.page.locator('.playback-error p').textContent(), /Код видео: 4/);
  assert.ok(failed.reports.some((report) => report.event === 'error' && report.variant === 'av1-lossless' && report.code === 4));
  assert.ok(!failed.reports.some((report) => report.event === 'recovered'));
  const attempts = failed.count();
  await failed.page.waitForTimeout(300);
  assert.equal(failed.count(), attempts, 'an unsupported alternate never loops automatically');
  await failed.page.locator('.playback-error').getByRole('button', { name: 'Повторить', exact: true }).click();
  await failed.page.locator('.playback-error').waitFor();
  assert.ok(failed.count() > attempts, 'manual retry retries the alternate');
  assert.equal(await failed.page.locator('.video-pool video[data-surface="floor"]').getAttribute('src'), failed.alternateUrl);
  assert.deepEqual(failed.errors, []);
  console.log('ok   alternate failure reports its actual error once and manual retry retains the selected variant');
  await failed.page.close();
  console.log('Media compatibility browser checks passed.');
} finally { await browser.close(); }
