import assert from 'node:assert/strict';
import { triangleGlb } from './scene.test.mjs';

if (process.env.HALL5_TEST_ISOLATED !== '1') throw new Error('Запускайте только с HALL5_TEST_ISOLATED=1 на отдельной тестовой DATA_DIR');
const base = process.env.BASE || 'http://127.0.0.1:3215';
const password = process.env.TEST_ADMIN_PASSWORD || 'hall5-test';
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
async function request(url, method = 'GET', body, authenticated = true) {
  const form = body instanceof FormData;
  const response = await fetch(`${base}${url}`, { method, headers: { ...(authenticated ? { Cookie: cookie } : {}), ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
let project;
try {
  const created = await request('/api/projects', 'POST', { title: 'QA сцена / GLB' });
  assert.equal(created.status, 201); project = created.data.project;
  const route = `/api/projects/${project.id}`;
  assert.equal((await request(`${route}/scene`, 'GET', undefined, false)).status, 401);
  const initial = await request(`${route}/scene`);
  assert.deepEqual(initial.data.scene.assets, []);
  const form = new FormData();
  form.append('file', new Blob([triangleGlb()], { type: 'model/gltf-binary' }), 'furniture.glb');
  const uploaded = await request(`${route}/assets`, 'POST', form);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded));
  const asset = uploaded.data.asset;
  assert.equal((await fetch(`${base}${asset.url}`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}${asset.url}`)).status, 401);
  const bad = new FormData();
  bad.append('file', new Blob([triangleGlb({ images: [{ uri: 'https://example.com/private.png' }] })]), 'bad.glb');
  assert.equal((await request(`${route}/assets`, 'POST', bad)).status, 400);
  const object = { id: 'model1', type: 'model', name: 'Мебель', position: [0, 0, 0], rotation: [0, 30, 0], size: [1, 1, 1], color: '#ffffff', source: null, assetId: asset.id };
  const scene = { ...initial.data.scene, room: { width: 24, depth: 12, height: 6 }, objects: [object] };
  const saved = await request(`${route}/scene`, 'PATCH', { scene, contentRevision: initial.data.contentRevision });
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.equal(saved.data.contentRevision, initial.data.contentRevision + 1);
  assert.equal((await request(`${route}/scene`, 'PATCH', { scene, contentRevision: initial.data.contentRevision })).status, 409);
  assert.equal((await request(`${route}/assets/${asset.id}`, 'DELETE')).status, 409);
  const pub = await request(`/api/s/${project.slug}`, 'GET', undefined, false);
  assert.equal(pub.data.project.scene.objects[0].assetId, asset.id);
  const publicAsset = pub.data.project.scene.assets[0].url;
  assert.equal((await fetch(`${base}${publicAsset}`)).status, 200);
  assert.equal((await fetch(`${base}${publicAsset.split('?')[0]}`)).status, 403);
  await request(`${route}/share`, 'PATCH', { enabled: false });
  assert.equal((await fetch(`${base}${publicAsset}`)).status, 404);
  const empty = { ...saved.data.scene, objects: [] };
  assert.equal((await request(`${route}/scene`, 'PATCH', { scene: empty, contentRevision: saved.data.contentRevision })).status, 200);
  assert.equal((await request(`${route}/assets/${asset.id}`, 'DELETE')).status, 200);
  console.log('SCENE API PASSED: save, conflict, GLB validation, private/public media, revocation, deletion guard');
} finally {
  if (project) await request(`/api/projects/${project.id}`, 'DELETE');
}
