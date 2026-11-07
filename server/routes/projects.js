import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { PROJECTS_DIR, TMP_DIR, MAX_UPLOAD_BYTES } from '../config.js';
import { store } from '../db.js';
import { SURFACE_MAP, SURFACES } from '../surfaces.js';
import { requireAdmin } from '../auth.js';
import { rid, nowISO, scryptHash, cleanText } from '../util.js';
import { adminProject } from '../serialize.js';
import { startProcessing, cancelProcessing } from '../jobs.js';
import { stageSurface, removeSurface, cancelReplacement } from '../surfaceLifecycle.js';
import { processingSurface, contentRevision } from '../content.js';
import { cleanupProjectFiles } from '../mediaFiles.js';
import { sendMedia } from '../mediaServe.js';
import { playbackDiagnostics } from '../playbackDiagnostics.js';
import { videoSceneProject, videoSceneState, beginVideoSceneEdit, createVideoScene, publishVideoScene,
  resetVideoSceneApproval, MAIN_VIDEO_SCENE } from '../videoScenes.js';

const ALLOWED_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.mts', '.m2ts', '.ts', '.mpg', '.mpeg']);

function extensionFor(file) {
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_EXT.has(ext)) return ext;
  const mime = String(file.mimetype || '');
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('quicktime')) return '.mov';
  if (mime.includes('matroska')) return '.mkv';
  return '.mp4';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${rid(16)}${extensionFor(file)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXT.has(ext) || String(file.mimetype || '').startsWith('video/')) {
      cb(null, true);
    } else {
      const error = new Error('Поддерживаются только видеофайлы');
      error.status = 400;
      cb(error);
    }
  },
});

export const projectsRouter = Router();

projectsRouter.use(requireAdmin);

function selectedProject(req, query = false) {
  const id = req.params.sceneId ?? (query ? req.query.videoScene : undefined) ?? MAIN_VIDEO_SCENE;
  return typeof id === 'string' ? videoSceneProject(store.project(req.params.id), id) : null;
}
function beginScopedEdit(req) {
  if (req.params.sceneId) beginVideoSceneEdit(store.project(req.params.id), req.params.sceneId);
}

projectsRouter.post('/:id/video-scenes', (req, res) => {
  const project = store.project(req.params.id);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  const name = cleanText(req.body?.name, 80);
  if (!name) return res.status(400).json({ error: 'Укажите название видеосцены' });
  const selected = createVideoScene(project, name);
  store.save();
  res.status(201).json({ project: adminProject(selected), videoSceneId: selected.videoSceneId });
});
projectsRouter.patch('/:id/video-scenes/:sceneId', (req, res) => {
  const root = store.project(req.params.id);
  const selected = selectedProject(req);
  if (!selected) return res.status(404).json({ error: 'Видеосцена не найдена' });
  const name = cleanText(req.body?.name, 80);
  if (!name) return res.status(400).json({ error: 'Укажите название видеосцены' });
  if (selected.videoSceneId === MAIN_VIDEO_SCENE) root.videoSceneName = name;
  else videoSceneState(root, selected.videoSceneId).name = name;
  selected.updatedAt = nowISO();
  store.save();
  res.json({ project: adminProject(selected) });
});
projectsRouter.delete('/:id/video-scenes/:sceneId', (req, res) => {
  const root = store.project(req.params.id);
  const selected = selectedProject(req);
  if (!selected) return res.status(404).json({ error: 'Видеосцена не найдена' });
  if (selected.videoSceneId === MAIN_VIDEO_SCENE) return res.status(409).json({ error: 'Основную видеосцену удалить нельзя' });
  root.videoScenes = root.videoScenes.filter(scene => scene.id !== selected.videoSceneId);
  root.updatedAt = nowISO();
  store.save();
  void cancelProcessing(root.id, undefined, selected.videoSceneId);
  cleanupProjectFiles(root.id);
  res.json({ project: adminProject(root) });
});
projectsRouter.post('/:id/video-scenes/:sceneId/publish', (req, res) => {
  const root = store.project(req.params.id);
  if (!selectedProject(req)) return res.status(404).json({ error: 'Видеосцена не найдена' });
  const selected = publishVideoScene(root, req.params.sceneId, req.body?.contentRevision);
  store.save();
  res.json({ project: adminProject(selected) });
});

