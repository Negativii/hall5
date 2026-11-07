import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function acquireDataLock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'server.lock');
  const reclaim = `${file}.reclaim`;
  const token = crypto.randomBytes(16).toString('hex');
  const owner = { pid: process.pid, hostname: os.hostname(), token, startedAt: new Date().toISOString() };
  const claim = () => fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  try { claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-owner recovery: two new processes must never rename each other's fresh locks.
    let guard;
    try { guard = fs.openSync(reclaim, 'wx', 0o600); }
    catch { throw new Error('Папка данных занята или проверяется другим сервером. Повторите запуск после его остановки.'); }
    try {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { throw new Error(`Не удалось проверить блокировку ${file}; проверьте, что другой сервер остановлен.`); }
      let alive = true;
      if (previous.hostname === os.hostname() && Number.isSafeInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); }
        catch (probeError) { if (probeError.code === 'ESRCH') alive = false; }
      }
      if (alive) throw new Error('С этой папкой данных уже работает другой сервер HALL/5. Используйте один процесс.');
      fs.renameSync(file, `${file}.stale-${Date.now()}-${token.slice(0, 6)}`);
      claim();
    } finally {
      fs.closeSync(guard);
      fs.rmSync(reclaim, { force: true });
    }
  }
  return () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[lock] Не удалось снять блокировку:', error.message);
    }
  };
}
