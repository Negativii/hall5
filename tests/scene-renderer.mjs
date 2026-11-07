import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSceneContent } from '../src/components/scene/sceneObjects.ts';
import { defaultScene, normalizeScene } from '../server/sceneSchema.js';

function chair(index) {
  return {
    id: `chair-${index}`, type: 'chair', name: `Стул ${index + 1}`,
    position: [-4.9 + Math.floor(index / 8) * .65, 0, [-3.9, -3, -2.1, -1.2, 1.2, 2.1, 3, 3.9][index % 8]],
    rotation: [0, -90, 0], size: [.48, .9, .5], color: '#ead8b9', source: null,
  };
}
function config(objects) { return { ...defaultScene(), showRoomSurfaces: false, assets: [], objects }; }

test('seating plan supports 136 chairs and accepts at most 200 objects', () => {
  const chairs = Array.from({ length: 136 }, (_, index) => chair(index));
  assert.equal(normalizeScene(config(chairs)).objects.length, 136);
  assert.equal(normalizeScene(config(Array.from({ length: 200 }, (_, index) => chair(index)))).objects.length, 200);
  assert.throws(() => normalizeScene(config(Array.from({ length: 201 }, (_, index) => chair(index)))), /200/);
});

test('public seating shares one merged chair geometry and one draw batch per color', () => {
  const chairs = Array.from({ length: 136 }, (_, index) => chair(index));
  const content = createSceneContent(config(chairs));
  const batches = [];
  content.group.traverse((object) => { if (object.isInstancedMesh) batches.push(object); });
  assert.equal(batches.length, 1);
  const batch = batches[0];
  assert.equal(batch.count, 136);
  assert.equal(content.objects.size, 136);
  const actual = new THREE.Matrix4();
  for (const index of [0, 67, 135]) {
    batch.getMatrixAt(index, actual);
    const expected = content.objects.get(chairs[index].id).matrix;
    actual.elements.forEach((value, axis) => assert.ok(Math.abs(value - expected.elements[axis]) < 1e-6));
  }
  let geometryDisposals = 0, instanceDisposals = 0;
  batch.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });
  batch.addEventListener('dispose', () => { instanceDisposals += 1; });
  content.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(instanceDisposals, 1);
});

test('editor chairs remain individually selectable while sharing geometry', () => {
  const chairs = Array.from({ length: 136 }, (_, index) => chair(index));
  const content = createSceneContent(config(chairs), { editor: true });
  const geometries = new Set();
  for (const object of chairs) {
    const root = content.objects.get(object.id);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].isInstancedMesh, undefined);
    assert.equal(root.children[0].userData.sceneId, object.id);
    geometries.add(root.children[0].geometry);
  }
  assert.equal(geometries.size, 1);
  const geometry = [...geometries][0]; geometry.computeBoundingBox();
  assert.ok(Math.abs(geometry.boundingBox.min.y) < 1e-6);
  assert.ok(Math.abs(geometry.boundingBox.max.y - 1) < 1e-6);
  content.dispose();
});

test('perimeter screens use inward front faces while portable screens retain their backs', () => {
  const screen = (id, position, rotation, width) => ({ id, type: 'screen', name: id, position, rotation, size: [width, 5, .02], color: '#151515', source: 'right' });
  const walls = [
    screen('front', [-10, 0, 0], [0, 90, 0], 10),
    screen('left', [0, 0, -5], [0, 0, 0], 20),
    screen('right', [0, 0, 5], [0, 180, 0], 20),
    screen('rear', [10, 0, 0], [0, -90, 0], 10),
  ];
  const portable = { ...screen('portable', [0, 0, 0], [0, 0, 0], 4), size: [4, 2.25, .08] };
  for (const editor of [false, true]) {
    const content = createSceneContent(config([...walls, portable]), { editor });
    for (const wall of walls) {
      const root = content.objects.get(wall.id);
      assert.equal(root.children.length, 1);
      const plane = root.children[0];
      assert.equal(plane.geometry.type, 'PlaneGeometry');
      assert.equal(plane.material.side, THREE.FrontSide);
      assert.equal(plane.material.transparent, editor);
    }
    assert.equal(content.objects.get('portable').children.length, 2);
    content.dispose();
  }
});

