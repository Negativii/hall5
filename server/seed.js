import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECTS_DIR, ffmpegPath, binaryWorks } from './config.js';
import { store } from './db.js';
import { probe, transcode, makePoster } from './media.js';
import { SURFACES } from './surfaces.js';

const DURATION = 14;
const FPS = 24;

const PALETTES = {
  right: { type: 'linear', c: ['0x0a0503', '0xff5a36', '0xffb27a', '0x2a0a06'], speed: 0.012 },
  back: { type: 'linear', c: ['0x08060f', '0x6b4dff', '0xd9c2ff', '0x1a0d2e'], speed: 0.016 },
  left: { type: 'linear', c: ['0x04100b', '0x2fd6a3', '0xc6ffe9', '0x062b20'], speed: 0.011 },
  center: { type: 'linear', c: ['0x100b03', '0xffc266', '0xfff1cf', '0x3a2104'], speed: 0.018 },
  floor: { type: 'radial', c: ['0x100306', '0xff4d7d', '0xffc2d4', '0x300714'], speed: 0.009 },
};

function generate(source, output) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      source,
      '-t',
      String(DURATION),
      '-r',
      String(FPS),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      output,
    ];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (chunk) => {
      err += chunk.toString();
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400)))));
  });
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

const existing = store.bySlug('demo');
if (existing) {
  log('Демо уже существует: /s/demo');
  process.exit(0);
}

if (!ffmpegPath || !binaryWorks(ffmpegPath)) {
  log('ffmpeg не найден — демо не создано');
  process.exit(1);
}

const id = `demo${Date.now().toString(36).slice(-6)}`;
const dir = path.join(PROJECTS_DIR, id);
fs.mkdirSync(dir, { recursive: true });

const project = {
  id,
  slug: 'demo',
  title: 'Ночь музеев · демо-показ',
  client: 'KUOG HALL',
  eventDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
  description:
    'Демонстрационный показ: пять абстрактных заливок на стенах и полу зала 20 × 10 метров.',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  surfaces: {},
  share: {
    enabled: true,
    expiresAt: null,
    allowComments: true,
    allowDownload: false,
    passcodeHash: null,
    passcodeSalt: null,
  },
  comments: [],
  approval: null,
  demo: true,
};

for (const spec of SURFACES) {
  const palette = PALETTES[spec.key];
  const filename = `demo-${spec.key}.mp4`;
  const output = path.join(dir, filename);
  const source = `gradients=s=${spec.specW}x${spec.specH}:rate=${FPS}:duration=${DURATION}:nb_colors=4:type=${palette.type}:c0=${palette.c[0]}:c1=${palette.c[1]}:c2=${palette.c[2]}:c3=${palette.c[3]}:x0=0:y0=0:x1=${spec.specW}:y1=${spec.specH}:speed=${palette.speed}:seed=7`;

  log(`Генерирую ${spec.label} ${spec.specW}×${spec.specH}…`);
  await generate(source, output);

  const info = await probe(output);
  const base = path.parse(filename).name;
  const proxyName = `${base}.preview.mp4`;
  const posterName = `${base}.poster.jpg`;

  log(`  превью и постер…`);
  const plan = await transcode(output, path.join(dir, proxyName), {
    info,
    duration: info.duration,
  });
  const outputInfo = await probe(path.join(dir, proxyName));
  await makePoster(output, path.join(dir, posterName), {
    width: info.width,
    duration: info.duration,
  });

  project.surfaces[spec.key] = {
    key: spec.key,
    file: filename,
    originalName: filename,
    size: fs.statSync(output).size,
    mime: 'video/mp4',
    status: 'ready',
    progress: 100,
    stage: null,
    error: null,
    job: 'demo',
    duration: Math.round(info.duration * 1000) / 1000,
    width: info.width,
    height: info.height,
    codec: info.codec,
    fps: info.fps,
    previewMode: plan.mode,
    previewWidth: outputInfo.width,
    previewHeight: outputInfo.height,
    previewFps: outputInfo.fps,
    previewBitrate: outputInfo.bitrate,
    hasAudio: false,
    proxy: proxyName,
    poster: posterName,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
  };
}

store.add(project);
log('');
log('Демо готово.');
log('  /s/demo');
log(`  ${path.join(dir)}`);
