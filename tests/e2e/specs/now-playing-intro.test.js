// The Now Playing song intro: title over artist · album, top-left, shown when
// a song starts (or the view opens) and faded out after NOW_PLAYING_INTRO_MS.
// The view draws no permanent title (issue #136), so this is how a new song
// names itself on a surface whose control bar is usually idle-hidden.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

test('a song names itself on Now Playing, then the name fades', async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  // Mock tracks are 0.25s long; keep this one playing past the intro's 6s.
  await page.addInitScript(() => { window.__E2E_ENGINE_DURATION__ = 120; });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.locator('.nav .nav-btn').filter({ hasText: 'Library' }).click();
  await page.locator('.search-view-input').fill('a');
  await page.waitForTimeout(700);
  await page.locator('.ds-tab', { hasText: 'Tracks' }).first().click();
  const tableBtn = page.locator('button[title="Table view"]');
  if (await tableBtn.isVisible().catch(() => false)) await tableBtn.click();
  const firstRow = page.locator('.track-row').first();
  await firstRow.waitFor({ state: 'visible', timeout: 10000 });
  const title = (await firstRow.locator('.col-title').innerText()).trim();
  await firstRow.locator('.col-title').dblclick();

  await page.locator('.nav .nav-btn').filter({ hasText: 'Now Playing' }).click();
  const intro = page.locator('.now-playing-view [data-testid="np-intro"]');
  await expect(intro).toBeVisible();
  await expect(intro.locator('.np-intro-title')).toContainText(title);
  await expect(intro).not.toHaveClass(/is-leaving/);

  // Then it goes, without anyone touching anything.
  await expect(intro).toHaveClass(/is-leaving/, { timeout: 9000 });
});
