// Detail-page tabs that don't fit on one row go behind a "More" tab instead
// of wrapping (labels used to break onto two lines and push the last tab
// off the edge). Which tabs fit is the pure `fitTabs` (unit-tested); this
// pins the measuring around it in a real layout. The menu itself is native,
// so picking from it can't be driven here.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

async function openArtistA(page) {
  await page.addInitScript({ path: tauriMockPath });
  // The VA fixtures register the artist info type ("About"), giving the page
  // more than its two host tabs.
  await page.addInitScript(() => { window.__E2E_VA__ = true; });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
  await page.getByRole('button', { name: 'Library' }).click();
  await page.locator('.search-view .ds-tab', { hasText: 'Artists' }).click();
  await page.locator('.search-view .artist-card', { hasText: 'Artist A' }).click();
  await expect(page.locator('.detail-hero-title')).toHaveText('Artist A');
  await expect(tabBar(page).locator('.info-sections-tab', { hasText: 'About' })).toBeVisible();
}

// The page's main tab bar (the artist page also has the one-tab Albums strip).
function tabBar(page) {
  return page.locator('.info-sections-tabs').filter({ has: page.locator('[data-tab-id="tracks"]') });
}

test('every tab is on the row when there is room, with no More', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openArtistA(page);
  const bar = tabBar(page);
  await expect(bar.locator('.info-sections-tab', { hasText: 'About' })).toBeVisible();
  await expect(bar.locator('.info-sections-more')).toHaveCount(0);
});

test('a narrow bar moves tabs behind More and keeps the row one line high', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openArtistA(page);
  const bar = tabBar(page);
  const wideCount = await bar.locator('[data-tab-id]').count();
  expect(wideCount).toBeGreaterThan(2);

  // The mock page has only three tabs, which fit even the narrowest main
  // column, so narrow the bar itself — the same resize the observer sees
  // when the window shrinks or the queue opens.
  await page.addStyleTag({ content: '.artist-detail .info-sections-tabs { max-width: 200px; }' });
  const more = bar.locator('.info-sections-more');
  await expect(more).toBeVisible();

  // Fewer tabs on the row than exist, the active one (All Tracks) among them.
  const shown = bar.locator('[data-tab-id]');
  await expect.poll(() => shown.count()).toBeLessThan(wideCount);
  await expect(bar.locator('[data-tab-id="tracks"]')).toHaveClass(/active/);

  // One line: every tab and More share a top edge, and nothing spills past
  // the bar's right edge.
  const barBox = await bar.boundingBox();
  const boxes = await bar.locator('> .info-sections-tab').evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return { top: r.top, right: r.right }; }));
  for (const b of boxes) {
    expect(Math.abs(b.top - boxes[0].top)).toBeLessThan(1);
    expect(b.right).toBeLessThanOrEqual(barBox.x + barBox.width + 0.5);
  }

  // Widening again brings everything back.
  await page.addStyleTag({ content: '.artist-detail .info-sections-tabs { max-width: none; }' });
  await expect(more).toHaveCount(0);
  await expect.poll(() => shown.count()).toBe(wideCount);
});
