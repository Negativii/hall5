import { contentRevision, markContentChanged, processingSurface } from './content.js';
import { videoSceneProject, MAIN_VIDEO_SCENE } from './videoScenes.js';

export function stageSurface(store, projectId, key, candidate, videoSceneId = MAIN_VIDEO_SCENE) {
  const project = videoSceneProject(store.project(projectId), videoSceneId);
  const old = project?.surfaces?.[key];
  if (!project) throw new Error('Проект не найден');
  project.surfaces[key] = old?.status === 'ready'
    ? { ...old, replacement: candidate }
    : candidate;
  project.updatedAt = new Date().toISOString();
  store.save();
  return old?.status === 'ready' ? old.replacement : old;
}

export function patchProcessing(store, projectId, key, jobId, data, save = true, videoSceneId = MAIN_VIDEO_SCENE) {
  const project = videoSceneProject(store.project(projectId), videoSceneId);
  const target = processingSurface(project, key);
  if (!target || target.job !== jobId) return null;
  Object.assign(target, data);
  project.updatedAt = new Date().toISOString();
  if (save) store.save();
  return target;
}

export function promoteSurface(store, projectId, key, jobId, data, videoSceneId = MAIN_VIDEO_SCENE) {
  const project = videoSceneProject(store.project(projectId), videoSceneId);
  const active = project?.surfaces?.[key];
  const target = processingSurface(project, key);
  if (!target || target.job !== jobId) return null;
  const promoted = { ...target, ...data, status: 'ready', error: null, progress: 100, stage: null };
  delete promoted.replacement;
  project.surfaces[key] = promoted;
  project.updatedAt = new Date().toISOString();
  markContentChanged(project);
  store.save();
  return { promoted, previous: active === target ? null : active };
}

export function removeSurface(store, projectId, key, videoSceneId = MAIN_VIDEO_SCENE) {
  const project = videoSceneProject(store.project(projectId), videoSceneId);
  const surface = project?.surfaces?.[key];
  if (!surface) return null;
  delete project.surfaces[key];
  project.updatedAt = new Date().toISOString();
  markContentChanged(project);
  store.save();
  return surface;
}

export function replacementIdentity(candidate) {
  return candidate?.job || candidate?.file || null;
}

// Abandon only the candidate the owner actually saw. Processing does not bump
// the content revision, so it also needs its own identity to reject stale clicks.
export function cancelReplacement(store, projectId, key, { revision, replacementId }, videoSceneId = MAIN_VIDEO_SCENE) {
  const project = videoSceneProject(store.project(projectId), videoSceneId);
  const surface = project?.surfaces?.[key];
  if (!project || !surface) throw Object.assign(new Error('Видео не найдено'), { status: 404 });
  if (!Number.isSafeInteger(revision) || revision !== contentRevision(project)) {
    throw Object.assign(new Error('Версия сцены изменилась. Обновите страницу перед отменой замены.'), { status: 409 });
  }
  const candidate = surface.replacement;
  if (surface.status !== 'ready' || !candidate || typeof replacementId !== 'string' || replacementIdentity(candidate) !== replacementId) {
    throw Object.assign(new Error('Замена уже завершена или изменилась. Обновите страницу.'), { status: 409 });
  }
  delete surface.replacement;
  project.updatedAt = new Date().toISOString();
  store.save();
  return candidate;
}
