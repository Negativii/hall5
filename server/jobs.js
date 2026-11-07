import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR } from './config.js';
import { store } from './db.js';
import { enqueue, probe, transcode, makePoster } from './media.js';
import { processingSurface } from './content.js';
import { patchProcessing, promoteSurface } from './surfaceLifecycle.js';
import { cleanupProjectFiles, cleanupOrphanedMedia } from './mediaFiles.js';
import { previewPlan } from './mediaPlan.js';
import { needsCompatibilityPreview, createCompatibilityPreview } from './compatibilityPreview.js';
import { createMobilePreview } from './mobilePreview.js';
import { videoSceneProject, videoSceneEntries, MAIN_VIDEO_SCENE } from './videoScenes.js';

const running = new Map();

export function cancelProcessing(projectId, key, videoSceneId, jobId) {
  const pending = [];
  for (const [runningJobId, entry] of running) {
    if (jobId && runningJobId !== jobId) continue;
    if (projectId && entry.projectId !== projectId) continue;
    if (key && entry.key !== key) continue;
    if ((videoSceneId || key) && entry.videoSceneId !== (videoSceneId || MAIN_VIDEO_SCENE)) continue;
    entry.controller.abort(new Error('Задача отменена: контент изменён или сервер останавливается'));
    pending.push(entry.done);
  }
  return Promise.all(pending);
}

function friendly(error) {
  const text = String(error?.message || error || 'Неизвестная ошибка');
  if (/Invalid data|moov atom|could not find codec/i.test(text)) return 'Файл повреждён или кодек не поддерживается';
  return text.slice(0, 240);
}

export function startProcessing(projectId, key, videoSceneId = MAIN_VIDEO_SCENE) {
  const surface = processingSurface(videoSceneProject(store.project(projectId), videoSceneId), key);
  if (!surface?.file || !surface.job || running.has(surface.job)) return;
  const jobId = surface.job;
  const filename = surface.file;
  const dir = path.join(PROJECTS_DIR, projectId);
  const input = path.join(dir, filename);
  const base = path.parse(filename).name;
  const proxyName = `${base}.preview.mp4`;
  const posterName = `${base}.poster.jpg`;
  const compatibilityName = `${base}.compat.mp4`;
  const mobileName = `${base}.mobile.mp4`;
  const controller = new AbortController();
  const signal = controller.signal;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  running.set(jobId, { projectId, key, videoSceneId, controller, done });
  const patch = (data, save = true) => {
    signal.throwIfAborted();
    const updated = patchProcessing(store, projectId, key, jobId, data, save, videoSceneId);
    if (!updated) throw new Error('Задача заменена или проект удалён');
    return updated;
  };

  enqueue(async () => {
    try {
      patch({ status: 'processing', progress: 1, stage: 'Анализ видео', error: null });
      const info = await probe(input, { signal });
      const plan = previewPlan(info);
      const stage = plan.mode === 'copy' ? 'Подготовка без сжатия видео' : 'Совместимая копия полного разрешения';
      patch({ width: info.width, height: info.height, duration: Math.round(info.duration * 1000) / 1000,
        codec: info.codec, fps: info.fps, hasAudio: info.hasAudio, progress: 8, stage });
      let lastSave = 0;
      await transcode(input, path.join(dir, proxyName), {
        info, duration: info.duration, signal,
        onProgress: (value) => {
          const now = Date.now();
          const save = now - lastSave > 1500 || value >= 1;
          if (save) lastSave = now;
          patch({ progress: Math.max(8, Math.round(8 + value * 87)), stage }, save);
        },
      });
      // Check the generated stream, not just ffmpeg's exit code, before promotion.
      const outputInfo = await probe(path.join(dir, proxyName), { signal });
      if (Math.abs(outputInfo.duration - info.duration) > Math.max(0.5, info.duration * 0.01)) {
        throw new Error('Превью закодировано не полностью, повторите обработку');
      }
      if (outputInfo.width !== plan.width || outputInfo.height !== plan.height) {
        throw new Error('Размер браузерной копии отличается от оригинала. Замена не опубликована.');
      }
      let compatibilityPreview = null;
      if (needsCompatibilityPreview(outputInfo)) {
        patch({ progress: 96, stage: 'AV1 для больших экранов: без потери пикселей' });
        compatibilityPreview = { file: compatibilityName, ...await createCompatibilityPreview(
          path.join(dir, proxyName), path.join(dir, compatibilityName), { info: outputInfo, signal,
            onProgress: (value) => {
              const now = Date.now();
              const save = now - lastSave > 1500 || value >= 1;
              if (save) lastSave = now;
              patch({ progress: 96, stage: value < 0.95
                ? `AV1 без потерь: ${Math.round(value * 100)}%` : 'Проверка всех пикселей AV1' }, save);
            },
          }) };
      }
      patch({ progress: 97, stage: 'Копия для одновременного просмотра на телефоне' });
      const mobilePreview = { file: mobileName, ...await createMobilePreview(path.join(dir, proxyName),
        path.join(dir, mobileName), { info: outputInfo, signal }) };
      patch({ progress: 98, stage: 'Постер' });
      try {
        await makePoster(input, path.join(dir, posterName), { width: info.width, duration: info.duration, signal });
      } catch (error) {
        signal.throwIfAborted();
        console.warn('[poster]', error.message);
      }
      signal.throwIfAborted();
      promoteSurface(store, projectId, key, jobId, {
        proxy: proxyName, poster: fs.existsSync(path.join(dir, posterName)) ? posterName : null,
        previewMode: plan.mode, previewWidth: outputInfo.width, previewHeight: outputInfo.height,
        previewFps: outputInfo.fps, previewBitrate: outputInfo.bitrate,
        compatibilityPreview,
        mobilePreview,
        processedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }, videoSceneId);
    } catch (error) {
      if (!signal.aborted) {
        console.error('[process]', projectId, key, error.message);
        try {
          patchProcessing(store, projectId, key, jobId, {
            status: 'error', stage: null, error: friendly(error), progress: 0,
          }, true, videoSceneId);
        } catch (saveError) { console.error('[process-save]', saveError.message); }
      }
    } finally {
      running.delete(jobId);
      cleanupProjectFiles(projectId);
      finish();
    }
  });
}

export function requeueInterrupted() {
  cleanupOrphanedMedia();
  const interrupted = [];
  for (const project of store.projects) {
    for (const { id, state } of videoSceneEntries(project)) {
     for (const key of Object.keys(state.surfaces || {})) {
      const surface = processingSurface(state, key);
      if (surface?.file && surface.status === 'processing') {
        surface.progress = 0;
        surface.stage = 'Возобновление';
        interrupted.push([project.id, key, id]);
      }
     }
    }
  }
  if (interrupted.length) store.save();
  for (const [projectId, key, sceneId] of interrupted) startProcessing(projectId, key, sceneId);
  return interrupted.length;
}
