import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/demo', workers: 1, fullyParallel: false, timeout: 60000,
  expect: { timeout: 15000 }, reporter: 'list',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  use: { baseURL: 'http://localhost:5210/comses-lab/', viewport: { width: 1440, height: 1000 }, colorScheme: 'light', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run serve:demo', env: { DEMO_PORT: '5210', DEMO_BASE: '/comses-lab/' }, url: 'http://localhost:5210/comses-lab/', reuseExistingServer: false },
});
