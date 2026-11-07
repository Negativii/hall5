import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PlayerProject, SurfaceKey } from '../../lib/types';
import { defaultScene } from '../../lib/scene';
import { createSceneContent } from '../scene/sceneObjects';
import { createDemandRenderer, decodedFrameToken } from '../../lib/demandRender';
import { mediaSourceIdentity } from '../../lib/mediaCompatibility';

export const Room3D = memo(function Room3D({ project, videos, resetSignal, onFail, suspended = false }: {
  project: PlayerProject;
  videos: React.MutableRefObject<Partial<Record<SurfaceKey, HTMLVideoElement>>>;
  resetSignal: number;
  onFail: () => void;
  suspended?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ overview: () => void; inside: () => void; suspend: () => void } | null>(null);
  const savedPose = useRef<{ signature: string; position: number[]; target: number[]; up: number[] } | null>(null);
  const [modelError, setModelError] = useState('');
  const [overview, setOverview] = useState(false);
  const config = useMemo(() => project.scene || defaultScene(), [project.scene]);
  const signature = useMemo(() => JSON.stringify(config) + project.surfaces.map((surface) => `${surface.key}:${mediaSourceIdentity(surface.previewUrl)}`).join('|'), [config, project.surfaces]);

  useEffect(() => {
    // A focused surface owns the screen. Release 3D's GPU textures and context,
    // then reconstruct the same camera view when the room is visible again.
    const mount = mountRef.current; if (!mount || suspended) return;
    setModelError('');
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: (window.devicePixelRatio || 1) <= 1, alpha: false, powerPreference: 'default' }); }
    catch { onFail(); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, window.matchMedia('(max-width: 800px)').matches ? 1.25 : 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    renderer.domElement.tabIndex = 0; renderer.domElement.setAttribute('aria-label', '3D-зал. Мышь: осмотр, правая кнопка: перемещение. WASD: движение.'); mount.appendChild(renderer.domElement);
    const world = new THREE.Scene(); world.background = new THREE.Color('#060607');
    const { width: w, depth: d, height: h } = config.room;
    const max = Math.max(w, d, h);
    const camera = new THREE.PerspectiveCamera(62, 1, .025, Math.max(300, max * 10));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = true; controls.screenSpacePanning = false; controls.enableDamping = true; controls.dampingFactor = .08;
    controls.rotateSpeed = .5; controls.zoomSpeed = .7; controls.minDistance = .15; controls.maxDistance = max * 4; controls.maxPolarAngle = Math.PI * .97;
    const videoElements = Object.values(videos.current).filter((video): video is HTMLVideoElement => Boolean(video));
    const fallbackVideos = videoElements.filter((video) => typeof video.requestVideoFrameCallback !== 'function');
    const fallbackTokens = new Map<HTMLVideoElement, number>();
    const keys = new Set<string>();
    const forward = new THREE.Vector3(); const right = new THREE.Vector3(); const movement = new THREE.Vector3();
    let last = performance.now();
    let failed = false;
    const scheduler = createDemandRenderer({
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
      step: (now) => {
        const dt = Math.min(.1, (now - last) / 1000); last = now;
        if (keys.size) {
          camera.getWorldDirection(forward); forward.y = 0; forward.normalize();
          right.crossVectors(forward, camera.up).normalize(); movement.set(0, 0, 0);
          if (keys.has('w')) movement.add(forward); if (keys.has('s')) movement.sub(forward); if (keys.has('d')) movement.add(right); if (keys.has('a')) movement.sub(right);
          movement.normalize().multiplyScalar(dt * 3); camera.position.add(movement); controls.target.add(movement); scheduler.invalidate();
        }
        const moving = controls.update();
        let polling = false;
        for (const video of fallbackVideos) {
          if (video.paused || video.ended || video.readyState < 2) continue;
          polling = true;
          const token = decodedFrameToken(video);
          if (fallbackTokens.get(video) !== token) { fallbackTokens.set(video, token); scheduler.invalidate(); }
        }
        return moving || keys.size > 0 || polling;
      },
      render: () => { if (videoFits()) renderer.render(world, camera); },
    });
    // Oversized video must use the direct-video view, never Three's implicit resize.
    const videoFits = () => {
      if (failed) return false;
      if (videoElements.some((video) => video.videoWidth > renderer.capabilities.maxTextureSize || video.videoHeight > renderer.capabilities.maxTextureSize)) {
        failed = true; scheduler.suspend(true); onFail(); return false;
      }
      return true;
    };
    const redraw = () => { if (videoFits()) scheduler.invalidate(); };
    controls.addEventListener('change', redraw);
    const inside = () => { camera.position.set(w * .23, Math.min(1.75, h * .55), d * .385); controls.target.set(-w * .155, Math.min(1.9, h * .6), -d * .37); controls.update(); redraw(); };
    const exterior = () => {
      controls.target.set(0, h * .25, 0);
      const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov / 2);
      const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
      // Fit the entire hall through the narrower viewport dimension, including
      // portrait phones. Keep the same viewing direction and user orbit state.
      const radius = Math.hypot(w / 2, h / 2, d / 2) + h * .25;
      const distance = radius * 1.06 / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov));
      camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(.7, .55 - h / (4 * max), .8).normalize(), distance);
      controls.update(); redraw();
    };
    const pose = savedPose.current;
    if (pose?.signature === signature) {
      camera.position.fromArray(pose.position); camera.up.fromArray(pose.up); controls.target.fromArray(pose.target); controls.update(); redraw();
    } else { inside(); setOverview(false); }
    world.add(new THREE.HemisphereLight('#ffffff', '#343a4f', 2.5));
    const sun = new THREE.DirectionalLight('#ffffff', 2); sun.position.set(w, h * 3, d); world.add(sun);
    const updateStaticMatrices = () => {
      // The public scene has no moving furniture. Recompute transforms only when
      // content arrives, including asynchronously loaded GLB children.
      world.updateMatrixWorld(true);
      world.traverse((object) => { object.matrixAutoUpdate = false; });
      world.matrixWorldAutoUpdate = false;
      redraw();
    };
    const content = createSceneContent(config, { videos: videos.current, onError: setModelError, onLoad: updateStaticMatrices, onVideoFrame: redraw }); world.add(content.group);
    updateStaticMatrices();
    const mediaEvents = ['play', 'playing', 'seeked', 'loadeddata', 'loadedmetadata', 'canplay', 'pause', 'emptied', 'resize'];
    for (const video of videoElements) for (const event of mediaEvents) video.addEventListener(event, redraw);
    let width = 0; let height = 0;
    const resize = () => {
      const rect = mount.getBoundingClientRect();
      if (!rect.width || !rect.height || (rect.width === width && rect.height === height)) return;
      width = rect.width; height = rect.height;
      renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); redraw();
    };
    const observer = new ResizeObserver(resize); observer.observe(mount); resize();
    const keydown = (event: KeyboardEvent) => { if (/^[wasd]$/i.test(event.key)) { keys.add(event.key.toLowerCase()); last = performance.now(); redraw(); event.preventDefault(); } };
    const keyup = (event: KeyboardEvent) => keys.delete(event.key.toLowerCase());
    const blur = () => keys.clear(); const focus = () => renderer.domElement.focus({ preventScroll: true });
    renderer.domElement.addEventListener('keydown', keydown); renderer.domElement.addEventListener('keyup', keyup); renderer.domElement.addEventListener('blur', blur); renderer.domElement.addEventListener('pointerdown', focus);
    const lost = (event: Event) => { event.preventDefault(); if (!failed) { failed = true; scheduler.suspend(true); onFail(); } };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    const visibility = () => {
      keys.clear(); last = performance.now();
      scheduler.suspend(failed || document.hidden);
    };
    runtime.current = { overview: exterior, inside, suspend: visibility };
    document.addEventListener('visibilitychange', visibility); visibility(); redraw();
    return () => {
      savedPose.current = { signature, position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray() };
      runtime.current = null; scheduler.dispose(); document.removeEventListener('visibilitychange', visibility); observer.disconnect();
      renderer.domElement.removeEventListener('keydown', keydown); renderer.domElement.removeEventListener('keyup', keyup); renderer.domElement.removeEventListener('blur', blur); renderer.domElement.removeEventListener('pointerdown', focus); renderer.domElement.removeEventListener('webglcontextlost', lost);
      for (const video of videoElements) for (const event of mediaEvents) video.removeEventListener(event, redraw);
      controls.removeEventListener('change', redraw); controls.dispose(); content.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [signature, videos, onFail, suspended]);
  useEffect(() => { savedPose.current = null; runtime.current?.inside(); setOverview(false); }, [resetSignal]);
  return <div className="room3d" ref={mountRef}>
    <div className="room3d__views" style={{ position: 'absolute', top: 14, right: 14, display: 'flex', gap: 6, zIndex: 2 }}>
      <button className={`btn btn--sm ${overview ? 'btn--secondary' : 'btn--soft'}`} onClick={() => { runtime.current?.inside(); setOverview(false); }}>Внутри</button>
      <button className={`btn btn--sm ${overview ? 'btn--soft' : 'btn--secondary'}`} onClick={() => { runtime.current?.overview(); setOverview(true); }}>Общий вид</button>
    </div>
    {modelError ? <div role="status" style={{ position: 'absolute', top: 64, right: 14, maxWidth: 300, padding: 10, background: '#301c1ce8', color: '#ffbdb2', borderRadius: 8, fontSize: 11 }}>{modelError}</div> : null}
    <div className="room3d__hint"><span className="room3d__mouse" /> Потяните для осмотра · правая кнопка / WASD — движение</div>
  </div>;
});
