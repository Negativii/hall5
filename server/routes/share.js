import { Router } from 'express';
import { store } from '../db.js';
import { SURFACE_MAP } from '../surfaces.js';
import {
  hasShareAccess,
  issueShareCookie,
  verifyMediaToken,
  clearCookie,
  shareCookieName,
} from '../auth.js';
import { scryptVerify, cleanText, clampNumber, rid, nowISO } from '../util.js';
import { publicProject, projectDuration } from '../serialize.js';
import { contentRevision, canApproveProject } from '../content.js';
import { sendMedia } from '../mediaServe.js';
import { rateLimit } from '../ratelimit.js';
import { recordPlaybackDiagnostic } from '../playbackDiagnostics.js';
import { selectPublicVideoScene, MAIN_VIDEO_SCENE } from '../videoScenes.js';
import { requireFeedbackConsent } from '../legal.js';

export const shareRouter = Router();

function active(project) {
  if (!project || project.share?.enabled === false) return false;
  if (project.share?.expiresAt && new Date(project.share.expiresAt).getTime() < Date.now()) {
    return false;
  }
  return true;
}

function find(slug) {
  const project = store.bySlug(slug);
  return active(project) ? project : null;
}

function unlocked(req, project) {
  return hasShareAccess(req, project);
}

function selectedPublic(req, project) {
  return selectPublicVideoScene(project, req.params.sceneId ?? req.body?.videoSceneId ?? req.query.videoScene);
}
function staleMediaVersion(req, project) {
  if (req.query.v === undefined) return false;
  if (req.params.sceneId) return String(req.query.v) !== String(contentRevision(project));
  // Legacy per-channel URLs may still be playing in an old tab. Never resolve
  // an obsolete version to a different file after publication.
  const surface = project.surfaces?.[req.params.key];
  return ![String(contentRevision(project)), String(surface?.updatedAt || surface?.processedAt || '0')].includes(String(req.query.v));
}

shareRouter.get('/:slug', (req, res) => {
  const project = find(req.params.slug);
  if (!project) {
    res.status(404).json({ error: 'Показ не найден или ссылка больше не действует' });
    return;
  }
  if (!unlocked(req, project)) {
    res.status(401).json({
      locked: true,
      code: project.share?.passcodeHash ? 'password_required' : 'password_not_configured',
      error: project.share?.passcodeHash ? 'Введите пароль показа' : 'Владелец ещё не настроил пароль показа',
    });
    return;
  }
  const selected = selectedPublic(req, project);
  if (!selected) return res.status(404).json({ error: 'Видеосцена не опубликована' });
  res.json({ locked: false, project: publicProject(selected) });
});

shareRouter.post('/:slug/playback-diagnostics', (req, res) => {
  const project = find(req.params.slug);
  if (!project) return res.status(404).end();
  if (!unlocked(req, project)) return res.status(401).end();
  if (rateLimit(`playback:${req.ip}:${project.id}`, 30, 5 * 60 * 1000)) return res.status(429).end();
  if (!recordPlaybackDiagnostic(project.id, req.body)) return res.status(400).end();
  res.status(204).end();
});

shareRouter.post('/:slug/unlock', (req, res) => {
  const project = find(req.params.slug);
  if (!project) {
    res.status(404).json({ error: 'Показ не найден' });
    return;
  }
  const ip = req.ip || 'unknown';
  if (rateLimit(`unlock:${ip}:${project.id}`, 8, 10 * 60 * 1000)) {
    res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
    return;
  }
  const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode : '';
  if (!project.share?.passcodeHash) {
    res.status(401).json({ locked: true, code: 'password_not_configured', error: 'Владелец ещё не настроил пароль показа' });
    return;
  }
  if (passcode.length > 128 || !scryptVerify(passcode, project.share.passcodeSalt, project.share.passcodeHash)) {
    res.status(401).json({ error: 'Неверный пароль' });
    return;
  }
  issueShareCookie(req, res, project);
  const selected = selectedPublic(req, project);
  if (!selected) return res.status(404).json({ error: 'Видеосцена не опубликована' });
  res.json({ project: publicProject(selected) });
});

shareRouter.post('/:slug/logout', (req, res) => {
  if (/^[a-zA-Z0-9_-]{1,80}$/.test(req.params.slug)) clearCookie(res, shareCookieName(req.params.slug));
  res.json({ ok: true });
});

