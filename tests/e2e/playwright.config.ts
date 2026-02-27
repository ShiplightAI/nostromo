import { defineConfig } from '@playwright/test';
import { shiplightConfig } from 'shiplightai';

export default defineConfig({
  ...shiplightConfig(),
  testDir: './tests',
  testMatch: ['**/*.test.ts', '**/*.yaml.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 10_000 },
  retries: 0,
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 15_000,
  },
});
