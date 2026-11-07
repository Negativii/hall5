import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeScene } from './sceneSchema.js';

function empty() { return { version: 1, projects: [] }; }

export function validateDatabase(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.projects)) {
    throw new Error('Некорректная структура базы данных');
  }
  const ids = new Set();
  const slugs = new Set();
  for (const project of data.projects) {
    if (!project || typeof project.id !== 'string' || !/^[a-z0-9_-]+$/i.test(project.id)
      || typeof project.slug !== 'string' || !/^[a-z0-9_-]+$/i.test(project.slug)
      || !project.surfaces || typeof project.surfaces !== 'object' || Array.isArray(project.surfaces)
      || !project.share || typeof project.share !== 'object' || Array.isArray(project.share)
      || (project.comments !== undefined && !Array.isArray(project.comments))
      || ids.has(project.id) || slugs.has(project.slug)) {
      throw new Error('Некорректная запись проекта в базе данных');
    }
    if (project.contentRevision !== undefined && (!Number.isSafeInteger(project.contentRevision) || project.contentRevision < 0)) {
      throw new Error('Некорректная версия контента');
    }
    if (project.sceneAssets !== undefined) {
      if (!Array.isArray(project.sceneAssets)) throw new Error('Некорректная библиотека моделей');
      const assets = new Set();
      for (const asset of project.sceneAssets) {
        if (!asset || typeof asset.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(asset.id) || assets.has(asset.id)
          || typeof asset.file !== 'string' || !/^[a-z0-9_.-]+\.glb$/i.test(asset.file)) {
          throw new Error('Некорректная запись 3D-модели');
        }
        assets.add(asset.id);
      }
    }
    if (project.scene !== undefined) normalizeScene(project.scene, project.sceneAssets || []);
    const checkSurfaces = (surfaces, published = false) => {
     if (!surfaces || typeof surfaces !== 'object' || Array.isArray(surfaces)) throw new Error('Некорректные каналы видеосцены');
     for (const [key, surface] of Object.entries(surfaces)) {
      if (!['right', 'back', 'left', 'center', 'floor'].includes(key)) throw new Error('Неизвестная поверхность');
      const checkSurface = (value, nested = false) => {
        if (!value || value.key !== key || !['ready', 'processing', 'error'].includes(value.status)) {
          throw new Error('Некорректная запись поверхности');
        }
        for (const field of ['file', 'proxy', 'poster']) {
          if (value[field] && (typeof value[field] !== 'string' || !/^[a-z0-9_-][a-z0-9_.-]*$/i.test(value[field]) || path.basename(value[field]) !== value[field] || /[\\/]/.test(value[field]))) {
            throw new Error('Некорректное имя медиафайла');
          }
        }
        if (!value.file || (value.status === 'processing' && !value.job)) throw new Error('Не указан исходный файл или задача');
        if (value.status === 'ready' && (!value.proxy || !(value.width > 0) || !(value.height > 0) || !(value.duration > 0))) {
          throw new Error('Готовая поверхность не содержит параметров видео');
        }
        if (value.previewMode != null && !['copy', 'converted'].includes(value.previewMode)) {
          throw new Error('Неизвестный способ подготовки видео');
        }
        for (const field of ['fps', 'previewWidth', 'previewHeight', 'previewFps', 'previewBitrate']) {
          if (value[field] !== undefined && (!Number.isFinite(value[field]) || value[field] < 0)) {
            throw new Error('Некорректные параметры браузерного видео');
          }
        }
        if (value.status === 'ready' && value.previewMode && (!(value.previewWidth > 0) || !(value.previewHeight > 0))) {
          throw new Error('Не указаны размеры браузерного видео');
        }
        if (value.compatibilityPreview != null) {
          const copy = value.compatibilityPreview;
          if (typeof copy !== 'object' || Array.isArray(copy) || copy.codec !== 'av1' || copy.mode !== 'lossless'
            || typeof copy.file !== 'string' || !/^[a-z0-9_-][a-z0-9_.-]*\.compat\.mp4$/i.test(copy.file)
            || copy.mimeType !== 'video/mp4; codecs="av01"'
            || !/^[a-f0-9]{64}$/.test(copy.decodedSha256 || '')
            || !/^[a-f0-9]{64}$/.test(copy.timingSha256 || '')
            || !Number.isSafeInteger(copy.frameCount) || copy.frameCount <= 0
            || !Number.isFinite(copy.width) || !Number.isFinite(copy.height)
            || copy.width !== (value.previewWidth || value.width) || copy.height !== (value.previewHeight || value.height)
            || !Number.isFinite(copy.fps) || !(copy.fps > 0)
            || (value.previewFps > 0 && Math.abs(copy.fps - value.previewFps) > 0.0001)
            || !Number.isFinite(copy.duration) || !(copy.duration > 0)
            || Math.abs(copy.duration - value.duration) > Math.max(0.05, 1 / copy.fps)
            || !Number.isSafeInteger(copy.size) || copy.size <= 0) {
            throw new Error('Некорректная совместимая копия видео');
          }
        }
        if (value.mobilePreview != null) {
          const copy = value.mobilePreview;
          const sourceWidth = value.previewWidth || value.width;
          const sourceHeight = value.previewHeight || value.height;
          const scale = Math.min(1, 1920 / sourceWidth, 1080 / sourceHeight);
          if (typeof copy !== 'object' || Array.isArray(copy) || copy.codec !== 'h264' || copy.mode !== 'mobile'
            || typeof copy.file !== 'string' || !/^[a-z0-9_-][a-z0-9_.-]*\.mobile\.mp4$/i.test(copy.file)
            || copy.mimeType !== 'video/mp4' || !/^[a-f0-9]{64}$/.test(copy.timingSha256 || '')
            || !Number.isSafeInteger(copy.frameCount) || copy.frameCount <= 0
            || !Number.isInteger(copy.width) || copy.width < 2 || copy.width % 2 || copy.width > 1920 || copy.width > (value.previewWidth || value.width)
            || !Number.isInteger(copy.height) || copy.height < 2 || copy.height % 2 || copy.height > 1080 || copy.height > (value.previewHeight || value.height)
            || copy.width !== Math.max(2, Math.floor(sourceWidth * scale / 2) * 2)
            || copy.height !== Math.max(2, Math.floor(sourceHeight * scale / 2) * 2)
            || !Number.isFinite(copy.fps) || !(copy.fps > 0)
            || (value.previewFps > 0 && Math.abs(copy.fps - value.previewFps) > 0.0001)
            || !Number.isFinite(copy.duration) || !(copy.duration > 0)
            || Math.abs(copy.duration - value.duration) > Math.max(0.05, 1 / copy.fps)
            || !Number.isSafeInteger(copy.size) || copy.size <= 0) {
            throw new Error('Некорректная мобильная копия видео');
          }
        }
        if (value.replacement) {
          if (nested || value.status !== 'ready') throw new Error('Некорректная замена поверхности');
          checkSurface(value.replacement, true);
        }
      };
      checkSurface(surface);
      if (published && (surface.status !== 'ready' || surface.replacement)) throw new Error('Опубликованная видеосцена содержит черновик');
     }
    };
    const checkPublication = (publication) => {
      if (publication == null) return;
      if (typeof publication !== 'object' || Array.isArray(publication)
        || !Number.isSafeInteger(publication.contentRevision) || publication.contentRevision < 0
        || typeof publication.publishedAt !== 'string') throw new Error('Некорректная публикация видеосцены');
      checkSurfaces(publication.surfaces, true);
    };
    checkSurfaces(project.surfaces);
    checkPublication(project.publishedVideoScene);
    if (project.videoSceneName != null && (typeof project.videoSceneName !== 'string' || !project.videoSceneName.trim() || project.videoSceneName.length > 80)) throw new Error('Некорректное название видеосцены');
    if (project.videoScenes != null) {
      if (!Array.isArray(project.videoScenes) || project.videoScenes.length > 49) throw new Error('Некорректный список видеосцен');
      const sceneIds = new Set(['main']);
      for (const scene of project.videoScenes) {
        if (!scene || typeof scene.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(scene.id) || sceneIds.has(scene.id)
          || typeof scene.name !== 'string' || !scene.name.trim() || scene.name.length > 80
          || !Number.isSafeInteger(scene.contentRevision) || scene.contentRevision < 0 || !Array.isArray(scene.comments)
          || !Object.hasOwn(scene, 'published')) throw new Error('Некорректная видеосцена');
        sceneIds.add(scene.id);
        checkSurfaces(scene.surfaces);
        checkPublication(scene.published);
      }
    }
    ids.add(project.id);
    slugs.add(project.slug);
  }
  return data;
}

