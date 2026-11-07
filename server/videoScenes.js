import { contentRevision, markContentChanged, canApproveProject, requiredSurfaceKeys, currentApproval } from './content.js';
import { rid, nowISO } from './util.js';

export const MAIN_VIDEO_SCENE = 'main';
export const MAX_VIDEO_SCENES = 50;
export const rootProject = project => project?._rootProject || project;
export function videoSceneEntries(project) {
  const root = rootProject(project);
  return root ? [{ id: MAIN_VIDEO_SCENE, name: root.videoSceneName || 'Основная сцена', state: root },
    ...(root.videoScenes || []).map(state => ({ id: state.id, name: state.name, state }))] : [];
}
export function videoSceneState(project, id = MAIN_VIDEO_SCENE) {
  return videoSceneEntries(project).find(entry => entry.id === id)?.state || null;
}
function managed(root, id) { return id !== MAIN_VIDEO_SCENE || Object.hasOwn(root, 'publishedVideoScene'); }
function publication(root, id, state) {
  return id === MAIN_VIDEO_SCENE ? (managed(root, id) ? root.publishedVideoScene : root) : state.published;
}
function setPublication(root, id, state, value) {
  if (id === MAIN_VIDEO_SCENE) root.publishedVideoScene = value; else state.published = value;
}

// The legacy project is the virtual main video scene. Forward writes to the
// actual nested state, while every scene shares the same room and asset library.
export function videoSceneProject(project, id = MAIN_VIDEO_SCENE, { publicView = false } = {}) {
  const root = rootProject(project);
  const entry = videoSceneEntries(root).find(item => item.id === id);
  if (!entry) return null;
  const target = publicView ? publication(root, id, entry.state) : entry.state;
  if (!target) return null;
  const view = { ...root, videoSceneId: id, videoSceneName: entry.name };
  Object.defineProperties(view, {
    _rootProject: { value: root }, _videoSceneState: { value: entry.state }, _publicVideoScene: { value: publicView },
  });
  for (const field of ['surfaces', 'contentRevision', 'approval']) Object.defineProperty(view, field, {
    enumerable: true, configurable: true, get: () => target[field], set: value => {
      target[field] = value;
      if (field === 'approval' && publicView && contentRevision(entry.state) === contentRevision(target)) entry.state.approval = value;
    },
  });
  Object.defineProperty(view, 'comments', { enumerable: true, configurable: true,
    get: () => entry.state.comments || [], set: value => { entry.state.comments = value; } });
  Object.defineProperty(view, 'updatedAt', { enumerable: true, configurable: true,
    get: () => entry.state.updatedAt || root.updatedAt,
    set: value => { entry.state.updatedAt = value; root.updatedAt = value; } });
  return view;
}

function snapshot(project) {
  const surfaces = {};
  for (const [key, surface] of Object.entries(project.surfaces || {})) {
    if (surface.status !== 'ready') continue;
    surfaces[key] = structuredClone(surface);
    delete surfaces[key].replacement;
  }
  return { surfaces, contentRevision: contentRevision(project), approval: structuredClone(currentApproval(project)), publishedAt: nowISO() };
}

export function beginVideoSceneEdit(project, id = MAIN_VIDEO_SCENE) {
  const root = rootProject(project);
  const selected = videoSceneProject(root, id);
  if (!selected) return null;
  if (id === MAIN_VIDEO_SCENE && !managed(root, id)) {
    // First use of explicit scene editing preserves the exact currently visible
    // set. Uploads and failed candidates cannot modify this published snapshot.
    const visible = snapshot(root);
    root.publishedVideoScene = canApproveProject({ ...root, surfaces: visible.surfaces }) ? visible : null;
  }
  return selected;
}

