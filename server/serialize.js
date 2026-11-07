import { SURFACES, SURFACE_MAP } from './surfaces.js';
import { mediaToken } from './auth.js';
import { PUBLIC_URL } from './config.js';
import { serializeScene } from './scene.js';
import { publicLegalConfig } from './legal.js';
import { replacementIdentity } from './surfaceLifecycle.js';
import { contentRevision, currentApproval, requiredSurfaceKeys, canApproveProject, hasReviewableContent } from './content.js';
import { rootProject, videoSceneProject, selectPublicVideoScene, videoSceneSummaries, canPublishVideoScene, hasUnpublishedChanges, MAIN_VIDEO_SCENE } from './videoScenes.js';

export { requiredSurfaceKeys } from './content.js';

export function projectDuration(project) {
  const values = requiredSurfaceKeys(project).map((key) => project.surfaces?.[key])
    .filter((s) => s && s.status === 'ready' && Number(s.duration) > 0)
    .map((s) => Number(s.duration));
  return values.length ? Math.min(...values) : 0;
}

export function readiness(project) {
  const ready = SURFACES.filter((s) => project.surfaces?.[s.key]?.status === 'ready').length;
  const processing = SURFACES.filter(
    (s) => project.surfaces?.[s.key]?.status === 'processing' || project.surfaces?.[s.key]?.replacement?.status === 'processing',
  ).length;
  return { ready, processing, total: SURFACES.length };
}

export function projectStatus(project) {
  if (currentApproval(project)) return 'approved';
  return canApproveProject(project) ? 'ready' : 'draft';
}

export function durationWarning(project) {
  const values = requiredSurfaceKeys(project).map((key) => project.surfaces?.[key])
    .filter((s) => s && s.status === 'ready' && Number(s.duration) > 0)
    .map((s) => Number(s.duration));
  if (values.length < 2) return null;
  const spread = Math.max(...values) - Math.min(...values);
  if (spread <= 0.25) return null;
  return `Хронометраж поверхностей отличается на ${spread.toFixed(1)} с — при показе они будут синхронизированы по самой короткой.`;
}

function baseSurface(project, key) {
  const spec = SURFACE_MAP[key];
  const surface = project.surfaces?.[key] || null;
  const ratio = surface ? Number(surface.width) / Number(surface.height) : 0;
  const specRatio = spec.specW / spec.specH;
  return {
    key,
    num: spec.num,
    label: spec.label,
    name: spec.name,
    title: spec.title,
    physical: spec.physical,
    specW: spec.specW,
    specH: spec.specH,
    specRatio,
    status: surface?.status || 'empty',
    progress: surface?.progress || 0,
    stage: surface?.stage || null,
    error: surface?.error || null,
    width: surface?.width || 0,
    height: surface?.height || 0,
    fps: surface?.fps || 0,
    previewMode: surface?.previewMode || null,
    previewWidth: surface?.previewWidth || 0,
    previewHeight: surface?.previewHeight || 0,
    previewFps: surface?.previewFps || 0,
    previewBitrate: surface?.previewBitrate || 0,
    duration: surface?.duration || 0,
    size: surface?.size || 0,
    originalName: surface?.originalName || null,
    updatedAt: surface?.updatedAt || surface?.processedAt || null,
    aspectWarning: Boolean(surface?.width && surface?.height && Math.abs(ratio / specRatio - 1) > 0.015),
    hasAudio: Boolean(surface?.hasAudio),
  };
}

function compatibilityPreview(surface, url) {
  const copy = surface?.status === 'ready' && surface.compatibilityPreview;
  return copy ? { url, codec: copy.codec, mode: copy.mode, mimeType: copy.mimeType,
    width: copy.width, height: copy.height, fps: copy.fps } : null;
}

function mobilePreview(surface, url) {
  const copy = surface?.status === 'ready' && surface.mobilePreview;
  return copy ? { url, codec: copy.codec, mode: copy.mode, mimeType: copy.mimeType,
    width: copy.width, height: copy.height, fps: copy.fps } : null;
}

