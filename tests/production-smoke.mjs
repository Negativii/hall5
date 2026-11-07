import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import ffmpeg from 'ffmpeg-static';
import { browserPath } from './browser-path.mjs';

// A real production server, real video processing and a fresh viewer session.
// Never load .env or the archived database.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-production-'));
const base = 'http://127.0.0.1:3237';
const password = 'isolated-production-smoke-password';
const child = spawn(process.execPath, ['server/index.js', '--prod'], {
  env: { ...process.env, DATA_DIR: directory, HOST: '127.0.0.1', PORT: '3237', ADMIN_PASSWORD: password },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser;
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const exited = once(child, 'exit');
async function waitFor(predicate, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Server stopped: ${logs}`);
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${logs}`);
}
let cookie = '';
async function api(url, method = 'GET', body) {
  const form = body instanceof FormData;
  const response = await fetch(base + url, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? form ? body : JSON.stringify(body) : undefined });
  assert.ok(response.ok, `${url}: ${response.status} ${await response.clone().text()}`);
  if (url === '/api/login') cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return response.json();
}
try {
  await waitFor(() => fetch(base + '/api/health').then(r => r.ok).catch(() => false));
  await api('/api/login', 'POST', { password });
  const { project } = await api('/api/projects', 'POST', { title: 'Production smoke' });
  const file = path.join(directory, 'sample.mp4');
  execFileSync(process.env.FFMPEG_PATH || ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=320x160:rate=24', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { windowsHide: true });
  for (const key of ['right', 'back', 'left', 'center', 'floor']) {
    const form = new FormData(); form.append('file', new File([fs.readFileSync(file)], 'sample.mp4', { type: 'video/mp4' }));
    await api(`/api/projects/${project.id}/video-scenes/main/surfaces/${key}`, 'POST', form);
  }
  let ready;
  await waitFor(async () => {
    ready = (await api(`/api/projects/${project.id}`)).project;
    return ready.ready === 5 && ready.processing === 0;
  });
  await api(`/api/projects/${project.id}/video-scenes/main/publish`, 'POST', { contentRevision: ready.contentRevision });
  await api(`/api/projects/${project.id}/share`, 'PATCH', { passcode: 'viewer-smoke-password' });
  browser = await chromium.launch({ executablePath: browserPath(), headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/login');
  await page.getByLabel('Пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.waitForURL('**/admin');
  await page.getByText('Production smoke', { exact: true }).waitFor({ state: 'visible' });
  const viewer = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  viewer.on('pageerror', error => errors.push(error.message));
  await viewer.goto(`${base}/s/${project.slug}`);
  await viewer.getByLabel('Пароль показа').fill('viewer-smoke-password');
  await viewer.getByRole('button', { name: 'Открыть', exact: true }).click();
  await viewer.getByRole('button', { name: 'Смотреть', exact: true }).click();
  await viewer.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing');
  await viewer.getByTitle('Схема поверхностей', { exact: true }).click();
  await viewer.getByRole('button', { name: 'Пауза', exact: true }).click();
  await viewer.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].every(v => v.paused));
  await viewer.getByTitle('3D-зал', { exact: true }).click();
  await viewer.locator('canvas').first().waitFor({ state: 'visible' });
  assert.deepEqual(errors, []);
  console.log('PRODUCTION SMOKE PASSED: login, five uploads, FFmpeg, publication, viewer password, playback, pause, board and 3D; no JS errors');
} finally {
  await browser?.close();
  child.kill(); await exited;
  fs.rmSync(directory, { recursive: true, force: true });
}
