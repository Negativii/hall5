import type { SceneConfig } from './scene';
export type SurfaceKey = 'right' | 'back' | 'left' | 'center' | 'floor';

export type SurfaceStatus = 'empty' | 'processing' | 'ready' | 'error' | 'pending';

export interface Comment {
  id: string;
  author: string;
  text: string;
  time: number;
  createdAt: string;
  revision?: number;
  videoSceneId?: string;
}

export interface VideoSceneSummary {
  id: string;
  name: string;
  published: boolean;
  contentRevision: number;
  publishedRevision: number | null;
  ready: number;
  total: number;
  processing: number;
  canPublish?: boolean;
  hasUnpublishedChanges?: boolean;
  isDefault: boolean;
  approved: boolean;
}

export interface VideoSceneContext {
  videoSceneId?: string;
  videoSceneName?: string;
  videoScenes?: VideoSceneSummary[];
  canPublish?: boolean;
  hasUnpublishedChanges?: boolean;
}

export interface Approval {
  revision?: number;
  author: string;
  note: string;
  at: string;
}

export interface Replacement {
  id: string;
  status: SurfaceStatus; progress: number; stage: string | null; error: string | null;
  originalName: string | null; width: number; height: number; duration: number; size: number; hasAudio: boolean;
}

export interface CompatibilityPreview {
  url: string;
  codec: 'av1';
  mimeType: string;
  mode: 'lossless';
  width: number;
  height: number;
  fps: number;
}

export interface MobilePreview {
  url: string;
  codec: 'h264';
  mimeType: 'video/mp4';
  mode: 'mobile';
  width: number;
  height: number;
  fps: number;
}

export interface Surface {
  compatibilityPreview?: CompatibilityPreview | null;
  mobilePreview?: MobilePreview | null;
  replacement?: Replacement | null;
  key: SurfaceKey;
  num: number;
  label: string;
  name: string;
  title: string;
  physical: string;
  specW: number;
  specH: number;
  specRatio: number;
  status: SurfaceStatus;
  progress: number;
  stage: string | null;
  error: string | null;
  width: number;
  height: number;
  fps: number;
  previewMode: 'copy' | 'converted' | null;
  previewWidth: number;
  previewHeight: number;
  previewFps: number;
  previewBitrate: number;
  duration: number;
  size: number;
  originalName: string | null;
  updatedAt: string | null;
  aspectWarning: boolean;
  hasAudio: boolean;
  previewUrl: string | null;
  posterUrl: string | null;
  downloadUrl: string | null;
}

export interface ShareInfo {
  enabled: boolean;
  path: string;
  expiresAt: string | null;
  allowComments: boolean;
  allowDownload: boolean;
  passcodeSet: boolean;
}

export interface Project extends VideoSceneContext {
  requiredSurfaceKeys: SurfaceKey[];
  canApprove: boolean;
  scene: SceneConfig;
  contentRevision: number;
  id: string;
  slug: string;
  title: string;
  client: string;
  eventDate: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  duration: number;
  ready: number;
  processing: number;
  total: number;
  status: 'draft' | 'ready' | 'approved';
  durationWarning: string | null;
  surfaces: Surface[];
  share: ShareInfo;
  comments: Comment[];
  approval: Approval | null;
  demo: boolean;
  publicUrl: string | null;
  mediaToken: string;
}

export interface PublicSurface extends Omit<Surface, 'status' | 'previewUrl'> {
  status: 'ready' | 'pending';
  previewUrl: string | null;
  originalUrl: string | null;
  downloadUrl: string | null;
}

export interface PublicProject extends VideoSceneContext {
  requiredSurfaceKeys: SurfaceKey[];
  processing: number;
  canApprove: boolean;
  scene: SceneConfig;
  contentRevision: number;
  id: string;
  slug: string;
  title: string;
  client: string;
  eventDate: string;
  description: string;
  duration: number;
  ready: number;
  total: number;
  approved: boolean;
  approval: Approval | null;
  demo: boolean;
  share: {
    allowComments: boolean;
    allowDownload: boolean;
  };
  comments: Comment[];
  surfaces: PublicSurface[];
  mediaToken: string;
}

