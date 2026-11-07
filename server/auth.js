import { signPayload, verifyPayload, safeEqual, parseCookies, hmac } from './util.js';
import { SECRET, ADMIN_PASSWORD, ADMIN_PASSWORD_CONFIGURED } from './config.js';

export const ADMIN_COOKIE = 'h5_admin';

const ADMIN_TTL = 7 * 24 * 60 * 60;
const SHARE_TTL = 24 * 60 * 60;

export function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export function isSecureRequest(req) {
  return Boolean(req.secure);
}

export function issueAdminCookie(req, res) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL;
  const token = signPayload(`admin.${hmac(ADMIN_PASSWORD, SECRET)}.${exp}`, SECRET);
  setCookie(res, ADMIN_COOKIE, token, { maxAge: ADMIN_TTL, secure: isSecureRequest(req) });
}

export function isAdmin(req) {
  if (!ADMIN_PASSWORD_CONFIGURED) return false;
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifyPayload(cookies[ADMIN_COOKIE], SECRET);
  if (!payload) return false;
  const [scope, credential, exp, extra] = payload.split('.');
  return !extra && scope === 'admin' && credential === hmac(ADMIN_PASSWORD, SECRET)
    && Number(exp) > Math.floor(Date.now() / 1000);
}

export function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'Требуется вход в кабинет', code: 'auth' });
    return;
  }
  next();
}

export function checkPassword(password) {
  return ADMIN_PASSWORD_CONFIGURED && typeof password === 'string' && password.length <= 1024
    && safeEqual(password, ADMIN_PASSWORD);
}

export function shareCookieName(slug) {
  return `h5_s_${slug}`;
}

export function issueShareCookie(req, res, project) {
  const exp = Math.floor(Date.now() / 1000) + SHARE_TTL;
  const revision = project.share?.revision || '0';
  const token = signPayload(`share.${project.id}.${revision}.${shareCredential(project)}.${exp}`, SECRET);
  setCookie(res, shareCookieName(project.slug), token, {
    maxAge: SHARE_TTL,
    secure: isSecureRequest(req),
  });
}

export function hasShareAccess(req, project) {
  if (!project?.share?.passcodeHash || !project.share.passcodeSalt) return false;
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifyPayload(cookies[shareCookieName(project.slug)], SECRET);
  if (!payload) return false;
  const [scope, projectId, revision, credential, expires, extra] = payload.split('.');
  const exp = Number(expires);
  return (
    !extra && scope === 'share' && projectId === project.id
    && revision === (project.share?.revision || '0') && credential === shareCredential(project)
    && exp > Math.floor(Date.now() / 1000)
  );
}

function shareCredential(project) {
  return hmac(`${project.share.passcodeSalt}:${project.share.passcodeHash}`, SECRET);
}

export function mediaToken(projectId, ttlSeconds = 12 * 60 * 60, revision = '0') {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return signPayload(`media.${projectId}.${revision}.${exp}`, SECRET);
}

export function verifyMediaToken(token, projectId, revision = '0') {
  const payload = verifyPayload(token, SECRET);
  if (!payload) return false;
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'media' || parts[1] !== projectId) return false;
  if (parts[2] !== revision) return false;
  return Number(parts[3]) > Math.floor(Date.now() / 1000);
}
