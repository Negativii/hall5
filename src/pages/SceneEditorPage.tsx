import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Box, Check, Copy, Eye, Move3D, Redo2, Rotate3D, Save, Scaling, Trash2, Undo2, UploadCloud } from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { api, ApiError } from '../lib/api';
import { SceneAsset, SceneConfig, SceneObject, SceneObjectType, OBJECT_LABELS, defaultScene, makeSceneObject, sceneFingerprint } from '../lib/scene';
import { SurfaceKey } from '../lib/types';
import { SceneViewport, TransformMode } from '../components/scene/SceneViewport';
import { disposeObject } from '../components/scene/sceneObjects';
import { Btn, Field, IconBtn, Spinner, Toggle } from '../components/ui';
import { Modal } from '../components/Modal';
import { useToast } from '../components/Toast';
import '../styles/scene.css';

const PRESETS: SceneObjectType[] = ['screen', 'wall', 'floor', 'podium', 'table', 'chair', 'block'];
const SOURCES: Array<[SurfaceKey, string]> = [['right', 'RIGHT · правая'], ['back', 'BACK · задняя'], ['left', 'LEFT · левая'], ['center', 'CENTER · центральная'], ['floor', 'FLOOR · пол']];

function NumberInput({ value, onChange, label, min = -500, max = 500, step = .1 }: { value: number; onChange: (value: number) => void; label: string; min?: number; max?: number; step?: number }) {
  const formatted = (n: number) => String(Math.round(n * 10000) / 10000);
  const [draft, setDraft] = useState(formatted(value));
  useEffect(() => setDraft(formatted(value)), [value]);
  const commit = () => { const n = Number(draft); if (draft.trim() && Number.isFinite(n)) { const next = Math.max(min, Math.min(max, n)); onChange(next); setDraft(formatted(next)); } else setDraft(formatted(value)); };
  return <input className="input" aria-label={label} type="number" min={min} max={max} step={step} value={draft} onChange={(event) => {
    const next = event.target.value; setDraft(next);
    const number = Number(next);
    // Valid edits must enable Save immediately, without requiring a click
    // elsewhere first. Preserve incomplete/out-of-range text until blur.
    if (next.trim() && Number.isFinite(number) && number >= min && number <= max) onChange(number);
  }} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />;
}

export function SceneEditorPage() {
  const { id } = useParams<{ id: string }>();
  return <SceneEditor key={id} id={id} />;
}