projectsRouter.get('/:id/playback-diagnostics', (req, res) => {
  if (!store.project(req.params.id)) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ diagnostics: playbackDiagnostics(req.params.id) });
});

projectsRouter.get('/', (req, res) => {
  const projects = [...store.projects]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((p) => adminProject(p));
  res.json({ projects });
});

projectsRouter.post('/', (req, res) => {
  const body = req.body || {};
  const title = cleanText(body.title, 120) || 'Новый показ';
  let slug = rid(9);
  while (store.bySlug(slug)) slug = rid(9);
  const project = {
    id: rid(10),
    slug,
    title,
    client: cleanText(body.client, 120),
    eventDate: /^\d{4}-\d{2}-\d{2}$/.test(body.eventDate || '') ? body.eventDate : '',
    description: cleanText(body.description, 2000),
    createdAt: nowISO(),
    updatedAt: nowISO(),
    surfaces: {},
    share: {
      enabled: true,
      revision: rid(6),
      expiresAt: null,
      allowComments: true,
      allowDownload: false,
      passcodeHash: null,
      passcodeSalt: null,
    },
    comments: [],
    approval: null,
    contentRevision: 0,
  };
  store.add(project);
  res.status(201).json({ project: adminProject(project) });
});

projectsRouter.get('/:id', (req, res) => {
  const project = selectedProject(req, true);
  if (!project) {
    res.status(404).json({ error: 'Проект не найден' });
    return;
  }
  res.json({ project: adminProject(project) });
});

projectsRouter.patch('/:id', (req, res) => {
  const project = store.project(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Проект не найден' });
    return;
  }
  const body = req.body || {};
  if ('title' in body) {
    const title = cleanText(body.title, 120);
    if (!title) {
      res.status(400).json({ error: 'Название не может быть пустым' });
      return;
    }
    project.title = title;
  }
  if ('client' in body) project.client = cleanText(body.client, 120);
  if ('description' in body) project.description = cleanText(body.description, 2000);
  if ('eventDate' in body) {
    project.eventDate = /^\d{4}-\d{2}-\d{2}$/.test(body.eventDate || '') ? body.eventDate : '';
  }
  project.updatedAt = nowISO();
  store.save();
  res.json({ project: adminProject(project) });
});

projectsRouter.delete('/:id', (req, res) => {
  const project = store.project(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Проект не найден' });
    return;
  }
  store.remove(project.id);
  void cancelProcessing(project.id);
  cleanupProjectFiles(project.id);
  res.json({ ok: true });
});

