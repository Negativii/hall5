import fs from 'node:fs';
import crypto from 'node:crypto';
import { ffmpegPath } from './config.js';
import { probe, runMediaProcess } from './media.js';
import { encoderTimeBase } from './mediaTimeBase.js';

// AVC Level 5.2 permits at most 36,864 macroblocks in a frame. Keep the
// unmodified H.264 preview, but add another codec for larger frames.
export function needsCompatibilityPreview(info) {
  return info.codec === 'h264' && Math.ceil(info.width / 16) * Math.ceil(info.height / 16) > 36864;
}

const processOptions = (signal) => ({ signal,
  timeoutMs: Math.max(60000, Number(process.env.MEDIA_TIMEOUT_MS) || 6 * 60 * 60 * 1000),
  idleMs: 5 * 60 * 1000 });

async function encoderArgs(signal, fps) {
  const { stdout } = await runMediaProcess(ffmpegPath, ['-hide_banner', '-encoders'], { signal });
  // Decode in display order instead of front-loading hidden reference frames
  // into the first packets. Bound keyframe spacing to roughly two seconds at
  // the source frame rate; this improves startup and seeks without changing
  // any decoded pixels. A low-delay bitstream can be larger than random access.
  const keyframes = ['-g', String(Math.max(1, Math.round((fps > 0 ? fps : 24) * 2)))];
  // Debian ships an older SVT encoder without working lossless support.
  // Prefer libaom when both are present; decoded verification remains mandatory.
  if (/\blibaom-av1\b/.test(stdout)) return ['-c:v', 'libaom-av1', '-cpu-used', '6',
    '-crf', '0', '-b:v', '0', '-row-mt', '1', ...keyframes,
    '-lag-in-frames', '0', '-auto-alt-ref', '0', '-aom-params', 'lossless=1:chroma-sample-position=1'];
  if (/\blibsvtav1\b/.test(stdout)) return ['-c:v', 'libsvtav1', '-preset', '6', ...keyframes,
    '-svtav1-params', 'lossless=1:lp=2:enable-tf=0:chroma-sample-position=left:pred-struct=1:hierarchical-levels=2:lookahead=0'];
  throw new Error('Для этого разрешения нужен FFmpeg с AV1 без потерь (SVT-AV1 3.0.2+ или libaom). Исходное видео сохранено.');
}

function rational(value, numerator, denominator) {
  let n = BigInt(value) * numerator;
  let d = denominator;
  let a = n < 0n ? -n : n;
  let b = d;
  while (b) [a, b] = [b, a % b];
  const divisor = a || 1n;
  return `${n / divisor}/${d / divisor}`;
}

async function decodedFingerprint(file, info, signal) {
  const pixels = crypto.createHash('sha256');
  const timing = crypto.createHash('sha256');
  let pending = '';
  let timebase;
  let frameCount = 0;
  const line = (value) => {
    const tb = value.match(/^#tb 0: (\d+)\/(\d+)$/);
    if (tb) { timebase = [BigInt(tb[1]), BigInt(tb[2])]; return; }
    if (!value || value.startsWith('#')) return;
    const columns = value.split(',').map(item => item.trim());
    if (!timebase || !timebase[1] || columns.length !== 6 || columns[0] !== '0' || !/^[a-f0-9]{64}$/i.test(columns[5])) {
      throw new Error('Не удалось проверить кадры совместимого видео. Замена не опубликована.');
    }
    // Canonical rational timestamps compare identically even when the MP4
    // timescale changes. Keep constant memory for long uploaded videos.
    pixels.update(`${columns[4]}:${columns[5]}\n`);
    timing.update(`${rational(columns[2], ...timebase)}:${rational(columns[3], ...timebase)}\n`);
    frameCount++;
  };
  await runMediaProcess(ffmpegPath, ['-nostdin', '-v', 'error', '-i', file,
    '-map', `0:${info.videoStream}`, '-an', '-sn', '-dn', '-c:v', 'rawvideo', '-pix_fmt', info.pixelFormat,
    '-fps_mode', 'passthrough', '-enc_time_base', encoderTimeBase(info), '-f', 'framehash', '-hash', 'sha256', '-'], {
    ...processOptions(signal), onStdout: (chunk) => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const item of lines) line(item.trim());
      if (pending.length > 4096) throw new Error('Некорректный ответ проверки кадров');
    },
  });
  if (pending.trim()) line(pending.trim());
  if (!frameCount) throw new Error('Совместимая копия не содержит кадров. Замена не опубликована.');
  return { decodedSha256: pixels.digest('hex'), timingSha256: timing.digest('hex'), frameCount };
}

