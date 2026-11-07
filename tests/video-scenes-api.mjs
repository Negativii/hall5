import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-video-scenes-'));
process.env.DATA_DIR = path.join(directory, 'data');
process.env.ADMIN_PASSWORD = 'test-only-video-scenes';
const { store, releaseDataLock } = await import('../server/db.js');
const { validateDatabase } = await import('../server/store.js');
const { ffmpegPath, PROJECTS_DIR } = await import('../server/config.js');
process.env.LEGAL_OPERATOR_NAME = 'Fixture operator';
process.env.LEGAL_OPERATOR_ADDRESS = 'Fixture address 1';
process.env.LEGAL_OPERATOR_EMAIL = 'fixture@example.invalid';
const { publicLegalConfig } = await import('../server/legal.js');
const { authRouter } = await import('../server/routes/auth.js');
const { projectsRouter } = await import('../server/routes/projects.js');
const { shareRouter } = await import('../server/routes/share.js');
const { sceneRouter } = await import('../server/routes/scene.js');
const { defaultScene } = await import('../server/sceneSchema.js');
const { stageSurface } = await import('../server/surfaceLifecycle.js');
const { cancelProcessing, requeueInterrupted } = await import('../server/jobs.js');
const { videoSceneState, createVideoScene } = await import('../server/videoScenes.js');

