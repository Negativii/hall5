import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';

// This suite creates and deletes its own project on a disposable test server.
// Never run mutations against the user's live show on port 3100.
const base = process.env.BASE || 'http://127.0.0.1:3217';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
assert.notEqual(new URL(base).port, '3100', 'Use an isolated DATA_DIR/test server, never the live show');
assert.ok(process.env.VIDEO_SCENES_TEST_PASSWORD, 'Pass the private test server password in VIDEO_SCENES_TEST_PASSWORD');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-video-scenes-ui-'));
const video = process.env.VIDEO_SCENES_TEST_VIDEO || path.join(temporary, 'sample.mp4');
if (!process.env.VIDEO_SCENES_TEST_VIDEO) execFileSync(process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg', [
  '-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x80:rate=24',
  '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video,
]);
const bytes = fs.readFileSync(video);
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let id;
const json = async (url, options) => {
  const result = await context.request.fetch(`${base}${url}`, options);
  assert.ok(result.ok(), `${options?.method || 'GET'} ${url}: ${result.status()} ${await result.text()}`);
  return result.json();
};
const selected = async name => {
  await page.getByRole('tabpanel').getByRole('heading', { name, exact: true }).waitFor();
  assert.equal(await page.locator('.surface-card').count(), 5, 'only one selected set of five upload cards exists');
};
const getProject = sceneId => json(`/api/projects/${id}${sceneId ? `?videoScene=${encodeURIComponent(sceneId)}` : ''}`);
const publicProject = async slug => {
  const response = await fetch(`${base}/api/s/${slug}`);
  assert.equal(response.status, 200);
  return (await response.json()).project;
};
const uploadCard = async (index, name) => page.locator('.surface-card input[type=file]').nth(index)
  .setInputFiles({ name, mimeType: 'video/mp4', buffer: bytes });
const waitPublishable = () => page.waitForFunction(() => {
  const button = [...document.querySelectorAll('.video-scenes-admin__publish button')][0];
  return button && !button.disabled;
}, null, { timeout: 60000 });

