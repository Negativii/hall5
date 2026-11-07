import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const EDGE =
  process.env.EDGE_PATH ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SHOTS = path.resolve('tests/shots');
fs.mkdirSync(SHOTS, { recursive: true });

const errors = [];
const browser = await chromium.launch({
  executablePath: EDGE,
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'ru-RU',
});
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => {
  if (!request.url().includes('favicon')) errors.push(`failed: ${request.url()} ${request.failure()?.errorText}`);
});

async function shot(name, options = {}) {
  await page.waitForTimeout(options.wait ?? 700);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: Boolean(options.full) });
  console.log('shot', name);
}

await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await shot('landing');
await shot('landing-full', { full: true, wait: 300 });

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await shot('login');

await page.fill('input[type="password"]', 'hall5');
await page.click('button[type="submit"]');
await page.waitForURL('**/admin', { timeout: 15000 });
await page.waitForTimeout(1200);
await shot('admin');

const card = page.locator('.project-card__main').first();
await card.click();
await page.waitForURL('**/admin/p/**');
await page.waitForTimeout(800);
await shot('project');
await shot('project-full', { full: true, wait: 300 });

await page.getByRole('button', { name: /Открыть показ/i }).first().click();
await page.waitForURL('**/present');
await page.waitForTimeout(2500);
await shot('present-curtain');

const playButton = page.locator('.curtain__play');
if (await playButton.count()) {
  await playButton.click();
  await page.waitForTimeout(4500);
  await shot('present-3d');

  await page.getByRole('button', { name: 'Схема' }).click();
  await page.waitForTimeout(1500);
  await shot('present-board');

  await page.locator('.comments-btn').click();
  await page.waitForTimeout(800);
  await shot('present-comments');
}

const publicContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'ru-RU',
});
const publicPage = await publicContext.newPage();
publicPage.on('pageerror', (error) => errors.push(`public pageerror: ${error.message}`));
publicPage.on('console', (message) => {
  if (message.type() === 'error') errors.push(`public console: ${message.text()}`);
});
await publicPage.goto(`${BASE}/s/demo`, { waitUntil: 'networkidle' });
await publicPage.waitForTimeout(1800);
await publicPage.screenshot({ path: path.join(SHOTS, 'share-curtain.png') });
await publicPage.locator('.curtain__play').click();
await publicPage.waitForTimeout(4500);
await publicPage.screenshot({ path: path.join(SHOTS, 'share-3d.png') });
await publicPage.getByRole('button', { name: 'Схема' }).click();
await publicPage.waitForTimeout(1200);
await publicPage.screenshot({ path: path.join(SHOTS, 'share-board.png') });

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  locale: 'ru-RU',
});
const mobilePage = await mobile.newPage();
mobilePage.on('pageerror', (error) => errors.push(`mobile pageerror: ${error.message}`));
await mobilePage.goto(`${BASE}/s/demo`, { waitUntil: 'networkidle' });
await mobilePage.waitForTimeout(1500);
await mobilePage.screenshot({ path: path.join(SHOTS, 'mobile-curtain.png') });
await mobilePage.locator('.curtain__play').click();
await mobilePage.waitForTimeout(3500);
await mobilePage.screenshot({ path: path.join(SHOTS, 'mobile-board.png') });

await browser.close();

console.log('\nERRORS:', errors.length);
for (const error of errors) console.log(' -', error);
if (errors.length) process.exitCode = 1;
