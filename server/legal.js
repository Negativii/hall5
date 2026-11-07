import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateDatabase } from './store.js';

// Change this when changing the purpose, data categories or terms of consent.
export const LEGAL_DOCUMENT_VERSION = '2026-10-30';
export const FEEDBACK_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

const text = (value, limit) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';

export function publicLegalConfig() {
  const operator = {
    name: text(process.env.LEGAL_OPERATOR_NAME, 240),
    address: text(process.env.LEGAL_OPERATOR_ADDRESS, 500),
    email: text(process.env.LEGAL_OPERATOR_EMAIL, 254),
  };
  const configured = operator.name.length >= 3 && operator.address.length >= 8
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operator.email);
  const consentVersion = `${LEGAL_DOCUMENT_VERSION}-${crypto.createHash('sha256')
    .update(JSON.stringify({ operator, retentionDays: FEEDBACK_RETENTION_DAYS, purpose: 'feedback' }))
    .digest('hex').slice(0, 16)}`;
  return {
    configured,
    documentVersion: LEGAL_DOCUMENT_VERSION,
    consentVersion,
    operator,
    feedbackRetentionDays: FEEDBACK_RETENTION_DAYS,
    cookies: { adminDays: 7, showHours: 24 },
    diagnosticsMinutes: 30,
  };
}

// Viewing does not require this consent. Only the optional feedback forms do.
// The receipt is stored with the submitted feedback, never exposed publicly.
export function requireFeedbackConsent(req, res) {
  const legal = publicLegalConfig();
  if (!legal.configured) {
    res.status(503).json({ error: 'Обратная связь пока недоступна: владелец должен заполнить сведения об операторе.', code: 'legal_not_configured' });
    return null;
  }
  if (req.body?.consent?.accepted !== true) {
    res.status(400).json({ error: 'Для отправки обратной связи нужно отдельное согласие на обработку персональных данных.', code: 'consent_required' });
    return null;
  }
  if (req.body.consent.version !== legal.consentVersion) {
    res.status(409).json({ error: 'Текст согласия обновился. Обновите страницу и ознакомьтесь с ним перед отправкой.', code: 'consent_changed' });
    return null;
  }
  return {
    version: legal.consentVersion,
    acceptedAt: new Date().toISOString(),
    purpose: 'feedback',
    method: 'checkbox',
    operator: legal.operator,
    retentionDays: FEEDBACK_RETENTION_DAYS,
  };
}

export function pruneFeedbackData(data, now = Date.now()) {
  const cutoff = now - FEEDBACK_RETENTION_DAYS * DAY_MS;
  const expired = value => {
    const at = typeof value === 'string' ? Date.parse(value) : NaN;
    // Never guess the age of legacy records with missing/corrupt dates.
    return Number.isFinite(at) && at <= cutoff;
  };
  const result = { comments: 0, approvals: 0 };
  const visited = new Set();
  for (const project of data.projects || []) {
    const states = [project, ...(project.videoScenes || [])];
    for (const state of states) {
      if (Array.isArray(state.comments)) {
        const retained = state.comments.filter(comment => !expired(comment.createdAt));
        result.comments += state.comments.length - retained.length;
        if (retained.length !== state.comments.length) state.comments = retained;
      }
      for (const version of [state, state.published, state === project ? project.publishedVideoScene : null]) {
        if (!version || visited.has(version)) continue;
        visited.add(version);
        if (version.approval && expired(version.approval.at)) {
          version.approval = null;
          result.approvals += 1;
        }
      }
    }
  }
  return result;
}

function writeBackupAtomically(file, raw, io) {
  const temporary = `${file}.retention-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = io.openSync(temporary, 'wx', 0o600);
    io.writeFileSync(fd, raw);
    io.fsyncSync(fd);
    io.closeSync(fd);
    fd = undefined;
    io.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) io.closeSync(fd);
    try { io.rmSync(temporary, { force: true }); } catch { /* preserve the original error */ }
  }
}

// Call at startup and periodically while this process owns the data lock.
// This covers the application's local recovery copy, not provider snapshots
// or manually exported archives, whose retention the operator must manage.
export function pruneExpiredFeedback(store, now = Date.now()) {
  const result = pruneFeedbackData(store.data, now);
  if (result.comments || result.approvals) store.save();
  const io = store.io || fs;
  let backupResult = { comments: 0, approvals: 0 };
  if (store.backup) {
    let raw;
    try { raw = io.readFileSync(store.backup, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (raw !== undefined) {
      const data = validateDatabase(JSON.parse(raw));
      backupResult = pruneFeedbackData(data, now);
      if (backupResult.comments || backupResult.approvals) {
        writeBackupAtomically(store.backup, JSON.stringify(data, null, 2), io);
      }
    }
  }
  return { ...result, backupComments: backupResult.comments, backupApprovals: backupResult.approvals };
}