test('thin video floor has one physical top surface at the exact height, including grazing rays', () => {
  const floor = { id: 'floor', type: 'floor', name: 'Пол', position: [0, -.02, 0], rotation: [0, 0, 0], size: [20, .02, 10], color: '#151515', source: 'floor' };
  const video = Object.assign(new EventTarget(), { readyState: 4, HAVE_CURRENT_DATA: 2 });
  for (const editor of [false, true]) {
    const content = createSceneContent(config([floor]), { editor, videos: editor ? undefined : { floor: video } });
    const root = content.objects.get('floor');
    content.group.updateMatrixWorld(true);
    assert.equal(root.children.length, 1, 'video must replace the solid top instead of overlapping it');
    const mesh = root.children[0];
    assert.equal(mesh.geometry.type, 'BoxGeometry');
    assert.equal(mesh.material[2].isMeshBasicMaterial, true);
    assert.equal(Boolean(mesh.material[2].map?.isVideoTexture), !editor);
    const bounds = new THREE.Box3().setFromObject(root);
    assert.ok(Math.abs(bounds.min.y + .02) < 1e-9);
    assert.ok(Math.abs(bounds.max.y) < 1e-9, 'visible floor must remain exactly at ground level');
    const topGroups = mesh.geometry.groups.filter((group) => group.materialIndex === 2);
    assert.equal(topGroups.length, 1);
    assert.equal(topGroups[0].count, 6, 'exactly two triangles cover the floor top');
    const target = new THREE.Vector3(-2, 0, 1.27);
    for (const eyeHeight of [.001, .1, 1.75, 12]) {
      const origin = new THREE.Vector3(9, eyeHeight, .1);
      const ray = new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
      const hits = ray.intersectObject(root, true);
      const atTarget = hits.filter((hit) => hit.point.distanceTo(target) < 1e-7);
      assert.equal(atTarget.length, 1, `one top surface at eye height ${eyeHeight}`);
      assert.equal(atTarget[0].face.materialIndex, 2);
    }
    content.dispose();
  }
});

test('video floor top preserves the previous horizontal plane UVs after scaling and rotation', () => {
  const floor = { id: 'floor', type: 'floor', name: 'Пол', position: [2, .15, -3], rotation: [0, 37, 0], size: [20, .02, 10], color: '#151515', source: 'floor' };
  const content = createSceneContent(config([floor]));
  content.group.updateMatrixWorld(true);
  const root = content.objects.get('floor');
  const mesh = root.children[0];
  const top = mesh.geometry.groups.find((group) => group.materialIndex === 2);
  const indices = mesh.geometry.getIndex();
  const vertices = new Set(Array.from({ length: top.count }, (_, index) => indices.getX(top.start + index)));
  const key = (point) => point.toArray().map((value) => Math.round(value * 1e6) / 1e6).join(',');
  const actual = new Map([...vertices].map((index) => [
    key(new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), index).applyMatrix4(mesh.matrixWorld)),
    new THREE.Vector2().fromBufferAttribute(mesh.geometry.getAttribute('uv'), index).toArray(),
  ]));
  const previous = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 1, 0);
  const positions = previous.getAttribute('position');
  for (let index = 0; index < positions.count; index++) {
    const point = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(root.matrixWorld);
    assert.deepEqual(actual.get(key(point)), new THREE.Vector2().fromBufferAttribute(previous.getAttribute('uv'), index).toArray());
  }
  previous.dispose();
  content.dispose();
});

