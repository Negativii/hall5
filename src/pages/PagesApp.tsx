import { useState } from 'react';
import { HashRouter, Link, Route, Routes } from 'react-router-dom';
import { Player } from '../components/player/Player';
import { ToastProvider } from '../components/Toast';
import type { PlayerProject } from '../lib/types';
import { SURFACE_SPECS } from '../lib/surfaces';
import { defaultScene } from '../lib/scene';
import '../styles/pages-demo.css';

function Demo() {
  const [project] = useState<PlayerProject>(() => ({
    id: 'public-demo', slug: 'public-demo', title: 'Проекционный зал · демо',
    client: '20 × 10 × 5 м', eventDate: '', description: 'Пять поверхностей и один таймлайн',
    contentRevision: 1, duration: 12, requiredSurfaceKeys: ['right', 'back', 'left', 'center', 'floor'],
    processing: 0, canApprove: false, scene: defaultScene(), ready: 5, total: 5,
    comments: [], approval: null, allowComments: false, allowDownload: false, demo: true, isAdmin: false,
    surfaces: SURFACE_SPECS.map(surface => ({
      key: surface.key as PlayerProject['requiredSurfaceKeys'][number], num: surface.num,
      label: surface.label, name: surface.name, physical: surface.physical,
      specW: surface.w, specH: surface.h, specRatio: surface.w / surface.h,
      status: 'ready', previewUrl: `${import.meta.env.BASE_URL}demo/${surface.key}.mp4`,
      posterUrl: `${import.meta.env.BASE_URL}demo/${surface.key}.jpg`, downloadUrl: null,
      duration: 12, width: surface.w / 5, height: surface.h / 5, fps: 24,
      previewMode: 'converted', previewWidth: surface.w / 5, previewHeight: surface.h / 5,
      previewFps: 24, previewBitrate: 0, hasAudio: false, aspectWarning: false, error: null,
    })),
  }));
  return <div className="pages-demo">
    <aside className="pages-demo__notice">
      <span><strong>Публичное демо</strong> · тестовая графика · схема и 3D работают в браузере</span>
      <a href="https://github.com/Negativii/hall5" target="_blank" rel="noreferrer">Исходный код ↗</a>
    </aside>
    <Player project={project} comments={[]} initialView="room" />
  </div>;
}

function DemoInfo() {
  return <main className="pages-demo__info">
    <Link to="/">← Вернуться в зал</Link>
    <h1>О публичном демо</h1>
    <p>Здесь доступны тестовые видеоканалы, синхронный просмотр, схема поверхностей и 3D-зал.</p>
    <p>Сайт размещён на GitHub Pages. Кабинет, загрузка файлов, закрытые проекты, отзывы и согласования доступны при отдельном запуске серверной версии.</p>
    <p>В демо нет входа, отправки отзывов и аналитики приложения. Данные закрытых проектов не опубликованы. Хостинг обслуживает GitHub в соответствии со своей <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">политикой конфиденциальности</a>.</p>
    <a href="https://github.com/Negativii/hall5#readme">Инструкция запуска полной версии ↗</a>
  </main>;
}

export default function PagesApp() {
  return <ToastProvider><HashRouter><Routes>
    <Route path="/" element={<Demo />} />
    <Route path="*" element={<DemoInfo />} />
  </Routes></HashRouter></ToastProvider>;
}
