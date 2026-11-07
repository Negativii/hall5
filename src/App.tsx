import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LegalPage } from './pages/LegalPage';
import './styles/legal.css';
import { ToastProvider } from './components/Toast';
import { SharePage } from './pages/SharePage';
import { NotFoundPage } from './pages/NotFoundPage';
const Landing = lazy(() => import('./pages/Landing').then((module) => ({ default: module.Landing })));
const Login = lazy(() => import('./pages/Login').then((module) => ({ default: module.Login })));
const AdminLayout = lazy(() => import('./pages/AdminLayout').then((module) => ({ default: module.AdminLayout })));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage').then((module) => ({ default: module.ProjectsPage })));
const ProjectPage = lazy(() => import('./pages/ProjectPage').then((module) => ({ default: module.ProjectPage })));
const AdminPresentPage = lazy(() => import('./pages/AdminPresentPage').then((module) => ({ default: module.AdminPresentPage })));
const SceneEditorPage = lazy(() => import('./pages/SceneEditorPage').then((module) => ({ default: module.SceneEditorPage })));

function ScrollToTop() {
  const location = useLocation();
  useEffect(() => {
    try { localStorage.removeItem('h5_author'); } catch { /* storage may be disabled */ }
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [location.pathname]);
  return null;
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <ScrollToTop />
        <Suspense fallback={<div className="public-boot" role="status">Открываем KUOG HALL…</div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />
          <Route path="/legal/:document" element={<LegalPage />} />
          <Route path="/admin/p/:id/scene" element={<Suspense fallback={<div className="public-boot" role="status">Открываем конструктор…</div>}><SceneEditorPage /></Suspense>} />
          <Route path="/admin/p/:id/present" element={<AdminPresentPage />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<ProjectsPage />} />
            <Route path="p/:id" element={<ProjectPage />} />
          </Route>
          <Route path="/s/:slug" element={<SharePage />} />
          <Route path="/admin/*" element={<Navigate to="/admin" replace />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}
