import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { acquireDataLock } from '../server/dataLock.js';
import { stageSurface, patchProcessing, promoteSurface, removeSurface } from '../server/surfaceLifecycle.js';
import { currentApproval, requiredSurfaceKeys, canApproveProject, hasReviewableContent } from '../server/content.js';
import { defaultScene } from '../server/sceneSchema.js';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-reliability-'));
process.on('exit', () => fs.rmSync(workspace, { recursive: true, force: true }));
function fixture(name) {
  const directory = path.join(workspace, name);
  fs.mkdirSync(directory);
  return { directory, file: path.join(directory, 'db.json') };
}
function project(id = 'p1') {
  return { id, slug: id, title: 'Test', surfaces: {}, share: { enabled: true }, comments: [], approval: null };
}
function ready(key, name = 'old') {
  return { key, status: 'ready', file: `${key}-${name}.mp4`, proxy: `${key}-${name}.preview.mp4`,
    width: 640, height: 160, duration: 2, job: name };
}
function candidate(job = 'new') {
  return { key: 'right', status: 'processing', file: `right-${job}.mp4`, job, progress: 0 };
}

test('missing database initializes empty; malformed database fails closed without overwriting', () => {
  const { file } = fixture('missing');
  assert.equal(new Store(file).projects.length, 0);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => new Store(file), /повреждена/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('recovery validates backup and preserves the exact damaged bytes', () => {
  const { file, directory } = fixture('recovery');
  const store = new Store(file);
  store.add(project());
  store.project('p1').title = 'Next version';
  store.save();
  const damagedBytes = Buffer.from([0xff, 0xfe, 0x00, 0x7b]);
  fs.writeFileSync(file, damagedBytes);
  const recovered = new Store(file);
  assert.equal(recovered.project('p1').title, 'Test');
  const preserved = fs.readdirSync(directory).find((name) => name.includes('.corrupt-'));
  assert.deepEqual(fs.readFileSync(path.join(directory, preserved)), damagedBytes);
  assert.equal(JSON.parse(fs.readFileSync(file)).projects[0].title, 'Test');
});

test('invalid schema and invalid backup do not become an empty database', () => {
  const { file } = fixture('invalid');
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: '../outside' }] }));
  fs.writeFileSync(`${file}.bak`, '{}');
  assert.throws(() => new Store(file), /повреждены/);
});

test('read access failure is fatal and does not attempt recovery writes', () => {
  const { file } = fixture('read-fail');
  let writes = 0;
  const io = Object.create(fs);
  io.readFileSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  io.writeFileSync = () => { writes++; };
  assert.throws(() => new Store(file, { io }), /недоступна/);
  assert.equal(writes, 0);
});

