import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://127.0.0.1:3215';
const browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const errors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 12000;
  while (!condition() && Date.now() < deadline) await sleep(100);
  assert.ok(condition(), 'expected a metadata refresh');
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const response = await context.request.get(`${BASE}/api/s/demo`);
  const { project: demo } = await response.json();
  const screen = { id: 'qa-screen', type: 'screen', name: 'QA screen', position: [0, 0, 0], rotation: [0, 0, 0], size: [4, 2, .1], color: '#eeeeee', source: 'right' };
  const ready = { ...demo, contentRevision: 301, duration: 14, requiredSurfaceKeys: ['right'], canApprove: true, processing: 0, scene: { ...demo.scene, showRoomSurfaces: false, objects: [screen], assets: [] } };
  let phase = 'pending';
  let calls = 0;
  await context.route((url) => url.pathname === '/api/s/demo/playback-diagnostics', (route) => route.fulfill({ status: 204 }));
  await context.route((url) => url.pathname === '/api/s/demo', (route) => {
    calls += 1;
    let project = ready;
    if (phase === 'pending' && calls === 1) project = { ...ready, contentRevision: 300, duration: 0, processing: 1, canApprove: false, surfaces: ready.surfaces.map((surface) => surface.key === 'right' ? { ...surface, status: 'pending', previewUrl: null, posterUrl: null } : surface) };
    if (phase === 'processing' || phase === 'token') project = { ...ready, processing: 1, canApprove: false };
    if (phase === 'token') project = { ...project, surfaces: project.surfaces.map((surface) => {
      if (!surface.previewUrl) return surface;
      const url = new URL(surface.previewUrl, BASE);
      const parts = url.searchParams.get('mt').split('.');
      parts[4] = 'rotated-test-signature';
      url.searchParams.set('mt', parts.join('.'));
      return { ...surface, previewUrl: url.pathname + url.search };
    }) };
    if (phase === 'updated' || phase === 'complete') project = { ...ready, contentRevision: 302, requiredSurfaceKeys: ['right', 'floor'], scene: { ...ready.scene, objects: [screen, { ...screen, id: 'qa-floor', type: 'floor', source: 'floor' }] } };
    return route.fulfill({ json: { locked: false, project } });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${BASE}/s/demo`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.video-pool video').count(), 0);
  await until(() => calls >= 2);
  await page.getByRole('button', { name: 'Открыть новую версию', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Открыть новую версию', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('video[data-surface=right]')?.readyState >= 3);
  assert.equal(await page.locator('.video-pool video').count(), 1);
  console.log('ok   an initially processing customer link detects the ready version after a bounded poll');

  phase = 'processing';
  let previous = calls;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(() => calls > previous);
  await page.locator('.curtain__play').click();
  await page.waitForFunction(() => document.querySelector('video[data-surface=right]')?.currentTime > .4);
  await page.evaluate(() => { window.qaVideo = document.querySelector('video[data-surface=right]'); window.qaTime = window.qaVideo.currentTime; });
  phase = 'token';
  previous = calls;
  await until(() => calls > previous);
  assert.equal(await page.evaluate(() => window.qaVideo === document.querySelector('video[data-surface=right]')), true, 'token reissue must preserve the video element');
  assert.equal(await page.evaluate(() => window.qaVideo.currentTime > window.qaTime + 2), true, 'metadata progress must not restart playback');
  assert.equal(await page.locator('.player').getAttribute('data-playback-state'), 'playing');
  console.log('ok   polling progress preserves signed source URLs, video identity and playback');

  phase = 'updated';
  previous = calls;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(() => calls > previous);
  await page.getByRole('button', { name: 'Открыть новую версию', exact: true }).waitFor();
  assert.equal(await page.locator('.video-pool video').count(), 1, 'new content waits for explicit acceptance');
  assert.equal(await page.getByRole('button', { name: 'Согласовать', exact: true }).isDisabled(), true, 'stale content cannot be approved');
  await page.getByRole('button', { name: 'Открыть новую версию', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.video-pool video').length === 2 && [...document.querySelectorAll('.video-pool video')].every((video) => video.readyState >= 3));
  assert.equal(await page.getByRole('button', { name: 'Согласовать', exact: true }).isEnabled(), true);
  console.log('ok   a changed revision keeps the old view until accepted and blocks stale approval');
  phase = 'complete';
  const completeCalls = calls;
  await sleep(5500);
  assert.equal(calls, completeCalls, 'ready content uses the slow scene refresh interval, not the five-second processing poll');
  assert.deepEqual(errors, []);
  console.log('ok   ready content leaves the five-second processing poll for the 30-second scene refresh');
  console.log('Share refresh checks passed.');
} finally { await browser.close(); }