function SceneEditor({ id }: { id: string | undefined }) {
  const navigate = useNavigate(); const toast = useToast();
  const [scene, setScene] = useState<SceneConfig>(defaultScene);
  const [loaded, setLoaded] = useState(false); const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0); const [saved, setSaved] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<TransformMode>('translate'); const [snap, setSnap] = useState(true);
  const [view, setView] = useState<'perspective' | 'top'>('perspective');
  const [past, setPast] = useState<SceneConfig[]>([]); const [future, setFuture] = useState<SceneConfig[]>([]);
  const [saving, setSaving] = useState(false); const [uploading, setUploading] = useState(false); const [deletingAsset, setDeletingAsset] = useState(false); const [error, setError] = useState('');
  const [recovery, setRecovery] = useState<SceneConfig | null>(null);
  const [recoveryStale, setRecoveryStale] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null); const fileRef = useRef<HTMLInputElement>(null);
  const dirty = loaded && sceneFingerprint(scene) !== saved;
  const sceneRef = useRef(scene); sceneRef.current = scene;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const savingRef = useRef(false);
  const uploadingRef = useRef(false);
  const deletingAssetRef = useRef(false);
  const lifecycle = useRef(0);
  useEffect(() => () => { lifecycle.current += 1; }, []);
  const selected = scene.objects.find((object) => object.id === selectedId);

  useEffect(() => {
    let alive = true;
    api<{ scene: SceneConfig; contentRevision: number }>(`/api/projects/${id}/scene`).then((data) => {
      if (!alive) return; setScene(data.scene); setSaved(sceneFingerprint(data.scene)); setRevision(data.contentRevision);
      try {
        const cached = JSON.parse(localStorage.getItem(`hall5-scene-draft:${id}`) || 'null');
        if (cached?.scene?.version === 1 && Array.isArray(cached.scene?.objects) && cached.scene.room && sceneFingerprint(cached.scene) !== sceneFingerprint(data.scene)) {
          setRecovery({ ...cached.scene, assets: data.scene.assets });
          setRecoveryStale(cached.revision !== data.contentRevision);
        }
      } catch { /* a local draft is optional */ }
      setLoaded(true);
    }).catch((error) => {
      if (!alive) return;
      if (error instanceof ApiError && error.status === 401) navigate(`/login?next=${encodeURIComponent(`/admin/p/${id}/scene`)}`, { replace: true });
      else setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить сцену');
    });
    return () => { alive = false; };
  }, [id, navigate]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirtyRef.current || savingRef.current || uploadingRef.current || deletingAssetRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      if (dirty) localStorage.setItem(`hall5-scene-draft:${id}`, JSON.stringify({ scene, revision }));
      else if (!recovery) localStorage.removeItem(`hall5-scene-draft:${id}`);
    } catch { /* editing still works if browser storage is full */ }
  }, [scene, revision, dirty, loaded, id, recovery]);
  const commit = useCallback((next: SceneConfig) => {
    const previousScene = sceneRef.current;
    if (sceneFingerprint(next) === sceneFingerprint(previousScene)) { setScene(next); sceneRef.current = next; return; }
    setPast((previous) => [...previous.slice(-49), previousScene]); setFuture([]); setScene(next); sceneRef.current = next; setError('');
  }, []);
  const updateObject = useCallback((objectId: string, patch: Partial<SceneObject>) => {
    const current = sceneRef.current;
    commit({ ...current, objects: current.objects.map((object) => object.id === objectId ? { ...object, ...patch } : object) });
  }, [commit]);
  const undo = useCallback(() => {
    const next = past.at(-1); if (!next) return;
    setFuture([sceneRef.current, ...future]); setPast(past.slice(0, -1));
    const value = { ...next, assets: sceneRef.current.assets }; setScene(value); sceneRef.current = value;
  }, [past, future]);
  const redo = useCallback(() => {
    const next = future[0]; if (!next) return;
    setPast([...past, sceneRef.current]); setFuture(future.slice(1));
    const value = { ...next, assets: sceneRef.current.assets }; setScene(value); sceneRef.current = value;
  }, [past, future]);
  const addObject = (type: SceneObjectType) => {
    if (scene.objects.length >= 200) { setError('В одной сцене можно разместить до 200 объектов.'); return; }
    const object = makeSceneObject(type); commit({ ...scene, objects: [...scene.objects, object] }); setSelectedId(object.id);
  };
  const removeSelected = useCallback(() => {
    if (!selectedId) return; const current = sceneRef.current;
    commit({ ...current, objects: current.objects.filter((object) => object.id !== selectedId) }); setSelectedId(null);
  }, [selectedId, commit]);
  const duplicate = () => {
    if (!selected || scene.objects.length >= 200) return;
    const object = { ...structuredClone(selected), id: crypto.randomUUID(), name: `${selected.name.slice(0, 112)} · копия`, position: [Math.min(500, selected.position[0] + .3), selected.position[1], Math.min(500, selected.position[2] + .3)] as [number, number, number] };
    commit({ ...scene, objects: [...scene.objects, object] }); setSelectedId(object.id);
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (leaveTo || recovery || deletingAssetRef.current) return;
      const element = event.target as HTMLElement;
      if (element.matches('input, textarea, select') || element.isContentEditable) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
      else if (event.key.toLowerCase() === 'w') setMode('translate');
      else if (event.key.toLowerCase() === 'e') setMode('rotate');
      else if (event.key.toLowerCase() === 'r') setMode('scale');
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [undo, redo, removeSelected, leaveTo, recovery]);
  const saveScene = async (): Promise<boolean> => {
    if (savingRef.current || uploadingRef.current || deletingAssetRef.current) return false;
    const request = lifecycle.current;
    const submitted = sceneRef.current;
    if (submitted.objects.some((object) => !object.name.trim())) { setError('Укажите название у каждого объекта перед сохранением.'); return false; }
    savingRef.current = true;
    setSaving(true); setError('');
    try {
      const endpoint = `/api/projects/${id}/scene`;
      const submit = (contentRevision: number) => api<{ scene: SceneConfig; contentRevision: number }>(endpoint, { method: 'PATCH', body: { scene: submitted, contentRevision } });
      let data;
      try { data = await submit(revision); }
      catch (error) {
        if (!(error instanceof ApiError && error.status === 409) || request !== lifecycle.current) throw error;
        const latest = await api<{ scene: SceneConfig; contentRevision: number }>(endpoint);
        if (request !== lifecycle.current) return false;
        // Video processing also increments the project revision. Retry once
        // only when the saved layout itself has not changed elsewhere.
        if (sceneFingerprint(latest.scene) !== saved) throw error;
        data = await submit(latest.contentRevision);
      }
      if (request !== lifecycle.current) return false;
      const fullySaved = sceneFingerprint(sceneRef.current) === sceneFingerprint(submitted);
      const next = fullySaved ? data.scene : { ...sceneRef.current, assets: data.scene.assets };
      setScene(next); sceneRef.current = next; setSaved(sceneFingerprint(data.scene)); setRevision(data.contentRevision);
      toast.push(fullySaved ? 'Сцена сохранена' : 'Предыдущие изменения сохранены', { description: fullySaved ? 'Заказчик увидит её в 3D-показе.' : 'Новые правки остались в редакторе. Сохраните их ещё раз.', tone: 'success' }); return fullySaved;
    } catch (error) {
      if (request !== lifecycle.current) return false;
      setError(error instanceof ApiError && error.status === 409 ? 'Проект изменился в другой вкладке. Ваши изменения сохранены в редакторе. Сначала откройте актуальный проект в другой вкладке и сравните версии.' : error instanceof Error ? error.message : 'Не удалось сохранить сцену'); return false;
    } finally { if (request === lifecycle.current) { savingRef.current = false; setSaving(false); } }
  };
  const go = (path: string) => { if (savingRef.current || uploadingRef.current || deletingAssetRef.current) { setError('Дождитесь завершения сохранения или операции с моделью.'); return; } if (dirty) setLeaveTo(path); else navigate(path); };
  const deleteAsset = async (asset: SceneAsset) => {
    if (savingRef.current || uploadingRef.current || deletingAssetRef.current) return;
    if (dirtyRef.current) { setError('Сначала сохраните расстановку, затем удалите файл неиспользуемой модели.'); return; }
    const request = lifecycle.current;
    deletingAssetRef.current = true; setDeletingAsset(true);
    try {
      await api(`/api/projects/${id}/assets/${asset.id}`, { method: 'DELETE' });
      if (request !== lifecycle.current) return;
      const next = { ...sceneRef.current, assets: sceneRef.current.assets.filter((item) => item.id !== asset.id) };
      setScene(next); sceneRef.current = next; setPast([]); setFuture([]); toast.push('Файл модели удалён');
    } catch (error) { if (request === lifecycle.current) setError(error instanceof Error ? error.message : 'Не удалось удалить модель'); }
    finally { if (request === lifecycle.current) { deletingAssetRef.current = false; setDeletingAsset(false); } }
  };
  const uploadModel = async (file: File | undefined) => {
    if (!file || uploadingRef.current || savingRef.current || deletingAssetRef.current) return;
    const request = lifecycle.current;
    if (!/\.glb$/i.test(file.name)) { setError('Выберите GLB-файл. Экспортируйте модель с включёнными текстурами (binary glTF).'); return; }
    if (file.size > 50 * 1024 * 1024) { setError('Размер GLB-файла должен быть не больше 50 МБ.'); return; }
    if (sceneRef.current.assets.length >= 40) { setError('Можно загрузить до 40 моделей в проект. Удалите неиспользуемые модели.'); return; }
    if (sceneRef.current.objects.length >= 200) { setError('В сцене уже 200 объектов. Сначала удалите лишние.'); return; }
    uploadingRef.current = true; setUploading(true); setError('');
    try {
      const manager = new THREE.LoadingManager(); manager.setURLModifier((url) => { if (/^(blob:|data:)/.test(url)) return url; throw new Error('Нужен GLB со встроенными текстурами и геометрией'); });
      const gltf = await new GLTFLoader(manager).parseAsync(await file.arrayBuffer(), '');
      const bounds = new THREE.Box3().setFromObject(gltf.scene); const dimensions = bounds.getSize(new THREE.Vector3()); disposeObject(gltf.scene);
      if (request !== lifecycle.current) return;
      if (bounds.isEmpty() || !dimensions.toArray().every((value) => Number.isFinite(value) && value >= 0) || dimensions.length() < .000001) throw new Error('В модели нет видимой геометрии');
      const form = new FormData(); form.append('file', file);
      const data = await api<{ asset: SceneAsset }>(`/api/projects/${id}/assets`, { method: 'POST', body: form });
      if (request !== lifecycle.current) return;
      const current = sceneRef.current;
      if (current.objects.length >= 200) {
        const next = { ...current, assets: [...current.assets, data.asset] }; setScene(next); sceneRef.current = next;
        setError('Файл модели загружен в библиотеку. Чтобы добавить его в сцену, сначала освободите место среди 200 объектов.'); return;
      }
      const object = makeSceneObject('model'); object.assetId = data.asset.id; object.name = file.name.replace(/\.glb$/i, '').slice(0, 120) || '3D-модель';
      const fit = Math.min(1, Math.min(current.room.width, current.room.depth) * .5 / Math.max(dimensions.x, dimensions.z, dimensions.y));
      object.size = dimensions.toArray().map((value) => Math.max(.01, Math.round(value * fit * 1000) / 1000)) as [number, number, number];
      commit({ ...current, assets: [...current.assets.filter((asset) => asset.id !== data.asset.id), data.asset], objects: [...current.objects, object] }); setSelectedId(object.id);
      toast.push('Модель добавлена', { description: 'Расположите её в сцене и нажмите «Сохранить».', tone: 'success' });
    } catch (error) { if (request !== lifecycle.current) return; const message = error instanceof Error ? error.message : 'Не удалось импортировать модель'; setError(/Draco|Meshopt|KTX2/i.test(message) ? 'Эта модель использует сжатие Draco, Meshopt или KTX2. Экспортируйте обычный GLB со встроенными текстурами.' : message); }
    finally { if (request === lifecycle.current) { uploadingRef.current = false; setUploading(false); if (fileRef.current) fileRef.current.value = ''; } }
  };

  if (loadError) return <div className="page"><div className="empty-state"><h2>Сцена недоступна</h2><p>{loadError}</p><Btn onClick={() => navigate(`/admin/p/${id}`)}>Вернуться в проект</Btn></div></div>;
  if (!loaded) return <div className="page page-loading"><Spinner /> Загружаем сцену</div>;
  return <div className="scene-editor">
    <header className="scene-editor__header">
      <div className="scene-editor__title"><IconBtn label="Вернуться в проект" onClick={() => go(`/admin/p/${id}`)}><ArrowLeft size={18} /></IconBtn><div><span className="eyebrow">KUOG HALL</span><h1>Конструктор сцены</h1></div></div>
      <div className="scene-editor__header-actions"><span className={`scene-save-status ${dirty ? 'is-dirty' : ''}`} role="status">{dirty ? 'Есть изменения' : <><Check size={14} /> Всё сохранено</>}</span><Btn icon={<Eye size={16} />} onClick={() => go(`/admin/p/${id}/present`)}>Показ</Btn><Btn variant="primary" icon={<Save size={16} />} onClick={() => saveScene()} loading={saving} disabled={!dirty || uploading || deletingAsset}>Сохранить</Btn></div>
    </header>
    {error ? <div className="scene-editor__error" role="alert">{error}<button aria-label="Закрыть сообщение" onClick={() => setError('')}>×</button></div> : null}
    <div className="scene-editor__layout">
      <aside className="scene-editor__library">
        <section><h2>Добавить объект</h2><div className="scene-presets">{PRESETS.map((type) => <button type="button" key={type} onClick={() => addObject(type)}><Box size={17} /><span>{OBJECT_LABELS[type]}</span></button>)}</div>
          <input type="file" hidden accept=".glb,model/gltf-binary" ref={fileRef} onChange={(event) => uploadModel(event.target.files?.[0])} />
          <Btn full icon={<UploadCloud size={16} />} loading={uploading} disabled={saving || deletingAsset} onClick={() => fileRef.current?.click()}>Импорт GLB</Btn><p className="scene-help">Свои модели с текстурами внутри файла, до 50 МБ.</p>
        </section>
        <section><h2>Объекты <span>{scene.objects.length}</span></h2><div className="scene-object-list" role="list" aria-label="Объекты сцены">{scene.objects.length ? scene.objects.map((object) => <button role="listitem" type="button" key={object.id} className={selectedId === object.id ? 'is-selected' : ''} onClick={() => setSelectedId(object.id)}><span className="scene-object-list__color" style={{ background: object.color }} /><span>{object.name}</span><small>{OBJECT_LABELS[object.type]}</small></button>) : <p className="scene-help">Добавьте объект из библиотеки или импортируйте модель.</p>}</div></section>
        {scene.assets.length ? <section><h2>Загруженные модели</h2><div className="scene-asset-list">{scene.assets.map((asset) => <div className="scene-asset-row" key={asset.id}><button disabled={deletingAsset} onClick={() => { if (scene.objects.length >= 200) return; const object = makeSceneObject('model'); object.assetId = asset.id; object.name = asset.name.replace(/\.glb$/i, '').slice(0, 120) || '3D-модель'; object.size = [...(scene.objects.find((item) => item.assetId === asset.id)?.size || [1, 1, 1])] as [number, number, number]; commit({ ...scene, objects: [...scene.objects, object] }); setSelectedId(object.id); }}><span>{asset.name}</span><span>+</span></button><IconBtn label={`Удалить файл ${asset.name}`} tone="danger" disabled={saving || uploading || deletingAsset || scene.objects.some((object) => object.assetId === asset.id)} onClick={() => deleteAsset(asset)}><Trash2 size={13} /></IconBtn></div>)}</div></section> : null}
      </aside>
      <main className="scene-editor__stage">
        <div className="scene-toolbar"><div>{([['translate', Move3D, 'Перемещение (W)'], ['rotate', Rotate3D, 'Поворот (E)'], ['scale', Scaling, 'Размер (R)']] as const).map(([value, Icon, label]) => <IconBtn key={value} label={label} active={mode === value} onClick={() => setMode(value)}><Icon size={18} /></IconBtn>)}</div><div><IconBtn label="Отменить" disabled={!past.length || deletingAsset} onClick={undo}><Undo2 size={17} /></IconBtn><IconBtn label="Повторить" disabled={!future.length || deletingAsset} onClick={redo}><Redo2 size={17} /></IconBtn><button className={`scene-toolbar__snap ${snap ? 'is-on' : ''}`} aria-pressed={snap} onClick={() => setSnap(!snap)}>Шаг 0,1 м</button></div><div className="scene-view-tabs"><button className={view === 'perspective' ? 'is-active' : ''} onClick={() => setView('perspective')}>3D</button><button className={view === 'top' ? 'is-active' : ''} onClick={() => setView('top')}>Сверху</button></div></div>
        <SceneViewport scene={scene} selectedId={selectedId} mode={mode} snap={snap} view={view} onSelect={setSelectedId} onTransform={updateObject} onError={setError} />
        <footer className="scene-editor__stage-footer"><span>Размеры в метрах · положение от центра зала · Y — высота нижней точки</span><span>{scene.room.width} × {scene.room.depth} × {scene.room.height} м</span></footer>
      </main>
      <aside className="scene-editor__inspector">
        <section><h2>Помещение</h2><div className="scene-vector">{(['width', 'depth', 'height'] as const).map((key, index) => <Field key={key} label={['Ширина', 'Глубина', 'Высота'][index]}><NumberInput label={`Помещение: ${key}`} value={scene.room[key]} min={key === 'height' ? .5 : 1} max={key === 'height' ? 50 : 200} onChange={(value) => commit({ ...scene, room: { ...scene.room, [key]: value } })} /></Field>)}</div><Toggle label="Четыре стены и пол" description="Видео на поверхностях помещения" checked={scene.showRoomSurfaces} onChange={(value) => commit({ ...scene, showRoomSurfaces: value })} /></section>
        <section><div className="scene-inspector-title"><h2>{selected ? OBJECT_LABELS[selected.type] : 'Свойства объекта'}</h2>{selected ? <div><IconBtn label="Дублировать объект" onClick={duplicate}><Copy size={15} /></IconBtn><IconBtn label="Удалить объект" tone="danger" onClick={removeSelected}><Trash2 size={15} /></IconBtn></div> : null}</div>
          {selected ? <><Field label="Название"><input className="input" aria-label="Название объекта" value={selected.name} maxLength={120} onChange={(event) => updateObject(selected.id, { name: event.target.value })} /></Field>
            {(['position', 'size', 'rotation'] as const).map((key) => <div className="scene-property" key={key}><h3>{key === 'position' ? 'Положение, м' : key === 'size' ? 'Размер, м' : 'Поворот, °'}</h3><div className="scene-vector">{[0, 1, 2].map((axis) => <Field key={axis} label={key === 'size' ? ['Ширина X', 'Высота Y', 'Глубина Z'][axis] : ['X', 'Y', 'Z'][axis]}><NumberInput key={`${selected.id}:${key}:${axis}`} label={`${key} ${['X', 'Y', 'Z'][axis]}`} value={selected[key][axis]} min={key === 'size' ? .01 : key === 'rotation' ? -3600 : -500} max={key === 'rotation' ? 3600 : key === 'size' ? 200 : 500} step={key === 'rotation' ? 1 : .1} onChange={(value) => { const vector = [...selected[key]] as [number, number, number]; vector[axis] = value; updateObject(selected.id, { [key]: vector }); }} /></Field>)}</div></div>)}
            {selected.type !== 'model' ? <Field label="Цвет"><div className="scene-color"><input aria-label="Цвет объекта" type="color" value={selected.color} onChange={(event) => updateObject(selected.id, { color: event.target.value })} /><span>{selected.color}</span></div></Field> : null}
            {selected.type === 'screen' || selected.type === 'floor' ? <Field label={selected.type === 'floor' ? 'Видео на полу' : 'Видео на экране'} hint="Несколько экранов могут показывать один канал."><select className="input" aria-label={selected.type === 'floor' ? 'Видео на полу' : 'Видео на экране'} value={selected.source || ''} onChange={(event) => updateObject(selected.id, { source: (event.target.value || null) as SurfaceKey | null })}><option value="">Только цвет</option>{SOURCES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field> : null}
            <Btn full variant="ghost" onClick={() => updateObject(selected.id, { position: [selected.position[0], 0, selected.position[2]] })}>Поставить на пол</Btn>
          </> : <p className="scene-help">Выберите объект в списке или в 3D. Для точного размещения используйте поля, для быстрого — цветные стрелки.</p>}
        </section>
      </aside>
    </div>
    <Modal open={Boolean(recovery)} title="Восстановить черновик сцены?" dismissable={false} onClose={() => {}} size="sm" footer={<><Btn variant="ghost" onClick={() => setRecovery(null)}>Оставить сохранённую</Btn><Btn variant="primary" onClick={() => { if (recovery) commit(recovery); setRecovery(null); }}>Восстановить черновик</Btn></>}><p>{recoveryStale ? 'На сервере появилась более новая версия проекта. Локальный черновик сохранён: его можно восстановить для проверки, но последующее сохранение заменит расстановку на сервере.' : 'В этом браузере остались несохранённые изменения. Их можно продолжить редактировать.'}</p></Modal>
    <Modal open={Boolean(leaveTo)} title="Сохранить сцену перед выходом?" dismissable={!saving} onClose={() => { if (!savingRef.current) setLeaveTo(null); }} size="sm" footer={<><Btn variant="ghost" disabled={saving} onClick={() => { const path = leaveTo; setLeaveTo(null); if (path) navigate(path); }}>Выйти без сохранения</Btn><Btn variant="primary" loading={saving} onClick={async () => { if (await saveScene()) { const path = leaveTo; setLeaveTo(null); if (path) navigate(path); } }}>Сохранить и выйти</Btn></>}><p>Изменения ещё не видны заказчику.</p></Modal>
  </div>;
}