async function audioHash(file, info, signal) {
  const { stdout } = await runMediaProcess(ffmpegPath, ['-nostdin', '-v', 'error', '-i', file,
    '-map', `0:${info.audioStream}`, '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], processOptions(signal));
  return stdout.trim();
}

// Flags and encoder names are not proof of losslessness. Decode the complete
// output and compare every video byte before making this file discoverable.
export async function verifyCompatibilityPreview(input, output, { info, signal } = {}) {
  const source = info || await probe(input, { signal });
  const target = await probe(output, { signal });
  // Some bundled FFprobe builds omit AV1 chroma_location even when the
  // sequence header declares it. Verify the bitstream rather than accepting
  // missing metadata or rejecting an otherwise exact copy.
  if (source.chromaLocation === 'left' && !target.chromaLocation) {
    let pending = '', found = false, mismatch = false;
    const inspect = line => {
      const match = line.match(/\bchroma_sample_position\s+\d+\s+=\s+(\d+)/);
      if (match) { found = true; mismatch ||= match[1] !== '1'; }
    };
    await runMediaProcess(ffmpegPath, ['-nostdin', '-hide_banner', '-i', output,
      '-map', `0:${target.videoStream}`, '-c:v', 'copy', '-frames:v', '1',
      '-bsf:v', 'trace_headers', '-an', '-f', 'null', '-'], { ...processOptions(signal), onStderr: chunk => {
        pending += chunk;
        const lines = pending.split('\n'); pending = lines.pop();
        for (const line of lines) inspect(line);
        if (pending.length > 4096) throw new Error('Некорректный заголовок AV1');
      } });
    inspect(pending);
    if (found && !mismatch) target.chromaLocation = 'left';
  }
  if (source.pixelFormat !== 'yuv420p' || source.hdr || source.rotation !== 0
    || target.codec !== 'av1' || target.pixelFormat !== source.pixelFormat
    || target.width !== source.width || target.height !== source.height
    || Math.abs(target.fps - source.fps) > 0.0001
    || Math.abs(target.duration - source.duration) > Math.max(0.05, 1 / Math.max(1, source.fps))
    || (source.frameCount && target.frameCount && source.frameCount !== target.frameCount)
    || target.hasAudio !== source.hasAudio) {
    throw new Error('Параметры AV1 отличаются от исходного видео. Замена не опубликована.');
  }
  for (const field of ['colorRange', 'colorSpace', 'colorPrimaries', 'colorTransfer', 'chromaLocation']) {
    if (source[field] && !['unknown', 'unspecified'].includes(source[field]) && source[field] !== target[field]) {
      throw new Error(`Цветовые параметры AV1 отличаются от исходного видео (${field}: ${source[field]} → ${target[field] || 'не указано'}). Замена не опубликована.`);
    }
  }
  const sourceFingerprint = await decodedFingerprint(input, source, signal);
  const targetFingerprint = await decodedFingerprint(output, target, signal);
  if (sourceFingerprint.decodedSha256 !== targetFingerprint.decodedSha256) {
    throw new Error('AV1-копия не прошла проверку без потерь. Нужен FFmpeg с lossless AV1; исходное видео сохранено.');
  }
  if (sourceFingerprint.timingSha256 !== targetFingerprint.timingSha256
    || sourceFingerprint.frameCount !== targetFingerprint.frameCount) {
    throw new Error('Временные метки кадров AV1 отличаются от оригинала. Замена не опубликована.');
  }
  if (source.hasAudio && (source.audioCodec !== target.audioCodec
    || await audioHash(input, source, signal) !== await audioHash(output, target, signal))) {
    throw new Error('Звук совместимой копии отличается от оригинала. Замена не опубликована.');
  }
  return { codec: 'av1', mode: 'lossless', mimeType: 'video/mp4; codecs="av01"',
    width: target.width, height: target.height, fps: target.fps, duration: target.duration,
    ...targetFingerprint, verifiedAt: new Date().toISOString(), size: fs.statSync(output).size };
}

export async function createCompatibilityPreview(input, output, { info, signal, onProgress } = {}) {
  const source = info || await probe(input, { signal });
  if (source.pixelFormat !== 'yuv420p' || source.hdr || source.rotation !== 0) {
    throw new Error('AV1 без потерь требует готовое SDR-превью yuv420p без поворота.');
  }
  if (source.chromaLocation && !['left', 'unspecified', 'unknown'].includes(source.chromaLocation)) {
    throw new Error('AV1 без потерь пока поддерживает только обычное расположение цветовых отсчётов left. Исходное видео сохранено.');
  }
  const colors = [];
  for (const [field, option] of [['colorRange', '-color_range'], ['colorSpace', '-colorspace'],
    ['colorPrimaries', '-color_primaries'], ['colorTransfer', '-color_trc']]) {
    if (source[field] && !['unknown', 'unspecified'].includes(source[field])) colors.push(option, source[field]);
  }
  const args = ['-nostdin', '-y', '-i', input, '-map', `0:${source.videoStream}`,
    '-map', source.hasAudio ? `0:${source.audioStream}` : '0:a:0?',
    ...await encoderArgs(signal, source.fps), '-pix_fmt', 'yuv420p', ...colors,
    '-fps_mode', 'passthrough', '-enc_time_base', encoderTimeBase(source), '-c:a', 'copy', '-sn', '-dn', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', '-f', 'mp4', output];
  await runMediaProcess(ffmpegPath, args, { ...processOptions(signal), onStdout: (chunk) => {
    for (const match of chunk.matchAll(/out_time_us=(\d+)/g)) onProgress?.(Math.min(0.95, Number(match[1]) / 1e6 / source.duration * 0.95));
  } });
  const result = await verifyCompatibilityPreview(input, output, { info: source, signal });
  onProgress?.(1);
  return result;
}
