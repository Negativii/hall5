import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');

export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const DB_FILE = path.join(DATA_DIR, 'db.json');

export const PORT = Number(process.env.PORT || 3000);
export const HOST = process.env.HOST || '0.0.0.0';
export const IS_PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';
// Never fall back to a publicly known password, including for local installs.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const ADMIN_PASSWORD_CONFIGURED = ADMIN_PASSWORD.length >= 12
  && !['hall5', 'password1234', '123456789012'].includes(ADMIN_PASSWORD.toLowerCase());
export const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.MAX_UPLOAD_GB || 8)) * 1024 ** 3;
export const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

for (const dir of [DATA_DIR, PROJECTS_DIR, TMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  const file = path.join(DATA_DIR, 'secret.key');
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  } catch {
    /* create below */
  }
  const value = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, value, { mode: 0o600 });
  return value;
}

export const SECRET = loadSecret();

let ffmpegPath = null;
let ffprobePath = null;
try {
  const mod = await import('ffmpeg-static');
  ffmpegPath = mod.default || mod;
} catch {
  ffmpegPath = null;
}
try {
  const mod = await import('@ffprobe-installer/ffprobe');
  ffprobePath = (mod.default || mod).path;
} catch {
  ffprobePath = null;
}

// A copied node_modules may contain a binary for a different OS/CPU.
// Prefer explicit paths, then a working bundled binary, then the system PATH.
ffmpegPath = process.env.FFMPEG_PATH || (ffmpegPath && fs.existsSync(ffmpegPath) && binaryWorks(ffmpegPath) ? ffmpegPath : 'ffmpeg');
ffprobePath = process.env.FFPROBE_PATH || (ffprobePath && fs.existsSync(ffprobePath) && binaryWorks(ffprobePath) ? ffprobePath : 'ffprobe');

export function binaryWorks(command) {
  try {
    const result = spawnSync(command, ['-version'], { stdio: 'ignore', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

export { ffmpegPath, ffprobePath };
