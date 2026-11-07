import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource-variable/unbounded';
import './styles.css';
import App from './App';
import PagesApp from './pages/PagesApp';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(import.meta.env.VITE_STATIC_DEMO === 'true' ? <PagesApp /> : <App />);
