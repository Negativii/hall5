import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { SceneConfig, SceneObject } from '../../lib/scene';
import { createSceneContent, disposeObject } from './sceneObjects';

export type TransformMode = 'translate' | 'rotate' | 'scale';
export function SceneViewport({ scene: config, selectedId, mode, snap, view, onSelect, onTransform, onError }: {
  scene: SceneConfig; selectedId: string | null; mode: TransformMode; snap: boolean; view: 'perspective' | 'top';
  onSelect: (id: string | null) => void; onTransform: (id: string, patch: Partial<SceneObject>) => void; onError: (message: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const runtime = useRef<{ transform: TransformControls; objects: Map<string, THREE.Group>; camera: THREE.PerspectiveCamera; orbit: OrbitControls; render: () => void } | null>(null);
  const callbacks = useRef({ onSelect, onTransform, onError }); callbacks.current = { onSelect, onTransform, onError };
  const cameraState = useRef<{ position: [number, number, number]; target: [number, number, number]; up: [number, number, number] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [modelErrors, setModelErrors] = useState<string[]>([]);
  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    setModelErrors([]);
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'default' }); }
    catch { setFailed(true); return; }
    setFailed(false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.setAttribute('aria-label', '3D-редактор сцены: выберите объект щелчком');
    renderer.domElement.tabIndex = 0; mount.appendChild(renderer.domElement);
    const world = new THREE.Scene(); world.background = new THREE.Color('#11151e');
    const max = Math.max(config.room.width, config.room.depth, config.room.height);
    const camera = new THREE.PerspectiveCamera(48, 1, .01, Math.max(300, max * 10));
    camera.position.set(max * .70, max * .55, max * .8);
    if (cameraState.current) camera.up.set(...cameraState.current.up);
    const orbit = new OrbitControls(camera, renderer.domElement); orbit.target.set(0, config.room.height * .3, 0); orbit.maxDistance = max * 5;
    orbit.minDistance = .2;
    if (cameraState.current) { camera.position.set(...cameraState.current.position); orbit.target.set(...cameraState.current.target); }
    orbit.update();
    world.add(new THREE.HemisphereLight('#ffffff', '#343c53', 2.5));
    const sun = new THREE.DirectionalLight('#ffffff', 2); sun.position.set(8, 16, 10); world.add(sun);
    const grid = new THREE.GridHelper(Math.max(20, Math.ceil(max * 1.5)), Math.min(100, Math.ceil(max * 1.5)), '#465574', '#252e42');
    grid.position.y = -.025; world.add(grid);
    const render = () => renderer.render(world, camera);
    const content = createSceneContent(config, { editor: true, onLoad: render, onError: (message) => setModelErrors((previous) => [...new Set([...previous, message])]) });
    world.add(content.group);
    const transform = new TransformControls(camera, renderer.domElement); transform.setSpace('world'); transform.setSize(.85);
    world.add(transform.getHelper());
    transform.addEventListener('change', render);
    transform.addEventListener('dragging-changed', (event) => { orbit.enabled = !event.value; });
    transform.addEventListener('mouseUp', () => {
      const object = transform.object; if (!object) return;
      const id = object.userData.sceneId;
      callbacks.current.onTransform(id, {
        position: object.position.toArray().map((value) => Math.round(value * 1000) / 1000) as [number, number, number],
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z].map((value) => Math.round(THREE.MathUtils.radToDeg(value) * 100) / 100) as [number, number, number],
        size: object.scale.toArray().map((value) => Math.max(.01, Math.min(200, Math.round(Math.abs(value) * 1000) / 1000))) as [number, number, number],
      });
    });
    orbit.addEventListener('change', render);
    const pointer = new THREE.Vector2(); const ray = new THREE.Raycaster(); let pointerStart = [0, 0];
    const onDown = (event: PointerEvent) => { pointerStart = [event.clientX, event.clientY]; };
    const onUp = (event: PointerEvent) => {
      if (transform.dragging || transform.axis || Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      ray.setFromCamera(pointer, camera); const hits = ray.intersectObjects([...content.objects.values()], true);
      callbacks.current.onSelect(hits.find((hit) => hit.object.userData.sceneId)?.object.userData.sceneId || null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown); renderer.domElement.addEventListener('pointerup', onUp);
    const resize = () => { const rect = mount.getBoundingClientRect(); if (!rect.width || !rect.height) return; renderer.setSize(rect.width, rect.height, false); camera.aspect = rect.width / rect.height; camera.updateProjectionMatrix(); render(); };
    const observer = new ResizeObserver(resize); observer.observe(mount); resize();
    runtime.current = { transform, objects: content.objects, camera, orbit, render };
    const lost = (event: Event) => { event.preventDefault(); setFailed(true); callbacks.current.onError('Графический контекст потерян. Сохраните изменения и перезагрузите страницу.'); };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    return () => {
      cameraState.current = { position: camera.position.toArray() as [number, number, number], target: orbit.target.toArray() as [number, number, number], up: camera.up.toArray() as [number, number, number] };
      runtime.current = null; observer.disconnect(); transform.detach(); transform.dispose(); orbit.dispose(); content.dispose(); disposeObject(grid);
      renderer.domElement.removeEventListener('pointerdown', onDown); renderer.domElement.removeEventListener('pointerup', onUp); renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.dispose(); renderer.domElement.remove();
    };
  }, [config]);
  useEffect(() => {
    const rt = runtime.current; if (!rt) return;
    const selected = selectedId && rt.objects.get(selectedId);
    if (selected) rt.transform.attach(selected); else rt.transform.detach();
    rt.transform.setMode(mode); rt.transform.setTranslationSnap(snap ? .1 : null); rt.transform.setRotationSnap(snap ? Math.PI / 12 : null); rt.transform.setScaleSnap(snap ? .1 : null); rt.render();
  }, [config, selectedId, mode, snap]);
  useEffect(() => {
    const rt = runtime.current; if (!rt) return;
    const max = Math.max(config.room.width, config.room.depth, config.room.height);
    if (view === 'top') { rt.camera.up.set(-1, 0, 0); rt.camera.position.set(0, max * 1.3, .001); rt.orbit.target.set(0, 0, 0); }
    else { rt.camera.up.set(0, 1, 0); rt.camera.position.set(max * .70, max * .55, max * .8); rt.orbit.target.set(0, config.room.height * .3, 0); }
    rt.orbit.update(); rt.render();
  }, [view, config.room.width, config.room.depth, config.room.height]);
  return <div className="scene-viewport" ref={mountRef}>
    {failed ? <div className="scene-viewport__fallback" role="alert">3D недоступен в этом браузере. Объекты можно редактировать через список и поля справа.</div> : null}
    {modelErrors.length ? <div className="scene-viewport__errors" role="status">{modelErrors.map((message) => <div key={message}>{message}</div>)}</div> : null}
    <div className="scene-viewport__hint">Левая кнопка — осмотр / выбор · правая — сдвиг вида · колесо — масштаб</div>
  </div>;
}
