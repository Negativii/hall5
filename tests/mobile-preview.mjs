import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-mobile-'));
process.env.DATA_DIR = path.join(directory, 'data');
process.env.ADMIN_PASSWORD = 'test-only-mobile';
const { mobilePreviewPlan, createMobilePreview, verifyMobilePreview } = await import('../server/mobilePreview.js');
const { probe } = await import('../server/media.js');
const { ffmpegPath, PROJECTS_DIR } = await import('../server/config.js');
const { store, releaseDataLock } = await import('../server/db.js');
const { validateDatabase } = await import('../server/store.js');
const { cleanupProjectFiles } = await import('../server/mediaFiles.js');
const { publicProject, adminProject } = await import('../server/serialize.js');
const { shareRouter } = await import('../server/routes/share.js');
const { projectsRouter } = await import('../server/routes/projects.js');
const { authRouter } = await import('../server/routes/auth.js');
const { cancelProcessing } = await import('../server/jobs.js');
const { scryptHash } = await import('../server/util.js');
const source = path.join(directory, 'source.mp4');
const mobile = path.join(directory, 'right-source.mobile.mp4');
let metadata;
let server;
after(async () => {
  await cancelProcessing();
  if (server) await new Promise(resolve => server.close(resolve));
  releaseDataLock();
  fs.rmSync(directory, { recursive: true, force: true });
});
function ffmpeg(args) {
  const result = spawnSync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}
const baseInfo = { codec: 'h264', pixelFormat: 'yuv420p', fps: 24, rotation: 0, hdr: false };

test('mobile dimensions fit 1920×1080 with even aspect-preserving sizes and no upscaling', () => {
  for (const [width, height, expected] of [[4800, 2400, [1920, 960]], [4800, 1200, [1920, 480]],
    [2560, 1440, [1920, 1080]], [1080, 1920, [606, 1080]], [320, 160, [320, 160]]]) {
    const plan = mobilePreviewPlan({ ...baseInfo, width, height });
    assert.deepEqual([plan.width, plan.height], expected);
    assert.ok(plan.width <= width && plan.height <= height);
    assert.ok(Math.abs((plan.width / plan.height) / (width / height) - 1) < 0.005);
  }
});

test('mobile encoding keeps 60fps, all timestamps and AAC while leaving the full-quality source untouched', async () => {
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=2560x640:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000',
    '-t', '0.3', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', source]);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  metadata = await createMobilePreview(source, mobile);
  assert.deepEqual([metadata.width, metadata.height, metadata.fps, metadata.frameCount], [1920, 480, 60, 18]);
  assert.deepEqual([metadata.codec, metadata.mode, metadata.mimeType], ['h264', 'mobile', 'video/mp4']);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), hash);
  const info = await probe(mobile);
  assert.equal(info.hasAudio, true); assert.equal(info.audioCodec, 'aac');
  assert.equal(info.profile, 'High'); assert.equal(info.pixelFormat, 'yuv420p');
  const bytes = fs.readFileSync(mobile);
  assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')));
  const bad = path.join(directory, 'missing-frame.mp4');
  ffmpeg(['-i', mobile, '-map', '0:v:0', '-frames:v', '17', '-c', 'copy', bad]);
  await assert.rejects(verifyMobilePreview(source, bad), /не прошла проверку|изменила кадры/);
});

