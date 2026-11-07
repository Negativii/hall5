import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { browserPath } from './browser-path.mjs';

const remote = process.env.PAGES_URL;
const base = remote || 'http://127.0.0.1:3241/hall5/';
const child = remote ? null : spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '3241', '--strictPort'], {
  env: { ...process.env, PAGES_BASE: '/hall5/' }, windowsHide: true, stdio: 'ignore',
});
const exit = child ? once(child, 'exit') : null;
let browser;
try {
  if (child) {
    for (let i = 0; ; i++) {
      if (await fetch(base).then(r => r.ok).catch(() => false)) break;
      if (i > 100 || child.exitCode !== null) throw new Error('Preview did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  browser = await chromium.launch({ executablePath: browserPath(), headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    const errors = [], api = [], failures = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url()); });
    page.on('response', r => { if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`); });
    await page.goto(base);
    await page.getByText('Публичное демо', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Смотреть', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.player')?.dataset.playbackState === 'playing');
    await page.waitForFunction(() => [...document.querySelectorAll('.video-pool video')].length === 5
      && [...document.querySelectorAll('.video-pool video')].every(v => v.readyState >= 3 && !v.paused));
    await page.getByTitle('Схема поверхностей', { exact: true }).click();
    await page.getByRole('button', { name: 'Пауза', exact: true }).click();
    await page.getByTitle('3D-зал', { exact: true }).click();
    await page.locator('canvas').first().waitFor({ state: 'visible' });
    if (width === 1440) await page.screenshot({ path: 'docs/screens/pages-demo.png' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
    await page.goto(base + '#/legal/privacy');
    await page.getByRole('heading', { name: 'О публичном демо' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'О публичном демо' }).waitFor();
    assert.deepEqual(errors, []); assert.deepEqual(api, []); assert.deepEqual(failures, []);
    console.log(`PAGES ${width}px PASSED: five videos, playback, pause, board, 3D, refresh, no API calls or HTTP/JS errors`);
    await page.close();
  }
} finally {
  await browser?.close();
  if (child) { child.kill(); await exit; }
}
