import { browserPath } from './browser-path.mjs';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright-core';

// Read-only against an already published multi-scene project. Diagnostics are
// intercepted so browser checks never become false customer error reports.
const base = process.env.BASE || 'http://127.0.0.1:3217';
const artifactDirectory = process.env.TEST_ARTIFACT_DIR || path.resolve('tests/tmp/video-scenes');
fs.mkdirSync(artifactDirectory, { recursive: true });
assert.ok(process.env.SHARE_PATH, 'Pass SHARE_PATH for a project with multiple published video scenes');
const sharePath = process.env.SHARE_PATH;
const slug = sharePath.split('/').at(-1);
const { project: initial } = await (await fetch(`${base}/api/s/${slug}`)).json();
assert.ok(initial.videoScenes.length >= 2);
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const page = await browser.newPage({ viewport: { width: 430, height: 932 }, screen: { width: 430, height: 932 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
const errors = [], requests = [], reports = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (request) => { if (request.resourceType() === 'media') requests.push(request.url()); });
await page.route('**/playback-diagnostics', (route) => { reports.push(route.request().postDataJSON()); return route.fulfill({ status: 204 }); });
try {
  await page.goto(`${base}${sharePath}`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.video-scene-switcher__button').count(), initial.videoScenes.length);
  const visited = new Set([initial.videoSceneId]);
  assert.ok(requests.every((url) => url.includes(`/video-scenes/${initial.videoSceneId}/`)), 'initial request only loads the selected scene');
  await page.locator('.curtain__play').click();
  await page.getByRole('button', { name: 'Схема', exact: true }).click();
  for (const scene of initial.videoScenes) {
    const { project } = await (await fetch(`${base}/api/s/${slug}?videoScene=${encodeURIComponent(scene.id)}`)).json();
    assert.deepEqual(project.scene, initial.scene, 'all scenes share exactly the same room geometry');
    if (scene.id !== initial.videoSceneId) {
      await page.evaluate(() => { window.__previous = [...document.querySelectorAll('.video-pool video')]; });
      visited.add(scene.id);
      await page.getByRole('button', { name: scene.name, exact: true }).click();
    }
    await page.waitForFunction((id) => document.querySelector('.player')?.dataset.videoScene === id && document.querySelector('.player')?.dataset.playbackState === 'playing'
      && [...document.querySelectorAll('.video-pool video')].every((video) => !video.paused && video.readyState >= 3 && video.currentTime > .02), scene.id);
    const sources = await page.locator('.video-pool video').evaluateAll((videos) => videos.map((video) => ({ key: video.dataset.surface, url: video.getAttribute('src'), width: video.videoWidth, height: video.videoHeight })));
    assert.equal(sources.length, 5);
    for (const source of sources) {
      const surface = project.surfaces.find((item) => item.key === source.key);
      const expected = surface.mobilePreview?.url || surface.previewUrl;
      assert.equal(new URL(source.url, base).pathname, new URL(expected, base).pathname);
    }
    assert.ok(requests.every((url) => [...visited].some((id) => url.includes(`/video-scenes/${id}/`))), 'later scenes are never preloaded');
    if (scene.id !== initial.videoSceneId) assert.ok(await page.evaluate(() => window.__previous.every((video) => !video.isConnected && video.paused && !video.hasAttribute('src'))));
    console.log(`ok   ${scene.name}: five selected scoped videos play; common room unchanged`);
  }
  await page.locator('.playbtn').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => video.paused));
  await page.screenshot({ path: path.join(artifactDirectory, 'video-scenes-public-actual-phone.png') });
  assert.ok(reports.some((report) => report.videoSceneId === initial.videoScenes.at(-1).id));
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
