import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ffmpegPath, ffprobePath, binaryWorks } from './config.js';
import { previewPlan } from './mediaPlan.js';

function requireBinary(path, label) {
  if (!path || !binaryWorks(path)) {
    throw new Error(
      `${label} не найден на сервере. Выполните «npm run setup:ffmpeg» или установите системный ffmpeg.`,
    );
  }
}

// Every subprocess has an absolute deadline, an inactivity deadline and cancellation.
// Wait for close before rejecting so the queue never starts another job over a live child.
export function runMediaProcess(command, args, { onStdout, onStderr, signal, timeoutMs = 60000, idleMs = 60000, maxOutput = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Обработка отменена')); return; }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    let reason;
    let killTimer;
    let idleTimer;
    const stop = (error) => {
      if (reason) return;
      reason = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop(new Error('Обработка не отвечает. Повторите попытку.')), idleMs);
      idleTimer.unref();
    };
    const deadline = setTimeout(() => stop(new Error('Превышено время обработки видео. Повторите попытку.')), timeoutMs);
    deadline.unref();
    resetIdle();
    const abort = () => stop(signal.reason || new Error('Обработка отменена'));
    signal?.addEventListener('abort', abort, { once: true });
    const clear = () => {
      clearTimeout(deadline);
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    child.stdout.on('data', (chunk) => {
      resetIdle();
      if (stdout.length + chunk.length > maxOutput) {
        if (!onStdout) stop(new Error('Слишком большой ответ анализатора видео'));
        stdout = stdout.slice(-20000);
      }
      stdout += chunk.toString();
      if (onStdout && !reason) {
        try { onStdout(chunk.toString()); }
        catch (error) { stop(error); }
      }
    });
    child.stderr.on('data', (chunk) => {
      resetIdle();
      stderr = (stderr + chunk.toString()).slice(-20000);
      if (onStderr && !reason) {
        try { onStderr(chunk.toString()); }
        catch (error) { stop(error); }
      }
    });
    child.on('error', (error) => { reason ||= error; });
    child.on('close', (code) => {
      clear();
      if (reason) reject(reason);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || `Код ${code}`));
    });
  });
}

export async function probe(file, { signal } = {}) {
  requireBinary(ffprobePath, 'ffprobe');
  const { stdout } = await runMediaProcess(ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal });
  const json = JSON.parse(stdout);
  const video = (json.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video) throw new Error('В файле нет видеодорожки');
  let width = Number(video.width) || 0;
  let height = Number(video.height) || 0;
  const rotation = ((Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video.tags?.rotate) || 0) % 360 + 360) % 360;
  if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) [width, height] = [height, width];
  const duration = Number(json.format?.duration || video.duration) || 0;
  if (!Number.isFinite(duration) || duration <= 0 || !width || !height) {
    throw new Error('Не удалось определить длительность или размеры видео');
  }
  const audio = (json.streams || []).find((s) => s.codec_type === 'audio');
  const [fpsNumerator, fpsDenominator] = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
  const fps = fpsDenominator > 0 ? fpsNumerator / fpsDenominator : 0;
  return { width, height, duration, codec: video.codec_name || '',
    videoStream: video.index, audioStream: audio?.index,
    pixelFormat: video.pix_fmt || '', profile: video.profile || '',
    fieldOrder: video.field_order || '', rotation,
    level: Number.isInteger(video.level) ? video.level : null,
    frameCount: Number(video.nb_frames) > 0 ? Number(video.nb_frames) : null,
    timeBase: video.time_base || '',
    colorRange: video.color_range || '', colorSpace: video.color_space || '',
    colorPrimaries: video.color_primaries || '', colorTransfer: video.color_transfer || '',
    chromaLocation: video.chroma_location || '',
    hdr: ['smpte2084', 'arib-std-b67'].includes(video.color_transfer)
      || (video.side_data_list || []).some((item) => /mastering display|content light|dovi/i.test(item.side_data_type || '')),
    fps: Number.isFinite(fps) ? fps : 0,
    audioCodec: audio?.codec_name || '', audioProfile: audio?.profile || '',
    container: (json.format?.format_name || '').split(',')[0],
    hasAudio: Boolean(audio),
    bitrate: Number(json.format?.bit_rate) || 0 };
}

export async function transcode(input, output, { duration, info, onProgress, signal } = {}) {
  requireBinary(ffmpegPath, 'ffmpeg');
  const source = info || await probe(input, { signal });
  const plan = previewPlan(source);
  duration ||= source.duration;
  const args = [
    '-nostdin',
    '-y',
    '-i',
    input,
    '-map',
    `0:${source.videoStream}`,
    '-map',
    source.hasAudio ? `0:${source.audioStream}` : '0:a:0?',
    ...plan.videoArgs,
    '-movflags',
    '+faststart',
    ...(plan.copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '320k']),
    '-sn',
    '-dn',
    '-progress',
    'pipe:1',
    '-nostats',
    '-f',
    'mp4',
    output,
  ];

  let lastReport = 0;
  await runMediaProcess(ffmpegPath, args, {
    signal,
    timeoutMs: Math.max(60000, Number(process.env.MEDIA_TIMEOUT_MS) || 6 * 60 * 60 * 1000),
    idleMs: 5 * 60 * 1000,
    onStdout: (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('out_time_')) continue;
        const [key, raw] = line.split('=');
        if (!raw || raw === 'N/A') continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        const seconds = key === 'out_time_ms' ? value / 1e6 : value / 1e6;
        if (duration > 0) {
          const pct = Math.min(0.99, Math.max(0, seconds / duration));
          const now = Date.now();
          if (now - lastReport > 600) {
            lastReport = now;
            onProgress?.(pct);
          }
        }
      }
    },
  });

  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    throw new Error('Не удалось закодировать превью');
  }
  onProgress?.(1);
  return plan;
}

export async function makePoster(input, output, { width, duration, signal }) {
  requireBinary(ffmpegPath, 'ffmpeg');
  const at = Math.min(1.2, Math.max(0, (duration || 2) * 0.2));
  const targetWidth = Math.max(2, Math.round(Math.min(960, width || 960) / 2) * 2);
  const args = [
    '-nostdin',
    '-y',
    '-ss',
    String(at),
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale=${targetWidth}:-2`,
    '-q:v',
    '3',
    '-f',
    'image2',
    output,
  ];
  await runMediaProcess(ffmpegPath, args, { signal });
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    throw new Error('Не удалось сделать постер');
  }
}

const queue = [];
let pumping = false;

export function enqueue(task) {
  queue.push(task);
  if (!pumping) pump();
}

async function pump() {
  pumping = true;
  while (queue.length) {
    const task = queue.shift();
    try {
      await task();
    } catch (error) {
      console.error('[job]', error);
    }
  }
  pumping = false;
}

export function queueInfo() {
  return { pending: queue.length, active: pumping };
}
