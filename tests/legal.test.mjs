import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/store.js';
import { publicLegalConfig, requireFeedbackConsent, pruneFeedbackData, pruneExpiredFeedback } from '../server/legal.js';

function withOperator(run) {
  const names = ['LEGAL_OPERATOR_NAME', 'LEGAL_OPERATOR_ADDRESS', 'LEGAL_OPERATOR_EMAIL'];
  const before = names.map(name => process.env[name]);
  Object.assign(process.env, { LEGAL_OPERATOR_NAME: 'Тестовый оператор', LEGAL_OPERATOR_ADDRESS: 'Россия, тестовый адрес 1', LEGAL_OPERATOR_EMAIL: 'test@example.invalid' });
  try { run(); } finally {
    names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; });
  }
}
const response = () => ({ statusCode: 200, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } });

test('feedback consent fails closed, records exact operator and rejects stale metadata', () => withOperator(() => {
  const config = publicLegalConfig();
  assert.equal(config.configured, true);
  const noConsent = response();
  assert.equal(requireFeedbackConsent({ body: {} }, noConsent), null);
  assert.equal(noConsent.statusCode, 400);
  const request = { body: { consent: { accepted: true, version: config.consentVersion } } };
  const receipt = requireFeedbackConsent(request, response());
  assert.deepEqual(receipt.operator, config.operator);
  assert.equal(receipt.retentionDays, 180);
  assert.equal(receipt.method, 'checkbox');
  process.env.LEGAL_OPERATOR_ADDRESS = 'Россия, другой тестовый адрес 2';
  const stale = response();
  assert.equal(requireFeedbackConsent(request, stale), null);
  assert.equal(stale.statusCode, 409);
  delete process.env.LEGAL_OPERATOR_NAME;
  const missing = response();
  assert.equal(requireFeedbackConsent(request, missing), null);
  assert.equal(missing.statusCode, 503);
}));

test('retention covers all scenes and published approvals without changing media or unknown dates', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const old = '2026-01-01T00:00:00Z';
  const fresh = '2026-10-29T00:00:00Z';
  const data = { projects: [{ surfaces: { floor: { file: 'retain.mp4' } }, comments: [
    { id: 'old', createdAt: old, consent: { version: 'old' } },
    { id: 'new', createdAt: fresh }, { id: 'legacy' },
  ], approval: { at: old }, publishedVideoScene: { approval: { at: old } },
  videoScenes: [{ comments: [{ createdAt: old }], approval: { at: fresh }, published: { approval: { at: old } } }] }] };
  assert.deepEqual(pruneFeedbackData(data, now), { comments: 2, approvals: 3 });
  assert.deepEqual(data.projects[0].comments.map(value => value.id), ['new', 'legacy']);
  assert.equal(data.projects[0].videoScenes[0].approval.at, fresh);
  assert.equal(data.projects[0].surfaces.floor.file, 'retain.mp4');
  assert.deepEqual(pruneFeedbackData(data, now), { comments: 0, approvals: 0 });
});

test('retention is durable and scrubs the local backup, including backup-only expired records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kuog-legal-'));
  try {
    const file = path.join(directory, 'db.json');
    const store = new Store(file);
    store.add({ id: 'project', slug: 'show', surfaces: {}, share: {}, comments: [{ id: 'old', author: 'Private name', createdAt: '2026-01-01T00:00:00Z' }], approval: null });
    const now = Date.parse('2026-10-30T12:00:00Z');
    const result = pruneExpiredFeedback(store, now);
    assert.equal(result.comments, 1);
    assert.equal(result.backupComments, 1);
    for (const target of [file, `${file}.bak`]) assert.equal(fs.readFileSync(target, 'utf8').includes('Private name'), false);
    assert.deepEqual(new Store(file).project('project').comments, []);
    const backup = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
    backup.projects[0].comments.push({ id: 'backup-old', createdAt: '2026-01-01T00:00:00Z' });
    fs.writeFileSync(`${file}.bak`, JSON.stringify(backup));
    const again = pruneExpiredFeedback(store, now);
    assert.equal(again.comments, 0);
    assert.equal(again.backupComments, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).projects[0].comments, []);
  } finally { fs.rmSync(directory, { force: true, recursive: true }); }
});
