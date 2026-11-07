import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';

const TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg',
};

export function surfaceFile(project, key, variant) {
  const surface = project.surfaces?.[key];
  if (!surface) return null;
  const name =
    variant === 'poster' ? surface.poster : variant === 'original' ? surface.file
      : variant === 'av1' ? surface.compatibilityPreview?.file : variant === 'mobile' ? surface.mobilePreview?.file
        : variant === 'proxy' ? surface.proxy : null;
  if (!name) return null;
  const file = path.join(PROJECTS_DIR, project.id, path.basename(name));
  if (!fs.existsSync(file)) return null;
  return { file, surface };
}

export function sendMedia(req, res, project, key, variant, { download = false } = {}) {
  const found = surfaceFile(project, key, variant);
  if (!found) {
    res.status(404).json({ error: 'Файл не найден' });
    return;
  }
  const { file, surface } = found;
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  const onError = (error) => {
    if (!error || res.headersSent || res.destroyed) return;
    // Preserve 416 for unsatisfiable Range requests (video seeking), as well
    // as other HTTP errors supplied by Express. Do not label every failure 404.
    res.status(error.status || error.statusCode || 500).end();
  };
  if (download) {
    const name = surface.originalName || `${key}${ext}`;
    res.download(file, name, onError);
    return;
  }
  res.sendFile(file, onError);
}