export function hasUnpublishedChanges(project, id = project?.videoSceneId || MAIN_VIDEO_SCENE) {
  const root = rootProject(project);
  const state = videoSceneState(root, id);
  if (!state) return false;
  const published = publication(root, id, state);
  return !published || contentRevision(state) !== contentRevision(published)
    || Object.values(state.surfaces || {}).some(surface => Boolean(surface.replacement) || surface.status !== 'ready');
}
export function canPublishVideoScene(project, id = project?.videoSceneId || MAIN_VIDEO_SCENE) {
  const selected = videoSceneProject(project, id);
  return Boolean(selected && hasUnpublishedChanges(selected, id) && canApproveProject(selected)
    && requiredSurfaceKeys(selected).every(key => !selected.surfaces[key]?.replacement));
}
export function publishVideoScene(project, id, revision) {
  const root = rootProject(project);
  const selected = videoSceneProject(root, id);
  if (!selected) throw Object.assign(new Error('Видеосцена не найдена'), { status: 404 });
  if (!Number.isSafeInteger(revision) || revision !== contentRevision(selected)) {
    throw Object.assign(new Error('Видеосцена изменилась. Обновите страницу перед публикацией.'), { status: 409 });
  }
  if (!canPublishVideoScene(root, id)) {
    throw Object.assign(new Error('Завершите все используемые видеоканалы и исправьте незавершённые замены перед публикацией.'), { status: 409 });
  }
  const next = snapshot(selected);
  next.approval = null;
  setPublication(root, id, selected._videoSceneState, next);
  selected.approval = null;
  selected.updatedAt = nowISO();
  return selected;
}
export function createVideoScene(project, name) {
  const root = rootProject(project);
  if (videoSceneEntries(root).length >= MAX_VIDEO_SCENES) throw Object.assign(new Error('В проекте уже 50 видеосцен'), { status: 400 });
  beginVideoSceneEdit(root, MAIN_VIDEO_SCENE);
  const now = nowISO();
  const state = { id: rid(12), name, surfaces: {}, contentRevision: 0, approval: null, comments: [],
    published: null, createdAt: now, updatedAt: now };
  root.videoScenes = [...(root.videoScenes || []), state];
  root.updatedAt = now;
  return videoSceneProject(root, state.id);
}
export function selectPublicVideoScene(project, requested) {
  const root = rootProject(project);
  if (requested !== undefined && requested !== null && requested !== '') {
    return typeof requested === 'string' ? videoSceneProject(root, requested, { publicView: true }) : null;
  }
  for (const { id } of videoSceneEntries(root)) {
    const view = videoSceneProject(root, id, { publicView: true });
    if (view) return view;
  }
  return null;
}
export function videoSceneSummaries(project, { publicView = false } = {}) {
  const root = rootProject(project);
  return videoSceneEntries(root).flatMap(({ id, name, state }) => {
    const published = publication(root, id, state);
    if (publicView && !published) return [];
    const view = videoSceneProject(root, id, { publicView });
    const keys = requiredSurfaceKeys(view);
    const ready = keys.filter(key => view.surfaces[key]?.status === 'ready').length;
    const processing = publicView ? 0 : Object.values(state.surfaces || {}).filter(surface => surface.status === 'processing' || surface.replacement?.status === 'processing').length;
    const publicProject = published ? videoSceneProject(root, id, { publicView: true }) : null;
    return [{ id, name, published: Boolean(published), publishedAt: published?.publishedAt || null,
      contentRevision: contentRevision(view), publishedRevision: published ? contentRevision(published) : null,
      ready, total: keys.length, processing, isDefault: id === MAIN_VIDEO_SCENE,
      approved: Boolean(publicProject && currentApproval(publicProject)),
      ...(publicView ? {} : { canPublish: canPublishVideoScene(root, id), hasUnpublishedChanges: hasUnpublishedChanges(root, id) }),
    }];
  });
}
export function resetVideoSceneApproval(project, id = MAIN_VIDEO_SCENE) {
  const root = rootProject(project);
  const state = videoSceneState(root, id);
  if (!state) return false;
  state.approval = null;
  const published = publication(root, id, state);
  if (published) published.approval = null;
  return true;
}

export function markSharedLayoutChanged(project) {
  const root = rootProject(project);
  for (const { id, state } of videoSceneEntries(root)) {
    const published = publication(root, id, state);
    markContentChanged(state);
    if (published && published !== state) markContentChanged(published);
  }
}
