import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import express from 'express';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-av1-'));
process.env.DATA_DIR = path.join(directory, 'data');
process.env.ADMIN_PASSWORD = 'test-only-av1';
const { needsCompatibilityPreview, createCompatibilityPreview, verifyCompatibilityPreview } = await import('../server/compatibilityPreview.js');
const { probe } = await import('../server/media.js');
const { ffmpegPath, ffprobePath, PROJECTS_DIR } = await import('../server/config.js');
const { store, releaseDataLock } = await import('../server/db.js');
const { validateDatabase } = await import('../server/store.js');
const { cleanupProjectFiles } = await import('../server/mediaFiles.js');
const { publicProject } = await import('../server/serialize.js');
const { shareRouter } = await import('../server/routes/share.js');
const { projectsRouter } = await import('../server/routes/projects.js');
const { authRouter } = await import('../server/routes/auth.js');
const { cancelProcessing } = await import('../server/jobs.js');
const { scryptHash } = await import('../server/util.js');
const input = path.join(directory, 'source.mp4');
const output = path.join(directory, 'right-source.compat.mp4');
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

test('compatibility is added for frames beyond AVC 5.2 without resizing ordinary channels', () => {
  assert.equal(needsCompatibilityPreview({ codec: 'h264', width: 4800, height: 2400 }), true);
  assert.equal(needsCompatibilityPreview({ codec: 'h264', width: 4800, height: 1200 }), false);
  assert.equal(needsCompatibilityPreview({ codec: 'h264', width: 4096, height: 2304 }), false);
  assert.equal(needsCompatibilityPreview({ codec: 'av1', width: 4800, height: 2400 }), false);
});

test('AV1 preserves all decoded video bytes, copied AAC, dimensions/FPS and the input file', async () => {
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x160:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000',
    '-t', '0.5', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '192k', input]);
  const originalHash = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
  metadata = await createCompatibilityPreview(input, output);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'), originalHash);
  assert.deepEqual([metadata.codec, metadata.mode, metadata.width, metadata.height, metadata.fps], ['av1', 'lossless', 320, 160, 24]);
  assert.match(metadata.decodedSha256, /^[a-f0-9]{64}$/);
  const encoded = await probe(output);
  assert.equal(encoded.frameCount, 12);
  assert.equal(encoded.hasAudio, true);
  assert.equal(encoded.audioCodec, 'aac');
  const bytes = fs.readFileSync(output);
  assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')));
});

