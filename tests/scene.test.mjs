import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultScene, normalizeScene, validateGlb } from '../server/sceneSchema.js';

export function triangleGlb(extra = {}) {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
    ...extra,
  };
  const raw = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 0x20);
  raw.copy(padded);
  const bytes = Buffer.alloc(12 + 8 + padded.length + 8 + 36);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(bytes, 20);
  const bin = 20 + padded.length;
  bytes.writeUInt32LE(36, bin);
  bytes.writeUInt32LE(0x004e4942, bin + 4);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => bytes.writeFloatLE(value, bin + 8 + i * 4));
  return bytes;
}

test('scene accepts primitives but strips supplied asset URLs', () => {
  const scene = { ...defaultScene(), assets: [{ id: 'evil', url: 'https://example.com/' }], objects: [{
    id: 'podium-1', type: 'podium', name: 'Подиум', position: [1, 0, 2], rotation: [0, 45, 0], size: [4, 0.5, 2], color: '#445566', source: null,
  }] };
  const normalized = normalizeScene(scene);
  assert.equal(normalized.objects[0].name, 'Подиум');
  assert.equal(normalized.assets, undefined);
});

test('scene rejects invalid dimensions, duplicate IDs, and unknown model assets', () => {
  assert.throws(() => normalizeScene({ ...defaultScene(), room: { width: -1, depth: 10, height: 5 } }));
  const object = { id: 'model', type: 'model', name: 'Стул', position: [0, 0, 0], rotation: [0, 0, 0], size: [1, 1, 1], color: '#ffffff', source: null, assetId: 'other-project' };
  assert.throws(() => normalizeScene({ ...defaultScene(), objects: [object] }));
  assert.throws(() => normalizeScene({ ...defaultScene(), objects: [object, object] }, [{ id: 'other-project' }]));
  assert.equal(normalizeScene({ ...defaultScene(), objects: [object] }, [{ id: 'other-project' }]).objects.length, 1);
});

test('GLB accepts self-contained geometry and rejects corruption/external files/unsupported compression', () => {
  assert.equal(validateGlb(triangleGlb()).vertices, 3);
  const badLength = triangleGlb(); badLength.writeUInt32LE(1, 8);
  assert.throws(() => validateGlb(badLength));
  assert.throws(() => validateGlb(triangleGlb({ buffers: [{ byteLength: 36, uri: 'https://example.com/file.bin' }] })));
  assert.throws(() => validateGlb(triangleGlb({ images: [{ uri: 'https://example.com/texture.png' }] })));
  assert.throws(() => validateGlb(triangleGlb({ extensionsRequired: ['KHR_draco_mesh_compression'] })));
  assert.throws(() => validateGlb(triangleGlb({ bufferViews: [{ buffer: 0, byteLength: 1000 }] })));
  for (const malformed of [{ meshes: [null] }, { images: {} }, { extensionsRequired: {} }, { meshes: [{ primitives: {} }] }]) {
    assert.throws(() => validateGlb(triangleGlb(malformed)), (error) => error.status === 400);
  }
  assert.throws(() => validateGlb(triangleGlb({ nodes: [{ mesh: 0, children: [1] }, { children: [0] }] })), (error) => error.status === 400);
});
