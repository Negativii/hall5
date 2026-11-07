import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Read a demo's authorized media, then override only its API representation in
// the browser. These fixtures never create projects, approve, or alter data.
const BASE = process.env.BASE || 'http://127.0.0.1:3215';
const SHARE_PATH = process.env.SHARE_PATH || '/s/demo';
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const emptyScene = { version: 1, room: { width: 20, depth: 10, height: 5 }, showRoomSurfaces: false, objects: [], assets: [] };
const object = (type, source = null) => ({ id: `qa-${type}`, type, name: `QA ${type}`, position: [0, 0, 0], rotation: [0, 0, 0], size: [4, 2, .1], color: '#eeeeee', source });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const response = await context.request.get(`${BASE}/api${SHARE_PATH}`);
  assert.ok(response.ok(), 'read demo fixture');
  const base = await response.json();
  let fixture;
  await context.route(`**/api${SHARE_PATH}`, (route) => route.fulfill({ json: { ...base, project: fixture } }));
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const mediaRequests = [];
  page.on('request', (request) => { if (request.url().includes('/media/')) mediaRequests.push(request.url()); });

  fixture = { ...base.project, requiredSurfaceKeys: ['right'], ready: 1, processing: 0, canApprove: true, scene: { ...emptyScene, objects: [object('screen', 'right')] } };
  await page.goto(`${BASE}${SHARE_PATH}`, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.video-pool video').count(), 1, 'only the used source gets a decoder');
  assert.equal(await page.locator('.video-pool video').getAttribute('data-surface'), 'right');
  await page.waitForFunction(() => document.querySelector('.video-pool video')?.readyState >= 3);
  assert.match(await page.locator('.curtain__foot').innerText(), /Видео: 1 из 1/);
  assert.equal(await page.getByRole('button', { name: 'Согласовать', exact: true }).isEnabled(), true, 'one used ready source is sufficient');
  await page.locator('.curtain__play').click();
  await page.waitForFunction(() => document.querySelector('.video-pool video')?.currentTime > .4 && !document.querySelector('.video-pool video')?.paused);
  assert.equal(await page.locator('.player').getAttribute('data-playback-state'), 'playing');
  assert.ok(mediaRequests.every((url) => !/\/(left|back|center|floor)\//.test(url)), 'unused media must not load');
  console.log('ok   a custom one-screen scene loads, plays, and permits review with one video');

  fixture = { ...base.project, duration: 0, requiredSurfaceKeys: [], ready: 0, processing: 0, canApprove: true, scene: { ...emptyScene, objects: [object('podium')] } };
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('.video-pool video').count(), 0, 'static scenes create no video decoders');
  assert.equal(await page.getByRole('button', { name: 'Согласовать', exact: true }).isEnabled(), true, 'a ready static scene can be approved');
  assert.equal(await page.locator('.curtain__warn').count(), 0, 'static scenes do not ask for five missing videos');
  await page.locator('.curtain__play').click();
  await page.locator('.room3d canvas').waitFor();
  assert.equal(await page.locator('.curtain').count(), 0, 'static content opens for inspection');
  console.log('ok   a static scene needs no videos and can be reviewed');

  fixture = { ...fixture, canApprove: false, scene: emptyScene };
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('button', { name: 'Согласовать', exact: true }).isDisabled(), true, 'empty content cannot be approved');
  assert.equal(await page.locator('.video-pool video').count(), 0);
  console.log('ok   an empty hidden-room scene remains blocked for approval');
  assert.deepEqual(errors, []);
  console.log('Modular player checks passed.');
} finally {
  await browser.close();
}
