import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

// All scene metadata, media and feedback are local fixtures. No live writes.
const base = process.env.BASE || 'http://127.0.0.1:3217';
const artifactDirectory = process.env.TEST_ARTIFACT_DIR || path.resolve('tests/tmp/video-scenes');
fs.mkdirSync(artifactDirectory, { recursive: true });
const seedBase = process.env.SEED_BASE || base;
const seed = (await (await fetch(`${seedBase}/api/s/demo`)).json()).project;
assert.ok(seed, 'A demo metadata fixture must be available on SEED_BASE or BASE');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-scenes-player-'));
const media = {};
for (const [variant, size] of [['proxy', '320x80'], ['mobile', '160x40']]) {
  const filename = path.join(directory, `${variant}.mp4`);
  execFileSync(process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg', ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24`, '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', filename]);
  media[variant] = fs.readFileSync(filename);
}
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const phone = { viewport: { width: 430, height: 932 }, screen: { width: 430, height: 932 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' };
const names = { main: 'Основная сцена', welcome: 'Встреча гостей', awards: 'Награждение', finale: 'Финал' };
const state = (page, expected) => page.waitForFunction((value) => document.querySelector('.player')?.dataset.playbackState === value, expected);
const selected = (page, id) => page.waitForFunction((value) => document.querySelector('.player')?.dataset.videoScene === value, id);
const until = (condition) => new Promise((resolve, reject) => { const end = Date.now() + 10000; const poll = () => condition() ? resolve() : Date.now() > end ? reject(new Error('Timed out waiting for fixture event')) : setTimeout(poll, 25); poll(); });
async function fixture(page, { locked = false } = {}) {
  const requests = [], reports = [], reviews = [], errors = [];
  let unlocked = !locked, removed = '', revision = 7, renamed = false, delayScene = '', failScene = '', delayedComment;
  const project = (id) => ({ ...structuredClone(seed), id: 'qa-video-scenes', slug: 'demo', videoSceneId: id, videoSceneName: names[id],
    contentRevision: revision, duration: 8, canApprove: true, processing: 0, approved: false, approval: null,
    share: { allowComments: true, allowDownload: false }, scene: { ...seed.scene, objects: [], assets: [] },
    videoScenes: Object.entries(names).filter(([key]) => key !== removed).map(([key, name]) => ({ id: key, name: renamed && key === 'finale' ? 'Финал обновлён' : name,
      published: true, contentRevision: revision, publishedRevision: revision, ready: 5, total: 5, processing: 0, isDefault: key === 'main', approved: false })),
    comments: [{ id: `comment-${id}`, author: 'Заказчик', text: `Отзыв: ${names[id]}`, time: 0, createdAt: new Date().toISOString() }],
    surfaces: seed.surfaces.map((surface) => ({ ...surface, status: 'ready', duration: 8, width: 320, height: 80, fps: 24, previewWidth: 320, previewHeight: 80, previewFps: 24,
      previewUrl: `/api/s/demo/video-scenes/${id}/media/${surface.key}/proxy?v=${revision}`, compatibilityPreview: null,
      mobilePreview: { url: `/api/s/demo/video-scenes/${id}/media/${surface.key}/mobile?v=${revision}`, codec: 'h264', mode: 'mobile', mimeType: 'video/mp4', width: 160, height: 40, fps: 24 },
      posterUrl: null, originalUrl: null, downloadUrl: null })) });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/s/demo**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/playback-diagnostics')) { reports.push(route.request().postDataJSON()); return route.fulfill({ status: 204 }); }
    if (url.pathname.endsWith('/unlock')) { unlocked = true; return route.fulfill({ json: { project: project('main') } }); }
    if (url.pathname.endsWith('/comments')) {
      const body = route.request().postDataJSON(); reviews.push(body);
      await new Promise((resolve) => { delayedComment = resolve; });
      return route.fulfill({ json: { comment: { id: 'late-comment', ...body, createdAt: new Date().toISOString() } } });
    }
    if (url.pathname.endsWith('/approve')) {
      const body = route.request().postDataJSON(); reviews.push(body);
      return route.fulfill({ json: { approval: { revision: body.contentRevision, author: body.author, note: body.note, at: new Date().toISOString() } } });
    }
    if (url.pathname.includes('/media/')) {
      requests.push(url.pathname);
      const bytes = media[url.pathname.split('/').at(-1)];
      assert.ok(bytes, `Unexpected media variant: ${url.pathname}`);
      const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        return route.fulfill({ status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Accept-Ranges': 'bytes' }, body: bytes.subarray(start, end + 1) });
      }
      return route.fulfill({ contentType: 'video/mp4', body: bytes });
    }
    if (url.pathname === '/api/s/demo') {
      if (!unlocked) return route.fulfill({ status: 401, json: { locked: true, title: 'Закрытый показ', error: 'Нужен пароль' } });
      const id = url.searchParams.get('videoScene') || 'main';
      requests.push(`metadata:${id}`);
      if (!names[id] || id === removed) return route.fulfill({ status: 404, json: { error: 'Видеосцена недоступна' } });
      if (id === delayScene) await new Promise((resolve) => setTimeout(resolve, 300));
      if (id === failScene) return route.fulfill({ status: 503, json: { error: 'Недоступно' } });
      return route.fulfill({ json: { locked: false, project: project(id) } });
    }
    return route.continue();
  });
  return { requests, reports, reviews, errors,
    rename: () => { renamed = true; }, remove: (id) => { removed = id; }, revise: () => { revision += 1; },
    delay: (id) => { delayScene = id; }, fail: (id) => { failScene = id; }, releaseComment: () => delayedComment?.() };
}
try {
  const page = await browser.newPage(phone);
  const f = await fixture(page);
  await page.goto(`${base}/s/demo`, { waitUntil: 'networkidle' });
  await selected(page, 'main');
  assert.equal(await page.locator('.video-scene-switcher__button').count(), 4);
  assert.ok(f.requests.filter((url) => url.includes('/media/')).every((url) => url.includes('/main/') && url.endsWith('/mobile')));
  assert.deepEqual(f.requests.filter((url) => url.startsWith('metadata:')), ['metadata:main']);
  await page.locator('.curtain__play').click(); await state(page, 'playing');
  await page.waitForFunction(() => document.querySelector('video')?.currentTime > .4);
  await page.evaluate(() => { window.__oldVideos = [...document.querySelectorAll('.video-pool video')]; });
  f.delay('welcome');
  await page.getByRole('button', { name: 'Встреча гостей', exact: true }).click();
  assert.ok(await page.locator('.video-pool video').evaluateAll((videos) => videos.every((video) => video.paused)));
  await selected(page, 'welcome'); await state(page, 'playing');
  assert.equal(new URL(page.url()).searchParams.get('scene'), 'welcome');
  assert.ok(await page.evaluate(() => window.__oldVideos.every((video) => !video.isConnected && video.paused && !video.getAttribute('src'))), 'old scene releases all decoder sources');
  assert.ok(await page.locator('.video-pool video').evaluateAll((videos) => videos.length === 5 && videos.every((video) => video.currentTime < 2 && video.currentSrc.includes('/welcome/'))));
  assert.ok(f.requests.filter((url) => url.includes('/media/')).every((url) => !url.includes('/awards/') && !url.includes('/finale/')), 'unselected scenes never preload');
  assert.ok(f.reports.some((report) => report.videoSceneId === 'welcome'));
  assert.equal(await page.locator('.viewswitch button.is-active').innerText(), 'Схема');
  console.log('ok   same-revision scene switches start at zero, preserve view, scope diagnostics and release old decoders; only selected media loads');

  await page.locator('.playbtn').click(); await state(page, 'paused');
  await page.getByRole('button', { name: 'Один экран', exact: true }).click(); await state(page, 'playing');
  await page.waitForFunction(() => document.querySelector('.video-pool__focused')?.videoWidth === 320);
  assert.equal(await page.locator('.video-pool video').evaluateAll((videos) => videos.filter((video) => video.hasAttribute('src')).length), 1);
  await page.getByRole('button', { name: 'Пауза видео', exact: true }).click();
  await page.locator('.focus__close').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => video.paused && video.currentSrc.includes('/mobile')));
  await page.evaluate(() => { window.__sameVideos = [...document.querySelectorAll('.video-pool video')]; });
  f.rename();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Финал обновлён', exact: true }).waitFor();
  assert.ok(await page.evaluate(() => window.__sameVideos.every((video, index) => video === document.querySelectorAll('.video-pool video')[index])), 'list refresh preserves decoder identity');
  await state(page, 'paused');
  await page.screenshot({ path: path.join(artifactDirectory, 'video-scenes-public-phone.png') });
  await page.setViewportSize({ width: 932, height: 430 });
  await page.waitForTimeout(300);
  assert.ok(await page.locator('.video-scene-switcher').evaluate((element) => element.getBoundingClientRect().bottom <= document.querySelector('.player__stage').getBoundingClientRect().top));
  assert.equal(await page.locator('.player__head').count(), 1);
  await page.screenshot({ path: path.join(artifactDirectory, 'video-scenes-public-landscape.png') });
  await page.setViewportSize({ width: 430, height: 932 });
  console.log('ok   mobile group/full-quality focus behavior survives switching; list refresh keeps paused video nodes; portrait and landscape selector fit');

  await page.locator('.comments-btn').click();
  assert.match(await page.locator('.sidepanel').innerText(), /Отзыв: Встреча гостей/);
  await page.getByPlaceholder('Ваше имя').fill('QA');
  await page.getByPlaceholder('Что поправить?').fill('Поздний отзыв для встречи');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await until(() => f.reviews.length > 0);
  assert.equal(f.reviews[0].videoSceneId, 'welcome'); assert.equal(f.reviews[0].contentRevision, 7);
  await page.getByRole('button', { name: 'Награждение', exact: true }).click();
  await selected(page, 'awards'); await state(page, 'playing');
  f.releaseComment();
  await page.locator('.comments-btn').click();
  assert.match(await page.locator('.sidepanel').innerText(), /Отзыв: Награждение/);
  assert.doesNotMatch(await page.locator('.sidepanel').innerText(), /Поздний отзыв|Встреча гостей/);
  await page.locator('.comments-btn').click();
  await page.getByRole('button', { name: 'Согласовать', exact: true }).click();
  await page.getByPlaceholder('Например, Анна, арт-директор').fill('QA');
  await page.getByRole('dialog').getByRole('button', { name: 'Согласовать', exact: true }).click();
  await page.locator('.approved-pill').waitFor();
  assert.equal(f.reviews.at(-1).videoSceneId, 'awards'); assert.equal(f.reviews.at(-1).contentRevision, 7);
  console.log('ok   comments and approvals target the selected publication; a late previous-scene comment never leaks into the new scene');

  f.fail('finale');
  await page.getByRole('button', { name: 'Финал обновлён', exact: true }).click();
  await page.getByText('Не удалось открыть видеосцену.', { exact: false }).waitFor();
  await selected(page, 'awards');
  assert.equal(new URL(page.url()).searchParams.get('scene'), 'awards');
  f.remove('awards');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await selected(page, 'main');
  await page.getByText('Эта видеосцена больше недоступна.', { exact: false }).waitFor();
  assert.equal(await page.locator('.approved-pill').count(), 0);
  assert.deepEqual(f.errors, []);
  await page.close();
  console.log('ok   a failed switch retains the previous scene; a removed scene falls back to the published default');

  const locked = await browser.newPage(phone);
  const gate = await fixture(locked, { locked: true });
  await locked.goto(`${base}/s/demo?scene=finale`, { waitUntil: 'networkidle' });
  await locked.getByPlaceholder('Пароль показа').fill('fixture-passcode');
  await locked.getByRole('button', { name: 'Открыть', exact: true }).click();
  await selected(locked, 'finale');
  assert.ok(gate.requests.filter((url) => url.includes('/media/')).every((url) => url.includes('/finale/')));
  assert.deepEqual(gate.errors, []);
  await locked.close();
  console.log('ok   protected deep links unlock directly into the selected scene without loading the default videos');
} finally {
  await browser.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