export interface PlayerSurface {
  compatibilityPreview?: CompatibilityPreview | null;
  mobilePreview?: MobilePreview | null;
  key: SurfaceKey;
  num: number;
  label: string;
  name: string;
  physical: string;
  specW: number;
  specH: number;
  specRatio: number;
  status: 'ready' | 'pending' | 'error';
  previewUrl: string | null;
  posterUrl: string | null;
  downloadUrl: string | null;
  duration: number;
  width: number;
  height: number;
  fps: number;
  previewMode: 'copy' | 'converted' | null;
  previewWidth: number;
  previewHeight: number;
  previewFps: number;
  previewBitrate: number;
  hasAudio: boolean;
  aspectWarning: boolean;
  error: string | null;
}

export interface PlayerProject extends VideoSceneContext {
  requiredSurfaceKeys: SurfaceKey[];
  processing: number;
  canApprove: boolean;
  scene: SceneConfig;
  contentRevision: number;
  id: string;
  slug: string;
  title: string;
  client: string;
  eventDate: string;
  description: string;
  duration: number;
  surfaces: PlayerSurface[];
  comments: Comment[];
  approval: Approval | null;
  allowComments: boolean;
  allowDownload: boolean;
  demo: boolean;
  isAdmin: boolean;
  ready: number;
  total: number;
}

export function toPlayerProject(project: Project | PublicProject, isAdmin: boolean): PlayerProject {
  const isPublic = 'approved' in project;
  const surfaces: PlayerSurface[] = project.surfaces.map((surface) => ({
    key: surface.key,
    num: surface.num,
    label: surface.label,
    name: surface.name,
    physical: surface.physical,
    specW: surface.specW,
    specH: surface.specH,
    specRatio: surface.specRatio,
    status:
      surface.status === 'ready'
        ? 'ready'
        : surface.status === 'error'
          ? 'error'
          : 'pending',
    previewUrl: surface.previewUrl,
    compatibilityPreview: surface.compatibilityPreview || null,
    mobilePreview: surface.mobilePreview || null,
    posterUrl: surface.posterUrl,
    downloadUrl: surface.downloadUrl,
    duration: surface.duration,
    width: surface.width,
    height: surface.height,
    fps: surface.fps || 0,
    previewMode: surface.previewMode || null,
    previewWidth: surface.previewWidth || 0,
    previewHeight: surface.previewHeight || 0,
    previewFps: surface.previewFps || 0,
    previewBitrate: surface.previewBitrate || 0,
    hasAudio: surface.hasAudio,
    aspectWarning: surface.aspectWarning,
    error: surface.error,
  }));

  return {
    videoSceneId: project.videoSceneId,
    videoSceneName: project.videoSceneName,
    videoScenes: project.videoScenes,
    canPublish: project.canPublish,
    hasUnpublishedChanges: project.hasUnpublishedChanges,
    requiredSurfaceKeys: project.requiredSurfaceKeys ?? ['right', 'back', 'left', 'center', 'floor'],
    processing: project.processing ?? 0,
    canApprove: project.canApprove ?? (project.ready === project.total && !(project.processing ?? 0)),
    scene: project.scene,
    contentRevision: project.contentRevision ?? 0,
    id: project.id,
    slug: project.slug,
    title: project.title,
    client: project.client,
    eventDate: project.eventDate,
    description: project.description,
    duration: project.duration,
    surfaces,
    comments: project.comments,
    approval: project.approval,
    allowComments: project.share.allowComments,
    allowDownload: project.share.allowDownload,
    demo: project.demo,
    isAdmin,
    ready: project.ready,
    total: project.total,
  };
}