shareRouter.post('/:slug/comments', (req, res) => {
  let project = find(req.params.slug);
  if (!project) {
    res.status(404).json({ error: 'Показ не найден' });
    return;
  }
  if (!unlocked(req, project)) {
    res.status(401).json({ error: 'Нужен пароль' });
    return;
  }
  project = selectedPublic(req, project);
  if (!project) return res.status(404).json({ error: 'Видеосцена не опубликована' });
  if (project.share?.allowComments === false) {
    res.status(403).json({ error: 'Комментарии отключены' });
    return;
  }
  const consent = requireFeedbackConsent(req, res);
  if (!consent) return;
  if (req.body?.contentRevision !== undefined && req.body.contentRevision !== contentRevision(project)) {
    return res.status(409).json({ error: 'Версия видеосцены изменилась. Обновите показ перед комментарием.' });
  }
  if (rateLimit(`comment:${req.ip}:${project.id}`, 40, 5 * 60 * 1000)) {
    res.status(429).json({ error: 'Слишком много комментариев' });
    return;
  }
  const author = cleanText(req.body?.author, 40);
  const text = cleanText(req.body?.text, 2000);
  if (!author) {
    res.status(400).json({ error: 'Укажите имя' });
    return;
  }
  if (!text) {
    res.status(400).json({ error: 'Комментарий пустой' });
    return;
  }
  const duration = projectDuration(project);
  const comment = {
    id: rid(8),
    author,
    text,
    time: clampNumber(req.body?.time, 0, Math.max(0, duration), 0),
    createdAt: nowISO(),
    revision: contentRevision(project),
    videoSceneId: project.videoSceneId || MAIN_VIDEO_SCENE,
    consent,
  };
  project.comments = [...(project.comments || []), comment];
  project.updatedAt = nowISO();
  store.save();
  const { consent: receipt, ...publicComment } = comment;
  res.status(201).json({ comment: publicComment });
});

shareRouter.post('/:slug/approve', (req, res) => {
  let project = find(req.params.slug);
  if (!project) {
    res.status(404).json({ error: 'Показ не найден' });
    return;
  }
  if (!unlocked(req, project)) {
    res.status(401).json({ error: 'Нужен пароль' });
    return;
  }
  project = selectedPublic(req, project);
  if (!project) return res.status(404).json({ error: 'Видеосцена не опубликована' });
  if (project.share?.allowComments === false) {
    res.status(403).json({ error: 'Согласование отключено' });
    return;
  }
  const consent = requireFeedbackConsent(req, res);
  if (!consent) return;
  const author = cleanText(req.body?.author, 40);
  if (!author) {
    res.status(400).json({ error: 'Укажите имя' });
    return;
  }
  if (!canApproveProject(project)) {
    res.status(409).json({ error: 'Добавьте содержимое сцены и дождитесь готовности всех используемых видеоканалов' });
    return;
  }
  const revision = contentRevision(project);
  const submittedRevision = req.body?.contentRevision ?? req.body?.revision;
  if (submittedRevision !== undefined && submittedRevision !== revision) {
    res.status(409).json({ error: 'Версия показа изменилась. Обновите страницу и проверьте новый контент.' });
    return;
  }
  project.approval = {
    revision,
    author,
    note: cleanText(req.body?.note, 600),
    at: nowISO(),
    consent,
  };
  project.updatedAt = nowISO();
  store.save();
  const { consent: receipt, ...approval } = project.approval;
  res.json({ approval });
});

shareRouter.get(['/:slug/media/:key/:variant', '/:slug/video-scenes/:sceneId/media/:key/:variant'], (req, res) => {
  let project = find(req.params.slug);
  const key = req.params.key;
  const variant = req.params.variant;
  if (!project || !Object.hasOwn(SURFACE_MAP, key) || !['proxy', 'poster', 'original', 'av1', 'mobile'].includes(variant)) {
    res.status(404).json({ error: 'Не найдено' });
    return;
  }
  if (!unlocked(req, project)) return res.status(401).json({ error: 'Нужен пароль', code: 'password_required' });
  if (variant === 'original' && !project.share?.allowDownload) {
    res.status(403).json({ error: 'Скачивание отключено' });
    return;
  }
  if (!verifyMediaToken(req.query.mt, project.id, project.share?.revision || '0')) {
    res.status(403).json({ error: 'Ссылка на файл устарела, обновите страницу' });
    return;
  }
  project = selectPublicVideoScene(project, req.params.sceneId || MAIN_VIDEO_SCENE);
  if (!project) return res.status(404).json({ error: 'Видеосцена не опубликована' });
  if (staleMediaVersion(req, project)) return res.status(409).json({ error: 'Версия видеосцены изменилась. Обновите показ.' });
  sendMedia(req, res, project, key, variant);
});

shareRouter.get(['/:slug/download/:key', '/:slug/video-scenes/:sceneId/download/:key'], (req, res) => {
  let project = find(req.params.slug);
  const key = req.params.key;
  if (!project || !Object.hasOwn(SURFACE_MAP, key)) {
    res.status(404).json({ error: 'Не найдено' });
    return;
  }
  if (!unlocked(req, project)) return res.status(401).json({ error: 'Нужен пароль', code: 'password_required' });
  if (!project.share?.allowDownload) {
    res.status(403).json({ error: 'Скачивание отключено' });
    return;
  }
  if (!verifyMediaToken(req.query.mt, project.id, project.share?.revision || '0')) {
    res.status(403).json({ error: 'Ссылка устарела, обновите страницу' });
    return;
  }
  project = selectPublicVideoScene(project, req.params.sceneId || MAIN_VIDEO_SCENE);
  if (!project) return res.status(404).json({ error: 'Видеосцена не опубликована' });
  if (staleMediaVersion(req, project)) return res.status(409).json({ error: 'Версия видеосцены изменилась. Обновите показ.' });
  sendMedia(req, res, project, key, 'original', { download: true });
});