function minimalGLB() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0' }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  }));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const glb = Buffer.alloc(12 + 8 + jsonLength + 8 + positions.byteLength);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonLength, 12); glb.writeUInt32LE(0x4e4f534a, 16);
  glb.fill(0x20, 20, 20 + jsonLength); json.copy(glb, 20);
  glb.writeUInt32LE(positions.byteLength, 20 + jsonLength); glb.writeUInt32LE(0x004e4942, 24 + jsonLength);
  Buffer.from(positions.buffer).copy(glb, 28 + jsonLength);
  return glb;
}

function modelConfig(url) {
  return { ...config([0, 1].map((index) => ({
    id: `model-${index}`, type: 'model', name: 'Imported chair', assetId: 'asset-1',
    position: [index * 3, 0, 0], rotation: [0, index * 45, 0], size: [1, 1, 1], color: '#ffffff', source: null,
  }))), assets: [{ id: 'asset-1', name: 'chair.glb', url }] };
}

test('repeated GLB furniture parses once, shares GPU resources and retains independent editor transforms', async () => {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const originalFetch = globalThis.fetch; const originalParse = GLTFLoader.prototype.parseAsync;
  let fetches = 0; let parses = 0;
  globalThis.fetch = async () => { fetches++; return new Response(minimalGLB()); };
  GLTFLoader.prototype.parseAsync = function (...args) { parses++; return originalParse.apply(this, args); };
  let content;
  try {
    let loaded = 0; let resolveLoaded;
    const ready = new Promise((resolve) => { resolveLoaded = resolve; });
    const errors = [];
    content = createSceneContent(modelConfig('/test/shared-model.glb'), {
      editor: true, onLoad: () => { if (++loaded === 2) resolveLoaded(); }, onError: (message) => { errors.push(message); resolveLoaded(); },
    });
    await ready;
    assert.deepEqual(errors, []);
    assert.equal(fetches, 1); assert.equal(parses, 1);
    const roots = [...content.objects.values()];
    const meshes = roots.map((root) => { let result; root.traverse((node) => { if (node.isMesh) result = node; }); return result; });
    assert.notEqual(meshes[0], meshes[1]);
    assert.equal(meshes[0].geometry, meshes[1].geometry);
    assert.equal(meshes[0].material, meshes[1].material);
    assert.equal(meshes[0].userData.sceneId, 'model-0');
    assert.equal(meshes[1].userData.sceneId, 'model-1');
    roots[0].position.x = 9;
    assert.equal(roots[1].position.x, 3);
    let geometries = 0; let materials = 0;
    meshes[0].geometry.addEventListener('dispose', () => geometries++);
    meshes[0].material.addEventListener('dispose', () => materials++);
    content.dispose(); content.dispose();
    assert.equal(geometries, 1); assert.equal(materials, 1);
  } finally { content?.dispose(); globalThis.fetch = originalFetch; GLTFLoader.prototype.parseAsync = originalParse; }
});

test('a shared GLB finishing after scene disposal releases resources without mounting copies', async () => {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const originalFetch = globalThis.fetch; const originalParse = GLTFLoader.prototype.parseAsync;
  globalThis.fetch = async () => new Response(minimalGLB());
  let release; let notifyParsed;
  const parsed = new Promise((resolve) => { notifyParsed = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let geometries = 0; let materials = 0; let loaded = 0; let errors = 0;
  GLTFLoader.prototype.parseAsync = async function (...args) {
    const result = await originalParse.apply(this, args);
    result.scene.traverse((node) => {
      if (node.geometry) node.geometry.addEventListener('dispose', () => geometries++);
      if (node.material) node.material.addEventListener('dispose', () => materials++);
    });
    notifyParsed(); await gate; return result;
  };
  let content;
  try {
    content = createSceneContent(modelConfig('/test/disposed-model.glb'), { onLoad: () => loaded++, onError: () => errors++ });
    await parsed;
    content.dispose(); release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loaded, 0); assert.equal(errors, 0);
    assert.equal(geometries, 1); assert.equal(materials, 1);
  } finally { release?.(); content?.dispose(); globalThis.fetch = originalFetch; GLTFLoader.prototype.parseAsync = originalParse; }
});