test('failed commit restores committed memory and keeps a verified backup', () => {
  const { file } = fixture('write-fail');
  const io = Object.create(fs);
  let fail = false;
  io.renameSync = (source, target) => {
    if (fail && target === file) throw Object.assign(new Error('full disk'), { code: 'ENOSPC' });
    return fs.renameSync(source, target);
  };
  const store = new Store(file, { io });
  store.add(project());
  fail = true;
  store.project('p1').title = 'Should not commit';
  assert.throws(() => store.save(), /full disk/);
  assert.equal(store.project('p1').title, 'Test');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.bak`)).projects[0].title, 'Test');
  assert.equal(JSON.parse(fs.readFileSync(file)).projects[0].title, 'Test');
});

test('data directory lock rejects another live instance, releases and reclaims a dead owner', () => {
  const { directory } = fixture('lock');
  const release = acquireDataLock(directory);
  assert.throws(() => acquireDataLock(directory), /другой сервер/);
  release();
  const releaseAgain = acquireDataLock(directory);
  releaseAgain();
  fs.writeFileSync(path.join(directory, 'server.lock'), JSON.stringify({ hostname: os.hostname(), pid: 2147483647 }));
  const releaseDead = acquireDataLock(directory);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'server.lock'))).pid, process.pid);
  releaseDead();
});

test('failed replacement preserves active files, approval and revision; retry can promote atomically', () => {
  const { file } = fixture('replacement');
  const store = new Store(file);
  const initial = project();
  initial.surfaces.right = ready('right');
  initial.contentRevision = 3;
  initial.approval = { author: 'Client', revision: 3 };
  store.add(initial);
  stageSurface(store, 'p1', 'right', candidate());
  assert.equal(store.project('p1').surfaces.right.file, 'right-old.mp4');
  assert.equal(currentApproval(store.project('p1')).author, 'Client');
  patchProcessing(store, 'p1', 'right', 'new', { status: 'error', error: 'broken video' });
  assert.equal(store.project('p1').surfaces.right.status, 'ready');
  assert.equal(store.project('p1').surfaces.right.replacement.error, 'broken video');
  assert.equal(store.project('p1').contentRevision, 3);
  stageSurface(store, 'p1', 'right', candidate('retry'));
  assert.equal(promoteSurface(store, 'p1', 'right', 'new', {}), null, 'a stale job cannot promote');
  patchProcessing(store, 'p1', 'right', 'retry', { width: 640, height: 160, duration: 2 });
  promoteSurface(store, 'p1', 'right', 'retry', { proxy: 'right-retry.preview.mp4' });
  assert.equal(store.project('p1').surfaces.right.file, 'right-retry.mp4');
  assert.equal(store.project('p1').surfaces.right.replacement, undefined);
  assert.equal(store.project('p1').approval, null);
  assert.equal(store.project('p1').contentRevision, 4);
  const restarted = new Store(file);
  assert.equal(restarted.project('p1').surfaces.right.file, 'right-retry.mp4');
});

test('failed promotion and failed deletion do not change the published state', () => {
  const { file } = fixture('promotion-fail');
  const io = Object.create(fs);
  let fail = false;
  io.renameSync = (source, target) => {
    if (fail && target === file) throw new Error('write failed');
    return fs.renameSync(source, target);
  };
  const store = new Store(file, { io });
  const initial = project(); initial.surfaces.right = ready('right');
  store.add(initial);
  stageSurface(store, 'p1', 'right', { ...candidate(), width: 640, height: 160, duration: 2 });
  fail = true;
  assert.throws(() => promoteSurface(store, 'p1', 'right', 'new', { proxy: 'new.preview.mp4' }), /write failed/);
  assert.equal(store.project('p1').surfaces.right.file, 'right-old.mp4');
  assert.throws(() => removeSurface(store, 'p1', 'right'), /write failed/);
  assert.equal(store.project('p1').surfaces.right.file, 'right-old.mp4');
});

test('media subprocess deadline and cancellation release the queue', async () => {
  process.env.DATA_DIR = path.join(workspace, 'media-data');
  const { runMediaProcess, enqueue } = await import('../server/media.js');
  await assert.rejects(runMediaProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 80, idleMs: 1000 }), /время обработки/);
  const controller = new AbortController();
  const stopped = runMediaProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(new Error('cancel-test'));
  await assert.rejects(stopped, /cancel-test/);
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('queue stalled')), 3000);
    enqueue(async () => { await assert.rejects(runMediaProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 80 }), /время обработки/); });
    enqueue(async () => { clearTimeout(deadline); resolve(); });
  });
});


test('stored scenes and model filenames are validated before commit and load', () => {
  const { file } = fixture('scene-store');
  const store = new Store(file);
  const initial = project();
  initial.scene = defaultScene();
  initial.sceneAssets = [{ id: 'model1', file: 'model-one.glb', name: 'One' }];
  initial.scene.objects.push({ id: 'object1', type: 'model', name: 'Object', assetId: 'model1',
    position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: '#ffffff' });
  store.add(initial);
  assert.equal(new Store(file).project('p1').scene.objects[0].assetId, 'model1');
  store.project('p1').scene.room.width = 0;
  assert.throws(() => store.save(), /Ширина/);
  assert.equal(store.project('p1').scene.room.width, 20);
  store.project('p1').sceneAssets[0].file = '../outside.glb';
  assert.throws(() => store.save(), /3D-модели/);
  assert.equal(store.project('p1').sceneAssets[0].file, 'model-one.glb');
  store.project('p1').scene.objects[0].assetId = 'missing';
  assert.throws(() => store.save(), /Модель не найдена/);
  store.project('p1').surfaces.right = { ...ready('right'), file: 'bad\0.mp4' };
  assert.throws(() => store.save(), /имя медиафайла/);
  assert.equal(store.project('p1').surfaces.right, undefined);
});


test('custom scenes require only assigned channels and static scenes can be reviewed', async () => {
  const { projectDuration, projectStatus, adminProject, publicProject } = await import('../server/serialize.js');
  const legacy = project();
  assert.deepEqual(requiredSurfaceKeys(legacy), ['right', 'back', 'left', 'center', 'floor']);
  assert.equal(canApproveProject(legacy), false);
  const screen = { id: 'screen1', type: 'screen', name: 'Screen', source: 'right',
    position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: '#ffffff' };
  const custom = project('custom');
  custom.scene = { ...defaultScene(), showRoomSurfaces: false, objects: [screen, { ...screen, id: 'screen2' }] };
  custom.surfaces.right = { ...ready('right'), duration: 20 };
  custom.surfaces.left = { ...ready('left'), duration: 1 };
  custom.surfaces.back = { key: 'back', status: 'processing', file: 'back-queued.mp4', job: 'unused' };
  assert.deepEqual(requiredSurfaceKeys(custom), ['right']);
  assert.equal(canApproveProject(custom), true, 'unused processing video does not block a custom scene');
  assert.equal(projectDuration(custom), 20, 'unused short video does not truncate the timeline');
  assert.equal(projectStatus(custom), 'ready');
  assert.deepEqual(adminProject(custom).requiredSurfaceKeys, ['right']);
  assert.deepEqual(publicProject(custom).requiredSurfaceKeys, ['right']);
  assert.equal(publicProject(custom).processing, 1, 'upload polling retains all-five processing counts');
  custom.surfaces.right.replacement = candidate('replacement-required');
  assert.equal(canApproveProject(custom), false, 'replacement of a required channel blocks approval');
  custom.surfaces.right.replacement.status = 'error';
  assert.equal(canApproveProject(custom), true, 'failed replacement preserves the old reviewable content');
  delete custom.surfaces.right;
  assert.equal(canApproveProject(custom), false, 'a missing assigned channel blocks approval');
  custom.scene.objects = [{ ...screen, id: 'chair1', type: 'chair', source: null }];
  assert.deepEqual(requiredSurfaceKeys(custom), []);
  assert.equal(hasReviewableContent(custom), true);
  assert.equal(canApproveProject(custom), true);
  assert.equal(projectDuration(custom), 0);
  assert.equal(projectStatus(custom), 'ready');
  custom.scene.objects = [];
  assert.equal(hasReviewableContent(custom), false);
  assert.equal(canApproveProject(custom), false, 'an empty hidden scene is not reviewable');
  custom.scene.showRoomSurfaces = true;
  assert.equal(requiredSurfaceKeys(custom).length, 5, 'visible default room always requires all five channels');
});