test('small sources stay at original dimensions and frame rate', async () => {
  const small = path.join(directory, 'small.mp4');
  const smallMobile = path.join(directory, 'small.mobile.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x160:rate=24', '-frames:v', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', small]);
  const result = await createMobilePreview(small, smallMobile);
  assert.deepEqual([result.width, result.height, result.fps, result.frameCount], [320, 160, 24, 6]);
});

test('mobile URLs are protected, support Range, and retain primary/AV1 metadata and rollback files', async () => {
  const projectDir = path.join(PROJECTS_DIR, 'mobile');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(source, path.join(projectDir, 'right-source.mp4'));
  fs.copyFileSync(mobile, path.join(projectDir, 'right-source.mobile.mp4'));
  const project = { id: 'mobile', slug: 'mobile', title: 'Mobile', share: { enabled: true, revision: 'one' },
    surfaces: { right: { key: 'right', status: 'ready', file: 'right-source.mp4', proxy: 'right-source.mp4',
      width: 2560, height: 640, duration: metadata.duration, fps: 60, previewWidth: 2560, previewHeight: 640, previewFps: 60,
      hasAudio: true, mobilePreview: { file: 'right-source.mobile.mp4', ...metadata } } } };
  store.add(project);
  const malformed = structuredClone(store.data);
  malformed.projects[0].surfaces.right.mobilePreview.file = '../outside.mobile.mp4';
  assert.throws(() => validateDatabase(malformed), /Некорректная мобильная/);
  const wrongSize = structuredClone(store.data);
  wrongSize.projects[0].surfaces.right.mobilePreview.width = 1922;
  assert.throws(() => validateDatabase(wrongSize), /Некорректная мобильная/);
  for (const change of [{ timingSha256: 'invalid' }, { frameCount: 0 }, { fps: 30 },
    { duration: 5 }, { mode: 'lossless' }, { width: 1920, height: 1080 }]) {
    const malformedMetadata = structuredClone(store.data);
    Object.assign(malformedMetadata.projects[0].surfaces.right.mobilePreview, change);
    assert.throws(() => validateDatabase(malformedMetadata), /Некорректная мобильная/);
  }
  const plain = publicProject(project).surfaces.find(item => item.key === 'right');
  const exposed = plain.mobilePreview;
  assert.equal(exposed.file, undefined); assert.equal(exposed.timingSha256, undefined);
  assert.equal(exposed.width, 1920); assert.ok(plain.previewUrl.includes('/proxy?'));
  assert.ok(adminProject(project).surfaces.find(item => item.key === 'right').mobilePreview.url.includes('/mobile?'));
  const app = express(); app.use(express.json());
  app.use('/api', authRouter); app.use('/api/projects', projectsRouter); app.use('/api/s', shareRouter);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const credentials = scryptHash('fixture-viewer-password');
  project.share.passcodeSalt = credentials.salt; project.share.passcodeHash = credentials.hash;
  const unlock = await fetch(`${base}/api/s/mobile/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'fixture-viewer-password' }) });
  assert.equal(unlock.status, 200);
  const viewer = unlock.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await fetch(`${base}/api/projects/mobile/media/right/mobile`)).status, 401);
  assert.equal((await fetch(`${base}/api/s/mobile/media/right/mobile`)).status, 401);
  assert.equal((await fetch(`${base}/api/s/mobile/media/right/mobile`, { headers: { Cookie: viewer } })).status, 403);
  const range = await fetch(`${base}${exposed.url}`, { headers: { Cookie: viewer, Range: 'bytes=0-127' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('Content-Type'), 'video/mp4');
  assert.equal(range.headers.get('Content-Range'), `bytes 0-127/${metadata.size}`);
  assert.equal((await range.arrayBuffer()).byteLength, 128);
  project.share.revision = 'two';
  assert.equal((await fetch(`${base}${exposed.url}`, { headers: { Cookie: viewer } })).status, 401);
  project.share.revision = 'one'; project.share.enabled = false;
  assert.equal((await fetch(`${base}${exposed.url}`)).status, 404);
  project.share.enabled = true;
  project.surfaces.right.replacement = { key: 'right', status: 'processing', file: 'right-candidate.mp4', job: 'candidate' };
  store.save();
  for (const filename of ['right-candidate.mp4', 'right-candidate.mobile.mp4', 'right-orphan.mobile.mp4']) fs.writeFileSync(path.join(projectDir, filename), 'test');
  cleanupProjectFiles(project.id);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-source.mobile.mp4')), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-candidate.mobile.mp4')), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-orphan.mobile.mp4')), false);
  delete project.surfaces.right.mobilePreview; delete project.surfaces.right.replacement; store.save();
  cleanupProjectFiles(project.id);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-source.mobile.mp4')), true);
  store.save(); cleanupProjectFiles(project.id);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-source.mobile.mp4')), false);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-source.mp4')), true);
});
