import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

/**
 * Argos visual testing on the Synerise Design System Storybook.
 *
 * The captured surface is the `packages/storybook/storybook-static` build, the
 * exact artifact the current `chromatic_publish` job uploads.
 */
const PORT = Number(process.env['ARGOS_PORT'] ?? 6105);
const STATIC_DIR = fileURLToPath(
  new URL('../packages/storybook/storybook-static', import.meta.url),
);

const isCI = Boolean(process.env['CI']);

export default defineConfig({
  testDir: fileURLToPath(new URL('.', import.meta.url)),
  fullyParallel: true,
  forbidOnly: isCI,
  workers: isCI ? 2 : undefined,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: isCI
    ? [['list'], ['@argos-ci/playwright/reporter', { uploadToArgos: true }]]
    : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    // Subpixel antialiasing makes screenshots depend on the host, these flags
    // only matter on CI.
    launchOptions: {
      args: ['--disable-lcd-text', '--font-render-hinting=none'],
    },
  },
  webServer: {
    // A static server that keeps the exact path: `serve` and friends turn
    // `/iframe.html` into a redirect and Storybook then never boots.
    command: `python3 -m http.server ${PORT} --directory ${STATIC_DIR}`,
    url: `http://localhost:${PORT}/iframe.html`,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
