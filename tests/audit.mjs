import { spawnSync } from 'node:child_process';

const commands = [
  ['node_modules/typescript/bin/tsc', '-b'],
  ['node_modules/vite/bin/vite.js', 'build'],
  ['--experimental-strip-types', '--test', 'tests/reliability.mjs', 'tests/scene.test.mjs',
    'tests/scene-renderer.mjs', 'tests/demand-render.mjs', 'tests/video-frames.mjs', 'tests/playback-buffer.mjs',
    'tests/playback-sync.mjs', 'tests/playback-snapshot.mjs', 'tests/mobile-preview-policy.mjs',
    'tests/media-failure.mjs', 'tests/playback-diagnostics.mjs', 'tests/legal.test.mjs'],
  ['tests/private-access.mjs'],
  ['tests/backend-reliability.mjs'],
  ['tests/replacement-cancel.mjs'],
  ['tests/video-scenes-api.mjs'],
  ['--test', 'tests/media-timebase.mjs', 'tests/media-quality.mjs', 'tests/compatibility-preview.mjs', 'tests/mobile-preview.mjs'],
  ['tests/project-workflow-browser.mjs'],
  ['tests/scene-workflow-browser.mjs'],
  ['tests/production-smoke.mjs'],
];
for (const args of commands) {
  console.log(`\n>>> node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nAUDIT PASSED');