function parse(raw) { return validateDatabase(JSON.parse(raw)); }

// Flush the file before renaming it, then flush its directory where supported.
function atomicWrite(file, raw, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = io.openSync(tmp, 'wx', 0o600);
    io.writeFileSync(fd, raw);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(tmp, file);
    let dir;
    try {
      dir = io.openSync(path.dirname(file), 'r');
      io.fsyncSync(dir);
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EBADF', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
    } finally {
      if (dir !== undefined) io.closeSync(dir);
    }
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.rmSync(tmp, { force: true }); } catch { /* retain original error */ }
  }
}

export class Store {
  constructor(file, { io = fs } = {}) {
    this.file = file;
    this.backup = `${file}.bak`;
    this.io = io;
    this.data = empty();
    this.persisted = null;
    this.load();
  }

  load() {
    let raw;
    let readError;
    try { raw = this.io.readFileSync(this.file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`База недоступна: ${this.file}`, { cause: error });
      readError = error;
    }
    if (raw !== undefined) {
      try {
        this.data = parse(raw);
        this.persisted = JSON.stringify(this.data, null, 2);
        return;
      } catch (error) { readError = error; }
    }
    let backupRaw;
    try { backupRaw = this.io.readFileSync(this.backup); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Резервная база недоступна', { cause: error });
    }
    if (backupRaw === undefined && raw === undefined) {
      this.data = empty();
      return;
    }
    if (backupRaw === undefined) {
      throw new Error('База повреждена, проверенная резервная копия отсутствует. Данные не перезаписаны.', { cause: readError });
    }
    let recovered;
    try { recovered = parse(backupRaw); }
    catch (error) {
      throw new Error('База и резервная копия повреждены. Данные не перезаписаны.', { cause: error });
    }
    if (raw !== undefined) {
      const preserved = `${this.file}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      atomicWrite(preserved, raw, this.io);
      console.warn(`[database] Повреждённая база сохранена: ${preserved}`);
    }
    const verified = JSON.stringify(recovered, null, 2);
    atomicWrite(this.file, verified, this.io);
    this.data = recovered;
    this.persisted = verified;
    console.warn('[database] База восстановлена из проверенной резервной копии');
  }

  save() {
    try {
      const raw = JSON.stringify(validateDatabase(this.data), null, 2);
      atomicWrite(this.backup, this.persisted ?? raw, this.io);
      atomicWrite(this.file, raw, this.io);
      this.persisted = raw;
    } catch (error) {
      this.data = this.persisted === null ? empty() : parse(this.persisted);
      throw error;
    }
  }

  get projects() { return this.data.projects; }
  project(id) { return this.data.projects.find((p) => p.id === id) || null; }
  bySlug(slug) { return this.data.projects.find((p) => p.slug === slug) || null; }
  add(project) {
    this.data.projects.unshift(project);
    this.save();
    return project;
  }
  update(id, mutator) {
    const project = this.project(id);
    if (!project) return null;
    mutator(project);
    project.updatedAt = new Date().toISOString();
    this.save();
    return project;
  }
  remove(id) {
    const index = this.data.projects.findIndex((p) => p.id === id);
    if (index < 0) return false;
    this.data.projects.splice(index, 1);
    this.save();
    return true;
  }
}
