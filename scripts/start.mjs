import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) < 22 || (Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 12)) {
  console.error('Нужен Node.js 22.12 или новее. Установите Node.js LTS и запустите файл ещё раз.');
  process.exit(1);
}
const envFile = path.join(root, '.env');
if (!fs.existsSync(envFile)) {
  const example = fs.readFileSync('.env.example', 'utf8');
  fs.writeFileSync(envFile, example.replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${crypto.randomBytes(12).toString('base64url')}`).replace(/^PORT=.*$/m, 'PORT=3100').replace(/^HOST=.*$/m, 'HOST=127.0.0.1'), { mode: 0o600, flag: 'wx' });
  console.log('Создан .env с новым паролем. Пароль кабинета указан в строке ADMIN_PASSWORD.');
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.cmd') });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message || 'Не удалось подготовить приложение. Смотрите сообщение выше.');
    process.exit(result.status || 1);
  }
}
const installStamp = path.join(root, 'node_modules', '.hall5-install');
const installIdentity = `${process.platform}/${process.arch}/${crypto.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex')}`;
let installedIdentity;
try { installedIdentity = fs.readFileSync(installStamp, 'utf8'); } catch { /* fresh or copied install */ }
if (installedIdentity !== installIdentity || !fs.existsSync('node_modules/vite') || !fs.existsSync('node_modules/express')
  || !fs.existsSync('node_modules/@ffprobe-installer/ffprobe')) {
  run(npm, ['ci']);
  fs.writeFileSync(installStamp, installIdentity);
}
console.log('Проверяем и собираем KUOG HALL…');
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
console.log('Для остановки нажмите Ctrl+C. Для доступа заказчиков по интернету нужен публичный сервер.');
const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js', '--prod'], { cwd: root, stdio: 'inherit' });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code || 0));
child.on('error', (error) => { console.error(error.message); process.exit(1); });
