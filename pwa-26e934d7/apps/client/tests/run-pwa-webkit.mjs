import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', 'tests/pwa-ui.test.mjs'], {
  env: { ...process.env, PWA_BROWSER: 'webkit' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
