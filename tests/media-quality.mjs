import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import { previewPlan } from '../server/mediaPlan.js';

// Isolated media/config state; this suite never opens or changes the live DB.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hall5-media-quality-'));
process.env.DATA_DIR = path.join(directory, 'data');
const { probe, transcode } = await import('../server/media.js');
const { ffmpegPath } = await import('../server/config.js');
after(() => fs.rmSync(directory, { recursive: true, force: true }));
function ffmpeg(args) {
  const result = spawnSync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
}
const compatible = { codec: 'h264', pixelFormat: 'yuv420p', profile: 'High', rotation: 0,
  fieldOrder: 'progressive', width: 3840, height: 2160, audioCodec: 'aac', audioProfile: 'LC' };

test('only ordinary SDR H.264 profiles use packet copy; HDR is not silently tone-mapped', () => {
  assert.equal(previewPlan(compatible).mode, 'copy');
  for (const change of [{ pixelFormat: 'yuv420p10le' }, { profile: 'High 4:4:4 Predictive' },
    { codec: 'hevc' }, { rotation: 90 }, { fieldOrder: 'tt' }]) {
    assert.equal(previewPlan({ ...compatible, ...change }).mode, 'converted');
  }
  assert.throws(() => previewPlan({ ...compatible, hdr: true }), /HDR.*Оригинал сохранён/);
});

test('2560 px / 60 fps H.264 and AAC packets survive faststart MP4 without a second encode', async () => {
  const input = path.join(directory, 'h264.mp4');
  const output = path.join(directory, 'h264.preview.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=2560x640:rate=60',
    '-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=48000', '-t', '0.5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', input]);
  const before = await probe(input);
  const result = await transcode(input, output, { info: before });
  const after = await probe(output);
  assert.equal(result.mode, 'copy');
  assert.deepEqual([after.width, after.height, after.fps], [2560, 640, 60]);
  for (const stream of ['v:0', 'a:0']) {
    const hash = (file) => ffmpeg(['-i', file, '-map', `0:${stream}`, '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']).trim();
    assert.equal(hash(output), hash(input), `compressed ${stream} bytes changed`);
  }
  const bytes = fs.readFileSync(output);
  assert.ok(bytes.indexOf(Buffer.from('moov')) < bytes.indexOf(Buffer.from('mdat')), 'MP4 index must precede media payload');
});

test('incompatible SDR video keeps >1920 resolution and all 60 fps frames', async () => {
  const input = path.join(directory, 'mpeg4.mkv');
  const output = path.join(directory, 'mpeg4.preview.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=2560x640:rate=60', '-t', '0.4', '-c:v', 'mpeg4', '-q:v', '2', input]);
  const source = await probe(input);
  const result = await transcode(input, output, { info: source });
  const target = await probe(output);
  assert.equal(result.mode, 'converted');
  assert.deepEqual([target.width, target.height, target.fps], [2560, 640, 60]);
  const count = (file) => ffmpeg(['-i', file, '-map', '0:v:0', '-f', 'framemd5', '-']).split('\n').filter((line) => /^0,/.test(line)).length;
  assert.equal(count(output), count(input));
});

test('rotated input is physically rotated without reducing its displayed dimensions', async () => {
  const input = path.join(directory, 'rotation-source.mp4');
  const rotated = path.join(directory, 'rotation.mp4');
  const output = path.join(directory, 'rotation.preview.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x160:rate=24', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
  ffmpeg(['-display_rotation', '90', '-i', input, '-c', 'copy', rotated]);
  const source = await probe(rotated);
  assert.deepEqual([source.width, source.height], [160, 320]);
  await transcode(rotated, output, { info: source });
  const target = await probe(output);
  assert.deepEqual([target.width, target.height, target.rotation], [160, 320, 0]);
});

test('odd dimensions receive padding instead of a resize or crop', async () => {
  const input = path.join(directory, 'odd.mkv');
  const output = path.join(directory, 'odd.preview.mp4');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=201x101:rate=24', '-t', '0.3', '-c:v', 'ffv1', input]);
  await transcode(input, output);
  const target = await probe(output);
  assert.deepEqual([target.width, target.height, target.fps], [202, 102, 24]);
});
