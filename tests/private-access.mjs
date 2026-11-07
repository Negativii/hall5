import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kuog-private-access-'));
process.env.DATA_DIR = directory;
process.env.ADMIN_PASSWORD = 'private-access-test-admin';
const { authRouter } = await import('../server/routes/auth.js');
const { projectsRouter } = await import('../server/routes/projects.js');
const { shareRouter } = await import('../server/routes/share.js');
const { sceneRouter, sceneShareRouter } = await import('../server/routes/scene.js');
const { store, releaseDataLock } = await import('../server/db.js');
const { mediaToken, hasShareAccess, isAdmin } = await import('../server/auth.js');
const { signPayload, scryptHash } = await import('../server/util.js');
const { SECRET, PROJECTS_DIR } = await import('../server/config.js');
const { publicLegalConfig } = await import('../server/legal.js');
const { defaultScene } = await import('../server/sceneSchema.js');
const app = express(); app.use(express.json());
app.use('/api', authRouter); app.use('/api/projects', sceneRouter); app.use('/api/projects', projectsRouter);
app.use('/api/s', sceneShareRouter); app.use('/api/s', shareRouter);
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}`;
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
async function req(url, { method = 'GET', body, session = '', headers = {} } = {}) {
  return fetch(base + url, { method, headers: { ...(session ? { Cookie: session } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
}
let checks = 0;
function check(name) { checks++; console.log(`ok ${name}`); }
try {
  assert.equal((await req('/api/projects')).status, 401);
  assert.equal((await req('/api/login', { method: 'POST', body: { password: 'hall5' } })).status, 401);
  const login = await req('/api/login', { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(login.status, 200); const admin = cookie(login);
  assert.ok(login.headers.get('set-cookie').includes('HttpOnly')); assert.ok(login.headers.get('set-cookie').includes('SameSite=Lax'));
  check('admin credentials required; common default refused; session has HTTP-only and same-site flags');
  const created = await req('/api/projects', { method: 'POST', session: admin, body: { title: 'Confidential project title', client: 'Secret client' } });
  const { project: createdProject } = await created.json();
  const project = store.project(createdProject.id), slug = project.slug;
  const route = `/api/s/${slug}`;
  const unlockedLegacy = await req(route);
  assert.equal(unlockedLegacy.status, 401);
  const locked = await unlockedLegacy.json();
  assert.equal(locked.code, 'password_not_configured'); assert.equal(locked.locked, true);
  assert.equal(locked.title, undefined); assert.equal(locked.client, undefined); assert.equal(locked.project, undefined);
  assert.equal((await req(`${route}/unlock`, { method: 'POST', body: { passcode: '' } })).status, 401);
  check('new or legacy projects without passwords fail closed and reveal no title/client/content');

  const adminShare = `/api/projects/${project.id}/share`;
  for (const passcode of ['', 'short']) assert.equal((await req(adminShare, { method: 'PATCH', session: admin, body: { passcode } })).status, 400);
  assert.equal((await req(adminShare, { method: 'PATCH', session: admin, body: { passcode: 'client-password-1', allowDownload: true } })).status, 200);
  assert.equal((await req(`${route}/unlock`, { method: 'POST', body: { passcode: 'wrong' } })).status, 401);
  const unlock = await req(`${route}/unlock`, { method: 'POST', body: { passcode: 'client-password-1' } });
  assert.equal(unlock.status, 200); const viewer = cookie(unlock);
  assert.equal((await req(route, { session: viewer })).status, 200);
  assert.equal((await req('/api/projects', { session: viewer })).status, 401);
  check('per-project password unlocks only viewer access; password cannot be cleared');

  fs.mkdirSync(path.join(PROJECTS_DIR, project.id), { recursive: true });
  const bytes = Buffer.from('test fixture video and model bytes');
  for (const file of ['video.mp4', 'video.compat.mp4', 'video.mobile.mp4', 'poster.jpg', 'model.glb']) fs.writeFileSync(path.join(PROJECTS_DIR, project.id, file), bytes);
  const rendition = { width: 320, height: 80, fps: 24, duration: 1, frameCount: 24, size: bytes.length, timingSha256: 'a'.repeat(64) };
  project.surfaces.right = { key: 'right', status: 'ready', file: 'video.mp4', proxy: 'video.mp4', poster: 'poster.jpg', width: 320, height: 80, duration: 1,
    compatibilityPreview: { ...rendition, file: 'video.compat.mp4', codec: 'av1', mode: 'lossless', mimeType: 'video/mp4; codecs="av01"', decodedSha256: 'a'.repeat(64) },
    mobilePreview: { ...rendition, file: 'video.mobile.mp4', codec: 'h264', mode: 'mobile', mimeType: 'video/mp4' } };
  project.sceneAssets = [{ id: 'model1', file: 'model.glb', name: 'Model' }];
  project.scene = { ...defaultScene(), objects: [{ id: 'obj1', type: 'model', name: 'Fixture model', assetId: 'model1', position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: '#ffffff' }] };
  store.save();
  const token = mediaToken(project.id, 3600, project.share.revision);
  const paths = ['proxy', 'poster', 'original', 'av1', 'mobile'].flatMap(variant => [
    `${route}/media/right/${variant}?mt=${token}`, `${route}/video-scenes/main/media/right/${variant}?mt=${token}`,
  ]);
  paths.push(`${route}/download/right?mt=${token}`, `${route}/video-scenes/main/download/right?mt=${token}`, `${route}/assets/model1?mt=${token}`);
  for (const url of paths) {
    assert.equal((await req(url)).status, 401, `signed URL must not replace password session: ${url.split('?')[0]}`);
    const response = await req(url, { session: viewer, headers: { Range: 'bytes=0-3' } });
    assert.equal(response.status, 206, `viewer range allowed: ${url.split('?')[0]}`);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await response.arrayBuffer()).byteLength, 4);
  }
  assert.equal((await req(`${route}/media/right/proxy`, { session: viewer })).status, 403);
  check('all 13 video/poster/model/download routes require both viewer session and valid token; byte ranges still work');

  for (const url of paths.filter(url => !url.includes('/assets/'))) {
    const response = await req(url, { session: viewer, headers: { Range: 'bytes=999999-' } });
    assert.equal(response.status, 416, 'an invalid seek must retain its HTTP range status');
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
  }
  check('invalid video ranges return 416 for playback and downloads');
  const beforeInvalidChannel = JSON.stringify(store.project(project.id));
  for (const key of ['__proto__', 'constructor', 'toString']) {
    for (const prefix of [`/api/projects/${project.id}`, `/api/projects/${project.id}/video-scenes/main`]) {
      assert.equal((await req(`${prefix}/surfaces/${key}`, { method: 'POST', session: admin })).status, 404);
      assert.equal((await req(`${prefix}/surfaces/${key}`, { method: 'DELETE', session: admin })).status, 404);
    }
    assert.equal((await req(`${route}/media/${key}/proxy?mt=${token}`, { session: viewer })).status, 404);
  }
  assert.equal(JSON.stringify(store.project(project.id)), beforeInvalidChannel);
  check('prototype property names are rejected as channels without changing project state');

  for (const endpoint of ['comments', 'approve', 'playback-diagnostics']) {
    assert.equal((await req(`${route}/${endpoint}`, { method: 'POST', body: { author: 'Viewer', text: 'Test', surfaceKey: 'floor' } })).status, 401);
  }
  check('feedback and playback diagnostics reject anonymous callers');
  const feedback = { author: 'Test reviewer', text: 'Test comment' };
  delete process.env.LEGAL_OPERATOR_NAME; delete process.env.LEGAL_OPERATOR_ADDRESS; delete process.env.LEGAL_OPERATOR_EMAIL;
  assert.equal((await req(`${route}/comments`, { method: 'POST', session: viewer, body: feedback })).status, 503);
  process.env.LEGAL_OPERATOR_NAME = 'Fixture operator'; process.env.LEGAL_OPERATOR_ADDRESS = 'Fixture address 1'; process.env.LEGAL_OPERATOR_EMAIL = 'fixture@example.invalid';
  assert.equal((await req(`${route}/comments`, { method: 'POST', session: viewer, body: feedback })).status, 400);
  assert.equal((await req(`${route}/comments`, { method: 'POST', session: viewer, body: { ...feedback, consent: { accepted: true, version: 'old' } } })).status, 409);
  const consent = { accepted: true, version: publicLegalConfig().consentVersion };
  const submitted = await req(`${route}/comments`, { method: 'POST', session: viewer, body: { ...feedback, consent } });
  assert.equal(submitted.status, 201); assert.equal((await submitted.json()).comment.consent, undefined);
  assert.equal(project.comments[0].consent.version, consent.version);
  project.scene.showRoomSurfaces = false;
  const approved = await req(`${route}/approve`, { method: 'POST', session: viewer, body: { author: feedback.author, consent } });
  assert.equal(approved.status, 200); assert.equal((await approved.json()).approval.consent, undefined);
  assert.equal(project.approval.consent.version, consent.version);
  const visible = (await (await req(route, { session: viewer })).json()).project;
  assert.equal(visible.approval.consent, undefined); assert.equal(visible.comments[0].consent, undefined);
  check('feedback requires configured legal details and fresh separate consent; receipt stays in private storage');

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const legacyCookie = `h5_s_${slug}=${signPayload(`${project.share.revision}.${exp}`, SECRET)}`;
  assert.equal((await req(route, { session: legacyCookie })).status, 401);
  assert.equal(isAdmin({ headers: { cookie: `h5_admin=${signPayload(`admin.${exp}`, SECRET)}` } }), false);
  assert.equal((await req(route, { session: `h5_s_${slug}=%E0%A4%A` })).status, 401);
  const other = { ...project, id: 'another-project', slug: 'another-slug' };
  assert.equal(hasShareAccess({ headers: { cookie: viewer.replace(`h5_s_${slug}`, 'h5_s_another-slug') } }, other), false);
  check('legacy, malformed and transplanted project cookies are rejected');

  assert.equal((await req(adminShare, { method: 'PATCH', session: admin, body: { passcode: 'client-password-2' } })).status, 200);
  assert.equal((await req(route, { session: viewer })).status, 401);
  const unlock2 = await req(`${route}/unlock`, { method: 'POST', body: { passcode: 'client-password-2' } });
  const viewer2 = cookie(unlock2);
  assert.equal((await req(paths[0], { session: viewer2 })).status, 403);
  const changed = scryptHash('directly-replaced-password');
  const oldShare = { ...project.share };
  project.share.passcodeSalt = changed.salt; project.share.passcodeHash = changed.hash;
  assert.equal(hasShareAccess({ headers: { cookie: viewer2 } }, project), false);
  project.share = oldShare;
  check('password rotation revokes old sessions and media tokens; credentials bind session even without revision changes');

  const logout = await req(`${route}/logout`, { method: 'POST', session: viewer2 });
  assert.equal(logout.status, 200); assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await req(adminShare, { method: 'PATCH', session: admin, body: { enabled: false } })).status, 200);
  assert.equal((await req(route, { session: viewer2 })).status, 404);
  assert.equal((await req(paths[0], { session: viewer2 })).status, 404);
  check('viewer logout clears cookie and disabling a show stops existing sessions');
  console.log(`\n${checks} private-access checks passed`);
} finally {
  await new Promise(resolve => server.close(resolve));
  releaseDataLock(); fs.rmSync(directory, { recursive: true, force: true });
}