export function adminProject(project) {
  project = videoSceneProject(rootProject(project), project.videoSceneId || MAIN_VIDEO_SCENE);
  const { ready, processing, total } = readiness(project);
  const revision = project.share?.revision || '0';
  const token = mediaToken(project.id, 12 * 60 * 60, revision);
  return {
    id: project.id,
    videoSceneId: project.videoSceneId,
    videoSceneName: project.videoSceneName,
    videoScenes: videoSceneSummaries(project),
    canPublish: canPublishVideoScene(project),
    hasUnpublishedChanges: hasUnpublishedChanges(project),
    slug: project.slug,
    title: project.title,
    client: project.client || '',
    eventDate: project.eventDate || '',
    description: project.description || '',
    contentRevision: contentRevision(project),
    requiredSurfaceKeys: requiredSurfaceKeys(project),
    hasReviewableContent: hasReviewableContent(project),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    duration: projectDuration(project),
    ready,
    processing,
    total,
    status: projectStatus(project),
    canApprove: canApproveProject(project),
    scene: serializeScene(project, false),
    durationWarning: durationWarning(project),
    surfaces: SURFACES.map((spec) => {
      const s = baseSurface(project, spec.key);
      const surface = project.surfaces?.[spec.key];
      const version = encodeURIComponent(surface?.updatedAt || surface?.processedAt || '0');
      return {
        ...s,
        replacement: surface?.replacement ? {
          id: replacementIdentity(surface.replacement),
          status: surface.replacement.status,
          progress: surface.replacement.progress || 0,
          stage: surface.replacement.stage || null,
          error: surface.replacement.error || null,
          originalName: surface.replacement.originalName || '',
          width: surface.replacement.width || 0, height: surface.replacement.height || 0,
          duration: surface.replacement.duration || 0, size: surface.replacement.size || 0,
          hasAudio: Boolean(surface.replacement.hasAudio),
        } : null,
        previewUrl:
          surface?.status === 'ready' && surface.proxy
            ? `/api/projects/${project.id}/video-scenes/${project.videoSceneId}/media/${spec.key}/proxy?v=${version}`
            : null,
        compatibilityPreview: compatibilityPreview(surface, `/api/projects/${project.id}/video-scenes/${project.videoSceneId}/media/${spec.key}/av1?v=${version}`),
        mobilePreview: mobilePreview(surface, `/api/projects/${project.id}/video-scenes/${project.videoSceneId}/media/${spec.key}/mobile?v=${version}`),
        posterUrl: surface?.poster
          ? `/api/projects/${project.id}/video-scenes/${project.videoSceneId}/media/${spec.key}/poster?v=${version}`
          : null,
        downloadUrl: surface?.file
          ? `/api/projects/${project.id}/video-scenes/${project.videoSceneId}/media/${spec.key}/original?download=1`
          : null,
      };
    }),
    share: {
      enabled: project.share?.enabled !== false,
      path: `/s/${project.slug}`,
      expiresAt: project.share?.expiresAt || null,
      allowComments: project.share?.allowComments !== false,
      allowDownload: Boolean(project.share?.allowDownload),
      passcodeSet: Boolean(project.share?.passcodeHash),
    },
    comments: (project.comments || []).map((c) => ({
      id: c.id,
      author: c.author,
      text: c.text,
      time: c.time,
      createdAt: c.createdAt,
      revision: c.revision,
      videoSceneId: project.videoSceneId,
    })),
    approval: currentApproval(project),
    demo: Boolean(project.demo),
    publicUrl: PUBLIC_URL || null,
    mediaToken: token,
  };
}

export function publicProject(project) {
  project = project?._publicVideoScene ? project : selectPublicVideoScene(project, project.videoSceneId);
  if (!project) throw Object.assign(new Error('Видеосцена не опубликована'), { status: 404 });
  const revision = project.share?.revision || '0';
  const token = mediaToken(project.id, 8 * 60 * 60, revision);
  const { ready, processing, total } = readiness(project);
  const allowDownload = Boolean(project.share?.allowDownload);
  const legal = publicLegalConfig();
  const approval = currentApproval(project);
  const publicApproval = approval ? { revision: approval.revision, author: approval.author, note: approval.note, at: approval.at } : null;
  return {
    id: project.id,
    videoSceneId: project.videoSceneId,
    videoSceneName: project.videoSceneName,
    videoScenes: videoSceneSummaries(project, { publicView: true }),
    slug: project.slug,
    title: project.title,
    client: project.client || '',
    eventDate: project.eventDate || '',
    description: project.description || '',
    contentRevision: contentRevision(project),
    requiredSurfaceKeys: requiredSurfaceKeys(project),
    hasReviewableContent: hasReviewableContent(project),
    duration: projectDuration(project),
    ready,
    total,
    processing,
    canApprove: canApproveProject(project),
    scene: serializeScene(project, true),
    approved: Boolean(currentApproval(project)),
    approval: publicApproval,
    demo: Boolean(project.demo),
    share: {
      allowComments: legal.configured && project.share?.allowComments !== false,
      allowDownload,
    },
    legal,
    comments: project.share?.allowComments === false
      ? []
      : (project.comments || []).map((c) => ({
          id: c.id,
          author: c.author,
          text: c.text,
          time: c.time,
          createdAt: c.createdAt,
          revision: c.revision,
          videoSceneId: project.videoSceneId,
        })),
    surfaces: SURFACES.map((spec) => {
      const surface = project.surfaces?.[spec.key];
      const s = baseSurface(project, spec.key);
      const plain = {
        ...s,
        status: surface?.status === 'ready' ? 'ready' : 'pending',
        error: null,
        stage: null,
        progress: 0,
      };
      if (!surface || surface.status !== 'ready') return { ...plain, previewUrl: null, posterUrl: null };
      return {
        ...plain,
        previewUrl: `/api/s/${project.slug}/video-scenes/${project.videoSceneId}/media/${spec.key}/proxy?mt=${token}&v=${contentRevision(project)}`,
        compatibilityPreview: compatibilityPreview(surface,
          `/api/s/${project.slug}/video-scenes/${project.videoSceneId}/media/${spec.key}/av1?mt=${token}&v=${contentRevision(project)}`),
        mobilePreview: mobilePreview(surface,
          `/api/s/${project.slug}/video-scenes/${project.videoSceneId}/media/${spec.key}/mobile?mt=${token}&v=${contentRevision(project)}`),
        originalUrl: allowDownload
          ? `/api/s/${project.slug}/video-scenes/${project.videoSceneId}/media/${spec.key}/original?mt=${token}&v=${contentRevision(project)}`
          : null,
        posterUrl: surface.poster
          ? `/api/s/${project.slug}/video-scenes/${project.videoSceneId}/media/${spec.key}/poster?mt=${token}&v=${contentRevision(project)}`
          : null,
        downloadUrl: allowDownload
          ? `/api/s/${project.slug}/video-scenes/${project.videoSceneId}/download/${spec.key}?mt=${token}&v=${contentRevision(project)}`
          : null,
      };
    }),
    mediaToken: token,
  };
}
