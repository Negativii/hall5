import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = process.env.BASE || 'http://127.0.0.1:3217';
assert.equal(new URL(base).hostname, '127.0.0.1');
assert.notEqual(new URL(base).port, '3100');
assert.ok(process.env.PRIVATE_TEST_PASSWORD);
const browser = await chromium.launch({ executablePath: browserPath(), headless: true });
const admin = await browser.newContext();
const viewer = await browser.newContext();
const page = await viewer.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
async function api(context, route, method = 'GET', data) {
  const response = await context.request.fetch(base + route, { method, data });
  assert.ok(response.ok(), `${response.status()} ${await response.text()}`);
  return response.json();
}
let id;
try {
  await api(admin, '/api/login', 'POST', { password: process.env.PRIVATE_TEST_PASSWORD });
  let { project } = await api(admin, '/api/projects', 'POST', { title: 'Consent approval fixture' });
  id = project.id;
  await api(admin, `/api/projects/${id}/scene`, 'PATCH', { contentRevision: project.contentRevision, scene: { ...project.scene, showRoomSurfaces: false, objects: [{ id: 'fixture-block', type: 'block', name: 'Тестовый блок', position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: '#cccccc' }] } });
  await api(admin, `/api/projects/${id}/share`, 'PATCH', { passcode: 'fixture-approve-password' });
  await page.goto(base + `/s/${project.slug}`);
  await page.getByLabel('Пароль показа').fill('fixture-approve-password');
  await page.getByRole('button', { name: 'Открыть', exact: true }).click();
  await page.getByRole('button', { name: 'Согласовать', exact: true }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('Ваше имя', { exact: true }).fill('Тестовый согласующий');
  const submit = modal.getByRole('button', { name: 'Согласовать', exact: true });
  assert.equal(await modal.getByRole('checkbox').isChecked(), false);
  assert.equal(await submit.isDisabled(), true);
  await modal.getByRole('checkbox').check();
  await submit.click();
  await modal.waitFor({ state: 'hidden' });
  const approved = (await api(viewer, `/api/s/${project.slug}`)).project;
  assert.equal(approved.approval.author, 'Тестовый согласующий');
  assert.equal(approved.approval.consent, undefined);
  assert.equal(await page.evaluate(() => localStorage.getItem('h5_author')), null);
  assert.deepEqual(errors, []);
  console.log('ok approval requires separate unchecked consent; submission persists and receipt remains private; no JavaScript errors');
} finally {
  if (id) await api(admin, `/api/projects/${id}`, 'DELETE');
  await browser.close();
}
