import { existsSync } from "fs";

import { defineConfig, devices } from "@playwright/test";

// In managed sandboxes a standalone Chromium ships at this path; when the
// matching Playwright browser build is installed (CI), the default
// resolution is used instead.
const localChromium = "/opt/pw-browsers/chromium";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:3000",
    ...(existsSync(localChromium) && !process.env.CI
      ? { launchOptions: { executablePath: localChromium } }
      : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm start",
    url: "http://localhost:3000/api/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { MOCK_LLM: "true", MOCK_DRIVE: "true" },
  },
});
