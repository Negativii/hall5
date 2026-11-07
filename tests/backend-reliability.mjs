import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-api-reliability-'));
process.env.DATA_DIR = path.join(directory, 'data');
process.env.ADMIN_PASSWORD = 'test-only-backend-reliability';
process.env.LEGAL_OPERATOR_NAME = 'Fixture operator';
process.env.LEGAL_OPERATOR_ADDRESS = 'Fixture address 1';
process.env.LEGAL_OPERATOR_EMAIL = 'fixture@example.invalid';
const { publicLegalConfig } = await import('../server/legal.js');
const { authRouter } = await import('../server/routes/auth.js');
const { projectsRouter } = await import('../server/routes/projects.js');
const { shareRouter } = await import('../server/routes/share.js');
const { sceneRouter } = await import('../server/routes/scene.js');
const { defaultScene } = await import('../server/sceneSchema.js');
const { store, releaseDataLock } = await import('../server/db.js');
const { ffmpegPath } = await import('../server/config.js');
const { cancelProcessing, requeueInterrupted } = await import('../server/jobs.js');
const { stageSurface } = await import('../server/surfaceLifecycle.js');

const app = express();
app.use(express.json());
app.use('/api', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/projects', sceneRouter);
app.use('/api/s', shareRouter);
app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
const server = await new Promise((resolve, reject) => { const listening = app.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve(listening)); });
const base = `http://127.0.0.1:${server.address().port}`;
let cookies = '';
const viewerCookies = new Map();
async function configureViewer(id, slug) {
  assert.equal((await request(`/api/projects/${id}/share`, { method: 'PATCH', body: { passcode: 'fixture-viewer-password' } })).status, 200);
  const unlocked = await request(`/api/s/${slug}/unlock`, { admin: false, method: 'POST', body: { passcode: 'fixture-viewer-password' } });
  assert.equal(unlocked.status, 200);
  viewerCookies.set(slug, unlocked.headers.getSetCookie().map(item => item.split(';')[0]).join('; '));
}
async function request(url, { admin = true, body, method = 'GET', headers = {} } = {}) {
  if (body && /\/(comments|approve)(?:\?|$)/.test(url) && !admin) body = { ...body, consent: { accepted: true, version: publicLegalConfig().consentVersion } };
  const response = await fetch(`${base}${url}`, { method,
    headers: { ...(admin && cookies ? { Cookie: cookies } : !admin && viewerCookies.has(url.split('?')[0].split('/')[3]) ? { Cookie: viewerCookies.get(url.split('?')[0].split('/')[3]) } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const set = response.headers.getSetCookie?.();
  if (admin && set?.length) cookies = set.map((value) => value.split(';')[0]).join('; ');
  return response;
}
async function json(url, options) { const response = await request(url, options); return { status: response.status, data: await response.json() }; }
async function upload(id, key, bytes) {
  const form = new FormData();
  form.append('file', new File([bytes], `${key}.mp4`, { type: 'video/mp4' }));
  return json(`/api/projects/${id}/surfaces/${key}`, { method: 'POST', body: form });
}
async function until(predicate, name) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${name}`);
}
let checks = 0;
function check(name, callback) { callback(); checks++; console.log(`ok ${name}`); }

try {
  const video = path.join(directory, 'sample.mp4');
  const generated = spawnSync(ffmpegPath, ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x80:rate=25',
    '-t', '1.2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', video], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const bytes = fs.readFileSync(video);
  assert.equal((await json('/api/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } })).status, 200);
  const created = await json('/api/projects', { method: 'POST', body: { title: 'Reliability test' } });
  assert.equal(created.status, 201);
  const id = created.data.project.id;
  const slug = created.data.project.slug;
  await configureViewer(id, slug);
  const diagnosticPath = `/api/s/${slug}/playback-diagnostics`;
  const diagnosticReadPath = `/api/projects/${id}/playback-diagnostics`;
  const diagnostic = { surfaceKey: 'floor', code: 3, width: 4800, height: 2400, mode: 'single', activeSurfaceKeys: ['floor'] };
  assert.equal((await request(diagnosticReadPath, { admin: false })).status, 401);
  const beforeDiagnostic = JSON.stringify(store.project(id));
  assert.equal((await request(diagnosticPath, { admin: false, method: 'POST', body: diagnostic })).status, 204);
  const diagnosticRead = await json(diagnosticReadPath);
  check('playback diagnostics are admin-readable and leave project content unchanged', () => {
    assert.equal(diagnosticRead.data.diagnostics.length, 1);
    assert.equal(diagnosticRead.data.diagnostics[0].code, 3);
    assert.equal(JSON.stringify(store.project(id)), beforeDiagnostic);
  });
  assert.equal((await request(diagnosticPath, { admin: false, method: 'POST', body: { surfaceKey: 'invalid' } })).status, 400);
  assert.equal((await request('/api/s/missing-show/playback-diagnostics', { admin: false, method: 'POST', body: diagnostic })).status, 404);
  const { scryptHash } = await import('../server/util.js');
  const passcode = scryptHash('diagnostic-test');
  const shareBeforeDiagnostic = structuredClone(store.project(id).share);
  store.project(id).share = { ...shareBeforeDiagnostic, passcodeHash: passcode.hash, passcodeSalt: passcode.salt };
  assert.equal((await request(diagnosticPath, { admin: false, method: 'POST', body: diagnostic })).status, 401);
  store.project(id).share = { ...shareBeforeDiagnostic, enabled: false };
  assert.equal((await request(diagnosticPath, { admin: false, method: 'POST', body: diagnostic })).status, 404);
  store.project(id).share = shareBeforeDiagnostic;
  check('playback diagnostics respect locked and disabled share access', () => {});
  check('incomplete project cannot be approved', () => {});
  assert.equal((await json(`/api/s/${slug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', contentRevision: 0 } })).status, 409);
  for (const key of ['right', 'back', 'left', 'center', 'floor']) assert.equal((await upload(id, key, bytes)).status, 202);
  await until(() => Object.values(store.project(id).surfaces).filter((surface) => surface.status === 'ready').length === 5, 'all five videos ready');
  const initial = (await json(`/api/s/${slug}`, { admin: false })).data.project;
  check('five real proxy videos produce a ready show and content revision', () => {
    assert.equal(initial.ready, 5); assert.equal(initial.canApprove, true); assert.equal(initial.contentRevision, 5);
    assert.equal(initial.surfaces[0].previewMode, 'copy');
    assert.equal(initial.surfaces[0].previewWidth, 320);
    assert.equal(initial.surfaces[0].previewFps, 25);
    assert.equal(initial.surfaces[0].mobilePreview.mode, 'mobile');
    assert.deepEqual([initial.surfaces[0].mobilePreview.width, initial.surfaces[0].mobilePreview.height, initial.surfaces[0].mobilePreview.fps], [320, 80, 25]);
    assert.notEqual(initial.surfaces[0].mobilePreview.url, initial.surfaces[0].previewUrl);
  });
  const approved = await json(`/api/s/${slug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', contentRevision: initial.contentRevision } });
  assert.equal(approved.status, 200);
  const oldOriginal = store.project(id).surfaces.right.file;
  const oldMobile = store.project(id).surfaces.right.mobilePreview.file;
  const broken = await upload(id, 'right', Buffer.from('this is not a video'));
  check('replacement upload preserves active surface and blocks approval during processing', () => {
    assert.equal(broken.status, 202); assert.equal(broken.data.project.surfaces[0].status, 'ready');
    assert.equal(broken.data.project.surfaces[0].replacement.status, 'processing');
    assert.equal(store.project(id).surfaces.right.file, oldOriginal);
  });
  await until(() => store.project(id).surfaces.right.replacement?.status === 'error', 'broken candidate failure');
  const afterFailure = (await json(`/api/s/${slug}`, { admin: false })).data.project;
  const playable = await request(afterFailure.surfaces[0].previewUrl, { admin: false, headers: { Range: 'bytes=0-127' } });
  check('failed candidate keeps working public playback and previous agreement', () => {
    assert.equal(afterFailure.approved, true); assert.equal(afterFailure.contentRevision, 5);
    assert.equal(afterFailure.surfaces[0].replacement, undefined); assert.equal(playable.status, 206);
    assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'projects', id, oldOriginal)), true);
    assert.equal(store.project(id).surfaces.right.mobilePreview.file, oldMobile);
    assert.equal(fs.existsSync(path.join(process.env.DATA_DIR, 'projects', id, oldMobile)), true);
  });
  await playable.arrayBuffer();
  assert.equal((await upload(id, 'right', bytes)).status, 202);
  await until(() => !store.project(id).surfaces.right.replacement && store.project(id).contentRevision === 6, 'valid candidate promotion');
  const promoted = (await json(`/api/s/${slug}`, { admin: false })).data.project;
  check('successful replacement clears agreement and advances revision once', () => {
    assert.equal(promoted.approved, false); assert.equal(promoted.contentRevision, 6);
    assert.notEqual(store.project(id).surfaces.right.file, oldOriginal);
  });
  const stale = await json(`/api/s/${slug}/approve`, { admin: false, method: 'POST', body: { author: 'Stale tab', contentRevision: 5 } });
  check('stale client cannot approve a newer show', () => assert.equal(stale.status, 409));
  const current = await json(`/api/s/${slug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', contentRevision: 6 } });
  assert.equal(current.status, 200);
  // Model a crash after the candidate was persisted, before its queued worker started.
  const recoveredFile = 'right-recovered.mp4';
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'projects', id, recoveredFile), bytes);
  stageSurface(store, id, 'right', { key: 'right', status: 'processing', file: recoveredFile, job: 'recovered-job', progress: 0 });
  check('interrupted replacement is picked up at startup', () => assert.equal(requeueInterrupted(), 1));
  await until(() => store.project(id).contentRevision === 7, 'interrupted candidate promoted');
  const deletion = await json(`/api/projects/${id}/surfaces/right`, { method: 'DELETE' });
  check('committed removal clears agreement and prevents approval of incomplete show', () => {
    assert.equal(deletion.status, 200); assert.equal(store.project(id).contentRevision, 8); assert.equal(store.project(id).approval, null);
  });
  assert.equal((await json(`/api/s/${slug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', contentRevision: 8 } })).status, 409);
  const customCreated = await json('/api/projects', { method: 'POST', body: { title: 'Custom scene' } });
  const customId = customCreated.data.project.id;
  const customSlug = customCreated.data.project.slug;
  await configureViewer(customId, customSlug);
  const screen = { id: 'screen1', type: 'screen', name: 'Screen', source: 'right',
    position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: '#ffffff' };
  const customScene = { ...defaultScene(), showRoomSurfaces: false, objects: [screen] };
  assert.equal((await json(`/api/projects/${customId}/scene`, { method: 'PATCH', body: { scene: customScene, contentRevision: 0 } })).status, 200);
  assert.equal((await json(`/api/s/${customSlug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', contentRevision: 1 } })).status, 409);
  check('an unready channel assigned to a custom screen cannot be approved', () => {});
  assert.equal((await upload(customId, 'right', bytes)).status, 202);
  await until(() => store.project(customId).surfaces.right.status === 'ready', 'custom right ready');
  const unusedFile = 'back-unused.mp4';
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'projects', customId, unusedFile), bytes);
  stageSurface(store, customId, 'back', { key: 'back', status: 'processing', file: unusedFile, job: 'unused-back', progress: 0 });
  const customPublic = (await json(`/api/s/${customSlug}`, { admin: false })).data.project;
  assert.equal((await json(`/api/s/${customSlug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', contentRevision: customPublic.contentRevision } })).status, 200);
  check('one-channel custom scene can be approved while unused uploads are pending', () => {
    assert.deepEqual(customPublic.requiredSurfaceKeys, ['right']);
    assert.equal(customPublic.canApprove, true);
    assert.equal(customPublic.processing, 1);
    assert.equal(customPublic.ready, 1);
    assert.equal(customPublic.total, 5);
  });
  const staticScene = { ...customScene, objects: [{ ...screen, type: 'chair', source: null }] };
  assert.equal((await json(`/api/projects/${customId}/scene`, { method: 'PATCH', body: { scene: staticScene, contentRevision: customPublic.contentRevision } })).status, 200);
  const staticPublic = (await json(`/api/s/${customSlug}`, { admin: false })).data.project;
  assert.equal((await json(`/api/s/${customSlug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', contentRevision: staticPublic.contentRevision } })).status, 200);
  check('static furniture scene needs no video and can be approved', () => {
    assert.deepEqual(staticPublic.requiredSurfaceKeys, []);
    assert.equal(staticPublic.duration, 0);
    assert.equal(staticPublic.canApprove, true);
    assert.equal(staticPublic.hasReviewableContent, true);
  });
  assert.equal((await json(`/api/projects/${customId}/scene`, { method: 'PATCH', body: { scene: { ...staticScene, objects: [] }, contentRevision: staticPublic.contentRevision } })).status, 200);
  assert.equal((await json(`/api/s/${customSlug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', contentRevision: staticPublic.contentRevision + 1 } })).status, 409);
  check('empty hidden scene cannot be approved', () => {});

  const rebuildPath = `/api/projects/${id}/surfaces/back/rebuild`;
  const oldSurface = structuredClone(store.project(id).surfaces.back);
  const oldPreview = fs.readFileSync(path.join(process.env.DATA_DIR, 'projects', id, oldSurface.proxy));
  const oldRevision = store.project(id).contentRevision;
  const unauthorized = await json(rebuildPath, { admin: false, method: 'POST', body: { contentRevision: oldRevision } });
  assert.equal(unauthorized.status, 401);
  assert.equal((await json(rebuildPath, { method: 'POST', body: { contentRevision: oldRevision - 1 } })).status, 409);
  check('quality rebuild requires admin and the current content revision', () => {});
  const rebuilt = await json(rebuildPath, { method: 'POST', body: { contentRevision: oldRevision } });
  check('quality rebuild stages a unique original copy and keeps current playback available', () => {
    assert.equal(rebuilt.status, 202);
    const active = store.project(id).surfaces.back;
    assert.equal(active.proxy, oldSurface.proxy);
    assert.equal(active.file, oldSurface.file);
    assert.equal(active.replacement.status, 'processing');
    assert.notEqual(active.replacement.file, oldSurface.file);
    assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR, 'projects', id, active.replacement.file)), bytes);
    assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR, 'projects', id, active.proxy)), oldPreview);
  });
  assert.equal((await json(rebuildPath, { method: 'POST', body: { contentRevision: oldRevision } })).status, 409);
  await until(() => !store.project(id).surfaces.back.replacement && store.project(id).contentRevision === oldRevision + 1, 'quality rebuild promotion');
  check('quality rebuild publishes exactly once with quality metadata', () => {
    const active = store.project(id).surfaces.back;
    assert.notEqual(active.proxy, oldSurface.proxy);
    assert.equal(active.previewMode, 'copy');
    assert.equal(active.previewWidth, active.width);
    assert.equal(active.previewHeight, active.height);
    assert.deepEqual(fs.readFileSync(path.join(process.env.DATA_DIR, 'projects', id, active.file)), bytes);
  });
  console.log(`ALL ${checks} BACKEND RELIABILITY CHECKS PASSED`);
} finally {
  await cancelProcessing();
  await new Promise((resolve) => server.close(resolve));
  releaseDataLock();
  fs.rmSync(directory, { recursive: true, force: true });
}
