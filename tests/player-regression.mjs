import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

// Read-only checks against the five-video demo. Synthetic diagnostics and
// comment submission are intercepted in the browser, never written to storage.
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SHARE_PATH = process.env.SHARE_PATH || '/s/demo';
const browser = await chromium.launch({
  executablePath: browserPath(),
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
await page.route('**/api/s/*/playback-diagnostics', (route) => route.fulfill({ status: 204 }));
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const state = async (expected) => page.waitForFunction((value) => document.querySelector('.player')?.dataset.playbackState === value, expected);
const sample = () => page.locator('.video-pool video').evaluateAll((videos) => videos.map((video) => ({ time: video.currentTime, paused: video.paused, readyState: video.readyState, rate: video.playbackRate })));
const progressing = () => page.waitForFunction(() => {
  const videos = [...document.querySelectorAll('.video-pool video')];
  return videos.length === 5 && videos.every((video) => !video.paused && video.currentTime > 0.35);
});
async function seekRatio(ratio) {
  const box = await page.locator('.timeline').boundingBox();
  assert.ok(box, 'timeline is visible');
  await page.mouse.click(box.x + box.width * ratio, box.y + box.height / 2);
}
function synchronized(videos) {
  assert.equal(videos.length, 5);
  const times = videos.map((video) => video.time);
  assert.ok(Math.max(...times) - Math.min(...times) < 0.18, `surfaces drifted: ${JSON.stringify(videos)}`);
}
async function frozen() {
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => video.paused));
  const before = await sample();
  const timelineBefore = await page.locator('.timeline').getAttribute('aria-valuenow');
  await page.waitForTimeout(450);
  const after = await sample();
  after.forEach((video, index) => assert.ok(Math.abs(video.time - before[index].time) < 0.04, 'paused media must not advance'));
  assert.equal(await page.locator('.timeline').getAttribute('aria-valuenow'), timelineBefore, 'paused timeline must not advance');
}

try {
  await page.goto(`${BASE}${SHARE_PATH}`, { waitUntil: 'networkidle' });
  await page.locator('.curtain__play').click();
  await page.waitForFunction(() => {
    const videos = [...document.querySelectorAll('.video-pool video')];
    return videos.length === 5 && videos.every((video) => video.readyState >= 3);
  });
  const duration = await page.locator('.video-pool video').evaluateAll((videos) => Math.min(...videos.map((video) => video.duration)));
  await state('playing');
  await progressing();
  synchronized(await sample());
  console.log('ok   all five video tracks advance together');

  await page.locator('.playbtn').click();
  await state('paused');
  await frozen();
  await seekRatio(0.3);
  await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every((video) => !video.seeking));
  const afterSeek = await sample();
  synchronized(afterSeek);
  assert.ok(afterSeek.every((video) => video.paused && Math.abs(video.time / duration - 0.3) < 0.03), 'seek retains a common paused position');
  await page.locator('.playbtn').click();
  await state('playing');
  console.log('ok   pause and seek apply to all five tracks');

  await page.locator('video[data-surface="floor"]').evaluate((video) => {
    Object.defineProperty(video, 'readyState', { configurable: true, get: () => 2 });
    video.dispatchEvent(new Event('waiting'));
  });
  await state('buffering');
  await frozen();
  await page.locator('video[data-surface="floor"]').evaluate((video) => {
    delete video.readyState;
    video.dispatchEvent(new Event('canplay'));
  });
  await state('playing');
  await page.waitForTimeout(300);
  synchronized(await sample());
  console.log('ok   one buffering track freezes every track and the timeline; all resume');

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await state('buffering');
  await frozen();
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await state('playing');
  synchronized(await sample());
  console.log('ok   simulated background visibility pauses and resumes the group');

  await page.locator('.playbtn').click();
  await state('paused');
  await page.locator('video[data-surface="right"]').evaluate((video) => {
    video.play = () => Promise.reject(new DOMException('Injected autoplay rejection', 'NotAllowedError'));
  });
  await page.locator('.playbtn').click();
  await state('error');
  assert.match(await page.locator('.playback-error').innerText(), /Браузер не разрешил/);
  await frozen();
  await page.locator('video[data-surface="right"]').evaluate((video) => { delete video.play; });
  await page.locator('.playback-error').getByRole('button', { name: 'Повторить', exact: true }).click();
  await state('playing');
  await page.waitForTimeout(300);
  synchronized(await sample());
  console.log('ok   rejected play freezes timeline, shows an error, and retries explicitly');

  await seekRatio(0.98);
  await page.waitForFunction(() => {
    const videos = [...document.querySelectorAll('.video-pool video')];
    return videos.length === 5 && videos.every((video) => !video.paused && video.currentTime > 0.05 && video.currentTime < 2);
  });
  synchronized(await sample());
  console.log('ok   loop restarts all five tracks after the end');

  await page.getByRole('button', { name: 'Выключить повтор', exact: true }).click();
  await seekRatio(0.98);
  await state('paused');
  await frozen();
  await page.locator('.playbtn').click();
  await state('playing');
  await progressing();
  console.log('ok   loop off stops at the end and play restarts from zero');

  // Intercept feedback so this test does not write a comment into the fixture.
  let submitted;
  await page.route('**/api/s/*/comments', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { comment: { id: 'qa-comment', ...submitted, createdAt: new Date().toISOString() } } });
  });
  await page.locator('.comments-btn').click();
  await page.getByPlaceholder('Ваше имя').fill('QA');
  const textarea = page.getByPlaceholder('Что поправить?');
  await textarea.fill('Timestamp stays at the start of composing');
  const stamped = await page.locator('.comment-form__at').innerText();
  const beforeCompose = (await sample())[0].time;
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.comment-form__at').innerText(), stamped, 'typing keeps the original timestamp');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.locator('.comment__text').filter({ hasText: 'Timestamp stays at the start of composing' }).waitFor();
  assert.ok(submitted && Math.abs(submitted.time - beforeCompose) < 0.35, 'submitted timestamp belongs to composing start');
  console.log('ok   comment time is captured when composing begins');

  assert.deepEqual(pageErrors, [], 'browser must have no uncaught errors');
  console.log('Player regression checks passed.');
} finally {
  await browser.close();
}
