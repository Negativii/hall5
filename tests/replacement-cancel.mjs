import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kuog-replacement-cancel-'));
process.env.DATA_DIR = path.join(directory, 'data');
process.env.ADMIN_PASSWORD = 'isolated-replacement-test';
const { store, releaseDataLock } = await import('../server/db.js');
const { PROJECTS_DIR, ffmpegPath } = await import('../server/config.js');
const { authRouter } = await import('../server/routes/auth.js');
const { projectsRouter } = await import('../server/routes/projects.js');
const { defaultScene } = await import('../server/sceneSchema.js');
const { videoSceneProject, createVideoScene, publishVideoScene, beginVideoSceneEdit } = await import('../server/videoScenes.js');
const { stageSurface, patchProcessing } = await import('../server/surfaceLifecycle.js');
const { adminProject, publicProject } = await import('../server/serialize.js');
const { startProcessing, cancelProcessing } = await import('../server/jobs.js');
const { enqueue, queueInfo } = await import('../server/media.js');
const app = express(); app.use(express.json());
app.use('/api', authRouter); app.use('/api/projects', projectsRouter);
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';
async function request(route, { method = 'GET', body, authenticated = true } = {}) {
  const response = await fetch(base + route, { method, headers: {
    ...(authenticated ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { response, status: response.status, data: await response.json() };
}
const ready = (key, label) => ({ key, file: `${key}-${label}.mp4`, proxy: `${key}-${label}.preview.mp4`,
  width: 320, height: 80, duration: 1, status: 'ready', job: label });
const candidate = (label, status = 'error') => ({ key: 'right', file: `right-${label}.mp4`, job: label, status, progress: 0, error: status === 'error' ? 'Broken candidate' : null });
const sceneRoute = (id, key = 'right') => `/api/projects/project1/video-scenes/${id}/surfaces/${key}/replacement`;
const cancelBody = selected => ({ contentRevision: selected.contentRevision, replacementId: selected.surfaces.right.replacement.job });
let unblock;
let checks = 0;
const check = label => { checks++; console.log(`ok ${label}`); };
async function until(predicate) {
  const end = Date.now() + 30000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for processing'); await new Promise(resolve => setTimeout(resolve, 30)); }
}
try {
  const login = await request('/api/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.status, 200); cookie = login.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const keys = ['right', 'back', 'left', 'center', 'floor'];
  store.add({ id: 'project1', slug: 'fixture', title: 'Original title', surfaces: Object.fromEntries(keys.map(key => [key, ready(key, 'old')])),
    share: { enabled: true }, comments: [], approval: { revision: 5, author: 'Reviewer' }, contentRevision: 5, scene: defaultScene() });
  const mediaDir = path.join(PROJECTS_DIR, 'project1'); fs.mkdirSync(mediaDir, { recursive: true });
  for (const key of keys) for (const suffix of ['mp4', 'preview.mp4']) fs.writeFileSync(path.join(mediaDir, `${key}-old.${suffix}`), 'original fixture');
  beginVideoSceneEdit(store.project('project1'), 'main'); store.save();
  const published = structuredClone(store.project('project1').publishedVideoScene);
  stageSurface(store, 'project1', 'right', candidate('failed'));
  let project = store.project('project1');
  assert.equal(adminProject(project).surfaces[0].replacement.id, 'failed');
  assert.equal((await request(sceneRoute('main'), { method: 'DELETE', body: cancelBody(project), authenticated: false })).status, 401);
  for (const body of [{ contentRevision: 4, replacementId: 'failed' }, { contentRevision: 5, replacementId: 'earlier' }, { contentRevision: 5 }]) {
    assert.equal((await request(sceneRoute('main'), { method: 'DELETE', body })).status, 409);
    assert.equal(store.project('project1').surfaces.right.replacement.job, 'failed');
  }
  check('unauthorized and stale cancellation attempts cannot remove a candidate');
  const cancelled = await request(sceneRoute('main'), { method: 'DELETE', body: cancelBody(project) });
  assert.equal(cancelled.status, 200); project = store.project('project1');
  assert.equal(project.surfaces.right.replacement, undefined);
  assert.equal(project.surfaces.right.file, 'right-old.mp4'); assert.equal(project.contentRevision, 5);
  assert.equal(project.approval.author, 'Reviewer'); assert.deepEqual(project.publishedVideoScene, published);
  assert.ok(fs.existsSync(path.join(mediaDir, 'right-old.preview.mp4')));
  assert.equal((await request(sceneRoute('main'), { method: 'DELETE', body: { contentRevision: 5, replacementId: 'failed' } })).status, 409);
  check('failed replacement is abandoned while ready video, publication, agreement and revision remain intact');

  stageSurface(store, 'project1', 'right', candidate('earlier'));
  stageSurface(store, 'project1', 'right', candidate('newer'));
  assert.equal((await request(sceneRoute('main'), { method: 'DELETE', body: { contentRevision: 5, replacementId: 'earlier' } })).status, 409);
  assert.equal(store.project('project1').surfaces.right.replacement.job, 'newer');
  const io = Object.create(fs); io.renameSync = (source, destination) => {
    if (destination === store.file) throw new Error('Simulated disk full');
    return fs.renameSync(source, destination);
  };
  store.io = io;
  assert.equal((await request(sceneRoute('main'), { method: 'DELETE', body: { contentRevision: 5, replacementId: 'newer' } })).status, 500);
  store.io = fs;
  assert.equal(store.project('project1').surfaces.right.replacement.job, 'newer');
  assert.ok(patchProcessing(store, 'project1', 'right', 'newer', { error: 'Still retryable' }));
  assert.equal((await request(sceneRoute('main'), { method: 'DELETE', body: cancelBody(store.project('project1')) })).status, 200);
  check('candidate identity protects newer replacements; a failed save keeps the retryable candidate');

  const named = createVideoScene(store.project('project1'), 'Other scene');
  named.surfaces = Object.fromEntries(keys.map(key => [key, ready(key, 'old')])); named.contentRevision = 8;
  publishVideoScene(store.project('project1'), named.videoSceneId, 8); store.save();
  const namedPublication = structuredClone(named._videoSceneState.published);
  const sample = path.join(directory, 'sample.mp4');
  const generated = spawnSync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x80:rate=24', '-frames:v', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', sample], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  enqueue(() => new Promise(resolve => { unblock = resolve; }));
  for (const [id, job] of [['main', 'keep-main-job'], [named.videoSceneId, 'cancel-named-job']]) {
    fs.copyFileSync(sample, path.join(mediaDir, `right-${job}.mp4`));
    stageSurface(store, 'project1', 'right', candidate(job, 'processing'), id);
    startProcessing('project1', 'right', id);
  }
  const namedBefore = videoSceneProject(store.project('project1'), named.videoSceneId);
  const result = await request(sceneRoute(named.videoSceneId), { method: 'DELETE', body: cancelBody(namedBefore) });
  assert.equal(result.status, 200); assert.equal(result.data.project.videoSceneId, named.videoSceneId);
  unblock(); unblock = null;
  await until(() => store.project('project1').contentRevision === 6 && !queueInfo().active);
  const namedAfter = videoSceneProject(store.project('project1'), named.videoSceneId);
  assert.equal(namedAfter.surfaces.right.replacement, undefined); assert.equal(namedAfter.surfaces.right.file, 'right-old.mp4');
  assert.deepEqual(namedAfter._videoSceneState.published, namedPublication);
  assert.equal(namedAfter.contentRevision, 8); assert.equal(store.project('project1').surfaces.right.job, 'keep-main-job');
  assert.equal(publicProject(store.project('project1')).contentRevision, 5);
  check('cancelling queued named-scene processing cannot stop a different scene or overwrite the old video later');

  assert.equal(adminProject(store.project('project1')).canPublish, true);
  stageSurface(store, 'project1', 'right', candidate('failed-after-good-edit'));
  assert.equal(adminProject(store.project('project1')).canPublish, false);
  const restoredDraft = await request(sceneRoute('main'), { method: 'DELETE', body: cancelBody(store.project('project1')) });
  assert.equal(restoredDraft.status, 200); assert.equal(restoredDraft.data.project.canPublish, true);
  assert.equal(store.project('project1').surfaces.right.job, 'keep-main-job');
  assert.equal(store.project('project1').publishedVideoScene.contentRevision, 5);
  check('abandoning a failed candidate unlocks publication of earlier completed draft changes');

  const geometry = JSON.stringify(store.project('project1').scene);
  const renamed = await request('/api/projects/project1', { method: 'PATCH', body: { title: 'Renamed project', client: 'Updated client', description: 'Updated description' } });
  assert.equal(renamed.status, 200);
  assert.equal(adminProject(videoSceneProject(store.project('project1'), named.videoSceneId)).title, 'Renamed project');
  assert.equal(publicProject(videoSceneProject(store.project('project1'), named.videoSceneId, { publicView: true })).title, 'Renamed project');
  assert.equal(JSON.stringify(store.project('project1').scene), geometry);
  assert.equal(store.project('project1').contentRevision, 6); assert.equal(namedAfter.contentRevision, 8);
  check('project rename updates every scene without altering layout, files or scene revisions');
  console.log(`${checks} replacement workflow checks passed`);
} finally {
  store.io = fs;
  unblock?.();
  await cancelProcessing();
  await new Promise(resolve => server.close(resolve));
  releaseDataLock(); fs.rmSync(directory, { recursive: true, force: true });
}
