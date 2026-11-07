import { browserPath } from './browser-path.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// Frontend-only server and browser-local API fixtures: no backend, .env,
// project database or actual media is read or changed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let vite, browser, releaseSave;
try {
  vite = await createServer({ root, envDir: false, server: { host: '127.0.0.1', port: 3228, strictPort: true } });
  await vite.listen();
  const base = 'http://127.0.0.1:3228';
  browser = await chromium.launch({ executablePath: browserPath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], unexpected = []; page.on('pageerror', error => errors.push(error.message));
  const floor = { id: 'floor-object', type: 'floor', name: 'Рабочий пол', color: '#888888', position: [0, 0, 0], rotation: [0, 0, 0], size: [3, .1, 3], source: null };
  const makeScene = width => ({ version: 1, room: { width, depth: 10, height: 5 }, showRoomSurfaces: false, objects: [structuredClone(floor)], assets: [] });
  const projects = { first: { scene: makeScene(20), contentRevision: 0 }, second: { scene: makeScene(9), contentRevision: 0 } };
  let holdNextSave = false, observedSave;
  let conflictNext = '';
  let submitted;
  await context.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/api\/projects\/(first|second)\/scene$/);
    if (!match) {
      unexpected.push(`${route.request().method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { error: 'Unexpected fixture request' } });
    }
    const project = projects[match[1]];
    if (route.request().method() === 'GET') return route.fulfill({ json: project });
    const body = route.request().postDataJSON();
    if (conflictNext) {
      project.contentRevision += 1;
      if (conflictNext === 'geometry') project.scene.room.width = 80;
      conflictNext = '';
      return route.fulfill({ status: 409, json: { error: 'Проект изменился' } });
    }
    assert.equal(body.contentRevision, project.contentRevision);
    submitted = structuredClone(body.scene);
    const reply = { scene: structuredClone(body.scene), contentRevision: project.contentRevision + 1 };
    if (holdNextSave) {
      holdNextSave = false;
      const gate = new Promise(resolve => { releaseSave = resolve; });
      observedSave?.();
      await gate;
    }
    Object.assign(project, reply);
    await route.fulfill({ json: reply });
  });
  const width = () => page.getByRole('spinbutton', { name: 'Помещение: width', exact: true });
  const save = () => page.getByRole('button', { name: 'Сохранить', exact: true });
  const nextHeldSave = () => { holdNextSave = true; return new Promise(resolve => { observedSave = resolve; }); };
  await page.goto(base + '/admin/p/first/scene');
  await width().waitFor();
  assert.equal(await save().isDisabled(), true);
  await width().fill('22');
  assert.equal(await save().isEnabled(), true, 'a numeric edit can be saved without an extra blur click');
  const started = nextHeldSave();
  await save().click(); await started;
  await width().fill('24');
  releaseSave();
  await page.getByText('Предыдущие изменения сохранены', { exact: true }).waitFor();
  assert.equal(await width().inputValue(), '24', 'late save must preserve subsequent edits');
  assert.equal(submitted.room.width, 22);
  assert.equal(await save().isEnabled(), true);
  await save().click();
  await page.getByText('Всё сохранено', { exact: true }).waitFor();
  assert.equal(projects.first.scene.room.width, 24);
  console.log('ok numeric edits enable Save immediately and late save replies preserve newer local edits');

  const stale = { scene: { ...structuredClone(projects.first.scene), room: { width: 35, depth: 10, height: 5 } }, revision: 0 };
  await page.evaluate(value => localStorage.setItem('hall5-scene-draft:first', JSON.stringify(value)), stale);
  await page.reload();
  const recovery = page.getByRole('dialog', { name: 'Восстановить черновик сцены?' });
  await recovery.getByText('На сервере появилась более новая версия проекта.', { exact: false }).waitFor();
  assert.ok(await page.evaluate(() => localStorage.getItem('hall5-scene-draft:first')));
  await recovery.getByRole('button', { name: 'Восстановить черновик', exact: true }).click();
  assert.equal(await width().inputValue(), '35');
  await save().click(); await page.getByText('Всё сохранено', { exact: true }).waitFor();
  assert.equal(projects.first.scene.room.width, 35);
  console.log('ok stale local drafts remain available and require an explicit recovery choice');

  await page.getByRole('listitem').filter({ hasText: 'Рабочий пол' }).click();
  await page.getByRole('combobox', { name: 'Видео на полу', exact: true }).selectOption('floor');
  await page.getByRole('textbox', { name: 'Название объекта', exact: true }).fill('А'.repeat(120));
  await page.getByRole('spinbutton', { name: 'position X', exact: true }).fill('500');
  await page.getByRole('spinbutton', { name: 'position Z', exact: true }).fill('500');
  await page.getByRole('button', { name: 'Дублировать объект', exact: true }).click();
  assert.ok((await page.getByRole('textbox', { name: 'Название объекта', exact: true }).inputValue()).length <= 120);
  assert.equal(await page.getByRole('spinbutton', { name: 'position X', exact: true }).inputValue(), '500');
  assert.equal(await page.getByRole('spinbutton', { name: 'position Z', exact: true }).inputValue(), '500');
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  assert.equal(await page.getByRole('listitem').count(), 1);
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  assert.equal(await page.getByRole('listitem').count(), 2);
  await save().click(); await page.getByText('Всё сохранено', { exact: true }).waitFor();
  assert.equal(projects.first.scene.objects[0].source, 'floor');
  assert.equal(projects.first.scene.objects.length, 2);
  console.log('ok floor source is editable and duplicates stay within name/position limits');

  await width().fill('42');
  const pending = nextHeldSave(); await save().click(); await pending;
  await page.evaluate(() => { history.pushState({}, '', '/admin/p/second/scene'); dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForFunction(() => document.querySelector('input[aria-label="Помещение: width"]')?.value === '9');
  releaseSave();
  await page.waitForTimeout(150);
  assert.equal(await width().inputValue(), '9', 'an old project reply must not replace the newly opened editor');
  assert.equal(await save().isDisabled(), true);
  console.log('ok late replies from another project cannot change the active editor');
  await width().fill('12'); conflictNext = 'metadata';
  await save().click(); await page.getByText('Всё сохранено', { exact: true }).waitFor();
  assert.equal(projects.second.scene.room.width, 12);
  console.log('ok unrelated video-revision changes retry safely when saved geometry is unchanged');
  await width().fill('14'); conflictNext = 'geometry';
  await save().click();
  await page.getByRole('alert').getByText('Проект изменился в другой вкладке.', { exact: false }).waitFor();
  assert.equal(await width().inputValue(), '14');
  assert.equal(projects.second.scene.room.width, 80, 'conflicting remote layout must not be overwritten');
  console.log('ok a real layout conflict preserves both the remote layout and the local draft');
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, [], 'every API request must be explicitly handled by a synthetic fixture');
  console.log('SCENE WORKFLOW: 6 scenarios passed; no JavaScript errors');
} finally {
  releaseSave?.();
  try { await browser?.close(); }
  finally { await vite?.close(); }
}
