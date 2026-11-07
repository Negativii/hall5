import fs from 'node:fs';
import path from 'node:path';

// Use an installed browser; never depend on a developer's machine layout.
export function browserPath() {
  const explicit = process.env.BROWSER_PATH || process.env.EDGE_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`Browser not found: ${explicit}`);
    return explicit;
  }
  const candidates = process.platform === 'win32'
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).flatMap(root => [
        path.join(root, 'Microsoft/Edge/Application/msedge.exe'),
        path.join(root, 'Google/Chrome/Application/chrome.exe'),
      ])
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) throw new Error('Install Chrome/Edge/Chromium or set BROWSER_PATH to its executable.');
  return found;
}
