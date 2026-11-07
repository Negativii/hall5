import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.BASE || 'http://127.0.0.1:3217';
assert.equal(new URL(base).hostname, '127.0.0.1');
assert.notEqual(new URL(base).port, '3100', 'Only use a disposable clone');
const password = process.env.PRIVATE_TEST_PASSWORD;
assert.ok(password);
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const errors = [];
const admin = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
const viewer = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await viewer.newPage(); page.on('pageerror', error => errors.push(error.message));
const adminPage = await admin.newPage(); adminPage.on('pageerror', error => errors.push(error.message));
const report = [];
const ok = message => { report.push(message); console.log(`ok ${message}`); };
const api = async (context, url, method = 'GET', data) => {
  const response = await context.request.fetch(base + url, { method, data });
  assert.ok(response.ok(), `${method} ${url}: ${response.status()} ${await response.text()}`);
  return response.json();
};
const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
try {
  await page.goto(base);
  assert.equal(await page.getByRole('link', { name: /демо/i }).count(), 0);
  await page.getByText('KUOG HALL — закрытый сервис', { exact: false }).waitFor();
  await page.goto(base + '/legal/privacy');
  await page.locator('address').waitFor();
  assert.ok((await page.locator('address').textContent()).includes('Тестовый оператор'));
  for (const route of ['terms', 'cookies', 'consent']) {
    await page.goto(`${base}/legal/${route}`);
    await page.locator('address').waitFor();
    assert.equal(await overflow(), false);
  }
  ok('generic private home and all legal documents are readable before login');
  await page.goto(base + '/s/demo');
  await page.getByText('Организатор ещё не настроил пароль.', { exact: false }).waitFor();
  assert.equal(await page.locator('video').count(), 0);
  assert.equal(await page.locator('input[type=password]').count(), 0);
  ok('legacy show without a password is locked without project metadata or video elements');

  await adminPage.goto(base + '/login');
  await adminPage.getByLabel('Пароль', { exact: true }).fill(password);
  await adminPage.getByRole('button', { name: 'Войти', exact: true }).click();
  await adminPage.waitForURL('**/admin');
  const projects = await api(admin, '/api/projects');
  const project = projects.projects.find(project => project.slug === 'demo'); assert.ok(project);
  await adminPage.goto(`${base}/admin/p/${project.id}`);
  await adminPage.getByText('Показ закрыт для заказчиков.', { exact: false }).waitFor();
  assert.equal(await adminPage.getByText('Снять пароль', { exact: true }).count(), 0);
  await adminPage.getByPlaceholder('Задайте пароль').fill('fixture-viewer-pass-1');
  await adminPage.getByRole('button', { name: 'Задать', exact: true }).click();
  await adminPage.getByText('Пароль задан · минимум 8 символов', { exact: true }).waitFor();
  ok('admin signs in and sets mandatory project password from the website');

  await page.reload();
  await page.getByLabel('Пароль показа').fill('fixture-viewer-pass-1');
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти из показа', exact: true }).waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  const visibleProject = (await api(viewer, '/api/s/demo')).project;
  const videoUrl = visibleProject.surfaces.find(surface => surface.previewUrl)?.previewUrl; assert.ok(videoUrl);
  const anon = await browser.newContext();
  assert.equal((await anon.request.get(base + videoUrl)).status(), 401);
  const range = await viewer.request.get(base + videoUrl, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status(), 206); assert.equal(range.headers()['cache-control'], 'private, no-store');
  assert.equal((await viewer.request.get(base + '/api/projects')).status(), 401);
  await anon.close();
  ok('viewer unlock works; direct media URL requires cookie and keeps Range206; no admin access');

  await page.getByRole('button', { name: 'Отзывы', exact: true }).first().click();
  await page.getByPlaceholder('Ваше имя').fill('Тестовый зритель');
  await page.getByPlaceholder('Что поправить?').fill('Проверка отдельного согласия');
  assert.ok(await page.getByRole('button', { name: 'Отправить', exact: true }).isDisabled());
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.locator('.comment__text').filter({ hasText: 'Проверка отдельного согласия' }).waitFor();
  await page.waitForFunction(() => !document.querySelector('input[type=checkbox]')?.checked);
  assert.equal(await page.getByRole('checkbox').isChecked(), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('h5_author')), null);
  ok('feedback requires unchecked separate consent, sends successfully and never stores author in localStorage');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await overflow(), false);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.getByRole('checkbox').scrollIntoViewIfNeeded();
  const box = await page.getByRole('checkbox').boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 390);
  assert.equal(await overflow(), false);
  ok('feedback consent can be reached in mobile portrait and short landscape viewport');

  await api(admin, `/api/projects/${project.id}/share`, 'PATCH', { passcode: 'fixture-viewer-pass-2' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByLabel('Пароль показа').waitFor();
  assert.equal(await page.locator('video').count(), 0);
  assert.ok(!(await page.title()).includes(project.title));
  await page.getByLabel('Пароль показа').fill('fixture-viewer-pass-2');
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await page.getByRole('button', { name: 'Выйти из показа', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Выйти из показа', exact: true }).click();
  await page.getByLabel('Пароль показа').waitFor();
  assert.equal(await page.locator('video').count(), 0);
  assert.equal((await viewer.request.get(base + '/api/s/demo')).status(), 401);
  assert.equal((await viewer.cookies()).some(cookie => cookie.name === 'h5_s_demo'), false);
  ok('password rotation returns to clean gate; new password works; logout clears viewer access');
  await page.setViewportSize({ width: 390, height: 844 });
  const output = path.resolve('../kuog-private-browser-report.json');
  fs.writeFileSync(output, JSON.stringify({ checks: report, errors }, null, 2));
  await page.screenshot({ path: path.resolve('../kuog-password-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`${report.length} browser scenarios passed; no JavaScript errors`);
} finally { await browser.close(); }
