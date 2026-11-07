import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { store } from '../db.js';
import { PROJECTS_DIR, TMP_DIR } from '../config.js';
import { requireAdmin, verifyMediaToken, hasShareAccess } from '../auth.js';
import { rid, cleanText } from '../util.js';
import { contentRevision } from '../content.js';
import { markSharedLayoutChanged } from '../videoScenes.js';
import { normalizeScene, validateGlb } from '../sceneSchema.js';
import { serializeScene } from '../scene.js';
import { cleanupProjectFiles } from '../mediaFiles.js';

const uploads = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => cb(null, `${rid(18)}.glb`),
  }),
  limits: { fileSize: 50 * 1024 ** 2, files: 1 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() === '.glb') cb(null, true);
    else cb(Object.assign(new Error('Нужен файл .glb со встроенными текстурами'), { status: 400 }));
  },
});

export const sceneRouter = Router();
sceneRouter.use(requireAdmin);
sceneRouter.use('/:id/scene', (req, res, next) => {
  if (!store.project(req.params.id)) return res.status(404).json({ error: 'Проект не найден' });
  next();
});
sceneRouter.get('/:id/scene', (req, res) => {
  const project = store.project(req.params.id);
  res.json({ scene: serializeScene(project), contentRevision: contentRevision(project) });
});
sceneRouter.patch('/:id/scene', (req, res) => {
  const project = store.project(req.params.id);
  if (req.body?.contentRevision !== contentRevision(project)) {
    return res.status(409).json({ error: 'Проект изменился в другом окне. Обновите сцену перед сохранением.' });
  }
  const scene = normalizeScene(req.body?.scene, project.sceneAssets || []);
  if (JSON.stringify(scene) !== JSON.stringify(project.scene)) {
    project.scene = scene;
    markSharedLayoutChanged(project);
    project.updatedAt = new Date().toISOString();
    store.save();
  }
  res.json({ scene: serializeScene(project), contentRevision: contentRevision(project) });
});
sceneRouter.post('/:id/assets', (req, res, next) => {
  const project = store.project(req.params.id);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  if ((project.sceneAssets?.length || 0) >= 40) return res.status(400).json({ error: 'В проекте уже 40 моделей. Удалите неиспользуемые.' });
  next();
}, uploads.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите GLB-файл' });
  const project = store.project(req.params.id);
  if (!project) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(404).json({ error: 'Проект удалён во время загрузки' });
  }
  validateGlb(fs.readFileSync(req.file.path));
  if ((project.sceneAssets?.length || 0) >= 40) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: 'В проекте уже 40 моделей' });
  }
  const id = rid(16);
  const file = `model-${id}.glb`;
  const dir = path.join(PROJECTS_DIR, project.id);
  fs.mkdirSync(dir, { recursive: true });
  const destination = path.join(dir, file);
  fs.renameSync(req.file.path, destination);
  const asset = { id, file, name: cleanText(req.file.originalname, 120) || 'Модель.glb', size: req.file.size };
  project.sceneAssets = [...(project.sceneAssets || []), asset];
  project.updatedAt = new Date().toISOString();
  try { store.save(); }
  catch (error) { fs.rmSync(destination, { force: true }); throw error; }
  const serialized = serializeScene(project).assets.find((a) => a.id === id);
  res.status(201).json({ asset: serialized });
});
sceneRouter.get('/:id/assets/:assetId', (req, res) => {
  const project = store.project(req.params.id);
  sendAsset(req, res, project, req.params.assetId);
});
sceneRouter.delete('/:id/assets/:assetId', (req, res) => {
  const project = store.project(req.params.id);
  const asset = project?.sceneAssets?.find((a) => a.id === req.params.assetId);
  if (!asset) return res.status(404).json({ error: 'Модель не найдена' });
  if (project.scene?.objects.some((object) => object.assetId === asset.id)) return res.status(409).json({ error: 'Сначала удалите из сцены объекты с этой моделью' });
  project.sceneAssets = project.sceneAssets.filter((a) => a.id !== asset.id);
  store.save();
  cleanupProjectFiles(project.id);
  res.json({ ok: true });
});

function sendAsset(req, res, project, id) {
  const asset = project?.sceneAssets?.find((a) => a.id === id);
  if (!asset) return res.status(404).json({ error: 'Модель не найдена' });
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'private, no-store');
  res.sendFile(path.join(PROJECTS_DIR, project.id, path.basename(asset.file)), (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
}

export const sceneShareRouter = Router();
sceneShareRouter.get('/:slug/assets/:assetId', (req, res) => {
  const project = store.bySlug(req.params.slug);
  if (!project || project.share?.enabled === false || (project.share?.expiresAt && new Date(project.share.expiresAt).getTime() <= Date.now())) return res.status(404).json({ error: 'Показ недоступен' });
  if (!hasShareAccess(req, project)) return res.status(401).json({ error: 'Нужен пароль', code: 'password_required' });
  if (!verifyMediaToken(req.query.mt, project.id, project.share?.revision || '0')) return res.status(403).json({ error: 'Ссылка на модель устарела, обновите страницу' });
  if (!project.scene?.objects.some((object) => object.assetId === req.params.assetId)) return res.status(404).json({ error: 'Модель не используется в показе' });
  sendAsset(req, res, project, req.params.assetId);
});
