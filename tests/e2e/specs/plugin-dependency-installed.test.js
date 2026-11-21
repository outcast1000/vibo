// api.system.onDependencyInstalled, end to end through real worker plugins:
// the backend's `dependency-installed` event reaches the handler of a plugin
// whose manifest lists that tool, and only that plugin. `require-dependency`
// is fire-and-forget, so this event is how a plugin learns the install it
// asked for landed — polling on a timer missed installs started late from a
// dialog left open (the Whisper settings panel kept saying "Not installed").
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

function plugin(id, tool) {
  return {
    id,
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      author: 'e2e',
      description: 'Listens for its tool to be installed',
      runtime: 'worker',
      permissions: [],
      binaryDependencies: [{ name: tool, required: false, reason: 'Testing' }],
    },
    code: `
function activate(api) {
  api.system.onDependencyInstalled(function (c) {
    api.log('info', '${id} heard ' + c.name + ' ' + c.version);
  });
  api.log('info', '${id} is running');
}
return { activate: activate };`,
  };
}

const WHISPER = plugin('dep-whisper', 'whisper-cli');
const OTHER = plugin('dep-other', 'yt-dlp');

const lines = (page) =>
  page.evaluate(() => (window.__TEST_LOG_LINES__ || []).map((l) => l.message));

test('a dependency install reaches only the plugins that list the tool', async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((plugins) => {
    window.__E2E_PLUGINS__ = plugins;
    window.__E2E_STORE_SEED__ = {
      enabledPlugins: plugins.map((p) => p.id),
      onboardingComplete: true,
    };
  }, [WHISPER, OTHER]);
  await page.goto('/');
  await page.waitForSelector('.sidebar');

  await expect.poll(() => lines(page)).toEqual(expect.arrayContaining(['dep-whisper is running', 'dep-other is running']));

  await page.evaluate(() =>
    window.__TEST_ENGINE__.emit('dependency-installed', { name: 'whisper-cli', version: '1.9.6' }),
  );

  await expect.poll(() => lines(page)).toContain('dep-whisper heard whisper-cli 1.9.6');
  expect((await lines(page)).some((m) => m.startsWith('dep-other heard'))).toBe(false);
});
