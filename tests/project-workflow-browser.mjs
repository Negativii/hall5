import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { SURFACE_SPECS } from '../src/lib/surfaces.ts';

// A frontend-only server and synthetic API data: no actual project, .env,
// backend or saved video is read or modified by this regression suite.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({ root, envDir: false, server: { host: '127.0.0.1', port: 3229, strictPort: true } });
let browser;
try {
await vite.listen();
const base = 'http://127.0.0.1:3229';
browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'ru-RU' });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [], unexpected = [], patches = [], shares = [], gets = [], cancellations = [];
page.on('pageerror', error => errors.push(error.message));
const metadata = { title: 'Исходный проект', client: 'Первый заказчик', eventDate: '2026-11-01', description: 'Исходное описание' };
const share = { enabled: true, expiresAt: null, passcodeSet: true, allowComments: true, allowDownload: false, path: '/s/workflow-fixture' };
const names = { main: 'Основная сцена', alternate: 'Другой комплект' };
const revisions = { main: 11, alternate: 22 };
let holdPatch = false, holdShare = false, holdGet = '', failPatch = false;
let releasePatch, releaseShare, releaseGet;
let workingVideo = false, replacement = null;
const until = async predicate => {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Fixture event was not observed'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const project = (scene = 'main') => ({
  ...structuredClone(metadata), id: 'workflow-fixture', slug: 'workflow-fixture',
  videoSceneId: scene, videoSceneName: names[scene], contentRevision: revisions[scene],
  createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:00:00.000Z',
  videoScenes: Object.entries(names).map(([id, name]) => ({ id, name, published: false, contentRevision: revisions[id],
    publishedRevision: null, ready: 0, total: 5, processing: 0, canPublish: false, hasUnpublishedChanges: true, isDefault: id === 'main', approved: false })),
  canPublish: false, hasUnpublishedChanges: true, requiredSurfaceKeys: SURFACE_SPECS.map(surface => surface.key),
  canApprove: false, scene: { version: 1, room: { width: 20, depth: 10, height: 5 }, showRoomSurfaces: true, objects: [], assets: [] },
  duration: 0, ready: 0, processing: 0, total: 5, status: 'draft', durationWarning: null,
  surfaces: SURFACE_SPECS.map(surface => ({ key: surface.key, num: surface.num, label: surface.label, name: surface.name,
    title: surface.name, physical: surface.physical, specW: surface.w, specH: surface.h, specRatio: surface.w / surface.h,
    status: 'empty', progress: 0, stage: null, error: null, width: 0, height: 0, fps: 0, previewMode: null,
    previewWidth: 0, previewHeight: 0, previewFps: 0, previewBitrate: 0, duration: 0, size: 0, originalName: null,
    updatedAt: null, aspectWarning: false, hasAudio: false, previewUrl: null, posterUrl: null, downloadUrl: null, replacement: null,
    ...(scene === 'main' && surface.key === 'right' && workingVideo ? { status: 'ready', originalName: 'Рабочий ролик.mp4', width: 320, height: 80, duration: 1, replacement: structuredClone(replacement) } : {}) })),
  share: structuredClone(share), comments: [], approval: null, demo: false, publicUrl: null, mediaToken: 'synthetic-token',
});
await context.route('**/api/**', async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === '/api/me') return route.fulfill({ json: { authenticated: true } });
  if (url.pathname === '/api/projects/workflow-fixture' && request.method() === 'GET') {
    const scene = url.searchParams.get('videoScene') || 'main';
    gets.push(scene);
    const data = project(scene);
    if (holdGet === scene) { holdGet = ''; await new Promise(resolve => { releaseGet = resolve; }); }
    return route.fulfill({ json: { project: data } });
  }
  if (url.pathname === '/api/projects/workflow-fixture' && request.method() === 'PATCH') {
    const body = request.postDataJSON(); patches.push(body);
    if (failPatch) { failPatch = false; return route.fulfill({ status: 503, json: { error: 'Тестовая ошибка сохранения' } }); }
    Object.assign(metadata, body);
    const data = project();
    if (holdPatch) { holdPatch = false; await new Promise(resolve => { releasePatch = resolve; }); }
    return route.fulfill({ json: { project: data } });
  }
  if (url.pathname === '/api/projects/workflow-fixture/share' && request.method() === 'PATCH') {
    const body = request.postDataJSON(); shares.push(body); Object.assign(share, body);
    const data = project();
    if (holdShare) { holdShare = false; await new Promise(resolve => { releaseShare = resolve; }); }
    return route.fulfill({ json: { project: data } });
  }
  if (url.pathname === '/api/projects/workflow-fixture/video-scenes/main/surfaces/right/replacement' && request.method() === 'DELETE') {
    cancellations.push(request.postDataJSON()); replacement = null;
    return route.fulfill({ json: { project: project('main') } });
  }
  unexpected.push(`${request.method()} ${url.pathname}`);
  return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
});
const settings = () => page.getByRole('dialog', { name: 'Настройки проекта', exact: true });
const title = () => settings().getByLabel('Название', { exact: true });
const selected = id => page.getByRole('tabpanel').getByRole('heading', { name: names[id], exact: true }).waitFor();
const openSettings = async () => { await page.getByRole('button', { name: 'Переименовать проект', exact: true }).click(); await title().waitFor(); };
let checks = 0;
const check = label => { checks++; console.log(`ok ${label}`); };
try {
  await page.goto(`${base}/admin/p/workflow-fixture?videoScene=main`);
  await selected('main');
  await openSettings();
  await title().fill('');
  await title().pressSequentially('Название без потери фокуса', { delay: 55 });
  assert.equal(await title().inputValue(), 'Название без потери фокуса');
  assert.equal(await title().evaluate(element => document.activeElement === element), true);
  await title().press('Enter');
  await settings().waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Название без потери фокуса', exact: true }).waitFor();
  assert.deepEqual(patches.at(-1), { title: 'Название без потери фокуса' });
  check('real sequential typing retains focus and Enter saves only the edited project title');

  await openSettings();
  await title().fill('Отменённое название');
  await title().press('Escape');
  await settings().waitFor({ state: 'hidden' });
  await openSettings();
  assert.equal(await title().inputValue(), 'Название без потери фокуса');
  const oldGets = gets.length;
  metadata.client = 'Заказчик из другого окна'; metadata.description = 'Описание из другого окна';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await until(() => gets.length > oldGets);
  await page.locator('.project-head').getByText('Заказчик из другого окна', { exact: false }).waitFor();
  assert.equal(await settings().getByLabel('Заказчик', { exact: true }).inputValue(), 'Первый заказчик', 'open form keeps its own draft');
  await title().fill('Сохранён только заголовок');
  await title().press('Enter');
  await settings().waitFor({ state: 'hidden' });
  assert.deepEqual(patches.at(-1), { title: 'Сохранён только заголовок' });
  assert.equal(metadata.client, 'Заказчик из другого окна'); assert.equal(metadata.description, 'Описание из другого окна');
  await openSettings();
  assert.equal(await settings().getByLabel('Заказчик', { exact: true }).inputValue(), metadata.client);
  await title().press('Escape');
  check('cancelled edits reset on reopen; saving a title cannot overwrite unrelated changes from another window');

  await openSettings();
  await title().fill('Название после повтора'); failPatch = true;
  await title().press('Enter');
  await settings().getByText('Тестовая ошибка сохранения', { exact: true }).waitFor();
  assert.equal(await title().inputValue(), 'Название после повтора');
  await title().press('Enter'); await settings().waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Название после повтора', exact: true }).waitFor();
  check('failed save keeps the editable draft and can be retried with Enter');

  holdShare = true; holdGet = 'alternate'; releaseShare = undefined; releaseGet = undefined;
  await page.getByRole('switch', { name: 'Скачивание оригиналов', exact: true }).click();
  await until(() => Boolean(releaseShare));
  await page.getByRole('tab', { name: /Другой комплект/ }).click();
  await until(() => Boolean(releaseGet));
  const shareReply = page.waitForResponse(response => response.url().endsWith('/api/projects/workflow-fixture/share') && response.request().method() === 'PATCH');
  releaseShare(); await shareReply;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  releaseGet();
  await selected('alternate');
  assert.equal(new URL(page.url()).searchParams.get('videoScene'), 'alternate');
  assert.equal(await page.getByRole('switch', { name: 'Скачивание оригиналов', exact: true }).getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByText('Загружаем проект', { exact: true }).count(), 0);
  check('late share-settings response during a scene switch cannot strand the loading screen or reset selection');

  await openSettings();
  await title().fill('Поздний ответ настроек'); holdPatch = true; holdGet = 'main'; releasePatch = undefined; releaseGet = undefined;
  await title().press('Enter');
  await until(() => Boolean(releasePatch));
  await page.goBack();
  await until(() => Boolean(releaseGet));
  const patchReply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/projects/workflow-fixture' && response.request().method() === 'PATCH');
  releasePatch(); await patchReply;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  releaseGet();
  await selected('main');
  await settings().waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Поздний ответ настроек', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('videoScene'), 'main');
  assert.equal(await page.getByText('Загружаем проект', { exact: true }).count(), 0);
  check('history navigation during a slow project save preserves the selected scene and completes loading');

  await openSettings();
  await settings().getByRole('button', { name: 'Удалить проект', exact: true }).click();
  await page.getByRole('dialog', { name: 'Удалить проект?', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Удалить проект?', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await settings().isVisible(), true);
  const last = settings().getByRole('button', { name: 'Сохранить', exact: true });
  await last.focus(); await page.keyboard.press('Tab');
  assert.equal(await settings().evaluate(element => element.contains(document.activeElement)), true);
  await page.keyboard.press('Escape'); await settings().waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
  check('nested modal Escape closes only the top dialog; focus and page scrolling recover correctly');

  workingVideo = true;
  replacement = { id: 'failed-replacement', status: 'error', progress: 0, stage: null, error: 'Ошибка тестовой замены',
    originalName: 'Новый ролик.mp4', width: 0, height: 0, duration: 0, size: 100, hasAudio: false };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Отменить замену', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить замену', exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(cancellations, [{ contentRevision: 11, replacementId: 'failed-replacement' }]);
  assert.equal(workingVideo, true);
  await page.getByText('Рабочий ролик.mp4', { exact: true }).waitFor();
  check('cancel replacement sends the selected candidate identity and retains the working video card');

  await page.setViewportSize({ width: 390, height: 844 });
  await openSettings();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
    console.log('Mobile overflow:', await page.evaluate(() => [...document.querySelectorAll('body *')]
      .map(element => ({ element: element.tagName, class: element.className, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width }))
      .filter(item => item.width > 0 && item.right > innerWidth + 1).slice(0, 20)));
  }
  await title().fill('Мобильное название'); await title().press('Enter');
  await settings().waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Мобильное название', exact: true }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  check('mobile settings save the title with Enter and emit no JavaScript errors');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile admin layout must fit the viewport');
  check('mobile admin layout has no horizontal overflow');
  await page.setViewportSize({ width: 320, height: 740 });
  await openSettings();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '320px admin layout must fit the viewport');
  await title().fill('Узкое мобильное название'); await title().press('Enter');
  await settings().waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Узкое мобильное название', exact: true }).waitFor();
  for (const target of [page.locator('.rail .logo'), page.locator('.rail__nav'), page.locator('.rail__logout'), ...await page.locator('.rail .legal-links a').all()]) {
    assert.equal(await target.isVisible(), true);
    const box = await target.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 320.5);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  check('320px layout retains visible logo, project navigation, logout and every legal link');
  console.log(`${checks} project workflow browser checks passed`);
} finally {
  releasePatch?.(); releaseShare?.(); releaseGet?.();
}
} finally {
  try { await browser?.close(); }
  finally { await vite.close(); }
}