projectsRouter.post(['/:id/surfaces/:key', '/:id/video-scenes/:sceneId/surfaces/:key'], upload.single('file'), (req, res) => {
  const project = selectedProject(req);
  const key = req.params.key;
  if (!project || !Object.hasOwn(SURFACE_MAP, key)) {
    if (req.file) fs.rmSync(req.file.path, { force: true });
    res.status(404).json({ error: 'Проект или поверхность не найдены' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: 'Не выбран видеофайл' });
    return;
  }

  const dir = path.join(PROJECTS_DIR, project.id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(req.file.filename).toLowerCase() || '.mp4';
  const base = `${key}-${Date.now().toString(36)}-${rid(8)}`;
  const filename = `${base}${ext}`;
  try {
    fs.renameSync(req.file.path, path.join(dir, filename));
  } catch (error) {
    fs.rmSync(req.file.path, { force: true });
    res.status(500).json({ error: 'Не удалось сохранить файл' });
    return;
  }

  const originalName =
    cleanText(req.file.originalname, 240)
      .replace(/[\\:*?"<>|\r\n]+/g, '_')
      .replace(/\//g, '_') || `${key}${ext}`;
  const surface = {
    key,
    file: filename,
    originalName,
    size: req.file.size,
    mime: req.file.mimetype,
    status: 'processing',
    progress: 0,
    stage: 'В очереди',
    error: null,
    job: rid(8),
    duration: 0,
    width: 0,
    height: 0,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  try {
    beginScopedEdit(req);
    stageSurface(store, project.id, key, surface, project.videoSceneId);
  } catch (error) {
    fs.rmSync(path.join(dir, filename), { force: true });
    throw error;
  }
  // The previous published version remains active until the candidate is verified.
  void cancelProcessing(project.id, key, project.videoSceneId);
  cleanupProjectFiles(project.id);
  startProcessing(project.id, key, project.videoSceneId);
  res.status(202).json({ project: adminProject(project) });
});

projectsRouter.delete(['/:id/surfaces/:key/replacement', '/:id/video-scenes/:sceneId/surfaces/:key/replacement'], (req, res) => {
  const project = selectedProject(req);
  const key = req.params.key;
  if (!project || !Object.hasOwn(SURFACE_MAP, key)) return res.status(404).json({ error: 'Видео или сцена не найдены' });
  const candidate = cancelReplacement(store, project.id, key, {
    revision: req.body?.contentRevision, replacementId: req.body?.replacementId,
  }, project.videoSceneId);
  // Commit first: a failed save must not leave a processing candidate without
  // its worker. Abort only this job; a newer upload must never be cancelled.
  if (candidate.job) void cancelProcessing(project.id, key, project.videoSceneId, candidate.job);
  cleanupProjectFiles(project.id);
  res.json({ project: adminProject(videoSceneProject(store.project(project.id), project.videoSceneId)) });
});

projectsRouter.delete(['/:id/surfaces/:key', '/:id/video-scenes/:sceneId/surfaces/:key'], (req, res) => {
  const project = selectedProject(req);
  const key = req.params.key;
  if (!project || !Object.hasOwn(SURFACE_MAP, key)) {
    res.status(404).json({ error: 'Не найдено' });
    return;
  }
  const surface = project.surfaces[key];
  if (!surface) {
    res.status(404).json({ error: 'Видео не загружено' });
    return;
  }
  beginScopedEdit(req);
  removeSurface(store, project.id, key, project.videoSceneId);
  void cancelProcessing(project.id, key, project.videoSceneId);
  cleanupProjectFiles(project.id);
  res.json({ project: adminProject(project) });
});

projectsRouter.post(['/:id/surfaces/:key/retry', '/:id/video-scenes/:sceneId/surfaces/:key/retry'], (req, res) => {
  const project = selectedProject(req);
  const key = req.params.key;
  const surface = processingSurface(project, key);
  if (!project || !surface) {
    res.status(404).json({ error: 'Не найдено' });
    return;
  }
  if (!surface.file || !fs.existsSync(path.join(PROJECTS_DIR, project.id, surface.file))) {
    res.status(400).json({ error: 'Исходный файл не найден, загрузите видео заново' });
    return;
  }
  if (surface.status !== 'error') {
    res.status(409).json({ error: 'Повторная обработка доступна для видео с ошибкой' });
    return;
  }
  beginScopedEdit(req);
  void cancelProcessing(project.id, key, project.videoSceneId);
  surface.job = rid(8);
  surface.status = 'processing';
  surface.progress = 0;
  surface.stage = 'В очереди';
  surface.error = null;
  project.updatedAt = nowISO();
  store.save();
  startProcessing(project.id, key, project.videoSceneId);
  res.status(202).json({ project: adminProject(project) });
});

// Rebuild an older browser copy from its original without taking the published
// video offline. A new basename isolates output files from the active version.
projectsRouter.post(['/:id/surfaces/:key/rebuild', '/:id/video-scenes/:sceneId/surfaces/:key/rebuild'], async (req, res) => {
  const project = selectedProject(req);
  const key = req.params.key;
  const surface = project?.surfaces?.[key];
  if (!project || !Object.hasOwn(SURFACE_MAP, key) || !surface) {
    res.status(404).json({ error: 'Проект или поверхность не найдены' });
    return;
  }
  const revision = req.body?.contentRevision;
  if (!Number.isSafeInteger(revision) || revision !== contentRevision(project)) {
    res.status(409).json({ error: 'Версия проекта изменилась. Обновите страницу и повторите.' });
    return;
  }
  if (surface.status !== 'ready' || surface.replacement) {
    res.status(409).json({ error: 'Дождитесь обработки или завершите текущую замену видео.' });
    return;
  }
  const dir = path.join(PROJECTS_DIR, project.id);
  const original = path.join(dir, surface.file);
  if (!fs.existsSync(original)) {
    res.status(400).json({ error: 'Исходный файл не найден, загрузите видео заново' });
    return;
  }
  const filename = `${key}-${Date.now().toString(36)}-${rid(8)}${path.extname(surface.file)}`;
  const target = path.join(dir, filename);
  try {
    await fs.promises.copyFile(original, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    const current = videoSceneProject(store.project(project.id), project.videoSceneId);
    if (!current || current.surfaces[key] !== surface || surface.replacement || contentRevision(current) !== revision) {
      fs.rmSync(target, { force: true });
      res.status(409).json({ error: 'Версия проекта изменилась. Обновите страницу и повторите.' });
      return;
    }
    beginScopedEdit(req);
    stageSurface(store, project.id, key, {
      key, file: filename, originalName: surface.originalName, size: surface.size, mime: surface.mime,
      status: 'processing', progress: 0, stage: 'В очереди', error: null, job: rid(8),
      width: 0, height: 0, duration: 0, createdAt: nowISO(), updatedAt: nowISO(),
    }, project.videoSceneId);
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
  startProcessing(project.id, key, project.videoSceneId);
  res.status(202).json({ project: adminProject(videoSceneProject(store.project(project.id), project.videoSceneId)) });
});

projectsRouter.patch('/:id/share', (req, res) => {
  const project = store.project(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Проект не найден' });
    return;
  }
  const body = req.body || {};
  const share = { ...project.share };
  let bumpRevision = false;
  if ('enabled' in body) {
    share.enabled = Boolean(body.enabled);
    if (!share.enabled) bumpRevision = true;
  }
  if ('allowComments' in body) share.allowComments = Boolean(body.allowComments);
  if ('allowDownload' in body) share.allowDownload = Boolean(body.allowDownload);
  if ('expiresAt' in body) {
    if (!body.expiresAt) {
      share.expiresAt = null;
    } else {
      const date = new Date(body.expiresAt);
      if (Number.isNaN(date.getTime())) {
        res.status(400).json({ error: 'Некорректная дата' });
        return;
      }
      share.expiresAt = date.toISOString();
    }
  }
  if ('passcode' in body) {
    const value = typeof body.passcode === 'string' ? body.passcode.trim() : '';
    if (value.length < 8 || value.length > 128) {
      res.status(400).json({ error: 'Пароль показа обязателен: от 8 до 128 символов' });
      return;
    }
    const { salt, hash } = scryptHash(value);
    share.passcodeSalt = salt;
    share.passcodeHash = hash;
    bumpRevision = true;
  }
  if (bumpRevision) share.revision = rid(6);
  project.share = share;
  project.updatedAt = nowISO();
  store.save();
  res.json({ project: adminProject(project) });
});

projectsRouter.post('/:id/share/rotate', (req, res) => {
  const project = store.project(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Проект не найден' });
    return;
  }
  let slug = rid(9);
  while (store.bySlug(slug)) slug = rid(9);
  project.slug = slug;
  project.share.revision = rid(6);
  project.updatedAt = nowISO();
  store.save();
  res.json({ project: adminProject(project) });
});

projectsRouter.delete(['/:id/comments/:commentId', '/:id/video-scenes/:sceneId/comments/:commentId'], (req, res) => {
  const project = selectedProject(req);
  if (!project) {
    res.status(404).json({ error: 'Проект не найден' });
    return;
  }
  project.comments = (project.comments || []).filter((c) => c.id !== req.params.commentId);
  project.updatedAt = nowISO();
  store.save();
  res.json({ project: adminProject(project) });
});

projectsRouter.post(['/:id/approval/reset', '/:id/video-scenes/:sceneId/approval/reset'], (req, res) => {
  const project = selectedProject(req);
  if (!project) {
    res.status(404).json({ error: 'Проект не найден' });
    return;
  }
  resetVideoSceneApproval(project, project.videoSceneId);
  project.updatedAt = nowISO();
  store.save();
  res.json({ project: adminProject(project) });
});

projectsRouter.get(['/:id/media/:key/:variant', '/:id/video-scenes/:sceneId/media/:key/:variant'], (req, res) => {
  const project = selectedProject(req);
  const key = req.params.key;
  const variant = req.params.variant;
  if (!project || !Object.hasOwn(SURFACE_MAP, key) || !['proxy', 'poster', 'original', 'av1', 'mobile'].includes(variant)) {
    res.status(404).json({ error: 'Не найдено' });
    return;
  }
  sendMedia(req, res, project, key, variant, { download: req.query.download === '1' });
});

export const projectSurfaceKeys = SURFACES.map((s) => s.key);
