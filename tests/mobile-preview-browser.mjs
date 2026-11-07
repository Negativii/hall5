import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:3100';
const sharePath = process.env.SHARE_PATH || '/s/demo';
const slug = new URL(sharePath, base).pathname.split('/').at(-1);
const metadataPath = `/api/s/${slug}`;
const initial = await (await fetch(`${base}/api/s/${slug}`)).json();
const required = initial.project.surfaces.filter((surface) => initial.project.requiredSurfaceKeys.includes(surface.key));
assert.ok(required.every((surface) => surface.mobilePreview?.url), 'publish all five mobile previews before this test');
const identity = (value) => { const url = new URL(value, base); url.searchParams.delete('mt'); return url.pathname + url.search; };
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const phone = { viewport: { width: 430, height: 932 }, screen: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' };
const state = (page, value) => page.waitForFunction((value) => document.querySelector('.player')?.dataset.playbackState === value, value);
const sample = (page) => page.locator('.video-pool video').evaluateAll((videos) => videos.map((video) => ({ key: video.dataset.surface, src: video.getAttribute('src'), width: video.videoWidth, height: video.videoHeight, time: video.currentTime, paused: video.paused })));
const reportRoute = (page, reports) => page.route('**/api/s/*/playback-diagnostics', async (route) => { reports.push(route.request().postDataJSON()); await route.fulfill({ status: 204 }); });
try {
  const page = await browser.newPage(phone);
  const reports = [], requests = [], errors = [];
  page.on('request', (request) => { if (request.resourceType() === 'media') requests.push(identity(request.url())); });
  page.on('pageerror', (error) => errors.push(error.message));
  await reportRoute(page, reports);
  await page.goto(`${base}${sharePath}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.video-pool video').length === 5);
  const mobilePaths = required.map((surface) => identity(surface.mobilePreview.url));
  const primaryPaths = required.map((surface) => identity(surface.previewUrl));
  for (const video of await sample(page)) assert.equal(identity(video.src), mobilePaths[required.findIndex((surface) => surface.key === video.key)]);
  assert.ok(requests.every((url) => mobilePaths.includes(url)), 'initial phone overview never requests a hidden full-quality source');
  await page.evaluate(() => { window.__originalNodes = [...document.querySelectorAll('.video-pool video')]; });
  await page.locator('.curtain__play').click();
  await state(page, 'playing');
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => video.currentTime > 0.25 && !video.paused));
  for (const video of await sample(page)) {
    const expected = required.find((surface) => surface.key === video.key).mobilePreview;
    assert.equal(video.width, expected.width); assert.equal(video.height, expected.height);
  }
  assert.ok(reports.some((report) => report.event === 'snapshot' && report.variant === 'mobile' && report.snapshot.videos.every((video) => video.variant === 'mobile')));
  assert.match(await page.locator('.mobile-overview-note').textContent(), /Облегчённый обзор.*Полное качество/);
  assert.ok(await page.locator('.mobile-overview-note').evaluate((element) => {
    const note = element.getBoundingClientRect(); const controls = document.querySelector('.transport__row').getBoundingClientRect();
    return note.height > 0 && note.bottom <= controls.top && note.top >= 0;
  }), 'mobile quality label is visible above transport controls');
  await page.screenshot({ path: resolve('../../work/mobile-overview-phone.png') });
  console.log('ok   phone group loads only published mobile sources, reports mobile diagnostics and explains full-quality viewing');

  await page.locator('.playbtn').click(); await state(page, 'paused');
  const timeline = await page.getByRole('slider', { name: 'Перемотка' }).boundingBox();
  await page.mouse.click(timeline.x + timeline.width * 0.28, timeline.y + timeline.height / 2);
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => !video.seeking && video.paused && video.currentTime > 3));
  const position = (await sample(page))[0].time;
  await page.getByRole('button', { name: 'Один экран', exact: true }).click();
  await state(page, 'playing');
  let selected = (await sample(page)).find((video) => video.src);
  const full = required.find((surface) => surface.key === selected.key);
  assert.equal(identity(selected.src), identity(full.previewUrl));
  assert.equal(selected.width, full.previewWidth); assert.equal(selected.height, full.previewHeight);
  assert.ok(selected.time >= position - 0.2);
  assert.equal(await page.locator('.mobile-overview-note').count(), 0);
  for (let index = 0; index < 4; index += 1) await page.getByRole('button', { name: 'Следующая поверхность', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.video-pool__focused')?.dataset.surface === 'floor' && document.querySelector('.player')?.dataset.playbackState === 'playing');
  const floor = page.locator('.video-pool video[data-surface="floor"]');
  await floor.evaluate((video) => {
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 4, message: 'Injected unsupported full primary' }) });
    const load = video.load;
    video.load = function () { delete this.error; delete this.load; return load.call(this); };
    video.dispatchEvent(new Event('error'));
  });
  const losslessPath = identity(required.find((surface) => surface.key === 'floor').compatibilityPreview.url);
  await page.waitForFunction((path) => document.querySelector('.video-pool__focused')?.currentSrc.includes(path) && document.querySelector('.player')?.dataset.playbackState === 'playing', losslessPath.split('?')[0]);
  assert.equal(await floor.evaluate((video) => video.videoWidth), 4800);
  assert.equal(await floor.evaluate((video) => video.videoHeight), 2400);
  await page.screenshot({ path: resolve('../../work/mobile-full-quality-phone.png') });
  await page.getByRole('button', { name: 'Пауза видео', exact: true }).click();
  const fullPosition = await floor.evaluate((video) => video.currentTime);
  await page.locator('.focus__close').click();
  await page.waitForFunction((target) => [...document.querySelectorAll('.video-pool video')].every((video) => video.paused && !video.seeking && video.readyState >= 3 && Math.abs(video.currentTime - target) < 0.1), fullPosition);
  for (const video of await sample(page)) assert.equal(identity(video.src), identity(required.find((surface) => surface.key === video.key).mobilePreview.url));
  assert.ok(await page.evaluate(() => window.__originalNodes.every((node, index) => node === document.querySelectorAll('.video-pool video')[index])));
  const groupRequestIndex = requests.length;
  await page.waitForTimeout(250);
  assert.ok(requests.slice(groupRequestIndex).every((url) => mobilePaths.includes(url)));
  await page.getByRole('button', { name: 'Один экран', exact: true }).click();
  for (let index = 0; index < 4; index += 1) await page.getByRole('button', { name: 'Следующая поверхность', exact: true }).click();
  await page.waitForFunction((path) => document.querySelector('.video-pool__focused')?.currentSrc.includes(path) && document.querySelector('.player')?.dataset.playbackState === 'playing', losslessPath.split('?')[0]);
  assert.equal(identity(await floor.getAttribute('src')), losslessPath, 'full-quality AV1 choice survives a mobile group round-trip');
  assert.deepEqual(errors, []);
  console.log('ok   single view restores full resolution and AV1; returning restores mobile sources at the retained paused position on the same nodes');
  await page.close();

  const expiry = await browser.newPage(phone);
  await reportRoute(expiry, []);
  const nearExpiry = structuredClone(initial);
  const token = initial.project.mediaToken.split('.'); token[3] = String(Math.floor(Date.now() / 1000) + 30);
  for (const surface of nearExpiry.project.surfaces) {
    for (const owner of [surface, surface.mobilePreview]) {
      const field = owner === surface ? 'previewUrl' : 'url';
      if (!owner?.[field]) continue;
      const url = new URL(owner[field], base); url.searchParams.set('mt', token.join('.')); owner[field] = url.pathname + url.search;
    }
  }
  let refreshes = 0;
  await expiry.route((url) => url.pathname === metadataPath, (route) => route.fulfill({ json: ++refreshes === 1 ? nearExpiry : initial }));
  for (const surface of required) {
    const path = new URL(surface.mobilePreview.url, base).pathname;
    await expiry.route(`**${path}?*`, (route) => route.continue({ url: new URL(surface.mobilePreview.url, base).href }));
  }
  await expiry.goto(`${base}${sharePath}`, { waitUntil: 'networkidle' });
  await expiry.locator('.curtain__play').click(); await state(expiry, 'playing');
  await expiry.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => video.currentTime > 0.25));
  const before = await sample(expiry);
  await expiry.evaluate(() => { window.__initialNodes = [...document.querySelectorAll('.video-pool video')]; });
  const refreshed = expiry.waitForResponse((response) => new URL(response.url()).pathname === metadataPath);
  await expiry.evaluate(() => window.dispatchEvent(new Event('focus'))); await refreshed;
  await expiry.waitForFunction((oldSources) => [...document.querySelectorAll('.video-pool video')].every((video, index) => video.getAttribute('src') !== oldSources[index] && !video.paused && video.readyState >= 3) && document.querySelector('.player')?.dataset.playbackState === 'playing', before.map((video) => video.src));
  for (const video of await sample(expiry)) {
    assert.equal(identity(video.src), identity(required.find((surface) => surface.key === video.key).mobilePreview.url));
    assert.ok(video.time >= Math.min(...before.map((entry) => entry.time)) - 0.2);
  }
  assert.ok(await expiry.evaluate(() => window.__initialNodes.every((node, index) => node === document.querySelectorAll('.video-pool video')[index])));
  console.log('ok   expiring mobile and primary tokens rotate without changing group quality, timeline or native nodes');
  await expiry.close();

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await reportRoute(desktop, []);
  await desktop.goto(`${base}${sharePath}`, { waitUntil: 'networkidle' });
  for (const video of await sample(desktop)) assert.equal(identity(video.src), primaryPaths[required.findIndex((surface) => surface.key === video.key)]);
  assert.equal(await desktop.locator('.mobile-overview-note').count(), 0);
  console.log('ok   desktop defaults retain the original full-quality sources');
  await desktop.close();
} finally { await browser.close(); }
