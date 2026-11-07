import fs from 'node:fs';
import crypto from 'node:crypto';
import { ffmpegPath, ffprobePath } from './config.js';
import { probe, runMediaProcess } from './media.js';
import { encoderTimeBase } from './mediaTimeBase.js';

// A separate rendition for simultaneous phone playback. Full-quality files
// remain separate; this rendition intentionally trades detail for decoder cost.
export function mobilePreviewPlan(info) {
  if (!(info.width >= 2) || !(info.height >= 2) || !(info.fps > 0)
    || info.hdr || info.rotation !== 0 || info.pixelFormat !== 'yuv420p') {
    throw new Error('Мобильная копия требует готовое SDR-превью yuv420p с известной частотой кадров.');
  }
  const scale = Math.min(1, 1920 / info.width, 1080 / info.height);
  return { width: Math.max(2, Math.floor(info.width * scale / 2) * 2),
    height: Math.max(2, Math.floor(info.height * scale / 2) * 2),
    fps: info.fps, keyframeInterval: Math.max(1, Math.round(info.fps * 2)) };
}

const processOptions = (signal) => ({ signal,
  timeoutMs: Math.max(60000, Number(process.env.MEDIA_TIMEOUT_MS) || 6 * 60 * 60 * 1000),
  idleMs: 5 * 60 * 1000 });

function rational(value, numerator, denominator) {
  const n = BigInt(value) * numerator;
  let a = n < 0n ? -n : n;
  let b = denominator;
  while (b) [a, b] = [b, a % b];
  const divisor = a || 1n;
  return `${n / divisor}/${denominator / divisor}`;
}

async function frameTiming(file, info, signal) {
  const tb = info.timeBase.match(/^(\d+)\/(\d+)$/);
  if (!tb || !Number(tb[2])) throw new Error('Не удалось прочитать временную шкалу видео.');
  const timebase = [BigInt(tb[1]), BigInt(tb[2])];
  const hash = crypto.createHash('sha256');
  let pending = '';
  let frameCount = 0;
  const line = (value) => {
    if (!value.startsWith('frame|')) return;
    // Older bundled ffprobe appends `side_data|...` directly to the final
    // numeric field, without a delimiter. It is unrelated to frame timing.
    const fields = Object.fromEntries(value.replace(/side_data\|.*$/, '').split('|').slice(1).map(item => item.split('=')));
    const pts = fields.best_effort_timestamp;
    const duration = fields.duration ?? fields.pkt_duration;
    if (!/^-?\d+$/.test(pts || '') || !/^\d+$/.test(duration || '')) {
      throw new Error('Не удалось проверить временные метки мобильного видео.');
    }
    hash.update(`${rational(pts, ...timebase)}:${rational(duration, ...timebase)}\n`);
    frameCount++;
  };
  await runMediaProcess(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
    '-show_entries', 'frame=best_effort_timestamp,duration,pkt_duration', '-of', 'compact', file], {
    ...processOptions(signal), onStdout: chunk => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const item of lines) line(item.trim());
      if (pending.length > 16384) throw new Error('Некорректный ответ проверки видео');
    },
  });
  if (pending.trim()) line(pending.trim());
  if (!frameCount) throw new Error('Мобильное видео не содержит кадров.');
  return { frameCount, timingSha256: hash.digest('hex') };
}

async function audioHash(file, info, signal) {
  const { stdout } = await runMediaProcess(ffmpegPath, ['-nostdin', '-v', 'error', '-i', file,
    '-map', `0:${info.audioStream}`, '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], processOptions(signal));
  return stdout.trim();
}

export async function verifyMobilePreview(input, output, { info, signal } = {}) {
  const source = info || await probe(input, { signal });
  const plan = mobilePreviewPlan(source);
  const target = await probe(output, { signal });
  if (target.codec !== 'h264' || target.pixelFormat !== 'yuv420p'
    || target.width !== plan.width || target.height !== plan.height
    || Math.abs(target.fps - source.fps) > 0.0001
    || Math.abs(target.duration - source.duration) > Math.max(0.05, 1 / source.fps)
    || target.hasAudio !== source.hasAudio) {
    throw new Error('Мобильная копия не прошла проверку размеров или времени. Замена не опубликована.');
  }
  for (const field of ['colorRange', 'colorSpace', 'colorPrimaries', 'colorTransfer']) {
    if (source[field] && !['unknown', 'unspecified'].includes(source[field]) && source[field] !== target[field]) {
      throw new Error('Цветовые параметры мобильной копии изменены. Замена не опубликована.');
    }
  }
  const before = await frameTiming(input, source, signal);
  const after = await frameTiming(output, target, signal);
  if (before.frameCount !== after.frameCount || before.timingSha256 !== after.timingSha256) {
    throw new Error('Мобильная копия изменила кадры или их временные метки. Замена не опубликована.');
  }
  if (source.hasAudio && (source.audioCodec !== target.audioCodec
    || await audioHash(input, source, signal) !== await audioHash(output, target, signal))) {
    throw new Error('Звук мобильной копии отличается от оригинала. Замена не опубликована.');
  }
  return { codec: 'h264', mode: 'mobile', mimeType: 'video/mp4', width: target.width, height: target.height,
    fps: target.fps, duration: target.duration, ...after, size: fs.statSync(output).size,
    bitrate: target.bitrate, verifiedAt: new Date().toISOString() };
}

export async function createMobilePreview(input, output, { info, signal, onProgress } = {}) {
  const source = info || await probe(input, { signal });
  const plan = mobilePreviewPlan(source);
  const colors = [];
  for (const [field, option] of [['colorRange', '-color_range'], ['colorSpace', '-colorspace'],
    ['colorPrimaries', '-color_primaries'], ['colorTransfer', '-color_trc']]) {
    if (source[field] && !['unknown', 'unspecified'].includes(source[field])) colors.push(option, source[field]);
  }
  await runMediaProcess(ffmpegPath, ['-nostdin', '-y', '-i', input, '-map', `0:${source.videoStream}`,
    '-map', source.hasAudio ? `0:${source.audioStream}` : '0:a:0?',
    '-vf', `scale=${plan.width}:${plan.height}:flags=lanczos,setsar=1`,
    '-c:v', 'libx264', '-preset', 'medium', '-tune', 'zerolatency', '-crf', '20',
    '-maxrate', '4M', '-bufsize', '8M', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-bf', '0', '-refs', '1', '-g', String(plan.keyframeInterval), ...colors,
    '-fps_mode', 'passthrough', '-enc_time_base', encoderTimeBase(source), '-c:a', 'copy', '-sn', '-dn',
    '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', output], {
    ...processOptions(signal), onStdout: chunk => {
      for (const match of chunk.matchAll(/out_time_us=(\d+)/g)) onProgress?.(Math.min(0.95, Number(match[1]) / 1e6 / source.duration * 0.95));
    },
  });
  const result = await verifyMobilePreview(input, output, { info: source, signal });
  onProgress?.(1);
  return result;
}