test('same-sized lossy AV1 cannot be labelled or published as lossless', async () => {
  const bad = path.join(directory, 'lossy.mp4');
  ffmpeg(['-i', input, '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libaom-av1', '-cpu-used', '6',
    '-aom-params', 'chroma-sample-position=1', '-crf', '50', '-b:v', '0', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-c:a', 'copy', bad]);
  await assert.rejects(verifyCompatibilityPreview(input, bad), /не прошла проверку без потерь/);
});

test('AV1 startup has no hidden reference frames and seek points follow source FPS', async () => {
  const source = path.join(directory, '30fps.mp4');
  const target = path.join(directory, '30fps.compat.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x160:rate=30', '-frames:v', '66',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', source]);
  const result = await createCompatibilityPreview(source, target);
  assert.equal(result.frameCount, 66);
  assert.equal(result.fps, 30);
  const trace = spawnSync(ffmpegPath, ['-nostdin', '-hide_banner', '-i', target,
    '-map', '0:v:0', '-c', 'copy', '-bsf:v', 'trace_headers', '-f', 'null', '-'], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(trace.status, 0, trace.stderr || String(trace.error));
  const shown = [...trace.stderr.matchAll(/\bshow_frame\s+\d+\s+=\s+(\d+)/g)].map(match => Number(match[1]));
  assert.equal(shown.length, 66);
  assert.equal(shown.every(value => value === 1), true, 'hidden frames would front-load decoding before display');
  const packets = spawnSync(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_packets',
    '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'json', target], { encoding: 'utf8', timeout: 60000 });
  assert.equal(packets.status, 0, packets.stderr || String(packets.error));
  const data = JSON.parse(packets.stdout).packets;
  assert.equal(data.length, 66);
  assert.equal(data.every((packet, index) => Math.abs(Number(packet.pts_time) - index / 30) < 0.000001), true);
  const keyframes = data.filter(packet => packet.flags.includes('K')).map(packet => Number(packet.pts_time));
  assert.equal(keyframes[0], 0);
  assert.ok(keyframes.length >= 2);
  assert.ok(keyframes[1] >= 1.9 && keyframes[1] <= 2.1, '30fps seek point should be near 2s, not a fixed 48-frame interval');
});

test('AV1 media uses admin/token authorization and Range; cleanup retains active, candidate and rollback files', async () => {
  const projectDir = path.join(PROJECTS_DIR, 'compat');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.copyFileSync(input, path.join(projectDir, 'right-source.mp4'));
  fs.copyFileSync(output, path.join(projectDir, 'right-source.compat.mp4'));
  const project = { id: 'compat', slug: 'compat', title: 'Compatibility', share: { enabled: true, revision: 'one' },
    surfaces: { right: { key: 'right', status: 'ready', file: 'right-source.mp4', proxy: 'right-source.mp4',
      width: 320, height: 160, duration: 0.5, fps: 24, previewWidth: 320, previewHeight: 160, previewFps: 24,
      hasAudio: true, compatibilityPreview: { file: 'right-source.compat.mp4', ...metadata } } } };
  store.add(project);
  const malformed = structuredClone(store.data);
  malformed.projects[0].surfaces.right.compatibilityPreview.file = '../leak.compat.mp4';
  assert.throws(() => validateDatabase(malformed), /Некорректная совместимая/);
  const exposed = publicProject(project).surfaces.find(item => item.key === 'right').compatibilityPreview;
  assert.equal(exposed.file, undefined);
  assert.equal(exposed.decodedSha256, undefined);
  assert.equal(exposed.width, 320);
  const app = express(); app.use(express.json());
  app.use('/api', authRouter); app.use('/api/projects', projectsRouter); app.use('/api/s', shareRouter);
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const credentials = scryptHash('fixture-viewer-password');
  project.share.passcodeSalt = credentials.salt; project.share.passcodeHash = credentials.hash;
  const unlock = await fetch(`${base}/api/s/compat/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: 'fixture-viewer-password' }) });
  assert.equal(unlock.status, 200);
  const viewer = unlock.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert.equal((await fetch(`${base}/api/projects/compat/media/right/av1`)).status, 401);
  assert.equal((await fetch(`${base}/api/s/compat/media/right/av1`)).status, 401);
  assert.equal((await fetch(`${base}/api/s/compat/media/right/av1`, { headers: { Cookie: viewer } })).status, 403);
  const range = await fetch(`${base}${exposed.url}`, { headers: { Cookie: viewer, Range: 'bytes=0-127' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Type'), 'video/mp4');
  assert.equal(range.headers.get('Content-Range'), `bytes 0-127/${metadata.size}`);
  assert.equal((await range.arrayBuffer()).byteLength, 128);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const admin = await fetch(`${base}/api/projects/compat/media/right/av1`, { headers: { Cookie: cookie, Range: 'bytes=-128' } });
  assert.equal(admin.status, 206); await admin.arrayBuffer();
  project.share.enabled = false;
  assert.equal((await fetch(`${base}${exposed.url}`)).status, 404);
  project.share.enabled = true;
  project.share.revision = 'two';
  assert.equal((await fetch(`${base}${exposed.url}`, { headers: { Cookie: viewer } })).status, 401);
  project.share.revision = 'one';
  project.surfaces.right.replacement = { key: 'right', status: 'processing', file: 'right-candidate.mp4', job: 'candidate' };
  store.save();
  for (const filename of ['right-candidate.mp4', 'right-candidate.compat.mp4', 'right-orphan.compat.mp4']) fs.writeFileSync(path.join(projectDir, filename), 'test');
  cleanupProjectFiles(project.id);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-source.compat.mp4')), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-candidate.compat.mp4')), true);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-orphan.compat.mp4')), false);
  delete project.surfaces.right.compatibilityPreview;
  delete project.surfaces.right.replacement;
  store.save();
  cleanupProjectFiles(project.id);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-source.compat.mp4')), true, 'rollback snapshot keeps the previous compatibility file');
  store.save();
  cleanupProjectFiles(project.id);
  assert.equal(fs.existsSync(path.join(projectDir, 'right-source.compat.mp4')), false, 'unreferenced generated compatibility file is removed');
});

test('large replacement publishes verified AV1 atomically; unsupported chroma keeps the previous publication', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }) });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const big = path.join(directory, 'large.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=4800x2400:rate=24', '-frames:v', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', big]);
  const upload = async (file) => {
    const form = new FormData(); form.append('file', new File([fs.readFileSync(file)], 'large.mp4', { type: 'video/mp4' }));
    const response = await fetch(`${base}/api/projects/compat/surfaces/right`, { method: 'POST', headers: { Cookie: cookie }, body: form });
    assert.equal(response.status, 202);
  };
  const waitFor = async (predicate) => {
    const end = Date.now() + 60000;
    while (Date.now() < end) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error('Compatibility processing timed out');
  };
  const oldProxy = store.project('compat').surfaces.right.proxy;
  await upload(big);
  assert.equal(store.project('compat').surfaces.right.proxy, oldProxy);
  await waitFor(() => {
    const surface = store.project('compat').surfaces.right;
    if (surface.replacement?.status === 'error') throw new Error(surface.replacement.error);
    return !surface.replacement;
  });
  const ready = store.project('compat').surfaces.right;
  assert.notEqual(ready.proxy, oldProxy);
  assert.deepEqual([ready.compatibilityPreview.width, ready.compatibilityPreview.height, ready.compatibilityPreview.frameCount], [4800, 2400, 2]);
  const activeProxy = ready.proxy;
  const activeAV1 = ready.compatibilityPreview.file;
  const activeRevision = store.project('compat').contentRevision;
  const unsupported = path.join(directory, 'center.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=4800x2400:rate=24', '-frames:v', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-chroma_sample_location', 'center', unsupported]);
  assert.equal((await probe(unsupported)).chromaLocation, 'center');
  await upload(unsupported);
  await waitFor(() => store.project('compat').surfaces.right.replacement?.status === 'error');
  assert.equal(store.project('compat').surfaces.right.proxy, activeProxy);
  assert.equal(store.project('compat').surfaces.right.compatibilityPreview.file, activeAV1);
  assert.equal(store.project('compat').contentRevision, activeRevision);
  assert.equal(fs.existsSync(path.join(PROJECTS_DIR, 'compat', activeAV1)), true);
});
