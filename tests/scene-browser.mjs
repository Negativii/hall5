import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

if (process.env.HALL5_TEST_ISOLATED !== '1') throw new Error('Run only against an isolated QA DATA_DIR with HALL5_TEST_ISOLATED=1');
const BASE = process.env.BASE || 'http://127.0.0.1:3215';
const PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'hall5-test';
const SAMPLE = process.env.SAMPLE_GLB_PATH;
if (!SAMPLE || !fs.existsSync(SAMPLE)) throw new Error('SAMPLE_GLB_PATH must point to a self-contained sample GLB');
const EDITOR_SHOT = process.env.EDITOR_SCREENSHOT || path.resolve('../hall5-editor.png');
const CLIENT_SHOT = process.env.CLIENT_SCREENSHOT || path.resolve('../hall5-client.png');
let cookie = '';
async function api(url, method = 'GET', body) {
  const form = body instanceof FormData;
  const response = await fetch(`${BASE}${url}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}) }, body: body ? form ? body : JSON.stringify(body) : undefined });
  if (url === '/api/login') cookie = response.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  const data = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
const wait = (time) => new Promise((resolve) => setTimeout(resolve, time));
const errors = [];
let project; let browser;
try {
  await api('/api/login', 'POST', { password: PASSWORD });
  project = (await api('/api/projects', 'POST', { title: 'Сцена мероприятия · экраны и мебель', client: 'Проверка HALL/5' })).project;
  console.log('ok   isolated empty project created for a scene-first workflow');

  browser = await chromium.launch({ executablePath: browserPath(), headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ru-RU' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${BASE}/login`);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL('**/admin');
  const editor = `${BASE}/admin/p/${project.id}/scene`;
  await page.goto(editor);
  await page.getByRole('heading', { name: 'Конструктор сцены', exact: true }).waitFor();
  await page.locator('.scene-viewport canvas').waitFor();
  assert.equal(await page.locator('.scene-viewport__fallback').count(), 0, 'WebGL editor must render');

  async function field(label, value) {
    const input = page.getByRole('spinbutton', { name: label, exact: true });
    await input.fill(String(value)); await input.press('Tab');
  }
  async function add(type, name, x, z) {
    await page.getByRole('button', { name: type, exact: true }).click();
    await page.getByRole('textbox', { name: 'Название объекта', exact: true }).fill(name);
    await field('position X', x); await field('position Z', z);
  }
  await add('Экран', 'Главный экран', -4.5, -2.8);
  await field('size X', 5); await field('size Y', 2.8); await field('rotation Y', 12);
  await page.getByRole('combobox', { name: 'Видео на экране' }).selectOption('right');
  await add('Подиум', 'Сценический подиум', 3, -1.5);
  await field('size X', 3); await field('size Z', 2);
  await add('Стол', 'Стол регистрации', -1.5, 2.5);
  await field('rotation Y', 30);
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: 'rotation Y', exact: true }).inputValue(), '0');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  assert.equal(await page.getByRole('spinbutton', { name: 'rotation Y', exact: true }).inputValue(), '30');
  console.log('ok   primitives, numeric transforms, undo and redo work');

  await page.locator('input[type=file]').setInputFiles(SAMPLE);
  await page.getByRole('textbox', { name: 'Название объекта', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.scene-object-list [role=listitem]').length === 4);
  await page.getByRole('textbox', { name: 'Название объекта', exact: true }).fill('Стул из GLB');
  await field('position X', 1); await field('position Z', 2.5); await field('size X', .9); await field('size Y', 1.6); await field('size Z', .9); await field('rotation Y', -25);
  const save = page.getByRole('button', { name: 'Сохранить', exact: true });
  const savedResponse = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/scene`) && response.request().method() === 'PATCH');
  await save.click(); assert.equal((await savedResponse).status(), 200);
  await page.getByText('Всё сохранено', { exact: true }).waitFor();
  const serverScene = (await api(`/api/projects/${project.id}/scene`)).scene;
  assert.equal(serverScene.objects.length, 4);
  assert.ok(serverScene.objects.some((object) => object.type === 'model' && object.assetId));
  assert.deepEqual(serverScene.objects.find((object) => object.name === 'Стул из GLB').position, [1, 0, 2.5]);
  await page.reload();
  await page.getByRole('heading', { name: 'Конструктор сцены', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.scene-object-list [role=listitem]').length === 4);
  await page.getByRole('listitem').filter({ hasText: 'Стул из GLB' }).click();
  assert.equal(await page.getByRole('spinbutton', { name: 'position X', exact: true }).inputValue(), '1');
  assert.equal(await page.locator('.scene-viewport__errors').count(), 0, 'imported model must load in editor');
  await page.waitForTimeout(600);
  await page.screenshot({ path: EDITOR_SHOT, fullPage: true });
  console.log('ok   GLB import, save and reload preserve scene and geometry');

  // A mobile-sized editor stays reachable without horizontal document overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(widths.document <= widths.viewport + 2, `mobile horizontal overflow: ${JSON.stringify(widths)}`);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Название объекта', exact: true }).scrollIntoViewIfNeeded();
  console.log('ok   mobile editor controls remain reachable and layout fits');

  const publicContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU' });
  const client = await publicContext.newPage();
  client.on('pageerror', (error) => errors.push(error.message));
  client.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const assetResponses = [];
  client.on('response', (response) => { if (response.url().includes('/assets/')) assetResponses.push(response.status()); });
  await client.goto(`${BASE}/s/${project.slug}`);
  await client.locator('.curtain__play').click();
  await client.getByRole('button', { name: '3D', exact: true }).click();
  await client.locator('.room3d canvas').waitFor();
  await client.waitForFunction(() => !document.querySelector('.curtain'));
  assert.equal(await client.locator('.video-pool video').count(), 0, 'static custom scene opens before any video is uploaded');
  const deadlineModel = Date.now() + 10000;
  while (!assetResponses.length && Date.now() < deadlineModel) await wait(100);
  assert.ok(assetResponses.includes(200), 'public model must load through authorized asset URL');
  await client.waitForTimeout(600);
  assert.equal(await client.locator('.room3d [role=status]').count(), 0, 'public model must load without an error notice');
  await client.screenshot({ path: CLIENT_SHOT, fullPage: true });
  assert.deepEqual(errors, [], 'scene and client must not raise browser errors');
  console.log('ok   customer link opens the saved 3D scene and GLB without requiring videos');
  console.log('SCENE BROWSER PASSED: editor, transforms, history, GLB, persistence, mobile, public scene');
  console.log(`Screenshots: ${EDITOR_SHOT}, ${CLIENT_SHOT}`);
} finally {
  if (browser) await browser.close();
  if (project) await api(`/api/projects/${project.id}`, 'DELETE');
}
