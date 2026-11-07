import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import compression from 'compression';
import {
  ROOT,
  PORT,
  HOST,
  IS_PROD,
  ADMIN_PASSWORD_CONFIGURED,
  PUBLIC_URL,
  TMP_DIR,
  ffmpegPath,
  ffprobePath,
  binaryWorks,
} from './config.js';
import { authRouter } from './routes/auth.js';
import { requireAdmin } from './auth.js';
import { projectsRouter } from './routes/projects.js';
import { shareRouter } from './routes/share.js';
import { sceneRouter, sceneShareRouter } from './routes/scene.js';
import { store, releaseDataLock } from './db.js';
import { requeueInterrupted, cancelProcessing } from './jobs.js';
import { publicLegalConfig, pruneExpiredFeedback } from './legal.js';

const app = express();
app.disable('x-powered-by');
// Only our local reverse proxy may supply client IP / HTTPS headers.
app.set('trust proxy', 'loopback');
app.use(compression());

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'private, no-store');
  if (IS_PROD) {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
  }
  next();
});

app.use((req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (origin.host !== req.headers.host) {
        res.status(403).json({ error: 'Запрос с чужого домена отклонён' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Некорректный Origin' });
      return;
    }
  }
  next();
});

app.use(express.json({ limit: '2mb' }));

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
app.get('/api/legal', (req, res) => res.json(publicLegalConfig()));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/health/details', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    version: '1.1.0',
    ffmpeg: binaryWorks(ffmpegPath),
    ffprobe: binaryWorks(ffprobePath),
    publicUrl: PUBLIC_URL || null,
  });
});

app.use('/api', authRouter);
app.use('/api/projects', sceneRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/s', sceneShareRouter);
app.use('/api/s', shareRouter);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Не найдено' });
});

const server = http.createServer(app);

if (!IS_PROD) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: ROOT,
    server: { middlewareMode: true, hmr: { server } },
    appType: 'custom',
  });
  app.use(vite.middlewares);
  app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      let template = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
      template = await vite.transformIndexHtml(req.originalUrl, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
    } catch (error) {
      vite.ssrFixStacktrace(error);
      next(error);
    }
  });
} else {
  const dist = path.join(ROOT, 'dist');
  app.use(
    express.static(dist, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        }
      },
    }),
  );
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (req.file?.path) {
    try {
      fs.rmSync(req.file.path, { force: true });
    } catch {
      /* ignore */
    }
  }
  const code = err?.code;
  if (code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: req.path.includes('/assets') ? 'GLB-модель должна быть меньше 50 МБ' : 'Файл слишком большой. Увеличьте MAX_UPLOAD_GB на сервере.' });
    return;
  }
  if (err?.name === 'MulterError' || code === 'LIMIT_UNEXPECTED_FILE') {
    res.status(400).json({ error: err.message || 'Ошибка загрузки файла' });
    return;
  }
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ error: err.message || 'Некорректный запрос' });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Некорректный JSON' });
    return;
  }
  console.error('[server]', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

for (const name of fs.readdirSync(TMP_DIR)) {
  try {
    fs.rmSync(path.join(TMP_DIR, name), { force: true });
  } catch {
    /* ignore */
  }
}

function expireFeedback() {
  try { pruneExpiredFeedback(store); }
  catch (error) { console.error('[privacy] Не удалось очистить просроченную обратную связь:', error.message); }
}
expireFeedback();
setInterval(expireFeedback, 60 * 60 * 1000).unref();
const resumed = requeueInterrupted();

server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE'
    ? `Порт ${PORT} занят. Остановите прежний KUOG HALL или измените PORT в .env.`
    : `Не удалось запустить KUOG HALL: ${error.message}`);
  releaseDataLock();
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const address = `http://localhost:${PORT}`;
  console.log('');
  console.log('  KUOG HALL — закрытый показ проекционного зала');
  console.log(`  ${address}`);
  if (PUBLIC_URL) console.log(`  Публичный адрес: ${PUBLIC_URL}`);
  if (!ADMIN_PASSWORD_CONFIGURED) {
    console.log('  Вход заблокирован: задайте ADMIN_PASSWORD длиной не менее 12 символов в .env');
  }
  if (!binaryWorks(ffmpegPath) || !binaryWorks(ffprobePath)) {
    console.log('  ВНИМАНИЕ: ffmpeg/ffprobe не найдены, обработка видео недоступна');
  }
  if (resumed) console.log(`  Возобновлена обработка: ${resumed}`);
  console.log('');
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  const stopped = new Promise((resolve) => server.close(resolve));
  const deadline = setTimeout(() => process.exit(0), 8000);
  deadline.unref();
  await cancelProcessing();
  server.closeIdleConnections();
  await stopped;
  releaseDataLock();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
