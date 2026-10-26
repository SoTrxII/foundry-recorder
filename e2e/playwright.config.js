const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  globalSetup: './global-setup.js',
  globalTeardown: './global-teardown.js',
  // One real-time recording of ~20s, plus the server's ffmpeg mix
  timeout: 120_000,
  // One Foundry world, one recording at a time
  workers: 1,
  use: {
    // The installed Chrome: skips a browser download.
    // Without Chrome: CHROME_CHANNEL= npx playwright install chromium
    channel: process.env.CHROME_CHANNEL ?? 'chrome',
    // Foundry asks for at least 1366x768
    viewport: { width: 1600, height: 900 },
    launchOptions: {
      // Playwright mutes Chrome by default; Foundry's playback must run as
      // it does for a GM
      ignoreDefaultArgs: ['--mute-audio'],
    },
  },
  webServer: {
    command: 'node proxy.js',
    url: 'http://localhost:8096/healthz',
    reuseExistingServer: true,
  },
});