try {
  await json('/api/login', { method: 'POST', data: { password: process.env.VIDEO_SCENES_TEST_PASSWORD } });
  const created = await json('/api/projects', { method: 'POST', data: { title: 'Video scenes admin integration' } });
  id = created.project.id;
  const slug = created.project.slug;
  const room = created.project.scene;
  await page.goto(`${base}/admin/p/${id}`, { waitUntil: 'networkidle' });
  await selected('Основная сцена');
  assert.equal(await page.getByRole('button', { name: 'Удалить сцену', exact: true }).count(), 0, 'main scene cannot be deleted');
  assert.ok(await page.locator('.video-scenes-admin__publish > button').isDisabled());
  for (let index = 0; index < 5; index++) await uploadCard(index, `main-${index}.mp4`);
  await waitPublishable();
  await page.locator('.video-scenes-admin__publish > button').click();
  await page.getByRole('button', { name: 'Опубликовать изменения', exact: true }).waitFor();
  const publicMain = await publicProject(slug);
  assert.ok(publicMain.videoScenes.some(scene => scene.id === 'main'));
  const originalFiles = (await getProject('main')).project.surfaces.map(surface => surface.originalName);
  console.log('ok   main scene can publish a complete five-channel set and cannot be deleted');

  await page.getByRole('button', { name: 'Добавить сцену', exact: true }).click();
  const createDialog = page.getByRole('dialog', { name: 'Добавить сцену', exact: true });
  await createDialog.getByLabel('Название сцены', { exact: true }).fill('Встреча гостей');
  await createDialog.getByRole('button', { name: 'Добавить сцену', exact: true }).click();
  await selected('Встреча гостей');
  const sceneId = new URL(page.url()).searchParams.get('videoScene');
  assert.ok(sceneId && sceneId !== 'main');
  assert.ok(await page.getByRole('button', { name: 'Опубликовать сцену', exact: true }).isDisabled());
  assert.deepEqual((await getProject(sceneId)).project.scene, room);
  assert.ok(!(await publicProject(slug)).videoScenes.some(scene => scene.id === sceneId));

  // Hold an actual upload response while switching scenes. Its late completion
  // must not replace the selected scene's metadata or attach files to main.
  let releaseUpload, sawUpload;
  const caughtUpload = new Promise(resolve => { sawUpload = resolve; });
  const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
  const uploadPath = `**/api/projects/${id}/video-scenes/${sceneId}/surfaces/right`;
  await page.route(uploadPath, async route => { sawUpload(); await uploadGate; await route.continue(); });
  await uploadCard(0, 'guest-right.mp4');
  await caughtUpload;
  await page.getByRole('tab', { name: /Основная сцена/ }).click();
  await selected('Основная сцена');
  const uploaded = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/video-scenes/${sceneId}/surfaces/right`));
  releaseUpload();
  await uploaded;
  await page.waitForTimeout(250);
  await selected('Основная сцена');
  assert.deepEqual((await getProject('main')).project.surfaces.map(surface => surface.originalName), originalFiles);
  await page.unroute(uploadPath);
  await page.getByRole('tab', { name: /Встреча гостей/ }).click();
  await selected('Встреча гостей');
  for (let index = 1; index < 5; index++) await uploadCard(index, `guest-${index}.mp4`);
  await waitPublishable();
  assert.ok(!(await publicProject(slug)).videoScenes.some(scene => scene.id === sceneId), 'complete draft stays private until explicit publish');
  console.log('ok   new scene stays private and late uploads cannot reset selection or overwrite another scene');

  await page.getByRole('button', { name: 'Переименовать сцену', exact: true }).click();
  const renameDialog = page.getByRole('dialog', { name: 'Переименовать сцену', exact: true });
  await renameDialog.getByLabel('Название сцены', { exact: true }).fill('Награждение');
  await renameDialog.getByRole('button', { name: 'Сохранить название', exact: true }).click();
  await selected('Награждение');
  await page.getByRole('button', { name: 'Опубликовать сцену', exact: true }).click();
  await page.getByRole('button', { name: 'Опубликовать изменения', exact: true }).waitFor();
  assert.ok((await publicProject(slug)).videoScenes.some(scene => scene.id === sceneId && scene.name === 'Награждение'));
  assert.deepEqual((await getProject(sceneId)).project.scene, room);

  for (const [feedbackScene, author] of [['main', 'Main reviewer'], [sceneId, 'Scene reviewer']]) {
    const data = await getProject(feedbackScene);
    await json(`/api/s/${slug}/comments`, { method: 'POST', data: { videoSceneId: feedbackScene, author, text: `${author} comment`, time: 0 } });
    await json(`/api/s/${slug}/approve`, { method: 'POST', data: { videoSceneId: feedbackScene, author, contentRevision: data.project.contentRevision } });
  }
  await page.reload({ waitUntil: 'networkidle' });
  await selected('Награждение');
  await page.getByText('Scene reviewer comment', { exact: true }).waitFor();
  assert.equal(await page.getByText('Main reviewer comment', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Сбросить согласование', exact: true }).click();
  await page.getByRole('button', { name: 'Сбросить согласование', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Удалить комментарий', exact: true }).click();
  await page.getByText('Scene reviewer comment', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await getProject(sceneId)).project.approval, null);
  assert.equal((await getProject(sceneId)).project.comments.length, 0);
  assert.equal((await getProject('main')).project.approval.author, 'Main reviewer');
  assert.equal((await getProject('main')).project.comments.length, 1);
  console.log('ok   selected-scene comments and approval reset never alter another scene’s feedback');

  await page.getByRole('button', { name: 'Настройки проекта', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Настройки проекта', exact: true });
  await settings.getByLabel('Название', { exact: true }).fill('Video scenes shared metadata');
  await settings.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  await selected('Награждение');
  assert.equal(new URL(page.url()).searchParams.get('videoScene'), sceneId, 'global metadata changes retain the selected scene');
  const customerLink = page.getByRole('link', { name: 'Открыть как заказчик', exact: true });
  assert.equal(new URL(await customerLink.getAttribute('href'), base).searchParams.get('scene'), sceneId,
    'customer links use the public scene selector, not the admin/API query parameter');
  const opened = context.waitForEvent('page');
  await customerLink.click();
  const customerPage = await opened;
  await customerPage.waitForFunction(sceneId => document.querySelector('.player')?.dataset.videoScene === sceneId, sceneId);
  assert.equal(new URL(customerPage.url()).searchParams.get('scene'), sceneId);
  await customerPage.close();
  await page.getByRole('button', { name: 'Открыть показ', exact: true }).first().click();
  await page.waitForURL(url => url.pathname.endsWith('/present') && url.searchParams.get('videoScene') === sceneId);
  await page.goto(`${base}/admin/p/${id}?videoScene=${sceneId}`, { waitUntil: 'networkidle' });
  await selected('Награждение');
  await page.screenshot({ path: path.join(temporary, 'video-scenes-admin-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(temporary, 'video-scenes-admin-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'scene controls do not cause mobile horizontal overflow');
  console.log('ok   rename, explicit publication, shared settings and preview keep the selected scene and common room');

  await page.getByRole('button', { name: 'Удалить сцену', exact: true }).click();
  await page.getByRole('dialog', { name: 'Удалить сцену «Награждение»?', exact: true }).getByRole('button', { name: 'Удалить', exact: true }).click();
  await selected('Основная сцена');
  assert.ok(!(await publicProject(slug)).videoScenes.some(scene => scene.id === sceneId));
  assert.deepEqual((await getProject('main')).project.scene, room);
  assert.deepEqual((await getProject('main')).project.surfaces.map(surface => surface.originalName), originalFiles);
  assert.deepEqual(errors, []);
  console.log('ok   deleting a published scene preserves main videos and the common furniture layout');
  console.log(JSON.stringify({ screenshots: temporary }));
} finally {
  if (id) await context.request.delete(`${base}/api/projects/${id}`);
  await browser.close();
  // Keep screenshots for visual review; fixture bytes are disposable.
  if (!process.env.VIDEO_SCENES_TEST_VIDEO) fs.rmSync(video, { force: true });
}
