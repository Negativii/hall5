import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffmpegPath } from '../server/config.js';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const tmp = path.resolve('tests/tmp');
fs.mkdirSync(tmp, { recursive: true });

const failures = [];
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name} ${extra}`);
  }
}

function createVideo(file) {
  const result = spawnSync(
    ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x160:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      file,
    ],
    { stdio: 'ignore' },
  );
  if (result.status !== 0) throw new Error('Не удалось создать тестовое видео');
}

const cookieJar = new Map();
function storeCookies(response) {
  for (const raw of response.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    cookieJar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}
function cookieHeader() {
  return [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function request(url, options = {}) {
  const response = await fetch(`${BASE}${url}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(cookieJar.size ? { Cookie: cookieHeader() } : {}),
      ...(options.headers || {}),
    },
  });
  storeCookies(response);
  return response;
}

async function json(url, options) {
  const response = await request(url, options);
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data, headers: response.headers };
}

const videoFile = path.join(tmp, 'upload-test.mp4');
createVideo(videoFile);
console.log('test video', fs.statSync(videoFile).size, 'bytes');

const login = await json('/api/login', { method: 'POST', body: JSON.stringify({ password: 'hall5' }) });
check('login', login.status === 200);

const created = await json('/api/projects', {
  method: 'POST',
  body: JSON.stringify({ title: 'API тест', client: 'Тест', eventDate: '2026-12-01' }),
});
check('create project', created.status === 201 && Boolean(created.data.project?.id));
const projectId = created.data.project.id;

const form = new FormData();
form.append('file', new File([fs.readFileSync(videoFile)], 'upload-test.mp4', { type: 'video/mp4' }));
const uploadResponse = await request(`/api/projects/${projectId}/surfaces/right`, {
  method: 'POST',
  body: form,
  headers: {},
});
check('upload accepted', uploadResponse.status === 202, String(uploadResponse.status));

let project = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 700));
  const response = await json(`/api/projects/${projectId}`);
  project = response.data.project;
  const surface = project?.surfaces.find((s) => s.key === 'right');
  if (surface?.status === 'ready' || surface?.status === 'error') break;
}
const surface = project.surfaces.find((s) => s.key === 'right');
check('surface processed', surface.status === 'ready', surface.error || surface.status);
check('surface metadata', surface.width === 640 && surface.height === 160 && surface.duration > 3.5, JSON.stringify({ w: surface.width, h: surface.height, d: surface.duration }));
check('proxy exists', Boolean(surface.previewUrl));
check('poster exists', Boolean(surface.posterUrl));
check('audio detected', surface.hasAudio === true);

const passcode = await json(`/api/projects/${projectId}/share`, {
  method: 'PATCH',
  body: JSON.stringify({ passcode: '2468' }),
});
check('set passcode', passcode.status === 200 && passcode.data.project.share.passcodeSet === true);

const preview = await fetch(`${BASE}${surface.previewUrl}`, {
  headers: { Cookie: cookieHeader(), Range: 'bytes=0-2047' },
});
check('admin preview range', preview.status === 206 && preview.headers.get('content-type') === 'video/mp4');

const publicJar = new Map();
async function publicRequest(url, options = {}) {
  const response = await fetch(`${BASE}${url}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(publicJar.size ? { Cookie: [...publicJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...(options.headers || {}),
    },
  });
  for (const raw of response.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    publicJar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return response;
}

const locked = await publicRequest(`/api/s/${project.slug}`);
check('share locked', locked.status === 401);
const wrong = await publicRequest(`/api/s/${project.slug}/unlock`, {
  method: 'POST',
  body: JSON.stringify({ passcode: '0000' }),
});
check('wrong passcode rejected', wrong.status === 401);
const unlocked = await publicRequest(`/api/s/${project.slug}/unlock`, {
  method: 'POST',
  body: JSON.stringify({ passcode: '2468' }),
});
const unlockedData = await unlocked.json();
check('unlock works', unlocked.status === 200 && Boolean(unlockedData.project?.mediaToken));
const publicProject = unlockedData.project;
const publicSurface = publicProject.surfaces.find((s) => s.key === 'right');
const publicPreview = await publicRequest(publicSurface.previewUrl);
check('public media', publicPreview.status === 200 || publicPreview.status === 206);

const comment = await publicRequest(`/api/s/${project.slug}/comments`, {
  method: 'POST',
  body: JSON.stringify({ author: 'Анна', text: 'Проверить стык', time: 2.5 }),
});
check('comment created', comment.status === 201);
const approval = await publicRequest(`/api/s/${project.slug}/approve`, {
  method: 'POST',
  body: JSON.stringify({ author: 'Анна', note: 'Готово' }),
});
check('incomplete show cannot be approved', approval.status === 409);

const adminProject = await json(`/api/projects/${projectId}`);
check('admin sees comment', adminProject.data.project.comments.length === 1);
check('incomplete show has no approval', adminProject.data.project.approval === null);

const disabled = await json(`/api/projects/${projectId}/share`, {
  method: 'PATCH',
  body: JSON.stringify({ enabled: false }),
});
check('share disabled', disabled.status === 200);
const closed = await publicRequest(`/api/s/${project.slug}`);
check('share closed', closed.status === 404);

const deleted = await json(`/api/projects/${projectId}`, { method: 'DELETE' });
check('project deleted', deleted.status === 200);

console.log('');
if (failures.length) {
  console.log('FAILURES:', failures.length);
  process.exitCode = 1;
} else {
  console.log('ALL API CHECKS PASSED');
}
