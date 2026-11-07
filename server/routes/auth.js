import { Router } from 'express';
import { checkPassword, issueAdminCookie, clearCookie, ADMIN_COOKIE, isAdmin } from '../auth.js';
import { rateLimit } from '../ratelimit.js';
import { ADMIN_PASSWORD_CONFIGURED } from '../config.js';

export const authRouter = Router();

authRouter.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimit(`login:${ip}`, 10, 15 * 60 * 1000)) {
    res.status(429).json({ error: 'Слишком много попыток. Попробуйте через 15 минут.' });
    return;
  }
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    res.status(401).json({ error: 'Неверный пароль' });
    return;
  }
  issueAdminCookie(req, res);
  res.json({ ok: true, defaultPassword: false });
});

authRouter.post('/logout', (req, res) => {
  clearCookie(res, ADMIN_COOKIE);
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({
    authenticated: isAdmin(req),
    defaultPassword: false,
    ...(isAdmin(req) ? { passwordConfigured: ADMIN_PASSWORD_CONFIGURED } : {}),
  });
});
