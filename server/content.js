import { SURFACES } from './surfaces.js';

export function contentRevision(project) {
  return Number.isSafeInteger(project.contentRevision) && project.contentRevision >= 0 ? project.contentRevision : 0;
}

export function markContentChanged(project) {
  project.contentRevision = contentRevision(project) + 1;
  project.approval = null;
}

export function currentApproval(project) {
  const approval = project.approval;
  if (!approval) return null;
  return Number(approval.revision ?? 0) === contentRevision(project) ? approval : null;
}

export function processingSurface(project, key) {
  const active = project?.surfaces?.[key];
  return active?.replacement || active || null;
}


// A hidden room only plays channels assigned to the scene's screens and floors.
// The original five-surface hall remains the default for older projects.
export function requiredSurfaceKeys(project) {
  if (!project.scene || project.scene.showRoomSurfaces !== false) return SURFACES.map((surface) => surface.key);
  const sources = new Set((project.scene.objects || [])
    .filter((object) => object.type === 'screen' || object.type === 'floor')
    .map((object) => object.source).filter(Boolean));
  return SURFACES.filter((surface) => sources.has(surface.key)).map((surface) => surface.key);
}

export function hasReviewableContent(project) {
  return requiredSurfaceKeys(project).length > 0 || (project.scene?.objects?.length || 0) > 0;
}

export function canApproveProject(project) {
  if (!hasReviewableContent(project)) return false;
  return requiredSurfaceKeys(project).every((key) => {
    const surface = project.surfaces?.[key];
    return surface?.status === 'ready' && Boolean(surface.proxy) && Number(surface.duration) > 0
      && surface.replacement?.status !== 'processing';
  });
}
