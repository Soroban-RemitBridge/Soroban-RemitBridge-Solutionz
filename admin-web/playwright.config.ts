import { defineConfig } from '@playwright/test';

/**
 * End-to-end configuration for the operator console.
 *
 * Two servers, and both are needed. The console reads server-side, so the browser
 * never issues the requests a Playwright route handler could intercept: something
 * has to answer the Next server, and that something is the stub in
 * `e2e/stub-backend.mjs`. Without it there is no way to exercise a page's data
 * path, only its markup.
 *
 * The app is served from a production build rather than `next dev`. A dev server
 * compiles routes on first request, which makes the first navigation of every
 * spec a race, and it is not the artifact anyone deploys — the build is what CI
 * already produces, and testing it is the point.
 *
 * `workers: 1` is deliberate. The stub is one process holding one mode and one
 * queue, so two specs interleaving would be reading each other's state. The suite
 * is fast enough that parallelism would buy seconds and cost determinism.
 */

const STUB_PORT = 4010;
const APP_PORT = 3100;

const STUB_URL = `http://127.0.0.1:${STUB_PORT}`;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] !== undefined ? 2 : 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },

  reporter: process.env['CI'] !== undefined ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: APP_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // No retained video: the failures worth debugging here are assertions about
    // text, and the trace already carries the DOM at each step.
  },

  /**
   * A single browser, on purpose. This console is a desktop operator tool with no
   * responsive behaviour to speak of, so a cross-browser matrix would multiply
   * runtime to re-run the same assertions.
   */
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 900 },
      },
    },
  ],

  webServer: [
    {
      command: 'node e2e/stub-backend.mjs',
      url: `${STUB_URL}/healthz`,
      env: { STUB_PORT: String(STUB_PORT) },
      reuseExistingServer: process.env['CI'] === undefined,
      timeout: 30_000,
    },
    {
      // Build then serve: the suite must exercise the same artifact CI ships, and
      // a developer running `npm run test:e2e` should not have to remember a
      // separate build step first.
      command: `npm run build && npm run start -- --port ${APP_PORT}`,
      url: APP_URL,
      env: {
        REMITBRIDGE_API_URL: STUB_URL,
        // Inlined at build time, and asserted by the shell spec: an operator has
        // to be able to see which deployment they are looking at.
        NEXT_PUBLIC_ENVIRONMENT_LABEL: 'e2e',
      },
      reuseExistingServer: process.env['CI'] === undefined,
      timeout: 240_000,
    },
  ],
});