const app = express(); app.use(express.json());
app.use('/api', authRouter); app.use('/api/projects', projectsRouter);
app.use('/api/projects', sceneRouter); app.use('/api/s', shareRouter);
app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}`;
let cookies = '';
const viewerCookies = new Map();
async function configureViewer(id, slug) {
  assert.equal((await request(`/api/projects/${id}/share`, { method: 'PATCH', body: { passcode: 'fixture-viewer-password' } })).status, 200);
  const unlocked = await request(`/api/s/${slug}/unlock`, { admin: false, method: 'POST', body: { passcode: 'fixture-viewer-password' } });
  assert.equal(unlocked.status, 200);
  viewerCookies.set(slug, unlocked.headers.getSetCookie().map(item => item.split(';')[0]).join('; '));
}
async function request(url, { admin = true, method = 'GET', body, headers = {} } = {}) {
  if (body && /\/(comments|approve)(?:\?|$)/.test(url) && !admin) body = { ...body, consent: { accepted: true, version: publicLegalConfig().consentVersion } };
  const result = await fetch(base + url, { method,
    headers: { ...(admin && cookies ? { Cookie: cookies } : !admin && viewerCookies.has(url.split('?')[0].split('/')[3]) ? { Cookie: viewerCookies.get(url.split('?')[0].split('/')[3]) } : {}),
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  if (admin && result.headers.getSetCookie().length) cookies = result.headers.getSetCookie().map(item => item.split(';')[0]).join('; ');
  return result;
}
async function json(url, options) { const result = await request(url, options); return { status: result.status, data: await result.json() }; }
async function upload(id, sceneId, key, bytes) {
  const form = new FormData(); form.append('file', new File([bytes], `${key}.mp4`, { type: 'video/mp4' }));
  const route = sceneId ? `/api/projects/${id}/video-scenes/${sceneId}/surfaces/${key}` : `/api/projects/${id}/surfaces/${key}`;
  assert.equal((await request(route, { method: 'POST', body: form })).status, 202);
}
async function until(predicate, label) {
  const end = Date.now() + 60000;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
}
const keys = ['right', 'back', 'left', 'center', 'floor'];
let checks = 0;
const check = (name, fn = () => {}) => { fn(); checks++; console.log(`ok ${name}`); };
try {
  const sample = path.join(directory, 'sample.mp4');
  const alternate = path.join(directory, 'alternate.mp4');
  for (const [file, filter] of [[sample, 'testsrc2=size=320x80:rate=24'], [alternate, 'color=c=blue:size=320x80:rate=24']]) {
    const result = spawnSync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', filter,
      '-frames:v', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const bytes = fs.readFileSync(sample), blue = fs.readFileSync(alternate);
  assert.equal((await json('/api/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } })).status, 200);
  const created = await json('/api/projects', { method: 'POST', body: { title: 'Video scenes test' } });
  const id = created.data.project.id, slug = created.data.project.slug;
  await configureViewer(id, slug);
  const common = { ...defaultScene(), objects: [{ id: 'chair1', type: 'chair', name: 'Chair', position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: '#ffffff' }] };
  assert.equal((await json(`/api/projects/${id}/scene`, { method: 'PATCH', body: { scene: common, contentRevision: 0 } })).status, 200);
  for (const key of keys) await upload(id, null, key, bytes);
  await until(() => keys.every(key => store.project(id).surfaces[key]?.status === 'ready'), 'legacy five channels');
  const publicGet = async (sceneId) => json(`/api/s/${slug}${sceneId ? `?videoScene=${sceneId}` : ''}`, { admin: false });
  const adminGet = async sceneId => (await json(`/api/projects/${id}?videoScene=${sceneId}`)).data.project;
  const approve = async (sceneId, revision) => json(`/api/s/${slug}/approve`, { admin: false, method: 'POST', body: { author: 'Client', videoSceneId: sceneId, contentRevision: revision } });
  const publish = async (sceneId, revision) => json(`/api/projects/${id}/video-scenes/${sceneId}/publish`, { method: 'POST', body: { contentRevision: revision } });
  const main = (await publicGet()).data.project;
  const geometry = JSON.stringify(main.scene);
  const mainRevision = main.contentRevision;
  assert.equal((await approve('main', mainRevision)).status, 200);
  const mainComment = (await json(`/api/s/${slug}/comments`, { admin: false, method: 'POST', body: { author: 'Client', text: 'Main note', time: 0.2, videoSceneId: 'main', contentRevision: mainRevision } })).data.comment;
  check('legacy five-channel project remains the default named scene with its feedback', () => {
    assert.equal(main.videoSceneId, 'main'); assert.equal(main.videoSceneName, 'Основная сцена');
    assert.equal(main.videoScenes.length, 1); assert.equal(main.ready, 5);
  });

  // Entering named-scene mode must preserve the legacy published set even if
  // an independent replacement is already pending on one of its channels.
  const pendingMain = 'right-main-pending.mp4';
  fs.copyFileSync(sample, path.join(PROJECTS_DIR, id, pendingMain));
  stageSurface(store, id, 'right', { key: 'right', status: 'processing', file: pendingMain, job: 'first-named-scene-pending', progress: 0 });
  const added = await json(`/api/projects/${id}/video-scenes`, { method: 'POST', body: { name: 'Представление' } });
  assert.equal(added.status, 201);
  const sceneId = added.data.videoSceneId;
  assert.equal(added.data.project.videoSceneId, sceneId);
  assert.equal((await publicGet(sceneId)).status, 404);
  let mainAfter = (await publicGet('main')).data.project;
  check('new draft stays private while the previous published set and common layout stay unchanged', () => {
    assert.equal(mainAfter.videoScenes.length, 1); assert.equal(mainAfter.approved, true);
    assert.equal(mainAfter.contentRevision, mainRevision); assert.equal(mainAfter.comments[0].id, mainComment.id);
    assert.equal(JSON.stringify(mainAfter.scene), geometry);
    assert.equal(JSON.stringify(added.data.project.scene), geometry);
    assert.equal(added.data.project.canPublish, false);
  });
  assert.equal(store.project(id).publishedVideoScene.surfaces.right.replacement, undefined);
  delete store.project(id).surfaces.right.replacement;
  store.save();
  const token = new URL(mainAfter.surfaces[0].previewUrl, base).searchParams.get('mt');
  assert.equal((await request(`/api/s/${slug}/video-scenes/${sceneId}/media/right/proxy?mt=${token}`, { admin: false })).status, 404);
  assert.equal((await request(`/api/projects/${id}?videoScene=${sceneId}`, { admin: false })).status, 401);
  check('a valid project media token cannot read an unpublished scene');

  await upload(id, sceneId, 'right', bytes);
  assert.equal((await publish(sceneId, 0)).status, 409);
  await until(() => videoSceneState(store.project(id), sceneId).surfaces.right?.status === 'ready', 'first draft channel');
  assert.equal((await publish(sceneId, 1)).status, 409);
  for (const key of keys.slice(1)) await upload(id, sceneId, key, bytes);
  await until(() => keys.every(key => videoSceneState(store.project(id), sceneId).surfaces[key]?.status === 'ready'), 'complete draft set');
  let draft = await adminGet(sceneId);
  assert.equal(draft.canPublish, true);
  assert.equal((await publicGet(sceneId)).status, 404);
  const sceneOriginalRevision = draft.contentRevision;
  assert.equal((await publish(sceneId, sceneOriginalRevision)).status, 200);
  let selected = (await publicGet(sceneId)).data.project;
  check('publication exposes all five finished channels together with phone renditions', () => {
    assert.equal(selected.videoSceneId, sceneId); assert.equal(selected.videoScenes.length, 2);
    assert.equal(selected.ready, 5); assert.equal(selected.contentRevision, sceneOriginalRevision);
    assert.ok(selected.surfaces.every(surface => surface.mobilePreview?.url.includes(`/video-scenes/${sceneId}/`)));
    assert.equal(JSON.stringify(selected.scene), geometry);
    assert.equal(selected.comments.length, 0); assert.equal(selected.approved, false);
  });
  const selectedComment = (await json(`/api/s/${slug}/comments?videoScene=${sceneId}`, { admin: false, method: 'POST', body: { author: 'Client', text: 'Presentation note', time: 0.1, contentRevision: selected.contentRevision } })).data.comment;
  assert.equal((await approve(sceneId, selected.contentRevision)).status, 200);
  draft = await adminGet(sceneId);
  check('scene approvals and comments are independent and admin sees the current published approval', () => {
    assert.ok(draft.approval); assert.equal(draft.approval.revision, selected.contentRevision);
    assert.equal(draft.comments.length, 1); assert.equal(draft.comments[0].id, selectedComment.id);
  });
  mainAfter = (await publicGet('main')).data.project;
  assert.equal(mainAfter.comments.length, 1); assert.equal(mainAfter.comments[0].id, mainComment.id); assert.equal(mainAfter.approved, true);

  const oldUrl = selected.surfaces.find(surface => surface.key === 'right').previewUrl;
  const oldMobileUrl = selected.surfaces.find(surface => surface.key === 'right').mobilePreview.url;
  const oldFile = videoSceneState(store.project(id), sceneId).published.surfaces.right.proxy;
  await upload(id, sceneId, 'right', Buffer.from('broken candidate'));
  await until(() => videoSceneState(store.project(id), sceneId).surfaces.right.replacement?.status === 'error', 'failed named replacement');
  draft = await adminGet(sceneId);
  assert.equal(draft.canPublish, false);
  assert.equal((await publish(sceneId, draft.contentRevision)).status, 409);
  selected = (await publicGet(sceneId)).data.project;
  const stillPlayable = await request(oldUrl, { admin: false, headers: { Range: 'bytes=0-127' } });
  assert.equal(stillPlayable.status, 206); await stillPlayable.arrayBuffer();
  check('failed replacement cannot be published and preserves the visible snapshot and agreement', () => {
    assert.equal(selected.contentRevision, sceneOriginalRevision); assert.equal(selected.approved, true);
    assert.equal(videoSceneState(store.project(id), sceneId).published.surfaces.right.proxy, oldFile);
  });
  await upload(id, sceneId, 'right', blue);
  await until(() => !videoSceneState(store.project(id), sceneId).surfaces.right.replacement, 'new draft candidate');
  draft = await adminGet(sceneId);
  assert.equal(draft.canPublish, true); assert.equal(draft.hasUnpublishedChanges, true);
  selected = (await publicGet(sceneId)).data.project;
  assert.equal(selected.contentRevision, sceneOriginalRevision); assert.equal(selected.approved, true);
  assert.equal((await publish(sceneId, sceneOriginalRevision)).status, 409);
  assert.equal((await publish(sceneId, draft.contentRevision)).status, 200);
  selected = (await publicGet(sceneId)).data.project;
  assert.equal((await request(oldUrl, { admin: false })).status, 409);
  assert.equal((await request(oldMobileUrl, { admin: false })).status, 409);
  assert.equal((await approve(sceneId, sceneOriginalRevision)).status, 409);
  assert.equal((await json(`/api/s/${slug}/comments`, { admin: false, method: 'POST', body: { author: 'Client', text: 'Stale', videoSceneId: sceneId, contentRevision: sceneOriginalRevision } })).status, 409);
  check('new publication clears only its agreement and stale media cannot mix old/new files', () => {
    assert.equal(selected.approved, false); assert.equal(selected.comments[0].id, selectedComment.id);
    assert.equal(selected.comments[0].revision, sceneOriginalRevision);
  });
  mainAfter = (await publicGet('main')).data.project;
  assert.equal(mainAfter.approved, true); assert.equal(mainAfter.contentRevision, mainRevision);

  assert.equal((await approve(sceneId, selected.contentRevision)).status, 200);
  const changed = structuredClone(common); changed.objects[0].position = [1, 0, 0];
  assert.equal((await json(`/api/projects/${id}/scene`, { method: 'PATCH', body: { scene: changed, contentRevision: store.project(id).contentRevision } })).status, 200);
  mainAfter = (await publicGet('main')).data.project;
  selected = (await publicGet(sceneId)).data.project;
  check('one shared layout change invalidates every scene approval and preserves the same room across scenes', () => {
    assert.equal(mainAfter.approved, false); assert.equal(selected.approved, false);
    assert.equal(mainAfter.contentRevision, mainRevision + 1);
    assert.equal(JSON.stringify(mainAfter.scene), JSON.stringify(selected.scene));
    assert.equal(selected.scene.objects[0].position[0], 1);
  });
  await json(`/api/projects/${id}/video-scenes/${sceneId}`, { method: 'PATCH', body: { name: 'Финал', scene: { objects: [] } } });
  selected = (await publicGet(sceneId)).data.project;
  assert.equal(selected.videoSceneName, 'Финал'); assert.equal(selected.scene.objects[0].position[0], 1);
  assert.equal((await approve('main', mainAfter.contentRevision)).status, 200);
  assert.equal((await approve(sceneId, selected.contentRevision)).status, 200);
  assert.equal((await json(`/api/projects/${id}/video-scenes/${sceneId}/approval/reset`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await publicGet('main')).data.project.approved, true);
  assert.equal((await publicGet(sceneId)).data.project.approved, false);
  assert.equal((await json(`/api/projects/${id}/video-scenes/${sceneId}/comments/${selectedComment.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await publicGet(sceneId)).data.project.comments.length, 0);
  assert.equal((await publicGet('main')).data.project.comments.length, 1);
  check('rename and feedback actions affect only the selected video scene');

  const interrupted = 'right-interrupted-named.mp4';
  fs.copyFileSync(sample, path.join(PROJECTS_DIR, id, interrupted));
  const beforeRecovery = videoSceneState(store.project(id), sceneId).contentRevision;
  stageSurface(store, id, 'right', { key: 'right', status: 'processing', file: interrupted, job: 'named-recovery', progress: 0 }, sceneId);
  assert.equal(requeueInterrupted(), 1);
  await until(() => videoSceneState(store.project(id), sceneId).contentRevision === beforeRecovery + 1, 'named recovery');
  assert.equal((await publicGet(sceneId)).data.project.contentRevision, selected.contentRevision);
  assert.equal((await publicGet('main')).data.project.contentRevision, mainAfter.contentRevision);
  check('restart recovery updates only the correct draft and keeps publications stable');

  for (const mutate of [data => { data.projects[0].videoScenes[0].id = 'main'; },
    data => { data.projects[0].videoScenes[0].published.surfaces.right.replacement = { ...data.projects[0].videoScenes[0].surfaces.right }; },
    data => { data.projects[0].videoScenes[0].published.surfaces.right.file = '../outside.mp4'; }]) {
    const invalid = structuredClone(store.data); mutate(invalid); assert.throws(() => validateDatabase(invalid));
  }
  const bounded = structuredClone(store.project(id));
  while ((bounded.videoScenes?.length || 0) < 49) createVideoScene(bounded, 'Bounded draft');
  assert.throws(() => createVideoScene(bounded, 'One too many'), /50/);
  check('schema rejects draft publications, path traversal, duplicate IDs and more than 50 scenes');

  // Two same-named channels can process independently; deleting one scene must
  // not cancel the main scene's pending job or remove its visible media.
  const mainDraftRevision = store.project(id).contentRevision;
  await upload(id, 'main', 'right', blue);
  await upload(id, sceneId, 'right', blue);
  assert.equal((await json(`/api/projects/${id}/video-scenes/${sceneId}`, { method: 'DELETE' })).status, 200);
  await until(() => store.project(id).contentRevision === mainDraftRevision + 1, 'main job after deleting other scene');
  assert.equal((await publicGet(sceneId)).status, 404);
  assert.equal((await request(oldUrl, { admin: false })).status, 404);
  mainAfter = (await publicGet('main')).data.project;
  assert.equal(mainAfter.contentRevision, mainDraftRevision);
  assert.equal(mainAfter.approved, true);
  assert.equal(mainAfter.videoScenes.length, 1);
  assert.equal((await json(`/api/projects/${id}/video-scenes/main`, { method: 'DELETE' })).status, 409);
  check('deleting another scene leaves default media, furniture, feedback and active processing intact');
  console.log(`ALL ${checks} VIDEO SCENE CHECKS PASSED`);
} finally {
  await cancelProcessing();
  await new Promise(resolve => server.close(resolve));
  releaseDataLock();
  fs.rmSync(directory, { recursive: true, force: true });
}
