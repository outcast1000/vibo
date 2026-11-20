// The artist / album pages' "Not in library" switch: on by default, it hides
// the provider's tracks the library lacks, and the hero Play plays what the
// list shows — owned rows plus the shown missing rows, in the order drawn.
//
// "Artist A" is a library artist; its Top Songs come from the debug-only
// mock-info plugin (its real tracks mixed with invented ones), loaded through
// the `__E2E_PLUGINS__` fixture with its one permission pre-approved.
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');
const pluginDir = path.resolve(__dirname, '..', '..', '..', 'src-tauri', 'dev-plugins', 'mock-info');

const PLUGIN = {
  id: 'mock-info',
  manifest: JSON.parse(fs.readFileSync(path.join(pluginDir, 'manifest.json'), 'utf8')),
  code: fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8'),
};

async function setup(page) {
  await page.addInitScript({ path: tauriMockPath });
  await page.addInitScript((plugin) => {
    window.__E2E_PLUGINS__ = [plugin];
    window.__E2E_STORE_SEED__ = {
      enabledPlugins: [plugin.id],
      onboardingComplete: true,
      debugMode: true,
      pluginPermissionGrants: { [plugin.id]: plugin.manifest.permissions },
    };
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async function (cmd, args) {
      if (cmd === 'info_get_types_for_entity' && args && args.entity === 'artist') {
        return [['artist_top_tracks', 'Top Songs', 'ranked_list', 60, 0, [['mock-info', 1]], '']];
      }
      return base(cmd, args);
    };
  }, PLUGIN);
  await page.goto('/');
  await page.waitForSelector('.sidebar');
}

async function openArtistA(page) {
  await page.getByRole('button', { name: 'Library' }).click();
  await page.waitForSelector('.search-view .ds-tabs .ds-tab');
  await page.locator('.search-view .ds-tab', { hasText: 'Artists' }).click();
  await page.locator('.search-view .artist-card', { hasText: 'Artist A' }).click();
  await expect(page.locator('.detail-hero-title')).toHaveText('Artist A');
}

const missingRows = (page) => page.locator('.artist-detail .track-list .track-row--missing');
const allRows = (page) => page.locator('.artist-detail .track-list .track-row');
const toggle = (page) => page.getByRole('switch', { name: 'Show tracks not in library' });

test('the switch hides the Not in library rows, and hero Play plays what is shown', async ({ page }) => {
  await setup(page);
  await openArtistA(page);

  // On by default: the merged rows are there and the switch says how many.
  await expect.poll(() => missingRows(page).count()).toBeGreaterThan(0);
  const missing = await missingRows(page).count();
  const total = await allRows(page).count();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.detail-track-missing-toggle')).toContainText(`Not in library (${missing})`);

  // Play with them shown queues every row the list draws.
  const hero = page.locator('.detail-hero');
  await hero.getByRole('button', { name: /^Play/ }).first().click();
  await expect(page.locator('.queue-item')).toHaveCount(total);

  // Switched off: the rows go, the switch stays, and Play queues the rest.
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-checked', 'false');
  await expect(missingRows(page)).toHaveCount(0);
  await expect(allRows(page)).toHaveCount(total - missing);
  await hero.getByRole('button', { name: /^Play/ }).first().click();
  await expect(page.locator('.queue-item')).toHaveCount(total - missing);
});
